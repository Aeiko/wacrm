-- Recovery observes local evidence only. No activation, dispatch, adoption, or started-work release.
CREATE TABLE public.coexistence_signup_recovery_receipts (
  attempt_id uuid PRIMARY KEY REFERENCES public.coexistence_signup_attempts(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL,
  request_id uuid NOT NULL,
  action text COLLATE "C" NOT NULL CHECK (action IN ('close_unstarted','record_hold')),
  disposition text GENERATED ALWAYS AS (CASE action WHEN 'close_unstarted' THEN 'closed_unstarted' ELSE 'held_uncertain' END) STORED,
  reviewed_at timestamptz NOT NULL
);
ALTER TABLE public.coexistence_signup_recovery_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.coexistence_signup_recovery_receipts FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.coexistence_signup_recovery_lock_actor(p_actor_id uuid,p_account_id uuid,p_session_id uuid)
RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE owner_id uuid; member_role account_role_enum; session_end timestamptz;
BEGIN
  -- Filter first so a foreign or mismatched session cannot cause any other tenant's row locks.
  IF NOT (connection_operation_authorized(p_actor_id,p_account_id,'manual_save') AND EXISTS(
    SELECT 1 FROM auth.sessions WHERE id=p_session_id AND user_id=p_actor_id
      AND (not_after IS NULL OR not_after>clock_timestamp()))) THEN RAISE EXCEPTION USING ERRCODE='P7401'; END IF;
  SELECT owner_user_id INTO owner_id FROM accounts WHERE id=p_account_id FOR NO KEY UPDATE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P7401'; END IF;
  SELECT account_role INTO member_role FROM profiles WHERE user_id=p_actor_id AND account_id=p_account_id FOR SHARE NOWAIT;
  IF NOT FOUND OR NOT (member_role='admin' OR (member_role='owner' AND owner_id=p_actor_id)) THEN
    RAISE EXCEPTION USING ERRCODE='P7401'; END IF;
  SELECT not_after INTO session_end FROM auth.sessions WHERE id=p_session_id AND user_id=p_actor_id FOR SHARE NOWAIT;
  IF NOT FOUND OR session_end<=clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='P7401'; END IF;
END $$;

CREATE FUNCTION public.coexistence_signup_recovery_pristine(o public.connection_operations,t public.coexistence_signup_attempts)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT o.state='reserved' AND o.steps='{}'::jsonb AND o.result IS NULL AND o.finished_at IS NULL
    AND o.phone_number_id IS NULL AND o.waba_id IS NULL
    AND t.launched_at IS NULL AND t.code_hash IS NULL AND t.token_deadline IS NULL AND t.token_hash IS NULL
    AND t.access_token IS NULL AND t.token_expires_at IS NULL AND t.preview IS NULL AND t.confirmed_at IS NULL AND t.reason IS NULL
$$;

-- Lock the requested tenant's rows only, in gate order. NULL attempt selects the latest signup for GET.
CREATE FUNCTION public.coexistence_signup_recovery_lock_attempt(p_account_id uuid,p_attempt_id uuid,
  OUT o public.connection_operations,OUT t public.coexistence_signup_attempts)
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE operation_id uuid; attempt_id uuid; k text;
BEGIN
  SELECT y.id,x.id INTO operation_id,attempt_id
    FROM coexistence_signup_attempts x JOIN connection_operations y ON y.id=x.operation_id
    WHERE y.original_account_id=p_account_id AND y.account_id=p_account_id AND y.kind='onboarding'
      AND (p_attempt_id IS NULL OR x.id=p_attempt_id)
    ORDER BY x.created_at DESC,x.id DESC LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM 1 FROM whatsapp_config WHERE account_id=p_account_id FOR UPDATE NOWAIT;
  SELECT * INTO STRICT o FROM connection_operations WHERE id=operation_id FOR UPDATE NOWAIT;
  PERFORM 1 FROM connection_operation_resources WHERE connection_operation_resources.operation_id=o.id
    ORDER BY resource_key FOR UPDATE NOWAIT;
  SELECT * INTO STRICT t FROM coexistence_signup_attempts WHERE id=attempt_id FOR UPDATE NOWAIT;
  -- Match 075's resource advisory locks so reads of signed negatives serialize with admission.
  -- Terminal operations no longer own keys, which may now belong to a different tenant.
  IF o.state IN ('reserved','active','blocked') THEN
    FOREACH k IN ARRAY (SELECT ARRAY(SELECT DISTINCT x FROM unnest(o.resource_keys) x ORDER BY x)) LOOP
      IF NOT pg_try_advisory_xact_lock(hashtextextended('connection-operation:'||k,0)) THEN RAISE lock_not_available; END IF;
    END LOOP;
  END IF;
END $$;

CREATE FUNCTION public.coexistence_signup_recovery_status(p_actor_id uuid,p_account_id uuid,p_session_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET timezone='UTC' AS $$
DECLARE t coexistence_signup_attempts; o connection_operations; audit coexistence_signup_recovery_receipts;
  state text; claims integer; negative boolean; exchanged boolean; checked_at timestamptz; locked record;
BEGIN
  PERFORM coexistence_signup_recovery_lock_actor(p_actor_id,p_account_id,p_session_id);
  SELECT * INTO locked FROM coexistence_signup_recovery_lock_attempt(p_account_id,NULL);
  o:=locked.o; t:=locked.t;
  IF t.id IS NULL THEN RETURN jsonb_build_object('status','ok','attempt',NULL); END IF;
  SELECT * INTO audit FROM coexistence_signup_recovery_receipts WHERE attempt_id=t.id;
  SELECT count(*) INTO claims FROM connection_operation_resources WHERE operation_id=o.id;
  SELECT EXISTS(SELECT 1 FROM coexistence_negative_evidence e JOIN connection_operation_resources r
    ON r.resource_key='waba:'||e.waba_id AND r.operation_id=o.id
    WHERE e.app_id=t.app_id AND e.observed_at>=t.launched_at
      AND e.kind IN ('ACCOUNT_OFFBOARDED','PARTNER_REMOVED','PARTNER_APP_UNINSTALLED')) INTO negative;
  checked_at:=clock_timestamp();
  exchanged:=o.steps ? 'exchange';
  state:=CASE
    WHEN o.state='cancelled' THEN 'cancelled'
    WHEN coexistence_signup_recovery_pristine(o,t) AND o.lease_until<=checked_at THEN 'expired_unstarted'
    WHEN negative OR o.state='blocked' OR t.reason IS NOT NULL OR t.token_deadline<=checked_at
      OR t.token_expires_at<=checked_at OR (t.token_hash IS NOT NULL AND t.access_token IS NULL)
      OR (o.state IN ('reserved','active') AND (NOT connection_operation_binding(o)
        OR NOT connection_operation_authorized(o.actor_id,o.account_id,'onboarding')
        OR NOT EXISTS(SELECT 1 FROM auth.sessions WHERE id=t.session_id AND user_id=o.actor_id
          AND (not_after IS NULL OR not_after>checked_at)))) THEN 'review_required'
    WHEN exchanged AND t.launched_at IS NOT NULL AND t.confirmed_at IS NOT NULL THEN 'confirmed'
    WHEN exchanged AND t.launched_at IS NOT NULL AND t.preview IS NOT NULL THEN 'verified'
    WHEN o.state='active' AND exchanged AND t.launched_at IS NOT NULL THEN 'exchange_started'
    WHEN o.state='active' AND o.steps ? 'launch' AND t.launched_at IS NOT NULL THEN 'launch_possible'
    WHEN coexistence_signup_recovery_pristine(o,t) THEN 'prepared'
    ELSE 'review_required' END;
  RETURN jsonb_build_object('status','ok','attempt',jsonb_build_object('id',t.id,'state',state,
    'launched_at',t.launched_at,'exchange_started',exchanged,'known_claims',claims,
    'disposition',audit.disposition,'reviewed_at',audit.reviewed_at));
EXCEPTION WHEN lock_not_available THEN RETURN jsonb_build_object('status','busy');
  WHEN SQLSTATE 'P7401' THEN RETURN jsonb_build_object('status','forbidden');
END $$;

CREATE FUNCTION public.coexistence_signup_recovery_record(p_actor_id uuid,p_account_id uuid,p_session_id uuid,
  p_attempt_id uuid,p_request_id uuid,p_action text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET timezone='UTC' AS $$
DECLARE t coexistence_signup_attempts; o connection_operations; audit coexistence_signup_recovery_receipts;
  reviewed timestamptz; locked record;
BEGIN
  IF p_attempt_id IS NULL OR p_request_id IS NULL OR p_action IS NULL OR p_action COLLATE "C" NOT IN ('close_unstarted','record_hold') THEN
    RETURN jsonb_build_object('status','invalid'); END IF;
  PERFORM coexistence_signup_recovery_lock_actor(p_actor_id,p_account_id,p_session_id);
  SELECT * INTO locked FROM coexistence_signup_recovery_lock_attempt(p_account_id,p_attempt_id);
  o:=locked.o; t:=locked.t;
  IF t.id IS NULL THEN RETURN jsonb_build_object('status','not_found'); END IF;
  SELECT * INTO audit FROM coexistence_signup_recovery_receipts WHERE attempt_id=t.id;
  IF FOUND THEN
    IF ROW(audit.actor_id,audit.request_id,audit.action) IS DISTINCT FROM ROW(p_actor_id,p_request_id,p_action COLLATE "C") THEN
      RETURN jsonb_build_object('status','conflict'); END IF;
  ELSE
    reviewed:=clock_timestamp();
    IF p_action='close_unstarted' THEN
      IF NOT coexistence_signup_recovery_pristine(o,t) OR o.lease_until>reviewed THEN
        RETURN jsonb_build_object('status','conflict'); END IF;
      DELETE FROM connection_operation_resources WHERE operation_id=o.id;
      UPDATE connection_operations SET state='cancelled',finished_at=reviewed WHERE id=o.id;
    ELSIF o.state NOT IN ('active','blocked') OR NOT (o.steps ? 'launch') OR t.launched_at IS NULL THEN
      RETURN jsonb_build_object('status','conflict');
    END IF;
    -- Hold inserts only an observation: neither an owner veto nor proof of provider rollback.
    INSERT INTO coexistence_signup_recovery_receipts(attempt_id,actor_id,request_id,action,reviewed_at)
      VALUES(t.id,p_actor_id,p_request_id,p_action,reviewed) RETURNING * INTO audit;
  END IF;
  RETURN jsonb_build_object('status','recorded','attempt_id',t.id,'request_id',audit.request_id,
    'disposition',audit.disposition,'reviewed_at',audit.reviewed_at);
EXCEPTION WHEN lock_not_available THEN RETURN jsonb_build_object('status','busy');
  WHEN SQLSTATE 'P7401' THEN RETURN jsonb_build_object('status','forbidden');
END $$;

REVOKE ALL ON FUNCTION public.coexistence_signup_recovery_lock_actor(uuid,uuid,uuid),
  public.coexistence_signup_recovery_pristine(public.connection_operations,public.coexistence_signup_attempts),
  public.coexistence_signup_recovery_lock_attempt(uuid,uuid),public.coexistence_signup_recovery_status(uuid,uuid,uuid),
  public.coexistence_signup_recovery_record(uuid,uuid,uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.coexistence_signup_recovery_status(uuid,uuid,uuid),
  public.coexistence_signup_recovery_record(uuid,uuid,uuid,uuid,uuid,text) TO service_role;
