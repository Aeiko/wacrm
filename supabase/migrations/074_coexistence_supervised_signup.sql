-- Local supervised protocol only. No activation, provider mutation or release endpoint.
-- Unknown targets are NULL, not fabricated reservations. SQL073 remains immutable.
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='public.connection_operations'::regclass
    AND contype='c' AND (pg_get_constraintdef(oid) LIKE '%manual_save%'
      OR pg_get_constraintdef(oid) LIKE '%steps - ARRAY%') LOOP
    EXECUTE format('ALTER TABLE public.connection_operations DROP CONSTRAINT %I',c.conname);
  END LOOP;
END $$;
ALTER TABLE public.connection_operations ADD CONSTRAINT connection_operations_signup_kind_check CHECK (
  (kind='manual_save' AND phone_number_id IS NOT NULL)
  OR (kind='manual_delete' AND phone_number_id IS NULL AND waba_id IS NULL AND NOT register_planned AND NOT subscribe_planned)
  OR (kind='onboarding' AND (phone_number_id IS NULL)=(waba_id IS NULL) AND NOT register_planned AND NOT subscribe_planned));
ALTER TABLE public.connection_operations ADD CONSTRAINT connection_operations_signup_steps_check CHECK (
  jsonb_typeof(steps)='object' AND steps-ARRAY['register','subscribe','launch','exchange']::text[]='{}'::jsonb
  AND NOT jsonb_path_exists(steps,'$.* ? (@ == null)')
  AND (NOT steps ? 'register' OR steps->>'register' IN ('started','success','rejected','unknown'))
  AND (NOT steps ? 'subscribe' OR steps->>'subscribe' IN ('started','success','rejected','unknown'))
  AND (NOT steps ? 'launch' OR (kind='onboarding' AND steps->>'launch'='started'))
  AND (NOT steps ? 'exchange' OR (kind='onboarding' AND steps->>'launch'='started' AND steps->>'exchange'='started')));

