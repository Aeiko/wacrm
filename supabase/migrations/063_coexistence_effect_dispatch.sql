-- Each lease covers exactly one stage. A started stage is never automatically replayed.
ALTER TABLE public.coexistence_live_effects
  DROP CONSTRAINT coexistence_live_effects_state_check,
  ADD CONSTRAINT coexistence_live_effects_state_check
    CHECK (state IN ('pending','leased','running','completed','ambiguous','stale')),
  ADD COLUMN stage integer NOT NULL DEFAULT 0 CHECK (stage BETWEEN 0 AND 9),
  ADD COLUMN lease_token uuid,
  ADD COLUMN lease_until timestamptz,
  ADD COLUMN action_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN content_consumed boolean NOT NULL DEFAULT false,
  ADD COLUMN outcomes jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(outcomes) = 'array' AND jsonb_array_length(outcomes) <= 10),
  ADD COLUMN last_error text CHECK (last_error IN ('binding_changed','identity_changed','inbound_expired','inbound_future','lease_expired','execution_uncertain'));
CREATE INDEX coexistence_effects_ready ON public.coexistence_live_effects(created_at, message_id)
  WHERE state IN ('pending','leased','running');
COMMENT ON TABLE public.coexistence_live_effects IS
  'Service-only staged dispatch; ambiguous stages require reconciliation, never automatic replay.';

-- Internal predicate shared by all transitions; no message text enters audit/error fields.
CREATE FUNCTION public.coexistence_effect_error(p_message_id uuid, p_app_id text)
RETURNS text LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN c.id IS NULL OR c.coexistence_generation IS DISTINCT FROM e.generation
      OR c.coexistence_app_id IS DISTINCT FROM p_app_id OR nullif(p_app_id, '') IS NULL
      OR c.coexistence_verified_at IS NULL OR c.status <> 'connected'
      OR nullif(c.access_token, '') IS NULL OR nullif(c.phone_number_id, '') IS NULL
      OR nullif(c.waba_id, '') IS NULL THEN 'binding_changed'
    WHEN cv.account_id IS DISTINCT FROM c.account_id OR ct.account_id IS DISTINCT FROM c.account_id
      OR ct.id IS NULL OR m.sender_type <> 'customer' OR m.message_source <> 'cloud_api'
      OR nullif(m.message_id, '') IS NULL
      OR (nullif(ct.phone_normalized, '') IS NULL AND nullif(ct.wa_user_id, '') IS NULL)
      OR NOT EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = c.user_id AND p.account_id = c.account_id)
      THEN 'identity_changed'
    -- shortcut: expire the whole effect, including webhooks, until delayed webhook delivery is separated from bot reply eligibility.
    WHEN m.created_at < now() - interval '24 hours' THEN 'inbound_expired'
    WHEN NOT isfinite(m.created_at) OR m.created_at > now() + interval '5 minutes' THEN 'inbound_future'
    ELSE NULL END
  FROM coexistence_live_effects e JOIN messages m ON m.id = e.message_id
  LEFT JOIN whatsapp_config c ON c.id = e.config_id
  LEFT JOIN conversations cv ON cv.id = m.conversation_id
  LEFT JOIN contacts ct ON ct.id = cv.contact_id WHERE e.message_id = p_message_id;
$$;

