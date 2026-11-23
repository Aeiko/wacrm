BEGIN;
CREATE SCHEMA wacrm_pilot_worker AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA wacrm_pilot_worker FROM PUBLIC, anon, authenticated,service_role;
CREATE TABLE wacrm_pilot_worker.selection(slot boolean PRIMARY KEY CHECK(slot), config_id uuid NOT NULL);
REVOKE ALL ON wacrm_pilot_worker.selection FROM PUBLIC,anon,authenticated,service_role;
-- Workers are unselected and have no runtime grants on install.
CREATE FUNCTION wacrm_pilot_worker.binding_current(p_config uuid,p_account uuid,p_generation uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT EXISTS (
   SELECT FROM public.whatsapp_config c JOIN public.accounts a ON a.id=c.account_id
   WHERE (c.id,c.account_id,c.coexistence_generation)=(p_config,p_account,p_generation)
     AND c.status='connected' AND c.coexistence_verified_at IS NOT NULL
     AND (c.access_token COLLATE "C" ~ '^[a-f0-9]{24}:([a-f0-9]{2})+:[a-f0-9]{32}$') IS TRUE
     AND NOT EXISTS (SELECT FROM public.coexistence_receiver_vetoes v WHERE (v.app_id,v.waba_id)=(c.coexistence_app_id,c.waba_id))
     AND NOT EXISTS (SELECT FROM public.coexistence_negative_evidence n WHERE (n.app_id,n.waba_id)=(c.coexistence_app_id,c.waba_id))
     AND (
       EXISTS (SELECT FROM public.coexistence_pilot_bindings b WHERE
         (b.config_id,b.account_id,b.generation,b.connection_revision,b.app_id,b.waba_id,b.phone_number_id,b.activated_at)=
         (c.id,c.account_id,c.coexistence_generation,a.connection_revision,c.coexistence_app_id,c.waba_id,c.phone_number_id,c.coexistence_verified_at)
         AND public.connection_operation_authorized(b.actor_id,b.account_id,'onboarding'))
       OR EXISTS (
         SELECT FROM public.coexistence_member_signup_attempts t
         JOIN public.connection_operations o ON (o.original_account_id,o.request_id,o.actor_id)=(t.account_id,t.state,t.actor_id)
         JOIN public.profiles p ON (p.user_id,p.account_id)=(t.actor_id,t.account_id)
         WHERE (t.account_id,t.revision,t.actor_id,t.app_id,t.waba_id,t.phone_number_id)=
           (c.account_id,a.connection_revision,c.user_id,c.coexistence_app_id,c.waba_id,c.phone_number_id)
           AND t.confirmed_at IS NOT NULL AND t.access_token IS NULL
           AND t.token_expires_at>statement_timestamp()
           AND o.account_id=c.account_id AND o.kind='onboarding' AND o.state='completed'
           AND o.finished_at=c.coexistence_verified_at
           AND o.result @> jsonb_build_object('status','activated','config_id',c.id,'generation',c.coexistence_generation)
       )
     )
 );
$$;
CREATE FUNCTION wacrm_pilot_worker.allowed(j public.coexistence_jobs) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT EXISTS (SELECT FROM wacrm_pilot_worker.selection s WHERE s.config_id=j.config_id)
 AND j.import_consent_id IS NULL
 AND public.coexistence_import_payload_scope(j.payload)=4
 AND wacrm_pilot_worker.binding_current(j.config_id,j.account_id,j.generation);
$$;
CREATE OR REPLACE FUNCTION wacrm_pilot_worker.coexistence_claim(p_limit integer)
RETURNS TABLE(id uuid, payload jsonb, lease_token uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 5 THEN
    RAISE EXCEPTION 'coexistence_invalid_limit';
  END IF;
  -- Keep dedupe tombstones; measure raw retention from intake, not completion.
  WITH expired AS (
    SELECT j.id FROM coexistence_jobs j
    WHERE wacrm_pilot_worker.allowed(j) AND j.created_at < now() - interval '7 days' AND j.status IN ('completed', 'quarantined')
      AND j.payload <> '{}'::jsonb ORDER BY j.created_at LIMIT 100 FOR UPDATE SKIP LOCKED
  ) UPDATE coexistence_jobs j SET payload = '{}'::jsonb, last_error = 'retention_expired'
    FROM expired e WHERE j.id = e.id;
  WITH expired AS (
    SELECT j.id FROM coexistence_jobs j
    WHERE wacrm_pilot_worker.allowed(j) AND j.status IN ('pending', 'processing')
      AND (j.status = 'pending' OR j.lease_until <= now())
      AND (j.attempts >= 5 OR j.created_at < now() - interval '7 days')
    ORDER BY j.created_at LIMIT 100 FOR UPDATE SKIP LOCKED
  ) UPDATE coexistence_jobs j SET status = 'quarantined', completed_at = now(),
      last_error = 'retry_expired', lease_token = NULL, lease_until = NULL,
      payload = CASE WHEN j.created_at < now() - interval '7 days' THEN '{}'::jsonb ELSE j.payload END
    FROM expired e WHERE j.id = e.id;
  RETURN QUERY WITH ready AS (
    SELECT j.id FROM coexistence_jobs j
    WHERE wacrm_pilot_worker.allowed(j) AND ((j.status = 'pending' AND j.available_at <= now())
      OR (j.status = 'processing' AND j.lease_until <= now()))
      AND j.attempts < 5 AND j.created_at >= now() - interval '7 days'
    ORDER BY j.available_at, j.created_at, j.id LIMIT p_limit FOR UPDATE SKIP LOCKED
  ) UPDATE coexistence_jobs j SET status = 'processing', attempts = j.attempts + 1,
      lease_token = gen_random_uuid(), lease_until = now() + interval '2 minutes'
    FROM ready r WHERE j.id = r.id RETURNING j.id, j.payload, j.lease_token;
END;
$$;

CREATE FUNCTION wacrm_pilot_worker.coexistence_commit(p_job_id uuid,p_lease_token uuid,p_operations jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT FROM public.coexistence_jobs j WHERE j.id=p_job_id AND j.lease_token=p_lease_token AND wacrm_pilot_worker.allowed(j)) THEN RETURN 'stale'; END IF;
 IF jsonb_typeof(p_operations) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'invalid operations'; END IF;
 IF EXISTS(SELECT FROM jsonb_array_elements(p_operations) o WHERE o->>'source'='history' OR o->>'kind' IN ('contact','hydration','progress')) THEN RAISE EXCEPTION 'inbox-only operations'; END IF;
 RETURN public.coexistence_commit(p_job_id,p_lease_token,p_operations);
END $$;
CREATE FUNCTION wacrm_pilot_worker.coexistence_fail(p_job_id uuid,p_lease_token uuid,p_code text,p_quarantine boolean) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT FROM public.coexistence_jobs j WHERE j.id=p_job_id AND j.lease_token=p_lease_token AND wacrm_pilot_worker.allowed(j)) THEN RETURN 'stale'; END IF;
 RETURN public.coexistence_fail(p_job_id,p_lease_token,p_code,p_quarantine);
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA wacrm_pilot_worker FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.claim_managed_inbox_reply(p_account uuid, p_conversation uuid,
  p_request uuid, p_config uuid, p_generation uuid, p_session uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL
    OR p_session IS NULL OR p_request IS NULL OR auth.jwt()->>'session_id' IS DISTINCT FROM p_session::text
    OR NOT EXISTS (SELECT 1 FROM auth.sessions WHERE id=p_session AND user_id=auth.uid()
      AND (not_after IS NULL OR not_after>statement_timestamp()))
    OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id=auth.uid() AND account_id=p_account
      AND account_role IN ('owner','admin','agent'))
    OR NOT EXISTS (SELECT 1 FROM public.conversations c
      JOIN public.contacts contact ON contact.id=c.contact_id AND contact.account_id=c.account_id
      JOIN public.whatsapp_config w ON w.account_id=c.account_id
      WHERE c.id=p_conversation AND c.account_id=p_account AND w.id=p_config
        AND w.coexistence_generation=p_generation AND w.status='connected'
        AND wacrm_pilot_worker.binding_current(w.id,w.account_id,w.coexistence_generation))
    OR NOT EXISTS (SELECT 1 FROM public.messages WHERE conversation_id=p_conversation
      AND sender_type='customer' AND message_source<>'history' AND message_id IS NOT NULL
      AND created_at > statement_timestamp()-interval '24 hours' AND created_at <= statement_timestamp())
  THEN RETURN 'denied'; END IF;
  INSERT INTO public.managed_inbox_reply_claims VALUES (auth.uid(),p_request) ON CONFLICT DO NOTHING;
  IF FOUND THEN RETURN 'claimed'; END IF;
  RETURN 'duplicate';
END $$;
COMMIT;
