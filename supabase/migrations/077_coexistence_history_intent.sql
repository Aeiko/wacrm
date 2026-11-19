-- Pre-activation intent only. SQL074/075 confirmation does not establish an active managed binding.
CREATE TABLE public.coexistence_history_intents (
  attempt_id uuid PRIMARY KEY REFERENCES public.coexistence_signup_attempts(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL,
  request_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  session_id uuid NOT NULL,
  connection_revision uuid NOT NULL,
  config_id uuid,
  generation uuid,
  app_id text NOT NULL,
  waba_id text NOT NULL,
  phone_number_id text NOT NULL,
  -- This version denotes exactly history selected / contacts unselected.
  consent_version text COLLATE "C" NOT NULL CHECK (consent_version='history-only-v1'),
  recorded_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at>recorded_at),
  UNIQUE (account_id,request_id),
  CHECK ((config_id IS NULL)=(generation IS NULL))
);
ALTER TABLE public.coexistence_history_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.coexistence_history_intents FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.coexistence_history_intent_record(p_actor_id uuid,p_account_id uuid,p_session_id uuid,
  p_attempt_id uuid,p_request_id uuid,p_expected_revision uuid,p_expected_config_id uuid,p_expected_generation uuid,
  p_app_id text,p_waba_id text,p_phone_number_id text,p_consent_version text,p_history boolean,p_contacts boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET timezone='UTC' AS $$
DECLARE o connection_operations; t coexistence_signup_attempts; c whatsapp_config; receipt coexistence_history_intents;
  bound record; observed_at_now timestamptz; expires timestamptz;
BEGIN
  IF p_actor_id IS NULL OR p_account_id IS NULL OR p_session_id IS NULL OR p_attempt_id IS NULL
    OR p_request_id IS NULL OR p_expected_revision IS NULL OR (p_expected_config_id IS NULL)<>(p_expected_generation IS NULL)
    OR (p_app_id ~ '^[1-9][0-9]{0,31}$') IS NOT TRUE
    OR (p_waba_id ~ '^[1-9][0-9]{0,31}$') IS NOT TRUE OR (p_phone_number_id ~ '^[1-9][0-9]{0,31}$') IS NOT TRUE
    OR p_consent_version COLLATE "C" IS DISTINCT FROM 'history-only-v1'
    OR p_history IS NOT TRUE OR p_contacts IS NOT FALSE THEN RETURN jsonb_build_object('status','invalid'); END IF;

  -- A frozen snapshot could miss a negative committed before we acquired the resource lock.
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RETURN jsonb_build_object('status','invalid'); END IF;
  IF NOT coexistence_signup_owner(p_actor_id,p_account_id,p_session_id) THEN
    RETURN jsonb_build_object('status','forbidden'); END IF;
  PERFORM coexistence_signup_recovery_lock_actor(p_actor_id,p_account_id,p_session_id);
  IF NOT connection_operation_authorized(p_actor_id,p_account_id,'onboarding') THEN
    RETURN jsonb_build_object('status','forbidden'); END IF;
  SELECT * INTO bound FROM coexistence_signup_recovery_lock_attempt(p_account_id,p_attempt_id);
  o:=bound.o;
  t:=bound.t;
  IF o.id IS NULL OR o.actor_id IS DISTINCT FROM p_actor_id OR t.session_id IS DISTINCT FROM p_session_id THEN
    RETURN jsonb_build_object('status','forbidden'); END IF;

  observed_at_now:=clock_timestamp();
  IF NOT EXISTS(SELECT 1 FROM auth.sessions WHERE id=p_session_id AND user_id=p_actor_id
    AND (not_after IS NULL OR not_after>observed_at_now)) THEN RETURN jsonb_build_object('status','forbidden'); END IF;
  IF o.state<>'active' OR t.reason IS NOT NULL OR t.launched_at IS NULL OR t.confirmed_at IS NULL
    OR t.confirmed_at<t.launched_at OR t.confirmed_at>observed_at_now OR t.preview IS NULL
    OR t.access_token IS NULL OR t.token_deadline IS NULL OR t.token_deadline<=observed_at_now
    OR t.token_expires_at IS NULL OR t.token_expires_at<=observed_at_now
    OR EXISTS(SELECT 1 FROM coexistence_signup_recovery_receipts WHERE attempt_id=t.id) THEN
    RETURN jsonb_build_object('status','blocked'); END IF;
  expires:=t.launched_at+interval '24 hours';
  IF expires<=observed_at_now THEN RETURN jsonb_build_object('status','expired'); END IF;

  SELECT * INTO c FROM whatsapp_config WHERE account_id=p_account_id;
  IF ROW(o.expected_revision,o.expected_config_id,o.expected_generation,t.app_id,o.waba_id,o.phone_number_id)
      IS DISTINCT FROM ROW(p_expected_revision,p_expected_config_id,p_expected_generation,p_app_id,p_waba_id,p_phone_number_id)
    OR t.preview->>'phone_number_id' IS DISTINCT FROM p_phone_number_id
    OR t.preview->>'waba_id' IS DISTINCT FROM p_waba_id
    OR t.preview->>'normalized_phone_number' IS DISTINCT FROM t.intended_phone
    OR NOT (ARRAY['waba:'||p_waba_id,'phone:'||p_phone_number_id] <@ o.resource_keys)
    OR NOT connection_operation_binding(o) THEN RETURN jsonb_build_object('status','conflict'); END IF;
  -- Read SQL075 evidence under the same resource locks, without mutating signup or claiming receipts.
  IF EXISTS(SELECT 1 FROM coexistence_negative_evidence e WHERE e.app_id=t.app_id AND e.observed_at>=t.launched_at
    AND e.waba_id IN (SELECT substring(k FROM 6) FROM unnest(o.resource_keys) k WHERE k LIKE 'waba:%'))
    THEN RETURN jsonb_build_object('status','blocked'); END IF;
  IF c.id IS NOT NULL AND (c.coexistence_app_id IS NOT NULL OR c.coexistence_verified_at IS NOT NULL
    OR c.status IS DISTINCT FROM 'connected' OR connection_operation_resource_id(c.waba_id) IS DISTINCT FROM p_waba_id
    OR connection_operation_resource_id(c.phone_number_id) IS DISTINCT FROM p_phone_number_id) THEN
    RETURN jsonb_build_object('status','conflict'); END IF;

  SELECT * INTO receipt FROM coexistence_history_intents WHERE attempt_id=t.id;
  IF FOUND THEN
    IF ROW(receipt.account_id,receipt.request_id,receipt.actor_id,receipt.session_id,receipt.connection_revision,
        receipt.config_id,receipt.generation,receipt.app_id,receipt.waba_id,receipt.phone_number_id,receipt.consent_version,receipt.expires_at)
      IS DISTINCT FROM ROW(p_account_id,p_request_id,p_actor_id,p_session_id,p_expected_revision,
        p_expected_config_id,p_expected_generation,p_app_id,p_waba_id,p_phone_number_id,p_consent_version,expires) THEN
      RETURN jsonb_build_object('status','conflict'); END IF;
  ELSE
    INSERT INTO coexistence_history_intents(attempt_id,account_id,request_id,actor_id,session_id,connection_revision,
      config_id,generation,app_id,waba_id,phone_number_id,consent_version,recorded_at,expires_at)
    VALUES(t.id,p_account_id,p_request_id,p_actor_id,p_session_id,p_expected_revision,
      p_expected_config_id,p_expected_generation,p_app_id,p_waba_id,p_phone_number_id,p_consent_version,observed_at_now,expires);
  END IF;
  RETURN jsonb_build_object('status','intent_recorded','attempt_id',t.id,'request_id',p_request_id,
    'expires_at',expires,'dispatch_authorized',false);
EXCEPTION WHEN lock_not_available THEN RETURN jsonb_build_object('status','busy');
  WHEN unique_violation THEN RETURN jsonb_build_object('status','conflict');
  WHEN SQLSTATE 'P7401' THEN RETURN jsonb_build_object('status','forbidden');
END $$;

REVOKE ALL ON FUNCTION public.coexistence_history_intent_record(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,
  text,text,text,text,boolean,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.coexistence_history_intent_record(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,
  text,text,text,text,boolean,boolean) TO service_role;
