-- Local operator attestation, not provider API proof or permission to import history.
CREATE TABLE public.coexistence_pilot_bindings (
  attempt_id uuid PRIMARY KEY,
  actor_id uuid NOT NULL,
  session_id uuid NOT NULL,
  account_id uuid NOT NULL UNIQUE,
  config_id uuid NOT NULL UNIQUE,
  generation uuid NOT NULL,
  connection_revision uuid NOT NULL,
  app_id text COLLATE "C" NOT NULL CHECK (app_id ~ '^[1-9][0-9]{0,31}$'),
  waba_id text COLLATE "C" NOT NULL UNIQUE CHECK (waba_id ~ '^[1-9][0-9]{0,31}$'),
  phone_number_id text COLLATE "C" NOT NULL UNIQUE CHECK (phone_number_id ~ '^[1-9][0-9]{0,31}$'),
  launch_lower_bound timestamptz NOT NULL CHECK (isfinite(launch_lower_bound)),
  token_expires_at timestamptz NOT NULL CHECK (isfinite(token_expires_at)),
  activated_at timestamptz NOT NULL CHECK (isfinite(activated_at)),
  intent_id uuid NOT NULL,
  CHECK (app_id<>waba_id AND app_id<>phone_number_id AND waba_id<>phone_number_id),
  CHECK (launch_lower_bound<=activated_at AND activated_at<token_expires_at)
);
ALTER TABLE public.coexistence_pilot_bindings OWNER TO postgres;
ALTER TABLE public.coexistence_pilot_bindings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.coexistence_pilot_bindings FROM PUBLIC,anon,authenticated,service_role;
COMMENT ON COLUMN public.coexistence_pilot_bindings.intent_id IS 'SQL077 intent request_id for this attempt.';
COMMENT ON COLUMN public.coexistence_pilot_bindings.token_expires_at IS
  'Provider expiry of the staged signup credential; not the lifetime of the independent operational credential.';

CREATE FUNCTION public.coexistence_pilot_binding_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'coexistence_pilot_binding_immutable' USING ERRCODE='23514';
END $$;
ALTER FUNCTION public.coexistence_pilot_binding_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.coexistence_pilot_binding_immutable() FROM PUBLIC,anon,authenticated,service_role;
-- No foreign keys that can erase or rewrite provenance on owner, account, or config deletion.
CREATE TRIGGER coexistence_pilot_binding_immutable BEFORE UPDATE OR DELETE ON public.coexistence_pilot_bindings
  FOR EACH ROW EXECUTE FUNCTION public.coexistence_pilot_binding_immutable();
CREATE TRIGGER coexistence_pilot_binding_no_truncate BEFORE TRUNCATE ON public.coexistence_pilot_bindings
  FOR EACH STATEMENT EXECUTE FUNCTION public.coexistence_pilot_binding_immutable();