CREATE TABLE public.coexistence_signup_attempts (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT coexistence_signup_attempts_pkey PRIMARY KEY,
  operation_id uuid NOT NULL CONSTRAINT coexistence_signup_operation_unique UNIQUE
    CONSTRAINT coexistence_signup_operation_fkey REFERENCES public.connection_operations(id) ON DELETE RESTRICT,
  session_id uuid NOT NULL, -- Deliberately not cascading from auth.sessions: logout cannot erase a fence.
  nonce_hash text NOT NULL CONSTRAINT coexistence_signup_nonce_check CHECK (nonce_hash ~ '^[a-f0-9]{64}$'),
  app_id text NOT NULL CONSTRAINT coexistence_signup_app_check CHECK (app_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  login_config_id text NOT NULL CONSTRAINT coexistence_signup_login_check CHECK (login_config_id ~ '^[A-Za-z0-9_-]{1,128}$'),
  intended_phone text NOT NULL CONSTRAINT coexistence_signup_phone_check CHECK (intended_phone ~ '^\+[1-9][0-9]{7,14}$'),
  code_hash text CONSTRAINT coexistence_signup_code_unique UNIQUE
    CONSTRAINT coexistence_signup_code_check CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  -- 32768 JS UTF16 units * 3 UTF8 bytes/unit * 2 hex chars + 58 GCM framing chars.
  access_token text CONSTRAINT coexistence_signup_ciphertext_check CHECK (length(access_token)<=196666
    AND access_token ~ '^[a-f0-9]{24}:([a-f0-9]{2})+:[a-f0-9]{32}$'),
  token_hash text CONSTRAINT coexistence_signup_token_hash_check CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  token_deadline timestamptz,
  token_expires_at timestamptz,
  preview jsonb,
  confirmed_at timestamptz,
  reason text CONSTRAINT coexistence_signup_reason_check CHECK (reason IN (
    'exchange_unknown','verification_failed','selection_conflict','provider_cancelled','callback_invalid')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT coexistence_signup_preview_check CHECK ((preview IS NULL)=(token_expires_at IS NULL)),
  CONSTRAINT coexistence_signup_token_deadline_check CHECK (access_token IS NULL OR token_deadline IS NOT NULL)
);
ALTER TABLE public.coexistence_signup_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.coexistence_signup_attempts FROM PUBLIC,anon,authenticated,service_role;

-- Admission expires absolutely one hour after exchange authorization, even before verification.
-- Actual lazy scrub preserves fingerprints/audit/claims. Before live launch, schedule this private
-- cleanup periodically as well; this local slice exposes no scheduler or generic release.
CREATE FUNCTION public.coexistence_signup_scrub()
RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  UPDATE coexistence_signup_attempts SET access_token=NULL WHERE id IN (
    SELECT id FROM coexistence_signup_attempts WHERE access_token IS NOT NULL
      AND (token_deadline<=clock_timestamp() OR token_expires_at<=clock_timestamp())
    ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED);
END $$;
CREATE FUNCTION public.coexistence_signup_owner(p_actor_id uuid,p_account_id uuid,p_session_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT connection_operation_authorized(p_actor_id,p_account_id,'onboarding') AND EXISTS(
    SELECT 1 FROM auth.sessions WHERE id=p_session_id AND user_id=p_actor_id
      AND (not_after IS NULL OR not_after>statement_timestamp()))
$$;
-- Exact original proof is sufficient only for late observations; fresh actions lock current authority.
CREATE FUNCTION public.coexistence_signup_lock(p_actor_id uuid,p_account_id uuid,p_session_id uuid,
  p_attempt_id uuid,p_nonce_hash text,p_fresh boolean)
RETURNS public.coexistence_signup_attempts LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE t coexistence_signup_attempts%ROWTYPE; o connection_operations%ROWTYPE;
BEGIN
  SELECT * INTO t FROM coexistence_signup_attempts WHERE id=p_attempt_id;
  SELECT * INTO o FROM connection_operations WHERE id=t.operation_id;
  IF t.id IS NULL OR o.actor_id IS DISTINCT FROM p_actor_id OR o.original_account_id IS DISTINCT FROM p_account_id
    OR t.session_id IS DISTINCT FROM p_session_id OR t.nonce_hash IS DISTINCT FROM p_nonce_hash THEN
    RAISE EXCEPTION USING ERRCODE='P7401';
  END IF;
  o:=connection_operation_lock(p_actor_id,o.id,o.token);
  SELECT * INTO t FROM coexistence_signup_attempts WHERE id=p_attempt_id FOR UPDATE NOWAIT;
  IF p_fresh THEN
    PERFORM 1 FROM auth.sessions WHERE id=p_session_id FOR SHARE NOWAIT;
    IF NOT coexistence_signup_owner(p_actor_id,p_account_id,p_session_id) THEN RAISE EXCEPTION USING ERRCODE='P7401'; END IF;
    IF NOT connection_operation_binding(o) THEN RAISE EXCEPTION USING ERRCODE='P7402'; END IF;
  END IF;
  RETURN t;
END $$;

CREATE FUNCTION public.coexistence_signup_prepare(p_actor_id uuid,p_account_id uuid,p_session_id uuid,
  p_request_id uuid,p_nonce_hash text,p_app_id text,p_login_config_id text,p_expected_revision uuid,
  p_expected_config_id uuid,p_expected_generation uuid,p_intended_phone text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a accounts%ROWTYPE; c whatsapp_config%ROWTYPE; o connection_operations%ROWTYPE;
  t coexistence_signup_attempts%ROWTYPE; keys text[]; k text;
BEGIN
  IF p_request_id IS NULL OR p_expected_revision IS NULL OR p_nonce_hash IS NULL OR p_nonce_hash !~ '^[a-f0-9]{64}$'
    OR p_app_id IS NULL OR p_app_id !~ '^[A-Za-z0-9_-]{1,128}$'
    OR p_login_config_id IS NULL OR p_login_config_id !~ '^[A-Za-z0-9_-]{1,128}$'
    OR p_intended_phone IS NULL OR p_intended_phone !~ '^\+[1-9][0-9]{7,14}$'
    OR (p_expected_config_id IS NULL)<>(p_expected_generation IS NULL) THEN RETURN jsonb_build_object('status','invalid'); END IF;
  SELECT * INTO a FROM accounts WHERE id=p_account_id FOR NO KEY UPDATE NOWAIT;
  PERFORM 1 FROM profiles WHERE user_id=p_actor_id FOR SHARE NOWAIT;
  PERFORM 1 FROM auth.sessions WHERE id=p_session_id FOR SHARE NOWAIT;
  IF NOT coexistence_signup_owner(p_actor_id,p_account_id,p_session_id) THEN RETURN jsonb_build_object('status','forbidden'); END IF;
  SELECT * INTO c FROM whatsapp_config WHERE account_id=p_account_id FOR UPDATE NOWAIT;
  IF a.connection_revision IS DISTINCT FROM p_expected_revision OR c.id IS DISTINCT FROM p_expected_config_id
    OR c.coexistence_generation IS DISTINCT FROM p_expected_generation THEN RETURN jsonb_build_object('status','conflict'); END IF;
  SELECT * INTO o FROM connection_operations WHERE original_account_id=p_account_id AND request_id=p_request_id FOR UPDATE NOWAIT;
  IF FOUND THEN
    SELECT * INTO t FROM coexistence_signup_attempts WHERE operation_id=o.id;
    IF t.id IS NULL OR ROW(o.actor_id,t.session_id,t.nonce_hash,t.app_id,t.login_config_id,t.intended_phone,
      o.expected_revision,o.expected_config_id,o.expected_generation) IS DISTINCT FROM ROW(p_actor_id,p_session_id,
      p_nonce_hash,p_app_id,p_login_config_id,p_intended_phone,p_expected_revision,p_expected_config_id,p_expected_generation) THEN
      RETURN jsonb_build_object('status','conflict'); END IF;
    IF o.state<>'reserved' THEN RETURN jsonb_build_object('status',CASE WHEN o.state='cancelled' THEN 'cancelled' ELSE 'blocked' END); END IF;
    IF o.lease_until<=clock_timestamp() THEN RETURN jsonb_build_object('status','expired'); END IF;
    RETURN jsonb_build_object('status','prepared','attempt_id',t.id,'lease_until',o.lease_until);
  END IF;
  PERFORM connection_operation_retire_unstarted(p_account_id);
  IF EXISTS(SELECT 1 FROM connection_operations WHERE account_id=p_account_id AND state IN ('reserved','active','blocked')) THEN
    RETURN jsonb_build_object('status','blocked'); END IF;
  SELECT ARRAY(SELECT DISTINCT x FROM unnest(ARRAY['phone:'||connection_operation_resource_id(c.phone_number_id),
    'waba:'||connection_operation_resource_id(c.waba_id)]) x WHERE x IS NOT NULL ORDER BY x) INTO keys;
  FOREACH k IN ARRAY keys LOOP
    IF NOT pg_try_advisory_xact_lock(hashtextextended('connection-operation:'||k,0)) THEN RAISE lock_not_available; END IF;
  END LOOP;
  -- Never cancel another account's reservation, even if its lease appears expired.
  IF EXISTS(SELECT 1 FROM connection_operation_resources WHERE resource_key=ANY(keys)) THEN RAISE lock_not_available; END IF;
  INSERT INTO connection_operations(account_id,original_account_id,actor_id,request_id,kind,expected_revision,
    expected_config_id,expected_generation,register_planned,subscribe_planned,resource_keys)
    VALUES(p_account_id,p_account_id,p_actor_id,p_request_id,'onboarding',p_expected_revision,
      p_expected_config_id,p_expected_generation,false,false,keys) RETURNING * INTO o;
  INSERT INTO connection_operation_resources SELECT unnest(keys),o.id;
  IF NOT connection_operation_binding(o) THEN RAISE EXCEPTION USING ERRCODE='P7402'; END IF;
  INSERT INTO coexistence_signup_attempts(operation_id,session_id,nonce_hash,app_id,login_config_id,intended_phone)
    VALUES(o.id,p_session_id,p_nonce_hash,p_app_id,p_login_config_id,p_intended_phone) RETURNING * INTO t;
  PERFORM coexistence_signup_scrub();
  RETURN jsonb_build_object('status','prepared','attempt_id',t.id,'lease_until',o.lease_until);
EXCEPTION WHEN lock_not_available OR unique_violation THEN RETURN jsonb_build_object('status','busy');
  WHEN SQLSTATE 'P7402' THEN RETURN jsonb_build_object('status','conflict');
END $$;

CREATE FUNCTION public.coexistence_signup_launch(p_actor_id uuid,p_account_id uuid,p_session_id uuid,p_attempt_id uuid,p_nonce_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t coexistence_signup_attempts%ROWTYPE; o connection_operations%ROWTYPE;
BEGIN
  t:=coexistence_signup_lock(p_actor_id,p_account_id,p_session_id,p_attempt_id,p_nonce_hash,true);
  SELECT * INTO o FROM connection_operations WHERE id=t.operation_id;
  IF o.steps ? 'launch' THEN RETURN jsonb_build_object('status','duplicate','dispatch',false); END IF;
  IF o.state<>'reserved' OR t.reason IS NOT NULL THEN RETURN jsonb_build_object('status','blocked'); END IF;
  IF o.lease_until<=clock_timestamp() THEN RETURN jsonb_build_object('status','expired'); END IF;
  UPDATE connection_operations SET state='active',steps=jsonb_build_object('launch','started') WHERE id=o.id;
  RETURN jsonb_build_object('status','started','dispatch',true,'app_id',t.app_id,'login_config_id',t.login_config_id);
EXCEPTION WHEN lock_not_available THEN RETURN jsonb_build_object('status','busy');
  WHEN SQLSTATE 'P7401' THEN RETURN jsonb_build_object('status','forbidden');
  WHEN SQLSTATE 'P7402' THEN RETURN jsonb_build_object('status','conflict');
END $$;

CREATE FUNCTION public.coexistence_signup_exchange_start(p_actor_id uuid,p_account_id uuid,p_session_id uuid,
  p_attempt_id uuid,p_nonce_hash text,p_code_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t coexistence_signup_attempts%ROWTYPE; o connection_operations%ROWTYPE;
BEGIN
  t:=coexistence_signup_lock(p_actor_id,p_account_id,p_session_id,p_attempt_id,p_nonce_hash,true);
  IF p_code_hash IS NULL OR p_code_hash !~ '^[a-f0-9]{64}$' THEN RETURN jsonb_build_object('status','invalid'); END IF;
  SELECT * INTO o FROM connection_operations WHERE id=t.operation_id;
  IF t.code_hash IS NOT NULL THEN RETURN jsonb_build_object('status','duplicate','dispatch',false); END IF;
  IF o.state<>'active' OR o.steps->>'launch' IS DISTINCT FROM 'started' OR t.reason IS NOT NULL THEN RETURN jsonb_build_object('status','blocked'); END IF;
  UPDATE coexistence_signup_attempts SET code_hash=p_code_hash,token_deadline=clock_timestamp()+interval '1 hour' WHERE id=t.id;
  UPDATE connection_operations SET steps=steps||jsonb_build_object('exchange','started') WHERE id=o.id;
  RETURN jsonb_build_object('status','started','dispatch',true,'app_id',t.app_id,'login_config_id',t.login_config_id);
EXCEPTION WHEN lock_not_available THEN RETURN jsonb_build_object('status','busy');
  WHEN unique_violation THEN RETURN jsonb_build_object('status','conflict');
  WHEN SQLSTATE 'P7401' THEN RETURN jsonb_build_object('status','forbidden');
  WHEN SQLSTATE 'P7402' THEN RETURN jsonb_build_object('status','conflict');
END $$;

CREATE FUNCTION public.coexistence_signup_store_token(p_actor_id uuid,p_account_id uuid,p_session_id uuid,
  p_attempt_id uuid,p_nonce_hash text,p_access_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t coexistence_signup_attempts%ROWTYPE;
BEGIN
  t:=coexistence_signup_lock(p_actor_id,p_account_id,p_session_id,p_attempt_id,p_nonce_hash,false);
  IF p_access_token IS NULL OR length(p_access_token)>196666 OR p_access_token !~ '^[a-f0-9]{24}:([a-f0-9]{2})+:[a-f0-9]{32}$' THEN
    RETURN jsonb_build_object('status','invalid'); END IF;
  IF t.code_hash IS NULL OR t.token_deadline<=clock_timestamp() OR t.token_expires_at<=clock_timestamp() THEN
    UPDATE coexistence_signup_attempts SET access_token=NULL WHERE id=t.id;
    RETURN jsonb_build_object('status','expired'); END IF;
  IF t.token_hash IS NOT NULL AND t.token_hash IS DISTINCT FROM encode(sha256(convert_to(p_access_token,'UTF8')),'hex') THEN
    RETURN jsonb_build_object('status','conflict'); END IF;
  UPDATE coexistence_signup_attempts SET token_hash=encode(sha256(convert_to(p_access_token,'UTF8')),'hex'),
    access_token=CASE WHEN reason IS NULL THEN p_access_token END WHERE id=t.id;
  RETURN jsonb_build_object('status','recorded');
EXCEPTION WHEN lock_not_available THEN RETURN jsonb_build_object('status','busy');
  WHEN SQLSTATE 'P7401' THEN RETURN jsonb_build_object('status','forbidden');
END $$;

CREATE FUNCTION public.coexistence_signup_token(p_actor_id uuid,p_account_id uuid,p_session_id uuid,p_attempt_id uuid,p_nonce_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t coexistence_signup_attempts%ROWTYPE; o connection_operations%ROWTYPE;
BEGIN
  t:=coexistence_signup_lock(p_actor_id,p_account_id,p_session_id,p_attempt_id,p_nonce_hash,true);
  SELECT * INTO o FROM connection_operations WHERE id=t.operation_id;
  IF t.access_token IS NULL OR t.token_deadline<=clock_timestamp() OR t.token_expires_at<=clock_timestamp() THEN
    UPDATE coexistence_signup_attempts SET access_token=NULL WHERE id=t.id;
    RETURN jsonb_build_object('status','expired'); END IF;
  IF o.state<>'active' OR t.reason IS NOT NULL THEN RETURN jsonb_build_object('status','blocked'); END IF;
  RETURN jsonb_build_object('status','token','access_token',t.access_token,'intended_phone',t.intended_phone,
    'app_id',t.app_id,'login_config_id',t.login_config_id);
EXCEPTION WHEN lock_not_available THEN RETURN jsonb_build_object('status','busy');
  WHEN SQLSTATE 'P7401' THEN RETURN jsonb_build_object('status','forbidden');
  WHEN SQLSTATE 'P7402' THEN RETURN jsonb_build_object('status','conflict');
END $$;

CREATE FUNCTION public.coexistence_signup_verify(p_actor_id uuid,p_account_id uuid,p_session_id uuid,p_attempt_id uuid,
  p_nonce_hash text,p_phone_number_id text,p_waba_id text,p_display_phone_number text,p_normalized_phone_number text,p_token_expires_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t coexistence_signup_attempts%ROWTYPE; o connection_operations%ROWTYPE; keys text[]; k text; candidate jsonb;
BEGIN
  t:=coexistence_signup_lock(p_actor_id,p_account_id,p_session_id,p_attempt_id,p_nonce_hash,true);
  SELECT * INTO o FROM connection_operations WHERE id=t.operation_id;
  IF p_phone_number_id IS NULL OR p_phone_number_id !~ '^[1-9][0-9]{0,31}$' OR p_waba_id IS NULL OR p_waba_id !~ '^[1-9][0-9]{0,31}$'
    OR p_normalized_phone_number IS DISTINCT FROM t.intended_phone OR p_display_phone_number IS NULL
    OR length(p_display_phone_number)>128 OR p_display_phone_number !~ '^\+?[0-9\s().-]+$' OR p_token_expires_at IS NULL
    OR NOT isfinite(p_token_expires_at) OR p_token_expires_at<=clock_timestamp() THEN RETURN jsonb_build_object('status','invalid'); END IF;
  IF o.state<>'active' OR t.reason IS NOT NULL OR t.access_token IS NULL OR t.token_deadline<=clock_timestamp()
    OR t.token_expires_at<=clock_timestamp() THEN RETURN jsonb_build_object('status','blocked'); END IF;
  candidate:=jsonb_build_object('phone_number_id',p_phone_number_id,'waba_id',p_waba_id,
    'display_phone_number',p_display_phone_number,'normalized_phone_number',p_normalized_phone_number);
  IF t.preview IS NOT NULL THEN
    IF t.preview=candidate AND t.token_expires_at=p_token_expires_at THEN RETURN jsonb_build_object('status','verified'); END IF;
    RETURN jsonb_build_object('status','conflict');
  END IF;
  IF EXISTS(SELECT 1 FROM whatsapp_config WHERE account_id<>p_account_id AND (
    connection_operation_resource_id(phone_number_id)=p_phone_number_id OR connection_operation_resource_id(waba_id)=p_waba_id)) THEN
    RETURN jsonb_build_object('status','conflict'); END IF;
  SELECT ARRAY(SELECT DISTINCT x FROM unnest(o.resource_keys||ARRAY['phone:'||p_phone_number_id,'waba:'||p_waba_id]) x ORDER BY x) INTO keys;
  FOREACH k IN ARRAY keys LOOP
    IF NOT pg_try_advisory_xact_lock(hashtextextended('connection-operation:'||k,0)) THEN RAISE lock_not_available; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM connection_operation_resources WHERE resource_key=ANY(keys) AND operation_id<>o.id) THEN
    RETURN jsonb_build_object('status','conflict'); END IF;
  INSERT INTO connection_operation_resources SELECT x,o.id FROM unnest(keys) x
    WHERE NOT EXISTS(SELECT 1 FROM connection_operation_resources WHERE resource_key=x AND operation_id=o.id);
  UPDATE connection_operations SET resource_keys=keys,phone_number_id=p_phone_number_id,waba_id=p_waba_id WHERE id=o.id RETURNING * INTO o;
  -- Locked recheck closes a previous holder finalizing after the initial binding read.
  IF NOT connection_operation_binding(o) THEN RAISE EXCEPTION USING ERRCODE='P7402'; END IF;
  UPDATE coexistence_signup_attempts SET preview=candidate,token_expires_at=p_token_expires_at WHERE id=t.id;
  RETURN jsonb_build_object('status','verified');
EXCEPTION WHEN lock_not_available OR unique_violation THEN RETURN jsonb_build_object('status','busy');
  WHEN SQLSTATE 'P7401' THEN RETURN jsonb_build_object('status','forbidden');
  WHEN SQLSTATE 'P7402' THEN RETURN jsonb_build_object('status','conflict');
END $$;

CREATE FUNCTION public.coexistence_signup_confirm(p_actor_id uuid,p_account_id uuid,p_session_id uuid,p_attempt_id uuid,p_nonce_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t coexistence_signup_attempts%ROWTYPE; o connection_operations%ROWTYPE;
BEGIN
  t:=coexistence_signup_lock(p_actor_id,p_account_id,p_session_id,p_attempt_id,p_nonce_hash,true);
  SELECT * INTO o FROM connection_operations WHERE id=t.operation_id;
  IF t.preview IS NULL OR t.reason IS NOT NULL OR o.state<>'active' OR t.access_token IS NULL
    OR t.token_expires_at<=clock_timestamp() OR t.token_deadline<=clock_timestamp() THEN RETURN jsonb_build_object('status','blocked'); END IF;
  UPDATE coexistence_signup_attempts SET confirmed_at=coalesce(confirmed_at,clock_timestamp()) WHERE id=t.id;
  RETURN jsonb_build_object('status','confirmed');
EXCEPTION WHEN lock_not_available THEN RETURN jsonb_build_object('status','busy');
  WHEN SQLSTATE 'P7401' THEN RETURN jsonb_build_object('status','forbidden');
  WHEN SQLSTATE 'P7402' THEN RETURN jsonb_build_object('status','conflict');
END $$;

CREATE FUNCTION public.coexistence_signup_review(p_actor_id uuid,p_account_id uuid,p_session_id uuid,p_attempt_id uuid,p_nonce_hash text,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t coexistence_signup_attempts%ROWTYPE; o connection_operations%ROWTYPE;
BEGIN
  t:=coexistence_signup_lock(p_actor_id,p_account_id,p_session_id,p_attempt_id,p_nonce_hash,false);
  IF p_reason IS NULL OR p_reason NOT IN ('exchange_unknown','verification_failed','selection_conflict','provider_cancelled','callback_invalid') THEN
    RETURN jsonb_build_object('status','invalid'); END IF;
  SELECT * INTO o FROM connection_operations WHERE id=t.operation_id;
  IF o.state NOT IN ('active','blocked') THEN RETURN jsonb_build_object('status','blocked'); END IF;
  UPDATE coexistence_signup_attempts SET reason=coalesce(reason,p_reason),access_token=NULL WHERE id=t.id;
  UPDATE connection_operations SET state='blocked' WHERE id=o.id;
  RETURN jsonb_build_object('status','recorded');
EXCEPTION WHEN lock_not_available THEN RETURN jsonb_build_object('status','busy');
  WHEN SQLSTATE 'P7401' THEN RETURN jsonb_build_object('status','forbidden');
END $$;

CREATE FUNCTION public.coexistence_signup_status(p_actor_id uuid,p_account_id uuid,p_session_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t coexistence_signup_attempts%ROWTYPE; o connection_operations%ROWTYPE; state text;
BEGIN
  PERFORM 1 FROM accounts WHERE id=p_account_id FOR NO KEY UPDATE NOWAIT;
  PERFORM 1 FROM profiles WHERE user_id=p_actor_id FOR SHARE NOWAIT;
  PERFORM 1 FROM auth.sessions WHERE id=p_session_id FOR SHARE NOWAIT;
  IF NOT coexistence_signup_owner(p_actor_id,p_account_id,p_session_id) THEN RETURN jsonb_build_object('status','forbidden'); END IF;
  SELECT x.* INTO t FROM coexistence_signup_attempts x JOIN connection_operations y ON y.id=x.operation_id
    WHERE y.original_account_id=p_account_id ORDER BY x.created_at DESC,x.id DESC LIMIT 1;
  IF t.id IS NULL THEN RETURN jsonb_build_object('status','ok','attempt',NULL); END IF;
  SELECT * INTO o FROM connection_operations WHERE id=t.operation_id;
  IF t.session_id IS DISTINCT FROM p_session_id THEN
    -- A different login cannot adopt work; provably unstarted expiry must still permit fresh admission.
    IF o.state='cancelled' OR (o.state='reserved' AND o.steps='{}'::jsonb AND o.lease_until<=clock_timestamp()) THEN
      RETURN jsonb_build_object('status','ok','attempt',NULL);
    END IF;
    RETURN jsonb_build_object('status','forbidden');
  END IF;
  PERFORM coexistence_signup_scrub();
  IF t.token_deadline<=clock_timestamp() OR t.token_expires_at<=clock_timestamp() THEN
    -- Scrub this row even when the bounded global batch did not reach it; expiry wins over preview/receipt.
    UPDATE coexistence_signup_attempts SET access_token=NULL WHERE id=t.id RETURNING * INTO t;
    t.reason:=coalesce(t.reason,'verification_failed');
  END IF;
  state:=CASE WHEN o.state='cancelled' OR (o.state='reserved' AND o.lease_until<=clock_timestamp()) THEN 'cancelled'
    WHEN o.state='blocked' OR t.reason IS NOT NULL THEN 'review_required' WHEN t.confirmed_at IS NOT NULL THEN 'confirmed'
    WHEN t.preview IS NOT NULL THEN 'verified' WHEN t.access_token IS NOT NULL THEN 'token_received'
    WHEN o.steps ? 'exchange' THEN 'exchanging' WHEN o.steps ? 'launch' THEN 'launch_possible' ELSE 'prepared' END;
  RETURN jsonb_build_object('status','ok','attempt',jsonb_build_object('id',t.id,'state',state,'intended_phone',t.intended_phone,
    'reason',t.reason,'preview',t.preview,'created_at',t.created_at,'lease_until',o.lease_until));
EXCEPTION WHEN lock_not_available THEN RETURN jsonb_build_object('status','busy');
END $$;

CREATE FUNCTION public.coexistence_signup_media_allowed(p_account_id uuid,p_config_id uuid,p_generation uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c whatsapp_config%ROWTYPE; keys text[]; k text;
BEGIN
  PERFORM 1 FROM accounts WHERE id=p_account_id FOR NO KEY UPDATE NOWAIT;
  SELECT * INTO c FROM whatsapp_config WHERE account_id=p_account_id AND id=p_config_id AND coexistence_generation=p_generation;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT ARRAY(SELECT x FROM unnest(ARRAY['phone:'||connection_operation_resource_id(c.phone_number_id),
    'waba:'||connection_operation_resource_id(c.waba_id)]) x WHERE x IS NOT NULL ORDER BY x) INTO keys;
  FOREACH k IN ARRAY keys LOOP
    IF NOT pg_try_advisory_xact_lock(hashtextextended('connection-operation:'||k,0)) THEN RETURN false; END IF;
  END LOOP;
  RETURN NOT EXISTS(SELECT 1 FROM connection_operations o JOIN coexistence_signup_attempts t ON t.operation_id=o.id
    WHERE o.state IN ('active','blocked') AND (o.account_id=p_account_id OR EXISTS(
      SELECT 1 FROM connection_operation_resources r WHERE r.operation_id=o.id AND r.resource_key=ANY(keys))));
EXCEPTION WHEN lock_not_available THEN RETURN false;
END $$;
-- SQL073 Storage trigger already denies active account OR canonical resource claims, including
-- unknown-target starts and subsequently verified claims. Do not replace its stronger guard.
DO $$ DECLARE f record; BEGIN
  FOR f IN SELECT p.oid::regprocedure signature,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname LIKE 'coexistence_signup_%' LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',f.signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.signature);
    IF f.proname NOT IN ('coexistence_signup_scrub','coexistence_signup_owner','coexistence_signup_lock') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
    END IF;
  END LOOP;
END $$;
