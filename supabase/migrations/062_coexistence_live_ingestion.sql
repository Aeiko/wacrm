-- Atomic live inbound acceptance only. Pending intents are NOT dispatched effects.
-- New operation: live_message (cloud_api/customer/delivered), MessageOperation fields
-- plus nullable interactive_reply_id. History message operations cannot use cloud_api.
CREATE TABLE public.coexistence_live_effects (
  message_id uuid PRIMARY KEY REFERENCES public.messages(id) ON DELETE CASCADE,
  config_id uuid NOT NULL REFERENCES public.whatsapp_config(id) ON DELETE CASCADE,
  generation uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'pending' CHECK (state = 'pending'),
  was_new_contact boolean NOT NULL,
  was_new_conversation boolean NOT NULL,
  was_first_inbound boolean NOT NULL
);
ALTER TABLE public.coexistence_live_effects ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.coexistence_live_effects FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.coexistence_live_effects TO service_role;
COMMENT ON TABLE public.coexistence_live_effects IS
  'Durable pending acceptance intents only; effect dispatch/recovery is a release blocker.';

CREATE OR REPLACE FUNCTION public.coexistence_commit(p_job_id uuid, p_lease_token uuid, p_operations jsonb)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE j coexistence_jobs%ROWTYPE; c whatsapp_config%ROWTYPE; op jsonb; contact uuid;
  conv uuid; msg messages%ROWTYPE; stamp timestamptz; managed text; old_state coexistence_contact_state%ROWTYPE;
  source text; normalized_status text; reply_id uuid; code text;
  is_live boolean; new_contact boolean; new_conversation boolean; first_inbound boolean;
  accepted boolean; inserted integer;
