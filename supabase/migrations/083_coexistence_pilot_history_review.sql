-- Separate operator attestation, not provider API proof or an authorization to dispatch.
CREATE FUNCTION public.coexistence_pilot_history_review(p_attempt_id uuid,p_actor_id uuid,p_account_id uuid,
  p_session_id uuid,p_context text,p_decision_id uuid,p_request_id uuid,p_approval text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp SET lock_timeout='250ms' AS $$
DECLARE denied CONSTANT jsonb:='{"status":"denied"}';
  b coexistence_pilot_bindings; s record; d coexistence_import_decisions; session_end timestamptz; checked_at timestamptz;
BEGIN
  IF current_user<>'postgres' OR current_setting('transaction_isolation')<>'read committed'
    OR p_approval COLLATE "C" IS DISTINCT FROM 'supervised-history-only-v1'
    OR (p_context COLLATE "C" ~ '^[0-9a-f]{64}$') IS NOT TRUE
    OR p_decision_id IS NULL OR p_request_id IS NULL THEN RETURN denied; END IF;

  SELECT * INTO b FROM coexistence_pilot_bindings WHERE attempt_id=p_attempt_id;
  IF NOT FOUND OR ROW(b.actor_id,b.account_id,b.session_id) IS DISTINCT FROM ROW(p_actor_id,p_account_id,p_session_id)
    OR coexistence_history_request_account(p_actor_id,p_session_id,b.app_id,b.waba_id,b.phone_number_id)
       IS DISTINCT FROM p_account_id THEN RETURN denied; END IF;

  -- Same order as owner submission and consent; re-read eligibility after taking the fences.
  PERFORM coexistence_signup_recovery_lock_actor(p_actor_id,p_account_id,p_session_id);
  PERFORM 1 FROM whatsapp_config WHERE account_id=p_account_id AND id=b.config_id FOR UPDATE NOWAIT;
  IF NOT FOUND THEN RETURN denied; END IF;
  PERFORM coexistence_import_resource_locks(b.waba_id,b.phone_number_id);
  IF coexistence_receiver_veto_locked(b.app_id,ARRAY[b.waba_id]) THEN RETURN denied; END IF;
  IF coexistence_history_request_account(p_actor_id,p_session_id,b.app_id,b.waba_id,b.phone_number_id)
    IS DISTINCT FROM p_account_id THEN RETURN denied; END IF;

  SELECT * INTO s FROM coexistence_import_settings_snapshot(p_actor_id,p_account_id,p_session_id,
    b.app_id,b.waba_id,b.phone_number_id);
  IF NOT FOUND OR s.pinned IS NOT TRUE OR s.can_grant IS NOT TRUE OR s.effective IS NOT TRUE
    OR ROW(s.revision,s.config_id,s.generation,s.context COLLATE "C")
      IS DISTINCT FROM ROW(b.connection_revision,b.config_id,b.generation,p_context) THEN RETURN denied; END IF;
  d:=s.decision;
  IF d.history IS NOT TRUE OR d.contacts IS NOT FALSE
    OR ROW(d.request_id,d.actor_id,d.session_id,d.account_id,d.connection_revision,d.config_id,d.generation,
           d.app_id,d.waba_id,d.phone_number_id)
      IS DISTINCT FROM ROW(p_decision_id,b.actor_id,b.session_id,b.account_id,b.connection_revision,b.config_id,
                           b.generation,b.app_id,b.waba_id,b.phone_number_id) THEN RETURN denied; END IF;

  IF EXISTS(SELECT 1 FROM coexistence_signup_recovery_receipts WHERE attempt_id=b.attempt_id)
    OR EXISTS(SELECT 1 FROM coexistence_negative_evidence WHERE app_id=b.app_id AND waba_id=b.waba_id
      AND observed_at>=b.launch_lower_bound)
    OR EXISTS(SELECT 1 FROM coexistence_history_reviews WHERE phone_number_id=b.phone_number_id AND outcome IS NOT NULL)
    THEN RETURN denied; END IF;

  -- The receipt's token expiry refers to staging, not the independently provisioned operational credential.
  SELECT not_after INTO session_end FROM auth.sessions WHERE id=p_session_id AND user_id=p_actor_id;
  checked_at:=clock_timestamp();
  IF NOT FOUND OR NOT isfinite(b.launch_lower_bound) OR b.launch_lower_bound>checked_at
    OR least(b.launch_lower_bound+interval '24 hours',session_end,d.expires_at)<=checked_at THEN RETURN denied; END IF;

  INSERT INTO coexistence_history_reviews(request_id,actor_id,session_id,account_id,config_id,generation,
    app_id,waba_id,phone_number_id,decision_id,launch_lower_bound)
  VALUES(p_request_id,b.actor_id,b.session_id,b.account_id,b.config_id,b.generation,b.app_id,b.waba_id,
    b.phone_number_id,d.request_id,b.launch_lower_bound);
  RETURN '{"status":"reviewed"}';
EXCEPTION WHEN lock_not_available OR deadlock_detected OR serialization_failure OR unique_violation OR SQLSTATE 'P7401' THEN
  RETURN denied;
END $$;

ALTER FUNCTION public.coexistence_pilot_history_review(uuid,uuid,uuid,uuid,text,uuid,uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.coexistence_pilot_history_review(uuid,uuid,uuid,uuid,text,uuid,uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
