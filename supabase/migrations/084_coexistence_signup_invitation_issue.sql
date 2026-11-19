-- Operator issuance only. Hand the private result to host memory out of band, after confirmed commit.
-- A lost result is not recoverable: even an expired or cancelled attempt leaves its receipt spent.
CREATE TABLE public.coexistence_signup_invitation_issues (
  attempt_id uuid PRIMARY KEY,
  account_id uuid NOT NULL UNIQUE,
  actor_id uuid NOT NULL,
  session_id uuid NOT NULL,
  connection_revision uuid NOT NULL,
  app_id text COLLATE "C" NOT NULL CHECK (app_id ~ '^[1-9][0-9]{0,31}$'),
  login_config_id text COLLATE "C" NOT NULL CHECK (login_config_id ~ '^[1-9][0-9]{0,31}$'),
  waba_id text COLLATE "C" NOT NULL UNIQUE CHECK (waba_id ~ '^[1-9][0-9]{0,31}$'),
  phone_number_id text COLLATE "C" NOT NULL UNIQUE CHECK (phone_number_id ~ '^[1-9][0-9]{0,31}$'),
  intended_phone text COLLATE "C" NOT NULL UNIQUE CHECK (intended_phone ~ '^\+[1-9][0-9]{7,14}$'),
  intent_id uuid NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (app_id NOT IN (login_config_id,waba_id,phone_number_id)
    AND login_config_id NOT IN (waba_id,phone_number_id) AND waba_id<>phone_number_id)
);
ALTER TABLE public.coexistence_signup_invitation_issues OWNER TO postgres;
ALTER TABLE public.coexistence_signup_invitation_issues ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.coexistence_signup_invitation_issues FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.coexistence_signup_invitation_issue_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'coexistence_signup_invitation_issue_immutable' USING ERRCODE='23514';
END $$;
ALTER FUNCTION public.coexistence_signup_invitation_issue_immutable() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.coexistence_signup_invitation_issue_immutable() FROM PUBLIC,anon,authenticated,service_role;
-- No cascades from the account, session or attempt can erase the sticky receipt.
CREATE TRIGGER coexistence_signup_invitation_issue_immutable BEFORE UPDATE OR DELETE
  ON public.coexistence_signup_invitation_issues FOR EACH ROW
  EXECUTE FUNCTION public.coexistence_signup_invitation_issue_immutable();
CREATE TRIGGER coexistence_signup_invitation_issue_no_truncate BEFORE TRUNCATE
  ON public.coexistence_signup_invitation_issues FOR EACH STATEMENT
  EXECUTE FUNCTION public.coexistence_signup_invitation_issue_immutable();