BEGIN
  -- Config first everywhere: capture, generation rotation and commit cannot race.
  SELECT wc.* INTO c FROM whatsapp_config wc JOIN coexistence_jobs cj ON cj.config_id = wc.id WHERE cj.id = p_job_id FOR UPDATE OF wc;
  SELECT * INTO j FROM coexistence_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR j.status <> 'processing' OR j.lease_token IS DISTINCT FROM p_lease_token
    OR j.lease_until <= now() THEN RETURN 'stale'; END IF;
  IF c.id IS NULL OR c.account_id <> j.account_id OR c.coexistence_generation <> j.generation
    OR c.coexistence_verified_at IS NULL OR c.coexistence_app_id IS NULL OR c.status <> 'connected' THEN
    UPDATE coexistence_jobs SET status = 'quarantined', last_error = 'binding_changed', completed_at = now(),
      lease_token = NULL, lease_until = NULL WHERE id = j.id;
    RETURN 'quarantined';
  END IF;
  IF jsonb_typeof(p_operations) IS DISTINCT FROM 'array' OR jsonb_array_length(p_operations) > 5000
    OR octet_length(p_operations::text) > 8388608 THEN RAISE EXCEPTION 'coexistence_invalid_operations'; END IF;
  -- Serialize identity creation across configs in the same account as well as this config.
  PERFORM 1 FROM accounts WHERE id = j.account_id FOR UPDATE;
  -- The subtransaction makes an unsupported operation or identity conflict all-or-nothing.
  BEGIN
    FOR op IN SELECT value FROM jsonb_array_elements(p_operations) LOOP
      IF op->>'kind' = 'quarantine' THEN
        RAISE EXCEPTION 'unsupported_payload' USING ERRCODE = 'P2001';
      ELSIF op->>'kind' = 'progress' THEN
        INSERT INTO coexistence_progress(config_id, generation, phase, chunk_order, progress, error_code)
        VALUES(c.id, j.generation, (op->>'phase')::integer, (op->>'chunk_order')::integer,
          (op->>'progress')::integer, (op->>'error_code')::integer)
        ON CONFLICT (config_id, generation) DO UPDATE SET
          phase = greatest(coexistence_progress.phase, EXCLUDED.phase),
          chunk_order = greatest(coexistence_progress.chunk_order, EXCLUDED.chunk_order),
          progress = greatest(coexistence_progress.progress, EXCLUDED.progress),
          error_code = coalesce(EXCLUDED.error_code, coexistence_progress.error_code), updated_at = now();
      ELSIF op->>'kind' = 'hydration' THEN
        IF (SELECT count(*) FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
          WHERE cv.account_id = j.account_id AND m.message_id = op->>'wamid') > 1 THEN
          RAISE EXCEPTION 'message_identity_conflict' USING ERRCODE = 'P2001';
        END IF;
        SELECT m.* INTO msg FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
          WHERE cv.account_id = j.account_id AND m.message_id = op->>'wamid' ORDER BY m.id LIMIT 1 FOR UPDATE OF m;
        IF NOT FOUND THEN RAISE EXCEPTION 'hydration_parent_missing' USING ERRCODE = '40001'; END IF;
        IF op->>'content_type' IS NULL OR op->>'content_type' NOT IN ('text','image','document','audio','video','location','interactive')
          OR nullif(op->>'media_id', '') IS NULL THEN RAISE EXCEPTION 'invalid_hydration' USING ERRCODE = 'P2001'; END IF;
        IF msg.message_source <> 'cloud_api' THEN
          UPDATE messages SET content_type = op->>'content_type', content_text = coalesce(op->>'content_text', content_text)
            WHERE id = msg.id;
          INSERT INTO coexistence_message_metadata(message_id, media_id, media_type, placeholder)
          VALUES(msg.id, op->>'media_id', op->>'media_type', false)
          ON CONFLICT (message_id) DO UPDATE SET media_id = EXCLUDED.media_id, media_type = EXCLUDED.media_type, placeholder = false;
        END IF;
      ELSIF op->>'kind' IN ('message', 'contact', 'live_message') THEN
        is_live := op->>'kind' = 'live_message';
        IF is_live THEN
          IF NOT op ?& ARRAY['kind','source','sender_type','identity','wamid','occurred_at',
              'content_type','content_text','status','reply_wamid','media_id','media_type','placeholder','interactive_reply_id']
            OR op->>'source' IS DISTINCT FROM 'cloud_api' OR op->>'sender_type' IS DISTINCT FROM 'customer'
            OR op->>'status' IS DISTINCT FROM 'delivered'
            OR jsonb_typeof(op->'identity') IS DISTINCT FROM 'object'
            OR jsonb_typeof(op->'wamid') IS DISTINCT FROM 'string' OR nullif(op->>'wamid', '') IS NULL
            OR jsonb_typeof(op->'occurred_at') IS DISTINCT FROM 'string'
            OR jsonb_typeof(op->'content_type') IS DISTINCT FROM 'string'
            OR op->>'content_type' NOT IN ('text','image','document','audio','video','location','interactive')
            OR jsonb_typeof(op->'placeholder') IS DISTINCT FROM 'boolean'
            OR EXISTS (SELECT 1 FROM unnest(ARRAY['content_text','reply_wamid','media_id','media_type','interactive_reply_id']) k
              WHERE jsonb_typeof(op->k) NOT IN ('string','null'))
            OR EXISTS (SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(op->'identity') = 'object'
                THEN op->'identity' ELSE '{}'::jsonb END) kv
              WHERE kv.key IN ('phone','wa_user_id','wa_parent_user_id','wa_username','name')
                AND jsonb_typeof(kv.value) NOT IN ('string','null')) THEN
            RAISE EXCEPTION 'invalid_live_message' USING ERRCODE = 'P2001';
          END IF;
        END IF;
        BEGIN
          stamp := (op->>'occurred_at')::timestamptz;
        EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
          IF is_live THEN RAISE EXCEPTION 'invalid_timestamp' USING ERRCODE = 'P2001'; END IF;
          RAISE;
        END;
        IF stamp IS NULL OR NOT isfinite(stamp) THEN RAISE EXCEPTION 'invalid_timestamp' USING ERRCODE = 'P2001'; END IF;
        new_contact := NOT EXISTS (SELECT 1 FROM contacts ct WHERE ct.account_id = j.account_id
          AND ((ct.phone_normalized <> '' AND ct.phone_normalized = regexp_replace(coalesce(op->'identity'->>'phone', ''), '\D', '', 'g'))
            OR ct.wa_user_id = nullif(op->'identity'->>'wa_user_id', '')));
        contact := coexistence_resolve_contact(j.account_id, c.user_id, op->'identity');
        IF op->>'kind' = 'contact' THEN
          IF op->>'action' IS NULL OR op->>'action' NOT IN ('add', 'remove') THEN
            RAISE EXCEPTION 'invalid_contact_action' USING ERRCODE = 'P2001'; END IF;
          SELECT * INTO old_state FROM coexistence_contact_state WHERE config_id = c.id AND generation = j.generation AND contact_id = contact;
          IF old_state.source_at IS NULL OR stamp > old_state.source_at
            OR (stamp = old_state.source_at AND op->>'action' = 'remove' AND old_state.action = 'add') THEN
            UPDATE contacts SET wa_username = coalesce(nullif(op->'identity'->>'wa_username', ''), wa_username)
              WHERE id = contact;
            managed := old_state.managed_name;
            IF op->>'action' = 'add' AND nullif(op->'identity'->>'name', '') IS NOT NULL THEN
              UPDATE contacts SET name = op->'identity'->>'name' WHERE id = contact
                AND (name IS NULL OR name = '' OR name = old_state.managed_name);
              IF FOUND THEN managed := op->'identity'->>'name'; END IF;
            END IF;
            INSERT INTO coexistence_contact_state(config_id, generation, contact_id, source_at, action, managed_name)
            VALUES(c.id, j.generation, contact, stamp, op->>'action', managed)
            ON CONFLICT (config_id, generation, contact_id) DO UPDATE SET source_at = EXCLUDED.source_at,
              action = EXCLUDED.action, managed_name = EXCLUDED.managed_name;
          END IF;
        ELSE
          source := op->>'source';
          IF (NOT is_live AND (source IS NULL OR source NOT IN ('history', 'phone_app'))) OR nullif(op->>'wamid', '') IS NULL
            OR op->>'sender_type' IS NULL OR op->>'sender_type' NOT IN ('customer', 'agent')
            OR (source = 'phone_app' AND op->>'sender_type' <> 'agent')
            OR op->>'content_type' IS NULL OR op->>'content_type' NOT IN ('text','image','document','audio','video','location','interactive')
            OR op->>'status' IS NULL OR op->>'status' NOT IN ('sent','delivered','read','failed','pending') THEN
            RAISE EXCEPTION 'invalid_message' USING ERRCODE = 'P2001'; END IF;
          UPDATE contacts SET name = nullif(op->'identity'->>'name', '')
            WHERE id = contact AND (name IS NULL OR name = '') AND nullif(op->'identity'->>'name', '') IS NOT NULL;
          UPDATE contacts SET wa_username = nullif(op->'identity'->>'wa_username', '')
            WHERE id = contact AND wa_username IS NULL AND nullif(op->'identity'->>'wa_username', '') IS NOT NULL;
          normalized_status := CASE WHEN op->>'status' = 'pending' THEN 'sending' ELSE op->>'status' END;
          INSERT INTO conversations(account_id, user_id, contact_id) VALUES(j.account_id, c.user_id, contact)
            ON CONFLICT (account_id, contact_id) DO NOTHING;
          GET DIAGNOSTICS inserted = ROW_COUNT;
          new_conversation := inserted = 1;
          SELECT id, first_inbound_at IS NULL INTO conv, first_inbound FROM conversations
            WHERE account_id = j.account_id AND contact_id = contact FOR UPDATE;
          IF EXISTS (SELECT 1 FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
            WHERE cv.account_id = j.account_id AND m.message_id = op->>'wamid' AND cv.id <> conv) THEN
            RAISE EXCEPTION 'message_identity_conflict' USING ERRCODE = 'P2001';
          END IF;
          SELECT m.id INTO reply_id FROM messages m WHERE m.conversation_id = conv AND m.message_id = coalesce(
            op->>'reply_wamid', (SELECT md.reply_wamid FROM coexistence_message_metadata md
              JOIN messages existing ON existing.id = md.message_id
              WHERE existing.conversation_id = conv AND existing.message_id = op->>'wamid'));
          INSERT INTO messages(conversation_id, sender_type, content_type, content_text, message_id, status, created_at, message_source, reply_to_message_id)
          VALUES(conv, op->>'sender_type', op->>'content_type', op->>'content_text', op->>'wamid', normalized_status, stamp, source, reply_id)
          ON CONFLICT (conversation_id, message_id) DO NOTHING;
          GET DIAGNOSTICS inserted = ROW_COUNT;
          SELECT * INTO msg FROM messages WHERE conversation_id = conv AND message_id = op->>'wamid' FOR UPDATE;
          accepted := is_live AND (inserted = 1 OR msg.message_source = 'history');
          IF accepted THEN
            -- Live context is authoritative, including null; only duplicates may use stored context.
            SELECT id INTO reply_id FROM messages WHERE conversation_id = conv AND message_id = op->>'reply_wamid';
          ELSIF msg.message_source = 'cloud_api' AND (NOT is_live OR EXISTS (
            SELECT 1 FROM coexistence_message_metadata WHERE message_id = msg.id)) THEN
            SELECT m.id INTO reply_id FROM messages m JOIN coexistence_message_metadata md
              ON md.message_id = msg.id AND md.reply_wamid = m.message_id
              WHERE m.conversation_id = conv;
          END IF;
          IF msg.sender_type <> op->>'sender_type' THEN RAISE EXCEPTION 'direction_conflict' USING ERRCODE = 'P2001'; END IF;
          IF msg.message_source <> 'cloud_api' OR accepted THEN
            UPDATE messages SET
              content_type = CASE WHEN accepted THEN op->>'content_type'
                WHEN coalesce((op->>'placeholder')::boolean, false) THEN content_type ELSE op->>'content_type' END,
              content_text = CASE WHEN accepted THEN op->>'content_text'
                WHEN coalesce((op->>'placeholder')::boolean, false) THEN content_text ELSE coalesce(op->>'content_text', content_text) END,
              -- Match message-status.ts: failure is terminal, but cannot replace delivery/read.
              status = CASE
                WHEN status = 'failed' THEN status
                WHEN normalized_status = 'failed' AND status IN ('sending', 'sent') THEN 'failed'
                WHEN array_position(ARRAY['sending','sent','delivered','read'], normalized_status)
                  > array_position(ARRAY['sending','sent','delivered','read'], status) THEN normalized_status
                ELSE status END,
              message_source = CASE WHEN is_live THEN 'cloud_api' WHEN source = 'phone_app' THEN 'phone_app' ELSE message_source END,
              created_at = CASE WHEN accepted THEN stamp ELSE created_at END,
              interactive_reply_id = CASE WHEN accepted THEN op->>'interactive_reply_id' ELSE interactive_reply_id END,
              reply_to_message_id = CASE WHEN accepted THEN reply_id ELSE coalesce(reply_to_message_id, reply_id) END
            WHERE id = msg.id;
          END IF;
          -- A legacy cloud row is already accepted; repair reply context without replaying effects.
          UPDATE messages SET reply_to_message_id = reply_id
            WHERE id = msg.id AND reply_to_message_id IS NULL AND reply_id IS NOT NULL;
          IF accepted THEN
            INSERT INTO coexistence_live_effects(message_id, config_id, generation,
              was_new_contact, was_new_conversation, was_first_inbound)
            VALUES(msg.id, c.id, j.generation, new_contact, new_conversation, first_inbound);
            UPDATE conversations SET unread_count = coalesce(unread_count, 0) + 1,
              status = CASE WHEN status = 'closed' THEN 'open' ELSE status END,
              first_inbound_at = coalesce(first_inbound_at, stamp)
              WHERE id = conv;
          END IF;
          -- Late history/duplicates cannot replace accepted live metadata.
          IF msg.message_source <> 'cloud_api' OR accepted OR NOT EXISTS (
            SELECT 1 FROM coexistence_message_metadata WHERE message_id = msg.id) THEN
            INSERT INTO coexistence_message_metadata(message_id, media_id, media_type, placeholder, reply_wamid)
            VALUES(msg.id, op->>'media_id', op->>'media_type', coalesce((op->>'placeholder')::boolean, false), op->>'reply_wamid')
            ON CONFLICT (message_id) DO UPDATE SET
              media_id = CASE WHEN accepted THEN EXCLUDED.media_id
                WHEN EXCLUDED.placeholder AND NOT coexistence_message_metadata.placeholder
                THEN coexistence_message_metadata.media_id ELSE coalesce(EXCLUDED.media_id, coexistence_message_metadata.media_id) END,
              media_type = CASE WHEN accepted THEN EXCLUDED.media_type
                WHEN EXCLUDED.placeholder AND NOT coexistence_message_metadata.placeholder
                THEN coexistence_message_metadata.media_type ELSE coalesce(EXCLUDED.media_type, coexistence_message_metadata.media_type) END,
              placeholder = CASE WHEN accepted THEN EXCLUDED.placeholder
                ELSE coexistence_message_metadata.placeholder AND EXCLUDED.placeholder END,
              reply_wamid = CASE WHEN accepted THEN EXCLUDED.reply_wamid
                ELSE coalesce(coexistence_message_metadata.reply_wamid, EXCLUDED.reply_wamid) END;
          END IF;
          -- Resolve reply context in either arrival order, scoped to this conversation.
          UPDATE messages m SET reply_to_message_id = msg.id FROM coexistence_message_metadata md
            WHERE md.message_id = m.id AND md.reply_wamid = msg.message_id
              AND m.conversation_id = conv AND m.reply_to_message_id IS NULL;
          UPDATE conversations cv SET last_message_at = m.created_at, last_message_text = m.content_text
            FROM messages m WHERE m.id = msg.id AND cv.id = conv
              AND (cv.last_message_at IS NULL OR m.created_at > cv.last_message_at
                OR (accepted AND m.created_at = cv.last_message_at AND NOT EXISTS (
                  SELECT 1 FROM messages other WHERE other.conversation_id = conv
                    AND other.created_at = m.created_at AND other.id <> m.id)));
        END IF;
      ELSE RAISE EXCEPTION 'unsupported_operation' USING ERRCODE = 'P2001';
      END IF;
    END LOOP;
  EXCEPTION WHEN SQLSTATE 'P2001' THEN
    GET STACKED DIAGNOSTICS code = MESSAGE_TEXT;
    UPDATE coexistence_jobs SET status = 'quarantined', last_error = code, completed_at = now(),
      lease_token = NULL, lease_until = NULL WHERE id = j.id;
    RETURN 'quarantined';
  END;
  UPDATE coexistence_jobs SET status = 'completed', completed_at = now(), lease_token = NULL,
    lease_until = NULL, last_error = NULL WHERE id = j.id;
  RETURN 'completed';
END;
$$;

ALTER FUNCTION public.coexistence_commit(uuid, uuid, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.coexistence_commit(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.coexistence_commit(uuid, uuid, jsonb) TO service_role;
