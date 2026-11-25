-- Operator-only, after explicit activation and exact WABA subscription readback.
-- psql -X -v ON_ERROR_STOP=1 -v account=... -v config=... -v generation=...
--   -v actor=... -v member_session=... -v app=... -v waba=... -v phone=... -f this-file
BEGIN;
SET LOCAL lock_timeout = '500ms';
SET LOCAL statement_timeout = '5s';
CREATE TEMP TABLE requested_member_inbox ON COMMIT DROP AS
SELECT :'account'::uuid account_id, :'config'::uuid config_id,
       :'generation'::uuid generation, :'actor'::uuid actor_id,
       :'member_session'::uuid session_id, :'app'::text app_id,
       :'waba'::text waba_id, :'phone'::text phone_id;
DO $$
DECLARE t record;
BEGIN
  SELECT * INTO STRICT t FROM requested_member_inbox;
  LOCK TABLE wacrm_pilot_worker.selection, wacrm_history_worker.selection IN SHARE ROW EXCLUSIVE MODE;
  IF EXISTS (SELECT FROM wacrm_pilot_worker.selection) OR EXISTS (SELECT FROM wacrm_history_worker.selection) THEN
    RAISE EXCEPTION 'Projection already selected';
  END IF;
  PERFORM FROM public.accounts WHERE id=t.account_id FOR NO KEY UPDATE NOWAIT;
  PERFORM FROM public.whatsapp_config c
    WHERE (c.id,c.account_id,c.coexistence_generation,c.user_id,c.coexistence_app_id,c.waba_id,c.phone_number_id)
        = (t.config_id,t.account_id,t.generation,t.actor_id,t.app_id,t.waba_id,t.phone_id)
    FOR UPDATE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'Exact binding unavailable'; END IF;
  PERFORM public.coexistence_receiver_scope_lock(t.app_id,t.waba_id);
  PERFORM FROM public.coexistence_member_signup_attempts a
    JOIN auth.sessions s ON s.id=a.session_id AND s.user_id=a.actor_id
    WHERE (a.account_id,a.actor_id,a.session_id,a.app_id,a.waba_id,a.phone_number_id)
        = (t.account_id,t.actor_id,t.session_id,t.app_id,t.waba_id,t.phone_id)
      AND a.confirmed_at IS NOT NULL AND a.access_token IS NULL
      AND (s.not_after IS NULL OR s.not_after>clock_timestamp())
    FOR SHARE OF a,s NOWAIT;
  IF NOT FOUND OR NOT wacrm_pilot_worker.binding_current(t.config_id,t.account_id,t.generation) THEN
    RAISE EXCEPTION 'Current member activation unavailable';
  END IF;
  INSERT INTO wacrm_pilot_worker.selection(slot,config_id) VALUES (true,t.config_id);
END $$;
COMMIT;
