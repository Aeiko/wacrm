-- Operator recovery is queue-only. Trusted server normalizes the private inspection
-- before final CAS; no browser role can inspect payloads or authorize a replay.
ALTER TABLE public.coexistence_jobs
  ADD COLUMN operator_request_id uuid,
  ADD COLUMN operator_requested_at timestamptz,
  ADD COLUMN operator_actor_id uuid,
  ADD COLUMN operator_previous_attempts integer,
  ADD COLUMN operator_previous_error text,
  ADD CONSTRAINT coexistence_operator_audit_pair CHECK (
    (operator_request_id IS NULL AND operator_requested_at IS NULL AND operator_actor_id IS NULL
      AND operator_previous_attempts IS NULL AND operator_previous_error IS NULL)
    OR (operator_request_id IS NOT NULL AND operator_requested_at IS NOT NULL AND operator_actor_id IS NOT NULL
      AND operator_previous_attempts IS NOT NULL AND operator_previous_error IS NOT NULL
      AND operator_previous_attempts BETWEEN 0 AND 5 AND operator_previous_error IN
        ('decode_failed','unsupported_payload','worker_failed','commit_failed','processing_failed',
         'hydration_parent_missing','retry_expired')));
CREATE UNIQUE INDEX coexistence_operator_request ON public.coexistence_jobs(account_id,operator_request_id)
  WHERE operator_request_id IS NOT NULL;
CREATE INDEX coexistence_operator_jobs ON public.coexistence_jobs(account_id,created_at DESC,id DESC)
  WHERE status <> 'completed';
CREATE INDEX coexistence_operator_effects ON public.coexistence_live_effects(config_id,created_at DESC,message_id DESC)
  WHERE state <> 'completed';
CREATE INDEX coexistence_operator_status ON public.coexistence_status_events(account_id,created_at DESC,id DESC)
  WHERE state <> 'completed';
CREATE INDEX coexistence_operator_updates ON public.coexistence_updates(account_id,captured_at DESC,id DESC)
  WHERE state <> 'applied';

CREATE FUNCTION public.coexistence_operator_audit_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF OLD.operator_request_id IS NOT NULL AND
    ROW(NEW.operator_request_id,NEW.operator_requested_at,NEW.operator_actor_id,
      NEW.operator_previous_attempts,NEW.operator_previous_error)
    IS DISTINCT FROM ROW(OLD.operator_request_id,OLD.operator_requested_at,OLD.operator_actor_id,
      OLD.operator_previous_attempts,OLD.operator_previous_error) THEN
    RAISE EXCEPTION 'coexistence_operator_audit_immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER coexistence_operator_audit_guard BEFORE UPDATE ON public.coexistence_jobs
  FOR EACH ROW EXECUTE FUNCTION public.coexistence_operator_audit_guard();

CREATE FUNCTION public.coexistence_operator_authorize(p_actor_id uuid,p_account_id uuid)
RETURNS void LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM profiles WHERE user_id=p_actor_id AND account_id=p_account_id
    AND account_role IN ('owner','admin')) THEN
    RAISE EXCEPTION 'coexistence_operator_forbidden' USING ERRCODE='42501';
  END IF;
END;
$$;
CREATE FUNCTION public.coexistence_operator_binding(c public.whatsapp_config,p_app_id text)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT coalesce(c.status='connected' AND c.coexistence_verified_at IS NOT NULL
    AND nullif(p_app_id,'') IS NOT NULL AND c.coexistence_app_id=p_app_id
    AND nullif(c.access_token,'') IS NOT NULL AND nullif(c.phone_number_id,'') IS NOT NULL
    AND nullif(c.waba_id,'') IS NOT NULL AND EXISTS(
      SELECT 1 FROM profiles WHERE user_id=c.user_id AND account_id=c.account_id),false)
