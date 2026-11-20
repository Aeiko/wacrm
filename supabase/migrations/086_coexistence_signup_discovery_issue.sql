-- Discovery issues are spent even if an attempt expires or is cancelled. No provider IDs until verify.
CREATE TABLE public.coexistence_signup_discovery_issues (
  attempt_id uuid PRIMARY KEY,
  account_id uuid NOT NULL UNIQUE,
  actor_id uuid NOT NULL,
  session_id uuid NOT NULL,
  connection_revision uuid NOT NULL,
  app_id text COLLATE "C" NOT NULL CHECK (app_id ~ '^[1-9][0-9]{0,31}$'),
  login_config_id text COLLATE "C" NOT NULL CHECK (login_config_id ~ '^[1-9][0-9]{0,31}$' AND login_config_id<>app_id),
  intended_phone text COLLATE "C" NOT NULL UNIQUE CHECK (intended_phone ~ '^\+[1-9][0-9]{7,14}$'),
  intent_id uuid NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.coexistence_signup_discovery_issues OWNER TO postgres;
ALTER TABLE public.coexistence_signup_discovery_issues ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.coexistence_signup_discovery_issues FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER coexistence_signup_discovery_issue_immutable BEFORE UPDATE OR DELETE
  ON public.coexistence_signup_discovery_issues FOR EACH ROW
  EXECUTE FUNCTION public.coexistence_signup_invitation_issue_immutable();
CREATE TRIGGER coexistence_signup_discovery_issue_no_truncate BEFORE TRUNCATE
  ON public.coexistence_signup_discovery_issues FOR EACH STATEMENT
  EXECUTE FUNCTION public.coexistence_signup_invitation_issue_immutable();

-- SQL084 also prepares through SQL074. Its issue and legacy prepare both respect a spent discovery receipt.
CREATE FUNCTION public.coexistence_signup_discovery_prepare_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF current_setting('transaction_isolation')<>'read committed'
    OR NOT pg_try_advisory_xact_lock(hashtextextended('coexistence-discovery:'||NEW.intended_phone,0))
    OR EXISTS(SELECT 1 FROM public.coexistence_signup_discovery_issues d
      WHERE d.intended_phone=NEW.intended_phone OR d.account_id=(
        SELECT o.original_account_id FROM public.connection_operations o WHERE o.id=NEW.operation_id)) THEN
    RAISE lock_not_available;
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION public.coexistence_signup_discovery_prepare_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.coexistence_signup_discovery_prepare_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER coexistence_signup_discovery_prepare_guard BEFORE INSERT ON public.coexistence_signup_attempts
  FOR EACH ROW EXECUTE FUNCTION public.coexistence_signup_discovery_prepare_guard();

CREATE FUNCTION public.coexistence_signup_discovery_issue(p_actor_id uuid,p_session_id uuid,p_account_id uuid,
  p_expected_revision uuid,p_app_id text,p_login_config_id text,p_intended_phone text,p_approval text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp SET lock_timeout='250ms' AS $$
DECLARE denied CONSTANT jsonb:='{"status":"denied"}';
  nonce uuid; prepared jsonb; attempt uuid; intent uuid;
BEGIN
  IF current_user<>'postgres' OR current_setting('transaction_isolation')<>'read committed'
    OR p_approval COLLATE "C" IS DISTINCT FROM 'private-owner-discovery-v1'
    OR p_actor_id IS NULL OR p_session_id IS NULL OR p_account_id IS NULL OR p_expected_revision IS NULL
    OR (p_app_id COLLATE "C" ~ '^[1-9][0-9]{0,31}$') IS NOT TRUE
    OR (p_login_config_id COLLATE "C" ~ '^[1-9][0-9]{0,31}$') IS NOT TRUE OR p_app_id=p_login_config_id
    OR (p_intended_phone COLLATE "C" ~ '^\+[1-9][0-9]{7,14}$') IS NOT TRUE
    OR NOT public.coexistence_signup_owner(p_actor_id,p_account_id,p_session_id) THEN RETURN denied; END IF;

  PERFORM public.coexistence_signup_recovery_lock_actor(p_actor_id,p_account_id,p_session_id);
  IF NOT pg_try_advisory_xact_lock(hashtextextended('coexistence-discovery:'||p_intended_phone,0))
    THEN RAISE SQLSTATE 'P8501'; END IF;
  IF NOT public.connection_operation_authorized(p_actor_id,p_account_id,'onboarding')
    OR NOT EXISTS(SELECT 1 FROM public.accounts a WHERE a.id=p_account_id AND a.connection_revision=p_expected_revision)
    OR EXISTS(SELECT 1 FROM public.whatsapp_config c WHERE c.account_id=p_account_id)
    OR EXISTS(SELECT 1 FROM public.connection_operations o WHERE o.original_account_id=p_account_id OR o.account_id=p_account_id)
    OR EXISTS(SELECT 1 FROM public.coexistence_pilot_bindings b WHERE b.account_id=p_account_id)
    OR EXISTS(SELECT 1 FROM public.coexistence_signup_invitation_issues i
      WHERE i.account_id=p_account_id OR i.intended_phone=p_intended_phone)
    OR EXISTS(SELECT 1 FROM public.coexistence_signup_attempts t JOIN public.connection_operations o ON o.id=t.operation_id
      WHERE t.intended_phone=p_intended_phone AND o.state IN ('reserved','active','blocked','completed')) THEN
    RAISE SQLSTATE 'P8501';
  END IF;

  nonce:=gen_random_uuid();
  intent:=gen_random_uuid();
  prepared:=public.coexistence_signup_prepare(p_actor_id,p_account_id,p_session_id,gen_random_uuid(),
    encode(sha256(convert_to(nonce::text,'UTF8')),'hex'),p_app_id,p_login_config_id,p_expected_revision,NULL,NULL,p_intended_phone);
  IF prepared->>'status' IS DISTINCT FROM 'prepared'
    OR ((prepared->>'lease_until')::timestamptz>clock_timestamp()) IS NOT TRUE
    OR NOT EXISTS(SELECT 1 FROM auth.sessions s WHERE s.id=p_session_id AND s.user_id=p_actor_id
      AND (s.not_after IS NULL OR s.not_after>clock_timestamp())) THEN RAISE SQLSTATE 'P8501'; END IF;
  attempt:=(prepared->>'attempt_id')::uuid;
  INSERT INTO public.coexistence_signup_discovery_issues(attempt_id,account_id,actor_id,session_id,connection_revision,
    app_id,login_config_id,intended_phone,intent_id)
    VALUES(attempt,p_account_id,p_actor_id,p_session_id,p_expected_revision,p_app_id,p_login_config_id,p_intended_phone,intent);
  RETURN jsonb_build_object('status','issued','invitation',jsonb_build_object('actorId',p_actor_id,'sessionId',p_session_id,
    'accountId',p_account_id,'attemptId',attempt,'nonce',nonce,'appId',p_app_id,'loginConfigId',p_login_config_id,
    'intendedPhone',p_intended_phone,'intentId',intent,'revision',p_expected_revision));
EXCEPTION WHEN OTHERS THEN RETURN denied;
END $$;
ALTER FUNCTION public.coexistence_signup_discovery_issue(uuid,uuid,uuid,uuid,text,text,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.coexistence_signup_discovery_issue(uuid,uuid,uuid,uuid,text,text,text,text)
  FROM PUBLIC,anon,authenticated,service_role;

-- The private host must authenticate the committed issuance, not just an ordinary prepared attempt.
CREATE FUNCTION public.coexistence_signup_discovery_authorized(p_actor_id uuid,p_account_id uuid,p_session_id uuid,
  p_attempt_id uuid,p_nonce_hash text,p_app_id text,p_login_config_id text,p_expected_revision uuid,p_intent_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM public.coexistence_signup_discovery_issues d
    JOIN public.coexistence_signup_attempts t ON t.id=d.attempt_id
    WHERE d.attempt_id=p_attempt_id AND t.nonce_hash=p_nonce_hash
      AND ROW(d.actor_id,d.account_id,d.session_id,d.app_id,d.login_config_id,d.connection_revision,d.intent_id)
        IS NOT DISTINCT FROM ROW(p_actor_id,p_account_id,p_session_id,p_app_id,p_login_config_id,p_expected_revision,p_intent_id)
      AND public.coexistence_signup_owner(p_actor_id,p_account_id,p_session_id))
$$;
ALTER FUNCTION public.coexistence_signup_discovery_authorized(uuid,uuid,uuid,uuid,text,text,text,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.coexistence_signup_discovery_authorized(uuid,uuid,uuid,uuid,text,text,text,uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.coexistence_signup_discovery_authorized(uuid,uuid,uuid,uuid,text,text,text,uuid,uuid)
  TO service_role;

-- Both concurrent confirmations can observe a preview; only the first may commit selection.
CREATE FUNCTION public.coexistence_signup_discovery_confirm_once()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.coexistence_signup_discovery_issues WHERE attempt_id=OLD.id) THEN
    RAISE SQLSTATE 'P7402';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION public.coexistence_signup_discovery_confirm_once() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.coexistence_signup_discovery_confirm_once() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER coexistence_signup_discovery_confirm_once BEFORE UPDATE OF confirmed_at
  ON public.coexistence_signup_attempts FOR EACH ROW
  WHEN (OLD.confirmed_at IS NOT NULL AND NEW.confirmed_at IS NOT NULL)
  EXECUTE FUNCTION public.coexistence_signup_discovery_confirm_once();

-- SQL075 invokes the fence inside the same transaction as verify/confirm, with local rows already locked.
ALTER FUNCTION public.coexistence_signup_negative_fence(uuid,text,text) RENAME TO coexistence_signup_negative_fence_before_085;
CREATE FUNCTION public.coexistence_signup_negative_fence(p_attempt_id uuid,
  p_candidate_phone text DEFAULT NULL,p_candidate_waba text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d public.coexistence_signup_discovery_issues; t public.coexistence_signup_attempts;
  o public.connection_operations; phone text; waba text; keys text[]; k text;
BEGIN
  SELECT * INTO d FROM public.coexistence_signup_discovery_issues WHERE attempt_id=p_attempt_id;
  IF NOT FOUND THEN RETURN public.coexistence_signup_negative_fence_before_085(p_attempt_id,p_candidate_phone,p_candidate_waba); END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE lock_not_available; END IF;
  SELECT * INTO STRICT t FROM public.coexistence_signup_attempts WHERE id=p_attempt_id;
  SELECT * INTO STRICT o FROM public.connection_operations WHERE id=t.operation_id;
  IF o.state IN ('completed','cancelled') THEN
    RETURN public.coexistence_signup_negative_fence_before_085(p_attempt_id,p_candidate_phone,p_candidate_waba);
  END IF;
  IF ROW(o.actor_id,o.original_account_id,o.account_id,o.expected_revision,t.session_id,t.app_id,t.login_config_id,t.intended_phone)
    IS DISTINCT FROM ROW(d.actor_id,d.account_id,d.account_id,d.connection_revision,d.session_id,d.app_id,d.login_config_id,d.intended_phone)
    OR o.kind<>'onboarding' OR o.expected_config_id IS NOT NULL OR o.expected_generation IS NOT NULL
    OR (p_candidate_phone IS NULL)<>(p_candidate_waba IS NULL) THEN RETURN true; END IF;

  IF t.preview IS NULL THEN
    IF o.phone_number_id IS NOT NULL OR o.waba_id IS NOT NULL OR o.resource_keys<>'{}'
      OR EXISTS(SELECT 1 FROM public.connection_operation_resources r WHERE r.operation_id=o.id) THEN RETURN true; END IF;
  ELSIF p_candidate_phone IS NOT NULL
    AND ROW(p_candidate_phone,p_candidate_waba) IS DISTINCT FROM ROW(o.phone_number_id,o.waba_id) THEN RETURN true;
  END IF;
  phone:=coalesce(p_candidate_phone,o.phone_number_id);
  waba:=coalesce(p_candidate_waba,o.waba_id);
  IF waba IS NULL AND phone IS NULL AND t.preview IS NULL THEN RETURN false; END IF;
  IF (phone COLLATE "C" ~ '^[1-9][0-9]{0,31}$') IS NOT TRUE OR (waba COLLATE "C" ~ '^[1-9][0-9]{0,31}$') IS NOT TRUE
    OR phone=waba OR phone IN (d.app_id,d.login_config_id) OR waba IN (d.app_id,d.login_config_id) THEN RETURN true; END IF;
  keys:=ARRAY['phone:'||phone,'waba:'||waba];
  IF t.preview IS NOT NULL AND (o.resource_keys IS DISTINCT FROM keys
    OR ROW(t.preview->>'phone_number_id',t.preview->>'waba_id',t.preview->>'normalized_phone_number')
      IS DISTINCT FROM ROW(phone,waba,d.intended_phone)
    OR ARRAY(SELECT r.resource_key FROM public.connection_operation_resources r WHERE r.operation_id=o.id ORDER BY r.resource_key)
      IS DISTINCT FROM keys) THEN RETURN true; END IF;

  FOREACH k IN ARRAY keys LOOP
    IF NOT pg_try_advisory_xact_lock(hashtextextended('connection-operation:'||k,0)) THEN RAISE lock_not_available; END IF;
  END LOOP;
  IF public.coexistence_receiver_veto_locked(d.app_id,ARRAY[waba])
    OR EXISTS(SELECT 1 FROM public.coexistence_negative_evidence e WHERE e.app_id=d.app_id AND e.waba_id=waba) THEN
    -- Unbound candidates can deny a step, but cannot record a durable stop against this attempt.
    IF t.preview IS NOT NULL THEN
      UPDATE public.coexistence_signup_attempts SET access_token=NULL,reason=coalesce(reason,'verification_failed') WHERE id=t.id;
      UPDATE public.connection_operations SET state='blocked' WHERE id=o.id AND state='active';
    END IF;
    RETURN true;
  END IF;
  RETURN EXISTS(SELECT 1 FROM public.coexistence_signup_invitation_issues i WHERE i.waba_id=waba OR i.phone_number_id=phone)
    OR EXISTS(SELECT 1 FROM public.whatsapp_config c WHERE c.account_id=d.account_id
      OR public.connection_operation_resource_id(c.waba_id)=waba OR public.connection_operation_resource_id(c.phone_number_id)=phone)
    OR EXISTS(SELECT 1 FROM public.connection_operation_resources r WHERE r.resource_key=ANY(keys) AND r.operation_id<>o.id)
    OR EXISTS(SELECT 1 FROM public.connection_operations x WHERE x.id<>o.id AND x.state IN ('reserved','active','blocked','completed')
      AND (x.resource_keys && keys OR x.waba_id=waba OR x.phone_number_id=phone))
    OR EXISTS(SELECT 1 FROM public.coexistence_pilot_bindings b WHERE b.account_id=d.account_id OR b.waba_id=waba OR b.phone_number_id=phone);
END $$;
ALTER FUNCTION public.coexistence_signup_negative_fence(uuid,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.coexistence_signup_negative_fence(uuid,text,text),public.coexistence_signup_negative_fence_before_085(uuid,text,text)
  FROM PUBLIC,anon,authenticated,service_role;

-- The SQL077 consent receipt must use the discovery issue's private intent ID; other lanes are unchanged.
ALTER FUNCTION public.coexistence_history_intent_record(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,boolean,boolean)
  RENAME TO coexistence_history_intent_record_before_085;
CREATE FUNCTION public.coexistence_history_intent_record(p_actor_id uuid,p_account_id uuid,p_session_id uuid,
  p_attempt_id uuid,p_request_id uuid,p_expected_revision uuid,p_expected_config_id uuid,p_expected_generation uuid,
  p_app_id text,p_waba_id text,p_phone_number_id text,p_consent_version text,p_history boolean,p_contacts boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.coexistence_signup_discovery_issues d WHERE d.attempt_id=p_attempt_id
    AND ROW(d.actor_id,d.account_id,d.session_id,d.intent_id,d.connection_revision,d.app_id)
      IS DISTINCT FROM ROW(p_actor_id,p_account_id,p_session_id,p_request_id,p_expected_revision,p_app_id)) THEN
    RETURN '{"status":"forbidden"}';
  END IF;
  RETURN public.coexistence_history_intent_record_before_085(p_actor_id,p_account_id,p_session_id,p_attempt_id,p_request_id,
    p_expected_revision,p_expected_config_id,p_expected_generation,p_app_id,p_waba_id,p_phone_number_id,p_consent_version,p_history,p_contacts);
END $$;
ALTER FUNCTION public.coexistence_history_intent_record(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,boolean,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.coexistence_history_intent_record(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,boolean,boolean),
  public.coexistence_history_intent_record_before_085(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,boolean,boolean)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.coexistence_history_intent_record(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,boolean,boolean)
  TO service_role;