CREATE FUNCTION public.coexistence_signup_invitation_issue(p_actor_id uuid,p_session_id uuid,p_account_id uuid,
  p_expected_revision uuid,p_app_id text,p_login_config_id text,p_waba_id text,p_phone_id text,
  p_intended_phone text,p_approval text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp
  SET lock_timeout='250ms' AS $$
DECLARE denied CONSTANT jsonb:='{"status":"denied"}';
  keys text[]; k text; nonce uuid; nonce_hash text; request_id uuid; intent_id uuid;
  prepared jsonb; attempt_id uuid;
BEGIN
  IF current_user<>'postgres' OR current_setting('transaction_isolation')<>'read committed'
    OR p_approval COLLATE "C" IS DISTINCT FROM 'private-owner-signup-v1'
    OR p_actor_id IS NULL OR p_session_id IS NULL OR p_account_id IS NULL OR p_expected_revision IS NULL
    OR (p_app_id COLLATE "C" ~ '^[1-9][0-9]{0,31}$') IS NOT TRUE
    OR (p_login_config_id COLLATE "C" ~ '^[1-9][0-9]{0,31}$') IS NOT TRUE
    OR (p_waba_id COLLATE "C" ~ '^[1-9][0-9]{0,31}$') IS NOT TRUE
    OR (p_phone_id COLLATE "C" ~ '^[1-9][0-9]{0,31}$') IS NOT TRUE
    OR p_app_id IN (p_login_config_id,p_waba_id,p_phone_id)
    OR p_login_config_id IN (p_waba_id,p_phone_id) OR p_waba_id=p_phone_id
    OR (p_intended_phone COLLATE "C" ~ '^\+[1-9][0-9]{7,14}$') IS NOT TRUE
    OR NOT public.coexistence_signup_owner(p_actor_id,p_account_id,p_session_id) THEN RETURN denied; END IF;

  PERFORM public.coexistence_signup_recovery_lock_actor(p_actor_id,p_account_id,p_session_id);
  IF NOT public.connection_operation_authorized(p_actor_id,p_account_id,'onboarding')
    OR NOT EXISTS(SELECT 1 FROM public.accounts a WHERE a.id=p_account_id AND a.connection_revision=p_expected_revision)
    OR EXISTS(SELECT 1 FROM public.whatsapp_config c WHERE c.account_id=p_account_id)
    OR EXISTS(SELECT 1 FROM public.connection_operations o WHERE o.original_account_id=p_account_id OR o.account_id=p_account_id)
    THEN RAISE SQLSTATE 'P8401'; END IF;

  -- Read collision and stop evidence after the SQL075 resource locks, then the SQL078 scope lock.
  keys:=ARRAY['phone:'||p_phone_id,'waba:'||p_waba_id];
  FOREACH k IN ARRAY keys LOOP
    IF NOT pg_try_advisory_xact_lock(hashtextextended('connection-operation:'||k,0)) THEN RAISE lock_not_available; END IF;
  END LOOP;
  IF public.coexistence_receiver_veto_locked(p_app_id,ARRAY[p_waba_id]) THEN RAISE SQLSTATE 'P8401'; END IF;
  IF EXISTS(SELECT 1 FROM public.coexistence_signup_invitation_issues i WHERE i.account_id=p_account_id
      OR i.waba_id=p_waba_id OR i.phone_number_id=p_phone_id OR i.intended_phone=p_intended_phone)
    OR EXISTS(SELECT 1 FROM public.whatsapp_config c WHERE public.connection_operation_resource_id(c.waba_id)=p_waba_id
      OR public.connection_operation_resource_id(c.phone_number_id)=p_phone_id)
    OR EXISTS(SELECT 1 FROM public.connection_operation_resources r WHERE r.resource_key=ANY(keys))
    OR EXISTS(SELECT 1 FROM public.connection_operations o WHERE o.state IN ('reserved','active','blocked','completed')
      AND (o.resource_keys && keys OR o.waba_id=p_waba_id OR o.phone_number_id=p_phone_id))
    -- An unresolved older signup may know only the intended number, not the provider IDs.
    OR EXISTS(SELECT 1 FROM public.coexistence_signup_attempts t JOIN public.connection_operations o ON o.id=t.operation_id
      WHERE t.intended_phone=p_intended_phone AND o.state IN ('reserved','active','blocked','completed'))
    OR EXISTS(SELECT 1 FROM public.coexistence_pilot_bindings b WHERE b.account_id=p_account_id
      OR b.waba_id=p_waba_id OR b.phone_number_id=p_phone_id)
    OR EXISTS(SELECT 1 FROM public.coexistence_negative_evidence e WHERE e.app_id=p_app_id AND e.waba_id=p_waba_id)
    THEN RAISE SQLSTATE 'P8401'; END IF;

  nonce:=gen_random_uuid();
  nonce_hash:=encode(sha256(convert_to(nonce::text,'UTF8')),'hex');
  request_id:=gen_random_uuid();
  -- SQL077 records consent only after owner confirmation; issuance allocates its future request ID.
  intent_id:=gen_random_uuid();
  prepared:=public.coexistence_signup_prepare(p_actor_id,p_account_id,p_session_id,request_id,nonce_hash,
    p_app_id,p_login_config_id,p_expected_revision,NULL,NULL,p_intended_phone);
  IF prepared->>'status' IS DISTINCT FROM 'prepared' THEN RAISE SQLSTATE 'P8401'; END IF;
  attempt_id:=(prepared->>'attempt_id')::uuid;
  IF ((prepared->>'lease_until')::timestamptz>clock_timestamp()) IS NOT TRUE
    OR NOT EXISTS(SELECT 1 FROM auth.sessions s WHERE s.id=p_session_id AND s.user_id=p_actor_id
      AND (s.not_after IS NULL OR s.not_after>clock_timestamp())) THEN RAISE SQLSTATE 'P8401'; END IF;

  INSERT INTO public.coexistence_signup_invitation_issues(attempt_id,account_id,actor_id,session_id,connection_revision,
    app_id,login_config_id,waba_id,phone_number_id,intended_phone,intent_id)
  VALUES(attempt_id,p_account_id,p_actor_id,p_session_id,p_expected_revision,
    p_app_id,p_login_config_id,p_waba_id,p_phone_id,p_intended_phone,intent_id);

  RETURN jsonb_build_object('status','issued','invitation',jsonb_build_object(
    'actorId',p_actor_id,'sessionId',p_session_id,'accountId',p_account_id,'attemptId',attempt_id,'nonce',nonce,
    'appId',p_app_id,'loginConfigId',p_login_config_id,'wabaId',p_waba_id,'phoneId',p_phone_id,
    'intendedPhone',p_intended_phone,'intentId',intent_id,'revision',p_expected_revision));
-- The exception block rolls back the prepare, receipt and any locks taken here on denial.
EXCEPTION WHEN OTHERS THEN RETURN denied;
END $$;
ALTER FUNCTION public.coexistence_signup_invitation_issue(uuid,uuid,uuid,uuid,text,text,text,text,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.coexistence_signup_invitation_issue(uuid,uuid,uuid,uuid,text,text,text,text,text,text)
  FROM PUBLIC,anon,authenticated,service_role;

-- SQL074 leaves operation resources empty until verification. Use the receipt pins for fencing,
-- not as claims or provider observations. Unissued attempts still use the SQL078 implementation.
ALTER FUNCTION public.coexistence_signup_negative_fence(uuid,text,text)
  RENAME TO coexistence_signup_negative_fence_before_084;
CREATE FUNCTION public.coexistence_signup_negative_fence(p_attempt_id uuid,
  p_candidate_phone text DEFAULT NULL,p_candidate_waba text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE i public.coexistence_signup_invitation_issues; t public.coexistence_signup_attempts;
  o public.connection_operations; keys text[]; k text;
BEGIN
  SELECT * INTO i FROM public.coexistence_signup_invitation_issues WHERE attempt_id=p_attempt_id;
  IF NOT FOUND THEN
    RETURN public.coexistence_signup_negative_fence_before_084(p_attempt_id,p_candidate_phone,p_candidate_waba);
  END IF;
  SELECT * INTO STRICT t FROM public.coexistence_signup_attempts WHERE id=p_attempt_id;
  SELECT * INTO STRICT o FROM public.connection_operations WHERE id=t.operation_id;
  IF o.state IN ('completed','cancelled') THEN
    RETURN public.coexistence_signup_negative_fence_before_084(p_attempt_id,p_candidate_phone,p_candidate_waba);
  END IF;

  keys:=ARRAY['phone:'||i.phone_number_id,'waba:'||i.waba_id];
  IF ROW(o.actor_id,o.original_account_id,o.account_id,o.expected_revision,t.session_id,t.app_id,t.login_config_id,t.intended_phone)
    IS DISTINCT FROM ROW(i.actor_id,i.account_id,i.account_id,i.connection_revision,i.session_id,i.app_id,i.login_config_id,i.intended_phone)
    OR NOT (o.resource_keys <@ keys)
    OR coalesce(o.phone_number_id,i.phone_number_id)<>i.phone_number_id OR coalesce(o.waba_id,i.waba_id)<>i.waba_id
    OR coalesce(p_candidate_phone,i.phone_number_id)<>i.phone_number_id OR coalesce(p_candidate_waba,i.waba_id)<>i.waba_id
    THEN RETURN true; END IF;

  -- Callers already hold the local operation/attempt rows. Never lock another tenant's rows here.
  FOREACH k IN ARRAY keys LOOP
    IF NOT pg_try_advisory_xact_lock(hashtextextended('connection-operation:'||k,0)) THEN RAISE lock_not_available; END IF;
  END LOOP;
  IF public.coexistence_receiver_veto_locked(i.app_id,ARRAY[i.waba_id])
    OR EXISTS(SELECT 1 FROM public.coexistence_negative_evidence e WHERE e.app_id=i.app_id AND e.waba_id=i.waba_id) THEN
    -- As in SQL078, status may record a genuine stop, but it never fabricates launch or claims.
    UPDATE public.coexistence_signup_attempts SET access_token=NULL,reason=coalesce(reason,'verification_failed')
      WHERE id=t.id AND (access_token IS NOT NULL OR reason IS NULL);
    UPDATE public.connection_operations SET state='blocked' WHERE id=o.id AND state='active';
    RETURN true;
  END IF;

  -- A caller hint or a foreign collision denies dispatch; status must not create a durable hold for it.
  IF EXISTS(SELECT 1 FROM public.whatsapp_config c WHERE c.account_id=i.account_id
      OR public.connection_operation_resource_id(c.waba_id)=i.waba_id
      OR public.connection_operation_resource_id(c.phone_number_id)=i.phone_number_id)
    OR EXISTS(SELECT 1 FROM public.connection_operation_resources r WHERE r.resource_key=ANY(keys) AND r.operation_id<>o.id)
    OR EXISTS(SELECT 1 FROM public.connection_operations x WHERE x.id<>o.id AND x.state IN ('reserved','active','blocked','completed')
      AND (x.resource_keys && keys OR x.waba_id=i.waba_id OR x.phone_number_id=i.phone_number_id))
    OR EXISTS(SELECT 1 FROM public.coexistence_pilot_bindings b WHERE b.account_id=i.account_id
      OR b.waba_id=i.waba_id OR b.phone_number_id=i.phone_number_id) THEN RETURN true; END IF;
  RETURN public.coexistence_signup_negative_fence_before_084(p_attempt_id,p_candidate_phone,p_candidate_waba);
END $$;
ALTER FUNCTION public.coexistence_signup_negative_fence(uuid,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.coexistence_signup_negative_fence(uuid,text,text),
  public.coexistence_signup_negative_fence_before_084(uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;
