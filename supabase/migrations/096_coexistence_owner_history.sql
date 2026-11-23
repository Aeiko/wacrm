BEGIN;
-- Portal access is separate from operator review and the local dispatch permit.
CREATE FUNCTION public.coexistence_owner_history(p_actor_id uuid,p_session_id uuid,p_action text,
  p_context text DEFAULT NULL,p_request_id uuid DEFAULT NULL,p_decision_id uuid DEFAULT NULL,
  p_history boolean DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp SET lock_timeout='250ms' AS $$
DECLARE a uuid; c whatsapp_config; result jsonb; denied jsonb:='{"state":"unavailable"}';
BEGIN
  IF p_action='start' THEN denied:='{"dispatch":false}';
  ELSIF p_action='permissions' THEN denied:='{"status":"ok","connection":null}';
  ELSIF p_action='consent' THEN denied:='{"status":"blocked"}';
  ELSIF p_action IS DISTINCT FROM 'inspect' THEN RETURN denied; END IF;

  SELECT p.account_id INTO a FROM profiles p WHERE p.user_id=p_actor_id;
  IF a IS NULL OR NOT coexistence_signup_owner(p_actor_id,a,p_session_id) THEN RETURN denied; END IF;
  IF p_action IN ('consent','start') THEN
    IF current_setting('transaction_isolation')<>'read committed' THEN RETURN denied; END IF;
    PERFORM coexistence_signup_recovery_lock_actor(p_actor_id,a,p_session_id);
    SELECT * INTO c FROM whatsapp_config WHERE account_id=a FOR UPDATE NOWAIT;
    IF NOT FOUND THEN RETURN denied; END IF;
    PERFORM coexistence_import_resource_locks(c.waba_id,c.phone_number_id);
    PERFORM coexistence_receiver_scope_lock(c.coexistence_app_id,c.waba_id);
  ELSE
    SELECT * INTO c FROM whatsapp_config WHERE account_id=a;
  END IF;
  IF NOT coexistence_signup_owner(p_actor_id,a,p_session_id)
    OR NOT wacrm_pilot_worker.binding_current(c.id,a,c.coexistence_generation)
    -- This portal lane accepts SQL093 activation, not the legacy pilot pin.
    OR NOT EXISTS (
      SELECT FROM coexistence_member_signup_attempts t
      JOIN connection_operations o ON (o.original_account_id,o.request_id,o.actor_id)=(t.account_id,t.state,t.actor_id)
      WHERE o.account_id=a AND o.kind='onboarding' AND o.state='completed'
        AND o.finished_at=c.coexistence_verified_at AND t.actor_id=c.user_id
        AND t.confirmed_at IS NOT NULL AND t.access_token IS NULL AND t.token_expires_at>clock_timestamp()
        AND (t.app_id,t.waba_id,t.phone_number_id)=(c.coexistence_app_id,c.waba_id,c.phone_number_id)
        AND t.revision=(SELECT connection_revision FROM accounts WHERE id=a)
        AND o.result @> jsonb_build_object('status','activated','config_id',c.id,'generation',c.coexistence_generation)
    ) THEN RETURN denied; END IF;

  CASE p_action
    WHEN 'permissions' THEN
      RETURN coexistence_import_settings_status(p_actor_id,a,p_session_id,c.coexistence_app_id,c.waba_id,c.phone_number_id);
    WHEN 'consent' THEN
      RETURN coexistence_import_settings_record(p_actor_id,a,p_session_id,c.coexistence_app_id,c.waba_id,c.phone_number_id,
        p_context,p_request_id,p_decision_id,p_history,false,'projection-v1');
    WHEN 'inspect' THEN
      RETURN coexistence_history_request_status(p_actor_id,p_session_id,c.coexistence_app_id,c.waba_id,c.phone_number_id);
    WHEN 'start' THEN
      result:=coexistence_history_request_start(p_actor_id,p_session_id,c.coexistence_app_id,c.waba_id,c.phone_number_id,
        p_context,p_decision_id,p_request_id);
      IF result->'dispatch' = 'true'::jsonb AND result->>'phone_number_id' IS DISTINCT FROM c.phone_number_id THEN
        RAISE EXCEPTION 'Unexpected history dispatch binding';
      END IF;
      RETURN result;
  END CASE;
EXCEPTION WHEN lock_not_available OR deadlock_detected OR SQLSTATE 'P7401' THEN RETURN denied;
END $$;
ALTER FUNCTION public.coexistence_owner_history(uuid,uuid,text,text,uuid,uuid,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.coexistence_owner_history(uuid,uuid,text,text,uuid,uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.coexistence_owner_history(uuid,uuid,text,text,uuid,uuid,boolean) TO service_role;
COMMIT;
