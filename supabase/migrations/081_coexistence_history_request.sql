-- Empty until independently provisioned by a trusted, supervised authority. Consent is not issuance.
CREATE TABLE public.coexistence_history_reviews (
  request_id uuid PRIMARY KEY,
  actor_id uuid NOT NULL,
  session_id uuid NOT NULL,
  account_id uuid NOT NULL,
  config_id uuid NOT NULL,
  generation uuid NOT NULL,
  app_id text COLLATE "C" NOT NULL CHECK (app_id ~ '^[1-9][0-9]{0,31}$'),
  waba_id text COLLATE "C" NOT NULL CHECK (waba_id ~ '^[1-9][0-9]{0,31}$'),
  phone_number_id text COLLATE "C" NOT NULL CHECK (phone_number_id ~ '^[1-9][0-9]{0,31}$'),
  decision_id uuid NOT NULL,
  launch_lower_bound timestamptz NOT NULL CHECK (isfinite(launch_lower_bound)),
  outcome text COLLATE "C" CHECK (outcome IN ('started','accepted','rejected','ambiguous','not_sent')),
  CHECK (app_id<>waba_id AND app_id<>phone_number_id AND waba_id<>phone_number_id),
  UNIQUE (account_id,decision_id)
);
-- No cascading foreign keys: deleting a binding must never release a physical phone's start.
CREATE UNIQUE INDEX coexistence_history_reviews_consumed_phone ON public.coexistence_history_reviews (phone_number_id)
  WHERE outcome IS NOT NULL;
ALTER TABLE public.coexistence_history_reviews OWNER TO postgres;
ALTER TABLE public.coexistence_history_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.coexistence_history_reviews FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.coexistence_history_request_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.outcome IS NULL AND NEW.launch_lower_bound<=clock_timestamp() THEN RETURN NEW; END IF;
  ELSIF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-'outcome')=(to_jsonb(OLD)-'outcome') AND (
      (OLD.outcome IS NULL AND NEW.outcome='started') OR
      (OLD.outcome='started' AND NEW.outcome IN ('accepted','rejected','ambiguous','not_sent'))
    ) THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'coexistence_history_review_immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER coexistence_history_review_guard BEFORE INSERT OR UPDATE OR DELETE ON public.coexistence_history_reviews
  FOR EACH ROW EXECUTE FUNCTION public.coexistence_history_request_guard();
CREATE TRIGGER coexistence_history_review_no_truncate BEFORE TRUNCATE ON public.coexistence_history_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION public.coexistence_history_request_guard();

CREATE FUNCTION public.coexistence_history_request_account(p_actor_id uuid,p_session_id uuid,
  p_app_id text,p_waba_id text,p_phone_id text)
RETURNS uuid LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT p.account_id FROM profiles p
  WHERE p.user_id=p_actor_id AND coexistence_signup_owner(p_actor_id,p.account_id,p_session_id)
    AND EXISTS(SELECT 1 FROM auth.sessions WHERE id=p_session_id AND user_id=p_actor_id
      AND (not_after IS NULL OR not_after>clock_timestamp()))
    AND p_app_id COLLATE "C" ~ '^[1-9][0-9]{0,31}$' AND p_waba_id COLLATE "C" ~ '^[1-9][0-9]{0,31}$'
    AND p_phone_id COLLATE "C" ~ '^[1-9][0-9]{0,31}$'
    AND p_app_id<>p_waba_id AND p_app_id<>p_phone_id AND p_waba_id<>p_phone_id
$$;