$$;
CREATE FUNCTION public.coexistence_operator_eligible(j public.coexistence_jobs,c public.whatsapp_config,p_app_id text)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT coalesce(j.status='quarantined' AND j.lease_token IS NULL AND j.lease_until IS NULL
    AND j.operator_request_id IS NULL AND j.payload <> '{}'::jsonb
    AND isfinite(j.created_at) AND j.created_at>now()-interval '7 days' AND j.created_at<=now()
    AND j.account_id=c.account_id AND j.config_id=c.id AND j.generation=c.coexistence_generation
    AND coexistence_operator_binding(c,p_app_id)
    AND j.last_error IN ('decode_failed','unsupported_payload','worker_failed','commit_failed',
      'processing_failed','hydration_parent_missing','retry_expired')
    AND NOT jsonb_path_exists(j.payload,'$.**.field ? (@ == "account_update")')
    AND NOT EXISTS(SELECT 1 FROM coexistence_lifecycle_evidence e
      WHERE e.config_id=j.config_id AND e.dedupe_key=j.dedupe_key),false)
$$;
CREATE FUNCTION public.coexistence_operator_reason(p_reason text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT CASE WHEN p_reason IS NULL THEN NULL WHEN p_reason IN (
    'decode_failed','unsupported_payload','worker_failed','commit_failed','processing_failed',
    'hydration_parent_missing','retry_expired','retention_expired','binding_changed','binding_paused',
    'lifecycle_target_unknown','identity_changed','inbound_expired','inbound_future','lease_expired',
    'execution_uncertain','event_expired','identity_missing','identity_conflict','message_identity_conflict',
    'invalid_hydration','invalid_contact_action','invalid_message','invalid_timestamp','direction_conflict',
    'unsupported_operation','invalid_live_message','invalid_update','invalid_update_identity',
    'invalid_message_status','invalid_provider_status','invalid_error_code','invalid_reaction',
    'unsupported_update','update_identity_conflict','message_origin_conflict') THEN p_reason ELSE 'unknown' END
$$;

-- This private row projection is bounded by its callers before JSON aggregation.
CREATE FUNCTION public.coexistence_operator_rows(p_account_id uuid,p_app_id text,p_kind text,
  p_before_created_at timestamptz,p_before_id uuid,p_limit integer)
RETURNS TABLE(id uuid,state text,reason text,created_at timestamptz,lease_until timestamptz,
  available_at timestamptz,attempts integer,stage integer,retention_until timestamptz,
  payload_present boolean,current_binding boolean,overdue boolean,retry_eligible boolean,
  operator_requested_at timestamptz)
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT * FROM (
    SELECT j.id,j.status,coexistence_operator_reason(j.last_error),j.created_at,j.lease_until,
      j.available_at,j.attempts,NULL::integer,j.created_at+interval '7 days',j.payload<>'{}'::jsonb,
      coalesce(j.account_id=c.account_id AND j.generation=c.coexistence_generation
        AND coexistence_operator_binding(c,p_app_id),false),
      coalesce((j.status='pending' AND j.available_at<=now()) OR
        (j.status='processing' AND j.lease_until<=now()),false),
      coexistence_operator_eligible(j,c,p_app_id),j.operator_requested_at
    FROM (SELECT * FROM coexistence_jobs WHERE p_kind='jobs' AND account_id=p_account_id
      AND status<>'completed' AND (p_before_created_at IS NULL OR (created_at,id)<(p_before_created_at,p_before_id))
      ORDER BY created_at DESC,id DESC LIMIT p_limit) j
    LEFT JOIN whatsapp_config c ON c.id=j.config_id
    UNION ALL
    SELECT e.message_id,e.state,coexistence_operator_reason(e.last_error),e.created_at,e.lease_until,
      NULL,NULL,e.stage,NULL,NULL,
      coalesce(c.account_id=p_account_id AND e.generation=c.coexistence_generation
        AND coexistence_operator_binding(c,p_app_id),false),
      coalesce(e.state IN ('leased','running') AND e.lease_until<=now(),false),false,NULL
    FROM (SELECT e.* FROM coexistence_live_effects e JOIN whatsapp_config c ON c.id=e.config_id
      JOIN messages m ON m.id=e.message_id JOIN conversations cv ON cv.id=m.conversation_id
      WHERE p_kind='effects' AND c.account_id=p_account_id AND cv.account_id=p_account_id AND e.state<>'completed'
        AND (p_before_created_at IS NULL OR (e.created_at,e.message_id)<(p_before_created_at,p_before_id))
      ORDER BY e.created_at DESC,e.message_id DESC LIMIT p_limit) e
    JOIN whatsapp_config c ON c.id=e.config_id
    UNION ALL
    SELECT e.id,e.state,coexistence_operator_reason(e.last_error),e.created_at,e.lease_until,
      NULL,NULL,NULL,NULL,NULL,
      coalesce(e.account_id=c.account_id AND e.generation=c.coexistence_generation
        AND coexistence_operator_binding(c,p_app_id),false),
      coalesce(e.state='running' AND e.lease_until<=now(),false),false,NULL
    FROM (SELECT * FROM coexistence_status_events WHERE p_kind='status_events' AND account_id=p_account_id
      AND state<>'completed' AND (p_before_created_at IS NULL OR (created_at,id)<(p_before_created_at,p_before_id))
      ORDER BY created_at DESC,id DESC LIMIT p_limit) e
    LEFT JOIN whatsapp_config c ON c.id=e.config_id
    UNION ALL
    SELECT u.id,u.state,NULL,u.captured_at,NULL,NULL,NULL,NULL,u.captured_at+interval '7 days',
      u.operation IS NOT NULL,
      coalesce(u.account_id=c.account_id AND u.generation=c.coexistence_generation
        AND coexistence_operator_binding(c,p_app_id),false),
      u.state='pending' AND u.captured_at<=now()-interval '7 days',false,NULL
    FROM (SELECT * FROM coexistence_updates WHERE p_kind='updates' AND account_id=p_account_id
      AND state<>'applied' AND (p_before_created_at IS NULL OR (captured_at,id)<(p_before_created_at,p_before_id))
      ORDER BY captured_at DESC,id DESC LIMIT p_limit) u
    LEFT JOIN whatsapp_config c ON c.id=u.config_id
  ) attention ORDER BY 4 DESC,1 DESC LIMIT p_limit
$$;

CREATE FUNCTION public.coexistence_operator_inventory(p_actor_id uuid,p_account_id uuid,p_app_id text,p_kind text,
  p_before_created_at timestamptz DEFAULT NULL,p_before_id uuid DEFAULT NULL,p_limit integer DEFAULT 25)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE items jsonb; cursor jsonb; n integer; connection jsonb;
BEGIN
  PERFORM coexistence_operator_authorize(p_actor_id,p_account_id);
  IF p_kind IS NULL OR p_kind NOT IN ('jobs','effects','status_events','updates')
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50
    OR (p_before_created_at IS NULL) <> (p_before_id IS NULL)
    OR (p_before_created_at IS NOT NULL AND NOT isfinite(p_before_created_at)) THEN
    RAISE EXCEPTION 'coexistence_operator_invalid_query' USING ERRCODE='22023';
  END IF;
  SELECT jsonb_build_object('managed',coexistence_app_id IS NOT NULL,'connected',status='connected',
    'verified',coexistence_verified_at IS NOT NULL) INTO connection FROM whatsapp_config WHERE account_id=p_account_id;
  WITH page AS MATERIALIZED (SELECT * FROM coexistence_operator_rows(p_account_id,p_app_id,p_kind,
      p_before_created_at,p_before_id,p_limit+1)),
    visible AS (SELECT * FROM page ORDER BY created_at DESC,id DESC LIMIT p_limit)
  SELECT coalesce((SELECT jsonb_agg(to_jsonb(v) ORDER BY v.created_at DESC,v.id DESC) FROM visible v),'[]'::jsonb),
    CASE WHEN (SELECT count(*) FROM page)>p_limit THEN
      (SELECT jsonb_build_object('created_at',created_at,'id',id) FROM visible ORDER BY created_at,id LIMIT 1) END
    INTO items,cursor;
  -- Count only indexed attention IDs: do not decode payloads or evaluate eligibility for gauges.
  SELECT count(*) INTO n FROM (
    SELECT j.id FROM coexistence_jobs j WHERE p_kind='jobs' AND j.account_id=p_account_id AND j.status<>'completed'
    UNION ALL
    SELECT e.message_id FROM coexistence_live_effects e JOIN whatsapp_config c ON c.id=e.config_id
      JOIN messages m ON m.id=e.message_id JOIN conversations cv ON cv.id=m.conversation_id
      WHERE p_kind='effects' AND c.account_id=p_account_id AND cv.account_id=p_account_id AND e.state<>'completed'
    UNION ALL
    SELECT id FROM coexistence_status_events WHERE p_kind='status_events' AND account_id=p_account_id AND state<>'completed'
    UNION ALL
    SELECT id FROM coexistence_updates WHERE p_kind='updates' AND account_id=p_account_id AND state<>'applied'
    LIMIT 1001
  ) bounded;
  RETURN jsonb_build_object('connection',coalesce(connection,'{"managed":false,"connected":false,"verified":false}'::jsonb),
    'observed_at',statement_timestamp(),'items',items,'next_cursor',cursor,'count',least(n,1000),'count_capped',n>1000);
END;
$$;

CREATE FUNCTION public.coexistence_operator_inspect(p_actor_id uuid,p_account_id uuid,p_job_id uuid,
  p_app_id text,p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j coexistence_jobs%ROWTYPE; c whatsapp_config%ROWTYPE;
BEGIN
  PERFORM coexistence_operator_authorize(p_actor_id,p_account_id);
  IF p_request_id IS NULL THEN RETURN '{"status":"ineligible"}'; END IF;
  IF EXISTS(SELECT 1 FROM coexistence_jobs WHERE account_id=p_account_id
    AND operator_request_id=p_request_id AND id<>p_job_id) THEN RETURN '{"status":"conflict"}'; END IF;
  SELECT * INTO j FROM coexistence_jobs WHERE id=p_job_id AND account_id=p_account_id;
  IF NOT FOUND THEN RETURN '{"status":"ineligible"}'; END IF;
  IF j.operator_request_id=p_request_id THEN
    RETURN jsonb_build_object('status','queued','requested_at',j.operator_requested_at);
  END IF;
  SELECT * INTO c FROM whatsapp_config WHERE id=j.config_id;
  IF NOT coexistence_operator_eligible(j,c,p_app_id) THEN RETURN '{"status":"ineligible"}'; END IF;
  RETURN jsonb_build_object('status','inspect','payload',j.payload,
    'fingerprint',encode(sha256(convert_to(to_jsonb(j)::text,'UTF8')),'hex'));
END;
$$;

CREATE FUNCTION public.coexistence_operator_requeue(p_actor_id uuid,p_account_id uuid,p_job_id uuid,
  p_app_id text,p_request_id uuid,p_fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE j coexistence_jobs%ROWTYPE; c whatsapp_config%ROWTYPE; stamp timestamptz;
BEGIN
  PERFORM coexistence_operator_authorize(p_actor_id,p_account_id);
  IF p_request_id IS NULL THEN RETURN '{"status":"ineligible"}'; END IF;
  -- NOWAIT avoids inversions with membership/config/worker operations. Caller may retry the same request.
  SELECT wc.* INTO c FROM whatsapp_config wc JOIN coexistence_jobs x ON x.config_id=wc.id
    WHERE x.id=p_job_id AND x.account_id=p_account_id FOR UPDATE OF wc NOWAIT;
  PERFORM 1 FROM accounts WHERE id=p_account_id FOR UPDATE NOWAIT;
  PERFORM 1 FROM profiles WHERE user_id=p_actor_id FOR SHARE NOWAIT;
  PERFORM coexistence_operator_authorize(p_actor_id,p_account_id);
  -- Pin the config owner's membership too; a concurrent move cannot invalidate acceptance.
  PERFORM 1 FROM profiles WHERE user_id=c.user_id FOR SHARE NOWAIT;
  SELECT * INTO j FROM coexistence_jobs WHERE id=p_job_id AND account_id=p_account_id FOR UPDATE NOWAIT;
  IF NOT FOUND THEN RETURN '{"status":"ineligible"}'; END IF;
  IF EXISTS(SELECT 1 FROM coexistence_jobs WHERE account_id=p_account_id
    AND operator_request_id=p_request_id AND id<>p_job_id) THEN RETURN '{"status":"conflict"}'; END IF;
  IF j.operator_request_id=p_request_id THEN
    RETURN jsonb_build_object('status','queued','requested_at',j.operator_requested_at);
  END IF;
  IF NOT coexistence_operator_eligible(j,c,p_app_id) THEN RETURN '{"status":"ineligible"}'; END IF;
  IF p_fingerprint IS DISTINCT FROM encode(sha256(convert_to(to_jsonb(j)::text,'UTF8')),'hex') THEN
    RETURN '{"status":"conflict"}';
  END IF;
  stamp:=clock_timestamp();
  UPDATE coexistence_jobs SET operator_request_id=p_request_id,operator_requested_at=stamp,
    operator_actor_id=p_actor_id,operator_previous_attempts=attempts,operator_previous_error=last_error,
    status='pending',attempts=0,available_at=stamp,completed_at=NULL,last_error=NULL,
    lease_token=NULL,lease_until=NULL WHERE id=j.id;
  RETURN jsonb_build_object('status','queued','requested_at',stamp);
EXCEPTION WHEN lock_not_available OR unique_violation THEN RETURN '{"status":"conflict"}';
END;
$$;

ALTER FUNCTION public.coexistence_operator_audit_guard() OWNER TO postgres;
ALTER FUNCTION public.coexistence_operator_authorize(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.coexistence_operator_binding(public.whatsapp_config,text) OWNER TO postgres;
ALTER FUNCTION public.coexistence_operator_eligible(public.coexistence_jobs,public.whatsapp_config,text) OWNER TO postgres;
ALTER FUNCTION public.coexistence_operator_reason(text) OWNER TO postgres;
ALTER FUNCTION public.coexistence_operator_rows(uuid,text,text,timestamptz,uuid,integer) OWNER TO postgres;
ALTER FUNCTION public.coexistence_operator_inventory(uuid,uuid,text,text,timestamptz,uuid,integer) OWNER TO postgres;
ALTER FUNCTION public.coexistence_operator_inspect(uuid,uuid,uuid,text,uuid) OWNER TO postgres;
ALTER FUNCTION public.coexistence_operator_requeue(uuid,uuid,uuid,text,uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.coexistence_operator_audit_guard(),public.coexistence_operator_authorize(uuid,uuid),
  public.coexistence_operator_binding(public.whatsapp_config,text),
  public.coexistence_operator_eligible(public.coexistence_jobs,public.whatsapp_config,text),
  public.coexistence_operator_reason(text),public.coexistence_operator_rows(uuid,text,text,timestamptz,uuid,integer),
  public.coexistence_operator_inventory(uuid,uuid,text,text,timestamptz,uuid,integer),
  public.coexistence_operator_inspect(uuid,uuid,uuid,text,uuid),
  public.coexistence_operator_requeue(uuid,uuid,uuid,text,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.coexistence_operator_inventory(uuid,uuid,text,text,timestamptz,uuid,integer),
  public.coexistence_operator_inspect(uuid,uuid,uuid,text,uuid),
  public.coexistence_operator_requeue(uuid,uuid,uuid,text,uuid,text) TO service_role;
