-- A claim authorizes one external dispatch, not a retryable lease/preflight.
-- Keep config identity as a snapshot: deleting/replacing config must not erase dedupe receipts.
ALTER TABLE public.coexistence_status_events
  DROP CONSTRAINT coexistence_status_events_config_id_fkey,
  ADD COLUMN claimed_app_id text;
CREATE INDEX coexistence_status_events_ready ON public.coexistence_status_events(created_at,id)
  WHERE state IN ('pending','running');
COMMENT ON TABLE public.coexistence_status_events IS
  'Service-only, at-most-once status dispatch. Crash/lost response after claim is ambiguous; never automatically resend. Receipts remain for the message lifetime.';

-- Internal shared fence; errors and claim context never contain credentials or message content.
CREATE FUNCTION public.coexistence_status_event_error(p_event_id uuid, p_app_id text)
RETURNS text LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT CASE
    WHEN c.id IS NULL OR a.id IS NULL OR c.account_id IS DISTINCT FROM e.account_id
      OR c.coexistence_generation IS DISTINCT FROM e.generation
      OR c.coexistence_app_id IS DISTINCT FROM p_app_id OR nullif(p_app_id,'') IS NULL
      OR c.coexistence_verified_at IS NULL OR c.status<>'connected'
      OR nullif(c.access_token,'') IS NULL OR nullif(c.phone_number_id,'') IS NULL
      OR nullif(c.waba_id,'') IS NULL THEN 'binding_changed'
    WHEN m.id IS NULL OR cv.id IS NULL OR ct.id IS NULL
      OR cv.account_id IS DISTINCT FROM e.account_id OR ct.account_id IS DISTINCT FROM e.account_id
      OR m.sender_type NOT IN ('agent','bot','ai','system') OR m.message_source IS DISTINCT FROM 'cloud_api'
      OR nullif(m.message_id,'') IS NULL
      OR NOT EXISTS (SELECT 1 FROM profiles p WHERE p.user_id=c.user_id AND p.account_id=e.account_id)
      THEN 'identity_changed'
    WHEN NOT isfinite(e.created_at) OR e.created_at>now()+interval '5 minutes'
      OR e.created_at<=now()-interval '24 hours' THEN 'event_expired'
    ELSE NULL END
  FROM coexistence_status_events e
  LEFT JOIN whatsapp_config c ON c.id=e.config_id
  LEFT JOIN accounts a ON a.id=e.account_id
  LEFT JOIN messages m ON m.id=e.message_id
  LEFT JOIN conversations cv ON cv.id=m.conversation_id
  LEFT JOIN contacts ct ON ct.id=cv.contact_id
  WHERE e.id=p_event_id;
$$;