CREATE FUNCTION public.coexistence_history_request_status(p_actor_id uuid,p_session_id uuid,
  p_app_id text,p_waba_id text,p_phone_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $$
DECLARE unavailable CONSTANT jsonb:='{"state":"unavailable"}';
  a uuid; s record; d coexistence_import_decisions; r coexistence_history_reviews;
BEGIN
  a:=coexistence_history_request_account(p_actor_id,p_session_id,p_app_id,p_waba_id,p_phone_id);
  IF a IS NULL THEN RETURN unavailable; END IF;
  SELECT * INTO s FROM coexistence_import_settings_snapshot(p_actor_id,a,p_session_id,p_app_id,p_waba_id,p_phone_id);
  IF NOT FOUND OR NOT s.pinned THEN RETURN unavailable; END IF;

  SELECT * INTO r FROM coexistence_history_reviews WHERE phone_number_id=p_phone_id AND outcome IS NOT NULL;
  IF FOUND THEN
    -- A global claim blocks everyone, but only the original owner/session/scope sees its outcome.
    IF ROW(r.actor_id,r.session_id,r.account_id,r.config_id,r.generation,r.app_id,r.waba_id)
      IS DISTINCT FROM ROW(p_actor_id,p_session_id,a,s.config_id,s.generation,p_app_id,p_waba_id) THEN RETURN unavailable; END IF;
    RETURN jsonb_build_object('state',r.outcome);
  END IF;
  d:=s.decision;
  IF NOT s.can_grant OR NOT s.effective OR d.actor_id IS DISTINCT FROM p_actor_id
    OR d.history IS NOT TRUE OR d.contacts IS NOT FALSE THEN RETURN unavailable; END IF;
  SELECT * INTO r FROM coexistence_history_reviews WHERE account_id=a AND decision_id=d.request_id;
  IF NOT FOUND OR ROW(r.actor_id,r.session_id,r.config_id,r.generation,r.app_id,r.waba_id,r.phone_number_id)
    IS DISTINCT FROM ROW(p_actor_id,p_session_id,s.config_id,s.generation,p_app_id,p_waba_id,p_phone_id)
    OR r.launch_lower_bound+interval '24 hours'<=clock_timestamp() THEN RETURN unavailable; END IF;
  RETURN jsonb_build_object('state','ready','review',jsonb_build_object('context',s.context,'decision_id',r.decision_id,
    'request_id',r.request_id,'phone_id_suffix',right(p_phone_id,4),'deadline_at',r.launch_lower_bound+interval '24 hours'));
END $$;

CREATE FUNCTION public.coexistence_history_request_start(p_actor_id uuid,p_session_id uuid,
  p_app_id text,p_waba_id text,p_phone_id text,p_context text,p_decision_id uuid,p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET lock_timeout='250ms' SET timezone='UTC' AS $$
DECLARE denied CONSTANT jsonb:='{"dispatch":false}';
  a uuid; cfg uuid; review jsonb; deadline timestamptz; checked_at timestamptz; token text;
  session_end timestamptz; grant_session_end timestamptz; grant_end timestamptz;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' OR p_decision_id IS NULL OR p_request_id IS NULL
    OR (p_context COLLATE "C" ~ '^[0-9a-f]{64}$') IS NOT TRUE THEN RETURN denied; END IF;
  a:=coexistence_history_request_account(p_actor_id,p_session_id,p_app_id,p_waba_id,p_phone_id);
  IF a IS NULL THEN RETURN denied; END IF;
  -- Match SQL079/080 and SQL078 ordering; the locks serialize replacement, revocation and receiver stops.
  PERFORM coexistence_signup_recovery_lock_actor(p_actor_id,a,p_session_id);
  SELECT id INTO cfg FROM whatsapp_config WHERE account_id=a AND coexistence_app_id=p_app_id
    AND connection_operation_resource_id(waba_id)=p_waba_id AND connection_operation_resource_id(phone_number_id)=p_phone_id
    FOR UPDATE NOWAIT;
  IF NOT FOUND OR a IS DISTINCT FROM coexistence_history_request_account(p_actor_id,p_session_id,p_app_id,p_waba_id,p_phone_id)
    THEN RETURN denied; END IF;
  PERFORM coexistence_import_resource_locks(p_waba_id,p_phone_id);
  IF coexistence_receiver_veto_locked(p_app_id,ARRAY[p_waba_id]) THEN RETURN denied; END IF;
  review:=coexistence_history_request_status(p_actor_id,p_session_id,p_app_id,p_waba_id,p_phone_id)->'review';
  IF (review->>'context') COLLATE "C" IS DISTINCT FROM p_context
    OR (review->>'decision_id')::uuid IS DISTINCT FROM p_decision_id
    OR (review->>'request_id')::uuid IS DISTINCT FROM p_request_id THEN RETURN denied; END IF;
  SELECT d.expires_at,s.not_after INTO grant_end,grant_session_end FROM coexistence_import_decisions d
    JOIN auth.sessions s ON s.id=d.session_id AND s.user_id=d.actor_id
    WHERE d.account_id=a AND d.request_id=p_decision_id FOR SHARE OF s NOWAIT;
  IF NOT FOUND THEN RETURN denied; END IF;
  SELECT not_after INTO session_end FROM auth.sessions WHERE id=p_session_id AND user_id=p_actor_id;
  deadline:=(review->>'deadline_at')::timestamptz;

  checked_at:=clock_timestamp();
  IF least(deadline,grant_end,grant_session_end,session_end)<=checked_at THEN RETURN denied; END IF;
  UPDATE coexistence_history_reviews SET outcome='started' WHERE request_id=p_request_id AND outcome IS NULL;
  IF NOT FOUND THEN RETURN denied; END IF;
  SELECT access_token INTO token FROM whatsapp_config WHERE id=cfg;
  IF least(deadline,grant_end,grant_session_end,session_end)<=clock_timestamp() THEN
    UPDATE coexistence_history_reviews SET outcome='not_sent' WHERE request_id=p_request_id;
    RETURN denied;
  END IF;
  RETURN jsonb_build_object('dispatch',true,'request_id',p_request_id,'phone_number_id',p_phone_id,
    'deadline_at',least(deadline,grant_end,grant_session_end,session_end),'encrypted_token',token);
EXCEPTION WHEN lock_not_available OR deadlock_detected OR unique_violation OR SQLSTATE 'P7401' THEN RETURN denied;
END $$;

CREATE FUNCTION public.coexistence_history_request_finish(p_request_id uuid,p_outcome text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET lock_timeout='250ms' AS $$
DECLARE previous text;
BEGIN
  IF p_request_id IS NULL OR (p_outcome COLLATE "C" IN ('accepted','rejected','ambiguous','not_sent')) IS NOT TRUE THEN
    RETURN false; END IF;
  SELECT outcome INTO previous FROM coexistence_history_reviews WHERE request_id=p_request_id FOR UPDATE NOWAIT;
  IF previous='started' THEN
    UPDATE coexistence_history_reviews SET outcome=p_outcome WHERE request_id=p_request_id;
    RETURN true;
  END IF;
  RETURN previous COLLATE "C" IS NOT DISTINCT FROM p_outcome;
EXCEPTION WHEN lock_not_available OR deadlock_detected OR serialization_failure THEN RETURN false;
END $$;

ALTER FUNCTION public.coexistence_history_request_guard() OWNER TO postgres;
ALTER FUNCTION public.coexistence_history_request_account(uuid,uuid,text,text,text) OWNER TO postgres;
ALTER FUNCTION public.coexistence_history_request_status(uuid,uuid,text,text,text) OWNER TO postgres;
ALTER FUNCTION public.coexistence_history_request_start(uuid,uuid,text,text,text,text,uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.coexistence_history_request_finish(uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.coexistence_history_request_guard(),
  public.coexistence_history_request_account(uuid,uuid,text,text,text),
  public.coexistence_history_request_status(uuid,uuid,text,text,text),
  public.coexistence_history_request_start(uuid,uuid,text,text,text,text,uuid,uuid),
  public.coexistence_history_request_finish(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.coexistence_history_request_status(uuid,uuid,text,text,text),
  public.coexistence_history_request_start(uuid,uuid,text,text,text,text,uuid,uuid),
  public.coexistence_history_request_finish(uuid,text) TO service_role;