CREATE FUNCTION public.coexistence_effect_claim(p_app_id text, p_limit integer DEFAULT 1)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE candidate record; e coexistence_live_effects%ROWTYPE; c whatsapp_config%ROWTYPE;
  result jsonb := '[]'; err text;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 5 OR nullif(p_app_id, '') IS NULL THEN
    RAISE EXCEPTION 'coexistence_invalid_claim';
  END IF;
  -- Filter before the cap: blocked conversations/other apps consume no candidate slots or row locks.
  FOR candidate IN
    SELECT x.message_id, x.config_id FROM coexistence_live_effects x
    JOIN whatsapp_config wc ON wc.id = x.config_id
    JOIN messages m ON m.id = x.message_id
    WHERE (wc.coexistence_app_id = p_app_id OR wc.coexistence_app_id IS NULL)
      AND (x.state = 'pending' OR (x.state IN ('leased','running') AND x.lease_until <= now()))
      AND (x.state = 'running' OR coexistence_effect_error(x.message_id, p_app_id) IS NOT NULL
        OR NOT EXISTS (
          SELECT 1 FROM coexistence_live_effects earlier JOIN messages em ON em.id = earlier.message_id
          WHERE em.conversation_id = m.conversation_id
            AND (earlier.created_at, earlier.message_id) < (x.created_at, x.message_id)
            AND earlier.state NOT IN ('completed','stale')
        ))
    ORDER BY x.created_at, x.message_id LIMIT 100
  LOOP
    SELECT * INTO c FROM whatsapp_config WHERE id = candidate.config_id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN CONTINUE; END IF;
    SELECT * INTO e FROM coexistence_live_effects WHERE message_id = candidate.message_id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND OR NOT (e.state = 'pending' OR (e.state IN ('leased','running') AND e.lease_until <= now())) THEN CONTINUE; END IF;
    -- Recheck app scope after acquiring the config lock; rotations may race selection.
    IF c.coexistence_app_id IS NOT NULL AND c.coexistence_app_id IS DISTINCT FROM p_app_id THEN CONTINUE; END IF;
    err := coexistence_effect_error(e.message_id, p_app_id);
    IF e.state = 'running' THEN
      UPDATE coexistence_live_effects SET state = 'ambiguous', last_error = coalesce(err, 'lease_expired'),
        lease_until = NULL WHERE message_id = e.message_id;
    ELSIF err IS NOT NULL THEN
      UPDATE coexistence_live_effects SET state = 'stale', last_error = err,
        lease_token = NULL, lease_until = NULL WHERE message_id = e.message_id;
    ELSIF NOT EXISTS (
      SELECT 1 FROM coexistence_live_effects earlier JOIN messages em ON em.id = earlier.message_id
      JOIN messages current_message ON current_message.id = e.message_id
      WHERE em.conversation_id = current_message.conversation_id
        AND (earlier.created_at, earlier.message_id) < (e.created_at, e.message_id)
        AND earlier.state NOT IN ('completed','stale')
    ) THEN
      UPDATE coexistence_live_effects SET state = 'leased', lease_token = gen_random_uuid(),
        lease_until = now() + interval '2 minutes', last_error = NULL WHERE message_id = e.message_id
        RETURNING * INTO e;
      result := result || jsonb_build_array(jsonb_build_object('message_id', e.message_id, 'lease_token', e.lease_token));
    END IF;
    EXIT WHEN jsonb_array_length(result) >= p_limit;
  END LOOP;
  RETURN result;
END;
$$;

