-- Projection authority starts at a separate post-binding decision, never at SQL077 intent.
ALTER FUNCTION public.coexistence_operator_reason(text) RENAME TO coexistence_operator_reason_before_079;
CREATE FUNCTION public.coexistence_operator_reason(p_reason text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT CASE WHEN p_reason='import_consent_required' THEN p_reason ELSE coexistence_operator_reason_before_079(p_reason) END
$$;
ALTER FUNCTION public.coexistence_operator_reason(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.coexistence_operator_reason(text) FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE public.coexistence_import_decisions (
  decision_order bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  account_id uuid NOT NULL,
  request_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  session_id uuid NOT NULL,
  connection_revision uuid NOT NULL,
  config_id uuid NOT NULL,
  generation uuid NOT NULL,
  app_id text NOT NULL,
  waba_id text NOT NULL,
  phone_number_id text NOT NULL,
  history boolean NOT NULL,
  contacts boolean NOT NULL,
  expires_at timestamptz NOT NULL,
  UNIQUE (account_id,request_id)
);
CREATE INDEX coexistence_import_decisions_binding ON public.coexistence_import_decisions
  (account_id,config_id,generation,decision_order DESC);
ALTER TABLE public.coexistence_import_decisions OWNER TO postgres;
ALTER TABLE public.coexistence_import_decisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.coexistence_import_decisions FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON SEQUENCE public.coexistence_import_decisions_decision_order_seq FROM PUBLIC,anon,authenticated,service_role;

ALTER TABLE public.coexistence_jobs ADD COLUMN import_consent_id uuid;
-- Queue state, raw delivery, and its authority are writable only through the existing queue RPCs.
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER ON public.coexistence_jobs FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.coexistence_import_resource_locks(p_waba text,p_phone text)
RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE k text;
BEGIN
  -- SQL075 takes resource keys after configs, and phone sorts before WABA.
  FOREACH k IN ARRAY ARRAY['phone:'||p_phone,'waba:'||p_waba] LOOP
    IF NOT pg_try_advisory_xact_lock(hashtextextended('connection-operation:'||k,0)) THEN RAISE lock_not_available; END IF;
  END LOOP;
END $$;

CREATE FUNCTION public.coexistence_import_binding_ready(c public.whatsapp_config,p_waba text,p_phone text)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT coalesce(c.status='connected' AND c.coexistence_verified_at<=clock_timestamp()
    AND isfinite(c.coexistence_verified_at) AND nullif(c.access_token,'') IS NOT NULL
    AND c.coexistence_app_id COLLATE "C" ~ '^[1-9][0-9]{0,31}$'
    AND p_waba COLLATE "C" ~ '^[1-9][0-9]{0,31}$' AND p_phone COLLATE "C" ~ '^[1-9][0-9]{0,31}$'
    AND EXISTS(SELECT 1 FROM profiles WHERE user_id=c.user_id AND account_id=c.account_id)
    AND NOT EXISTS(SELECT 1 FROM whatsapp_config other WHERE other.id<>c.id AND (
      connection_operation_resource_id(other.phone_number_id)=p_phone OR
      (other.coexistence_app_id IS NOT NULL AND connection_operation_resource_id(other.waba_id)=p_waba)))
    AND NOT EXISTS(SELECT 1 FROM connection_operations o WHERE o.state IN ('reserved','active','blocked')
      AND (o.account_id=c.account_id OR o.resource_keys && ARRAY['phone:'||p_phone,'waba:'||p_waba]))
    AND NOT EXISTS(SELECT 1 FROM coexistence_negative_evidence e WHERE e.app_id=c.coexistence_app_id
      AND e.waba_id=p_waba AND e.observed_at>=c.coexistence_verified_at)
    AND NOT EXISTS(SELECT 1 FROM coexistence_receiver_vetoes v WHERE v.app_id=c.coexistence_app_id AND v.waba_id=p_waba),false)
$$;

CREATE FUNCTION public.coexistence_import_latest(p_account uuid,p_config uuid,p_generation uuid)
RETURNS public.coexistence_import_decisions LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT d.* FROM coexistence_import_decisions d
    WHERE d.account_id=p_account AND d.config_id=p_config AND d.generation=p_generation
    ORDER BY d.decision_order DESC LIMIT 1
$$;

CREATE FUNCTION public.coexistence_import_consent(p_actor_id uuid,p_account_id uuid,p_session_id uuid,
  p_config_id uuid,p_generation uuid,p_app_id text,p_waba_id text,p_phone_number_id text,
  p_request_id uuid,p_history boolean,p_contacts boolean,p_previous_request_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='250ms' AS $$
DECLARE c whatsapp_config; prior coexistence_import_decisions; latest coexistence_import_decisions;
  revision uuid; withdrawing boolean; same_scope boolean; session_end timestamptz;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed'
    OR p_actor_id IS NULL OR p_account_id IS NULL OR p_session_id IS NULL OR p_config_id IS NULL OR p_generation IS NULL
    OR p_request_id IS NULL OR p_history IS NULL OR p_contacts IS NULL
    OR (p_app_id COLLATE "C" ~ '^[1-9][0-9]{0,31}$') IS NOT TRUE
    OR (p_waba_id COLLATE "C" ~ '^[1-9][0-9]{0,31}$') IS NOT TRUE
    OR (p_phone_number_id COLLATE "C" ~ '^[1-9][0-9]{0,31}$') IS NOT TRUE THEN RETURN '{"status":"invalid"}'; END IF;
  IF NOT coexistence_signup_owner(p_actor_id,p_account_id,p_session_id) THEN RETURN '{"status":"forbidden"}'; END IF;
  PERFORM coexistence_signup_recovery_lock_actor(p_actor_id,p_account_id,p_session_id);
  SELECT not_after INTO session_end FROM auth.sessions WHERE id=p_session_id AND user_id=p_actor_id;
  SELECT connection_revision INTO revision FROM accounts WHERE id=p_account_id;
  SELECT * INTO c FROM whatsapp_config WHERE account_id=p_account_id FOR UPDATE NOWAIT;
  IF NOT coexistence_signup_owner(p_actor_id,p_account_id,p_session_id) THEN RETURN '{"status":"forbidden"}'; END IF;

  SELECT * INTO prior FROM coexistence_import_decisions WHERE account_id=p_account_id AND request_id=p_request_id;
  latest:=coexistence_import_latest(p_account_id,p_config_id,p_generation);
  IF prior.id IS NOT NULL AND ROW(prior.actor_id,prior.session_id,prior.config_id,prior.generation,
      prior.app_id,prior.waba_id,prior.phone_number_id,prior.history,prior.contacts)
    IS DISTINCT FROM ROW(p_actor_id,p_session_id,p_config_id,p_generation,p_app_id,p_waba_id,p_phone_number_id,p_history,p_contacts)
    THEN RETURN '{"status":"conflict"}'; END IF;
  IF prior.id IS NOT NULL AND prior.id IS DISTINCT FROM latest.id THEN RETURN '{"status":"superseded"}'; END IF;

  withdrawing:=NOT p_history AND NOT p_contacts;
  same_scope:=ROW(c.id,c.coexistence_app_id,connection_operation_resource_id(c.waba_id),connection_operation_resource_id(c.phone_number_id))
    IS NOT DISTINCT FROM ROW(p_config_id,p_app_id,p_waba_id,p_phone_number_id);
  IF withdrawing THEN
    -- A stop or a hold must not prevent withdrawal. An old generation can only withdraw itself.
    IF NOT (same_scope AND (c.coexistence_generation=p_generation OR c.status IS DISTINCT FROM 'connected'
        OR c.coexistence_verified_at IS NULL))
      AND (latest.id IS NULL OR ROW(latest.app_id,latest.waba_id,latest.phone_number_id)
        IS DISTINCT FROM ROW(p_app_id,p_waba_id,p_phone_number_id)) THEN RETURN '{"status":"conflict"}'; END IF;
  ELSE
    IF NOT same_scope OR c.coexistence_generation IS DISTINCT FROM p_generation THEN RETURN '{"status":"conflict"}'; END IF;
    PERFORM coexistence_import_resource_locks(p_waba_id,p_phone_number_id);
    IF coexistence_receiver_veto_locked(p_app_id,ARRAY[p_waba_id])
      OR NOT coexistence_import_binding_ready(c,p_waba_id,p_phone_number_id) THEN RETURN '{"status":"blocked"}'; END IF;
    IF prior.id IS NOT NULL AND (prior.connection_revision<>revision OR prior.expires_at<=clock_timestamp()) THEN
      RETURN '{"status":"expired"}'; END IF;
  END IF;
  IF session_end<=clock_timestamp() THEN RETURN '{"status":"forbidden"}'; END IF;
  IF prior.id IS NULL THEN
    -- A new positive decision must acknowledge the latest choice, including a withdrawal.
    IF NOT withdrawing AND p_previous_request_id IS DISTINCT FROM latest.request_id THEN
      RETURN '{"status":"conflict"}'; END IF;
    INSERT INTO coexistence_import_decisions(account_id,request_id,actor_id,session_id,connection_revision,
      config_id,generation,app_id,waba_id,phone_number_id,history,contacts,expires_at)
    VALUES(p_account_id,p_request_id,p_actor_id,p_session_id,revision,p_config_id,p_generation,p_app_id,p_waba_id,
      p_phone_number_id,p_history,p_contacts,clock_timestamp()+interval '168 hours') RETURNING * INTO prior;
  END IF;
  RETURN jsonb_build_object('status','recorded','request_id',prior.request_id,'history',prior.history,
    'contacts',prior.contacts,'expires_at',prior.expires_at,'dispatch_authorized',false);
EXCEPTION WHEN lock_not_available OR deadlock_detected THEN RETURN '{"status":"busy"}';
  WHEN SQLSTATE 'P7401' THEN RETURN '{"status":"forbidden"}';
  WHEN unique_violation THEN RETURN '{"status":"conflict"}';
END $$;

-- A bitmask distinguishes history (1), directory (2), and any other source (4).
-- Both payload representations are consumed by the worker, including older envelopes.
CREATE FUNCTION public.coexistence_import_payload_scope(p_payload jsonb)
RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT coalesce(bit_or(
    (CASE WHEN change->>'field'='history' OR (change->'value') ? 'history' THEN 1 ELSE 0 END) |
    (CASE WHEN change->>'field'='smb_app_state_sync' OR (change->'value') ? 'state_sync' THEN 2 ELSE 0 END) |
    (CASE WHEN change->>'field' IN ('history','smb_app_state_sync') THEN 0 ELSE 4 END)),0)
  FROM (
    SELECT jsonb_path_query(p_payload,'$.deliveries[*]') AS change
    UNION ALL SELECT jsonb_path_query(p_payload,'$.legacy.entry[*].changes[*]')
    UNION ALL SELECT jsonb_path_query(p_payload,'$.entry[*].changes[*]')
  ) changes
$$;

CREATE FUNCTION public.coexistence_import_decision_usable(d public.coexistence_import_decisions,
  c public.whatsapp_config,p_scope integer)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT coalesce(d.id IS NOT NULL AND d.expires_at>clock_timestamp()
    AND CASE p_scope WHEN 1 THEN d.history WHEN 2 THEN d.contacts ELSE false END
    AND d.app_id=c.coexistence_app_id AND d.waba_id=connection_operation_resource_id(c.waba_id)
    AND d.phone_number_id=connection_operation_resource_id(c.phone_number_id)
    AND EXISTS(SELECT 1 FROM accounts a WHERE a.id=d.account_id AND a.connection_revision=d.connection_revision)
    AND connection_operation_authorized(d.actor_id,d.account_id,'onboarding')
    AND EXISTS(SELECT 1 FROM auth.sessions WHERE id=d.session_id AND user_id=d.actor_id
      AND (not_after IS NULL OR not_after>clock_timestamp()))
    AND coexistence_import_binding_ready(c,d.waba_id,d.phone_number_id),false)
$$;

CREATE FUNCTION public.coexistence_import_stamp()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c whatsapp_config; d coexistence_import_decisions; scope integer;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.import_consent_id IS DISTINCT FROM OLD.import_consent_id THEN
      RAISE EXCEPTION 'coexistence_import_stamp_immutable' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  NEW.import_consent_id:=NULL;
  IF NEW.status NOT IN ('pending','processing') OR NEW.created_at<transaction_timestamp()
    OR current_setting('transaction_isolation')<>'read committed' THEN RETURN NEW; END IF;
  scope:=coexistence_import_payload_scope(NEW.payload);
  IF scope NOT IN (1,2) THEN RETURN NEW; END IF;
  SELECT * INTO c FROM whatsapp_config WHERE id=NEW.config_id AND account_id=NEW.account_id
    AND coexistence_generation=NEW.generation FOR UPDATE NOWAIT;
  IF NOT FOUND THEN RETURN NEW; END IF;
  d:=coexistence_import_latest(NEW.account_id,NEW.config_id,NEW.generation);
  IF d.id IS NOT NULL THEN
    PERFORM coexistence_import_resource_locks(d.waba_id,d.phone_number_id);
    -- The config lock serializes intake with decisions and bound stops. Actor rows are locked at projection.
    IF coexistence_import_decision_usable(d,c,scope) THEN NEW.import_consent_id:=d.id; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER coexistence_import_stamp BEFORE INSERT OR UPDATE OF import_consent_id ON public.coexistence_jobs
  FOR EACH ROW EXECUTE FUNCTION public.coexistence_import_stamp();

ALTER FUNCTION public.coexistence_commit(uuid,uuid,jsonb) RENAME TO coexistence_commit_before_079;
CREATE FUNCTION public.coexistence_commit(p_job_id uuid,p_lease_token uuid,p_operations jsonb)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='250ms' AS $$
DECLARE j coexistence_jobs; c whatsapp_config; d coexistence_import_decisions;
  payload_scope integer; private_operations boolean; operation_matches boolean; allowed boolean:=false;
BEGIN
  -- Reject stale callers without locking or changing an unrelated job. Recheck after locks.
  SELECT * INTO j FROM coexistence_jobs WHERE id=p_job_id;
  IF NOT FOUND OR j.status<>'processing' OR p_lease_token IS NULL OR j.lease_token IS DISTINCT FROM p_lease_token
    OR j.lease_until IS NULL OR j.lease_until<=clock_timestamp() THEN RETURN 'stale'; END IF;
  IF jsonb_typeof(p_operations) IS DISTINCT FROM 'array' OR jsonb_array_length(p_operations)>5000
    OR octet_length(p_operations::text)>8388608 THEN RAISE EXCEPTION 'coexistence_invalid_operations'; END IF;
  SELECT coalesce(bool_or(op->>'kind' IN ('progress','hydration','contact') OR op->>'source'='history'),false)
    INTO private_operations FROM jsonb_array_elements(p_operations) op;
  payload_scope:=coexistence_import_payload_scope(j.payload);
  IF (payload_scope & 3)=0 AND NOT private_operations THEN
    RETURN coexistence_commit_before_079(p_job_id,p_lease_token,p_operations);
  END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE lock_not_available; END IF;
  -- Take the old commit's account lock before config/job; NOWAIT also interoperates with SQL072's reverse order.
  PERFORM 1 FROM accounts WHERE id=j.account_id FOR UPDATE NOWAIT;
  SELECT * INTO c FROM whatsapp_config WHERE id=j.config_id FOR UPDATE NOWAIT;
  SELECT * INTO j FROM coexistence_jobs WHERE id=p_job_id FOR UPDATE NOWAIT;
  IF NOT FOUND OR j.status<>'processing' OR j.lease_token IS DISTINCT FROM p_lease_token
    OR j.lease_until IS NULL OR j.lease_until<=clock_timestamp() THEN RETURN 'stale'; END IF;
  payload_scope:=coexistence_import_payload_scope(j.payload);
  SELECT coalesce(bool_and(CASE payload_scope WHEN 1 THEN
      (op->>'kind' IN ('progress','hydration') AND op->>'source' IS NULL)
        OR (op->>'kind'='message' AND op->>'source'='history')
    WHEN 2 THEN op->>'kind'='contact' AND op->>'source' IS NULL ELSE false END IS TRUE),false)
    INTO operation_matches FROM jsonb_array_elements(p_operations) op;
  IF operation_matches AND j.import_consent_id IS NOT NULL AND c.id IS NOT NULL
    AND c.account_id=j.account_id AND c.coexistence_generation=j.generation THEN
    d:=coexistence_import_latest(j.account_id,j.config_id,j.generation);
    IF d.id=j.import_consent_id THEN
      PERFORM 1 FROM profiles WHERE user_id=d.actor_id AND account_id=d.account_id FOR SHARE NOWAIT;
      PERFORM 1 FROM auth.sessions WHERE id=d.session_id AND user_id=d.actor_id FOR SHARE NOWAIT;
      PERFORM coexistence_import_resource_locks(d.waba_id,d.phone_number_id);
      allowed:=NOT coexistence_receiver_veto_locked(d.app_id,ARRAY[d.waba_id])
        AND coexistence_import_decision_usable(d,c,payload_scope);
    END IF;
  END IF;
  IF NOT allowed THEN
    UPDATE coexistence_jobs SET status='quarantined',last_error='import_consent_required',completed_at=clock_timestamp(),
      lease_token=NULL,lease_until=NULL WHERE id=j.id;
    RETURN 'quarantined';
  END IF;
  RETURN coexistence_commit_before_079(p_job_id,p_lease_token,p_operations);
END $$;

ALTER FUNCTION public.coexistence_import_consent(uuid,uuid,uuid,uuid,uuid,text,text,text,uuid,boolean,boolean,uuid) OWNER TO postgres;
ALTER FUNCTION public.coexistence_import_stamp() OWNER TO postgres;
ALTER FUNCTION public.coexistence_commit(uuid,uuid,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.coexistence_import_resource_locks(text,text),
  public.coexistence_import_binding_ready(public.whatsapp_config,text,text),public.coexistence_import_latest(uuid,uuid,uuid),
  public.coexistence_import_payload_scope(jsonb),
  public.coexistence_import_decision_usable(public.coexistence_import_decisions,public.whatsapp_config,integer),
  public.coexistence_import_stamp(),public.coexistence_commit_before_079(uuid,uuid,jsonb),
  public.coexistence_resolve_contact(uuid,uuid,jsonb),public.coexistence_capture_update(uuid,jsonb),
  public.coexistence_import_consent(uuid,uuid,uuid,uuid,uuid,text,text,text,uuid,boolean,boolean,uuid),
  public.coexistence_commit(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.coexistence_import_consent(uuid,uuid,uuid,uuid,uuid,text,text,text,uuid,boolean,boolean,uuid),
  public.coexistence_commit(uuid,uuid,jsonb) TO service_role;
