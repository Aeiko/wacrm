BEGIN;
CREATE TABLE public.managed_inbox_reply_claims (
  actor_id uuid NOT NULL,
  request_id uuid NOT NULL,
  PRIMARY KEY (actor_id, request_id)
);
REVOKE ALL ON public.managed_inbox_reply_claims FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE public.managed_inbox_reply_claims ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION public.claim_managed_inbox_reply(p_account uuid, p_conversation uuid,
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
        AND w.coexistence_app_id IS NOT NULL AND w.coexistence_verified_at IS NOT NULL)
    OR NOT EXISTS (SELECT 1 FROM public.messages WHERE conversation_id=p_conversation
      AND sender_type='customer' AND message_source<>'history' AND message_id IS NOT NULL
      AND created_at > statement_timestamp()-interval '24 hours' AND created_at <= statement_timestamp())
  THEN RETURN 'denied'; END IF;
  INSERT INTO public.managed_inbox_reply_claims VALUES (auth.uid(),p_request) ON CONFLICT DO NOTHING;
  IF FOUND THEN RETURN 'claimed'; END IF;
  RETURN 'duplicate';
END $$;
REVOKE ALL ON FUNCTION public.claim_managed_inbox_reply(uuid,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_managed_inbox_reply(uuid,uuid,uuid,uuid,uuid,uuid) TO authenticated;
COMMIT;