CREATE FUNCTION public.coexistence_status_event_claim(p_app_id text, p_limit integer DEFAULT 1)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE candidate record; e coexistence_status_events%ROWTYPE; c whatsapp_config%ROWTYPE;
  result jsonb := '[]'; err text;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 5 OR nullif(p_app_id,'') IS NULL THEN
    RAISE EXCEPTION 'coexistence_invalid_claim';
  END IF;
  FOR candidate IN
    SELECT x.id,x.config_id FROM coexistence_status_events x LEFT JOIN whatsapp_config wc ON wc.id=x.config_id
    WHERE (x.state='pending' AND (wc.coexistence_app_id=p_app_id OR wc.coexistence_app_id IS NULL))
      OR (x.state='running' AND (x.lease_until IS NULL OR x.lease_until<=now()))
    ORDER BY x.created_at,x.id LIMIT 100
  LOOP
    -- Match ingestion/lifecycle lock order; recheck everything after obtaining the locks.
    SELECT * INTO c FROM whatsapp_config WHERE id=candidate.config_id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      IF EXISTS (SELECT 1 FROM whatsapp_config WHERE id=candidate.config_id) THEN CONTINUE; END IF;
    ELSE
      PERFORM 1 FROM accounts WHERE id=c.account_id FOR UPDATE SKIP LOCKED;
      IF NOT FOUND THEN CONTINUE; END IF;
    END IF;
    SELECT * INTO e FROM coexistence_status_events WHERE id=candidate.id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF e.state='running' AND (e.lease_until IS NULL OR e.lease_until<=now()) THEN
      UPDATE coexistence_status_events SET state='ambiguous',last_error='lease_expired',lease_until=NULL WHERE id=e.id;
      CONTINUE;
    END IF;
    IF e.state<>'pending' OR (c.coexistence_app_id IS NOT NULL AND c.coexistence_app_id IS DISTINCT FROM p_app_id) THEN
      CONTINUE;
    END IF;
    err := coexistence_status_event_error(e.id,p_app_id);
    IF err IS NOT NULL THEN
      UPDATE coexistence_status_events SET state='stale',last_error=err,lease_token=NULL,lease_until=NULL WHERE id=e.id;
      CONTINUE;
    END IF;
    -- RUNNING is committed with the returned authorization: a lost claim response must not resend.
    UPDATE coexistence_status_events SET state='running',lease_token=gen_random_uuid(),
      lease_until=now()+interval '2 minutes',claimed_app_id=p_app_id,last_error=NULL
      WHERE id=e.id RETURNING * INTO e;
    SELECT result || jsonb_build_array(jsonb_build_object('id',e.id,'lease_token',e.lease_token,
      'account_id',e.account_id,'whatsapp_message_id',m.message_id,'conversation_id',m.conversation_id,
      'status',e.status,'occurred_at',e.occurred_at)) INTO result FROM messages m WHERE m.id=e.message_id;
    EXIT WHEN jsonb_array_length(result)>=p_limit;
  END LOOP;
  RETURN result;
END;
$$;

CREATE FUNCTION public.coexistence_status_event_settle(p_event_id uuid, p_lease_token uuid, p_status text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e coexistence_status_events%ROWTYPE; err text; outcome text;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('completed','ambiguous') THEN
    RAISE EXCEPTION 'coexistence_invalid_outcome';
  END IF;
  PERFORM 1 FROM whatsapp_config c JOIN coexistence_status_events x ON x.config_id=c.id
    WHERE x.id=p_event_id FOR UPDATE OF c;
  PERFORM 1 FROM accounts a JOIN coexistence_status_events x ON x.account_id=a.id
    WHERE x.id=p_event_id FOR UPDATE OF a;
  SELECT * INTO e FROM coexistence_status_events WHERE id=p_event_id FOR UPDATE;
  IF NOT FOUND OR p_lease_token IS NULL OR e.lease_token IS DISTINCT FROM p_lease_token
    OR e.state<>'running' THEN RETURN 'stale'; END IF;
  err := coexistence_status_event_error(e.id,e.claimed_app_id);
  IF e.lease_until IS NULL OR e.lease_until<=now() THEN err := coalesce(err,'lease_expired'); END IF;
  outcome := CASE WHEN err IS NOT NULL OR p_status='ambiguous' THEN 'ambiguous' ELSE 'completed' END;
  UPDATE coexistence_status_events SET state=outcome,lease_until=NULL,
    last_error=CASE WHEN outcome='ambiguous' THEN coalesce(err,'execution_uncertain') END WHERE id=e.id;
  RETURN outcome;
END;
$$;

ALTER FUNCTION public.coexistence_status_event_error(uuid,text) OWNER TO postgres;
ALTER FUNCTION public.coexistence_status_event_claim(text,integer) OWNER TO postgres;
ALTER FUNCTION public.coexistence_status_event_settle(uuid,uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.coexistence_status_event_error(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.coexistence_status_event_claim(text,integer),
  public.coexistence_status_event_settle(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.coexistence_status_event_claim(text,integer),
  public.coexistence_status_event_settle(uuid,uuid,text) TO service_role;