-- The operator must independently establish fresh assets, owner choice for incoming messages,
-- completed onboarding/active cloud binding, receiver readiness and absence of stop/hold evidence.
-- Pass separately provisioned, verified durable ciphertext as a bound parameter on a non-logging
-- connection. SQL validates its envelope and rejects copying the staged ciphertext; it cannot verify a provider token.
CREATE FUNCTION public.coexistence_pilot_activate(p_actor_id uuid,p_session_id uuid,p_account_id uuid,
  p_attempt_id uuid,p_intent_id uuid,p_expected_revision uuid,p_app_id text,p_login_config_id text,
  p_waba_id text,p_phone_id text,p_intended_phone text,p_operational_ciphertext text,p_approval text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp
  SET lock_timeout='250ms' SET timezone='UTC' AS $$
DECLARE denied CONSTANT jsonb:='{"status":"denied"}';
  o connection_operations; t coexistence_signup_attempts; i coexistence_history_intents;
  bound record; c whatsapp_config; keys text[]; checked_at timestamptz; session_end timestamptz;
  revision uuid; recheck jsonb;
BEGIN
  IF current_user<>'postgres' OR current_setting('transaction_isolation')<>'read committed'
    OR p_approval COLLATE "C" IS DISTINCT FROM 'supervised-live-binding-v1'
    OR p_actor_id IS NULL OR p_session_id IS NULL OR p_account_id IS NULL OR p_attempt_id IS NULL
    OR p_intent_id IS NULL OR p_expected_revision IS NULL
    OR (p_app_id COLLATE "C" ~ '^[1-9][0-9]{0,31}$') IS NOT TRUE
    OR (p_waba_id COLLATE "C" ~ '^[1-9][0-9]{0,31}$') IS NOT TRUE
    OR (p_phone_id COLLATE "C" ~ '^[1-9][0-9]{0,31}$') IS NOT TRUE
    OR p_app_id=p_waba_id OR p_app_id=p_phone_id OR p_waba_id=p_phone_id
    OR (p_login_config_id COLLATE "C" ~ '^[A-Za-z0-9_-]{1,128}$') IS NOT TRUE
    OR (p_intended_phone COLLATE "C" ~ '^\+[1-9][0-9]{7,14}$') IS NOT TRUE
    OR p_operational_ciphertext IS NULL OR octet_length(p_operational_ciphertext)>16384 THEN RETURN denied; END IF;
  IF (p_operational_ciphertext COLLATE "C" ~ '^[a-f0-9]{24}:([a-f0-9]{2})+:[a-f0-9]{32}$') IS NOT TRUE
    OR NOT coexistence_signup_owner(p_actor_id,p_account_id,p_session_id) THEN RETURN denied; END IF;

  -- SQL076: account/profile/session, config, operation/claim/attempt rows, then sorted SQL075 resource keys.
  PERFORM coexistence_signup_recovery_lock_actor(p_actor_id,p_account_id,p_session_id);
  SELECT * INTO bound FROM coexistence_signup_recovery_lock_attempt(p_account_id,p_attempt_id);
  o:=bound.o; t:=bound.t;
  keys:=ARRAY['phone:'||p_phone_id,'waba:'||p_waba_id];
  IF t.id IS NULL OR o.state IS DISTINCT FROM 'active'
    OR o.expected_config_id IS NOT NULL OR o.expected_generation IS NOT NULL
    OR ROW(o.actor_id,t.session_id,o.expected_revision,t.app_id,t.login_config_id,o.waba_id,o.phone_number_id,t.intended_phone)
      IS DISTINCT FROM ROW(p_actor_id,p_session_id,p_expected_revision,p_app_id,p_login_config_id,p_waba_id,p_phone_id,p_intended_phone)
    OR o.steps IS DISTINCT FROM '{"launch":"started","exchange":"started"}'::jsonb
    OR o.result IS NOT NULL OR o.finished_at IS NOT NULL
    OR o.resource_keys IS DISTINCT FROM keys
    OR ARRAY(SELECT r.resource_key FROM connection_operation_resources r WHERE r.operation_id=o.id ORDER BY r.resource_key) IS DISTINCT FROM keys
    OR NOT connection_operation_binding(o)
    OR t.reason IS NOT NULL OR t.access_token IS NULL OR t.access_token=p_operational_ciphertext
    OR t.code_hash IS NULL OR t.token_hash IS NULL
    OR t.launched_at IS NULL OR NOT isfinite(t.launched_at)
    OR t.confirmed_at IS NULL OR NOT isfinite(t.confirmed_at) OR t.confirmed_at<t.launched_at
    OR t.token_deadline IS NULL OR NOT isfinite(t.token_deadline)
    OR t.token_expires_at IS NULL OR NOT isfinite(t.token_expires_at) THEN RETURN denied; END IF;

  -- A preexisting exact intent is required. Holding its row makes the SQL077 call a recheck, never an insert.
  SELECT * INTO i FROM coexistence_history_intents WHERE attempt_id=t.id AND request_id=p_intent_id FOR UPDATE NOWAIT;
  IF NOT FOUND OR i.recorded_at<t.confirmed_at OR NOT isfinite(i.recorded_at) THEN RETURN denied; END IF;
  recheck:=coexistence_history_intent_record(p_actor_id,p_account_id,p_session_id,p_attempt_id,p_intent_id,
    p_expected_revision,NULL,NULL,p_app_id,p_waba_id,p_phone_id,'history-only-v1',true,false);
  IF recheck->>'status'='busy' THEN RETURN '{"status":"busy"}'; END IF;
  IF recheck->>'status' IS DISTINCT FROM 'intent_recorded' THEN RETURN denied; END IF;
  -- SQL078's wrapper holds the receiver scope lock now. A fresh pilot also rejects old signed negatives.
  IF EXISTS(SELECT 1 FROM coexistence_negative_evidence e WHERE e.app_id=p_app_id AND e.waba_id=p_waba_id)
    OR EXISTS(SELECT 1 FROM whatsapp_config w WHERE w.account_id=p_account_id
      OR connection_operation_resource_id(w.waba_id)=p_waba_id OR connection_operation_resource_id(w.phone_number_id)=p_phone_id)
    OR EXISTS(SELECT 1 FROM coexistence_pilot_bindings b WHERE b.attempt_id=p_attempt_id OR b.account_id=p_account_id
      OR b.waba_id=p_waba_id OR b.phone_number_id=p_phone_id)
    OR EXISTS(SELECT 1 FROM connection_operations x WHERE x.id<>o.id
      AND (x.original_account_id=p_account_id OR x.resource_keys && keys)
      AND (x.state IN ('reserved','active','blocked') OR x.state='completed')) THEN RETURN denied; END IF;

  SELECT not_after INTO session_end FROM auth.sessions WHERE id=p_session_id AND user_id=p_actor_id;
  checked_at:=clock_timestamp();
  IF NOT FOUND OR NOT connection_operation_authorized(p_actor_id,p_account_id,'onboarding')
    OR i.recorded_at>checked_at OR least(i.expires_at,session_end,t.token_deadline,t.token_expires_at)<=checked_at THEN
    RETURN denied;
  END IF;
  -- INSERT only; SQL064 allocates the generation before SQL078's config veto trigger runs.
  INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,waba_id,access_token,status,
    connected_at,coexistence_app_id,coexistence_verified_at)
    VALUES(p_account_id,p_actor_id,p_phone_id,p_waba_id,p_operational_ciphertext,'connected',checked_at,p_app_id,checked_at)
    RETURNING * INTO c;
  UPDATE accounts SET connection_revision=gen_random_uuid() WHERE id=p_account_id RETURNING connection_revision INTO revision;
  INSERT INTO coexistence_pilot_bindings(attempt_id,actor_id,session_id,account_id,config_id,generation,
    connection_revision,app_id,waba_id,phone_number_id,launch_lower_bound,token_expires_at,activated_at,intent_id)
    VALUES(t.id,p_actor_id,p_session_id,p_account_id,c.id,c.coexistence_generation,revision,p_app_id,p_waba_id,p_phone_id,
      t.launched_at,t.token_expires_at,checked_at,i.request_id);
  -- Retire staging permanently: SQL075's late store path checks the deadline, not completion.
  UPDATE coexistence_signup_attempts SET access_token=NULL,token_deadline='-infinity' WHERE id=t.id;
  UPDATE connection_operations SET state='completed',finished_at=checked_at,result='{"status":"activated"}' WHERE id=o.id;
  DELETE FROM connection_operation_resources WHERE operation_id=o.id AND resource_key=ANY(keys);
  RETURN '{"status":"activated"}';
EXCEPTION WHEN lock_not_available OR deadlock_detected THEN RETURN '{"status":"busy"}';
  WHEN integrity_constraint_violation OR SQLSTATE 'P7401' THEN RETURN denied;
END $$;
ALTER FUNCTION public.coexistence_pilot_activate(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.coexistence_pilot_activate(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,text,text)
  FROM PUBLIC,anon,authenticated,service_role;