CREATE FUNCTION public.coexistence_effect_begin(p_message_id uuid, p_lease_token uuid, p_app_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE e coexistence_live_effects%ROWTYPE; c whatsapp_config%ROWTYPE; err text; result jsonb;
BEGIN
  SELECT wc.* INTO c FROM whatsapp_config wc JOIN coexistence_live_effects x ON x.config_id = wc.id
    WHERE x.message_id = p_message_id FOR UPDATE OF wc;
  SELECT * INTO e FROM coexistence_live_effects WHERE message_id = p_message_id FOR UPDATE;
  IF NOT FOUND OR p_lease_token IS NULL OR e.lease_token IS DISTINCT FROM p_lease_token THEN
    RETURN '{"status":"stale"}'; END IF;
  IF e.state IN ('completed','ambiguous','stale') THEN RETURN jsonb_build_object('status', e.state); END IF;
  err := coexistence_effect_error(p_message_id, p_app_id);
  IF e.state = 'running' THEN
    -- A repeated begin cannot authorize a second execution, even with the same token.
    UPDATE coexistence_live_effects SET state = 'ambiguous', last_error = coalesce(err, 'execution_uncertain'),
      lease_until = NULL WHERE message_id = p_message_id;
    RETURN '{"status":"ambiguous"}';
  END IF;
  IF err IS NOT NULL THEN
    UPDATE coexistence_live_effects SET state = 'stale', last_error = err, lease_until = NULL
      WHERE message_id = p_message_id;
    RETURN '{"status":"stale"}';
  END IF;
  IF e.state <> 'leased' OR e.lease_until IS NULL OR e.lease_until <= now() THEN RETURN '{"status":"stale"}'; END IF;
  UPDATE coexistence_live_effects SET state = 'running' WHERE message_id = p_message_id;
  SELECT jsonb_build_object('status','running','stage',e.stage,'action_id',e.action_id,
    'content_consumed',e.content_consumed,'account_id',c.account_id,'config_owner_user_id',c.user_id,
    'conversation_id',m.conversation_id,'contact_id',cv.contact_id,'whatsapp_message_id',m.message_id,
    'content_type',m.content_type,'content_text',m.content_text,'interactive_reply_id',m.interactive_reply_id,
    'was_new_contact',e.was_new_contact,'was_new_conversation',e.was_new_conversation,
    'was_first_inbound',e.was_first_inbound,'occurred_at',m.created_at)
    INTO result FROM messages m JOIN conversations cv ON cv.id = m.conversation_id WHERE m.id = p_message_id;
  RETURN result;
END;
$$;

CREATE FUNCTION public.coexistence_effect_settle(p_message_id uuid, p_lease_token uuid, p_stage integer,
  p_status text, p_consumed boolean DEFAULT false)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE e coexistence_live_effects%ROWTYPE; c whatsapp_config%ROWTYPE; err text; next_state text;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('completed','ambiguous') THEN RAISE EXCEPTION 'coexistence_invalid_outcome'; END IF;
  SELECT wc.* INTO c FROM whatsapp_config wc JOIN coexistence_live_effects x ON x.config_id = wc.id
    WHERE x.message_id = p_message_id FOR UPDATE OF wc;
  SELECT * INTO e FROM coexistence_live_effects WHERE message_id = p_message_id FOR UPDATE;
  IF NOT FOUND OR p_lease_token IS NULL OR e.lease_token IS DISTINCT FROM p_lease_token
    OR e.state <> 'running' OR e.stage IS DISTINCT FROM p_stage THEN RETURN 'stale'; END IF;
  err := coexistence_effect_error(p_message_id, c.coexistence_app_id);
  IF err IS NOT NULL OR e.lease_until IS NULL OR e.lease_until <= now() THEN
    UPDATE coexistence_live_effects SET state = 'ambiguous', last_error = coalesce(err, 'lease_expired'),
      lease_until = NULL WHERE message_id = p_message_id;
    RETURN 'ambiguous';
  END IF;
  next_state := CASE WHEN p_status = 'ambiguous' THEN 'ambiguous' WHEN e.stage = 9 THEN 'completed' ELSE 'pending' END;
  UPDATE coexistence_live_effects SET state = next_state,
    outcomes = outcomes || jsonb_build_array(jsonb_build_object('stage',e.stage,'action_id',e.action_id,'status',p_status)),
    content_consumed = content_consumed OR (p_status = 'completed' AND e.stage IN (1,2) AND coalesce(p_consumed,false)),
    stage = CASE WHEN next_state = 'pending' THEN stage + 1 ELSE stage END,
    action_id = CASE WHEN next_state = 'pending' THEN gen_random_uuid() ELSE action_id END,
    lease_token = NULL, lease_until = NULL,
    last_error = CASE WHEN next_state = 'ambiguous' THEN 'execution_uncertain' ELSE NULL END
    WHERE message_id = p_message_id;
  RETURN next_state;
END;
$$;

ALTER FUNCTION public.coexistence_effect_error(uuid,text) OWNER TO postgres;
ALTER FUNCTION public.coexistence_effect_claim(text,integer) OWNER TO postgres;
ALTER FUNCTION public.coexistence_effect_begin(uuid,uuid,text) OWNER TO postgres;
ALTER FUNCTION public.coexistence_effect_settle(uuid,uuid,integer,text,boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.coexistence_effect_error(uuid,text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.coexistence_effect_claim(text,integer), public.coexistence_effect_begin(uuid,uuid,text),
  public.coexistence_effect_settle(uuid,uuid,integer,text,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.coexistence_effect_claim(text,integer), public.coexistence_effect_begin(uuid,uuid,text),
  public.coexistence_effect_settle(uuid,uuid,integer,text,boolean) TO service_role;
