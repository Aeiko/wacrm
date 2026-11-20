-- Durable, service-only coexistence intake. RPC results: capture = inserted count;
-- commit/fail = completed, quarantined, pending, or stale (no lease ownership).
ALTER TABLE public.whatsapp_config
  ADD COLUMN IF NOT EXISTS coexistence_app_id text,
  ADD COLUMN IF NOT EXISTS coexistence_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS coexistence_generation uuid NOT NULL DEFAULT gen_random_uuid();

CREATE OR REPLACE FUNCTION public.coexistence_rotate_generation()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  -- Membership permits ordinary configuration edits, never self-attested binding.
  IF current_user NOT IN ('postgres', 'service_role') THEN
    IF (TG_OP = 'INSERT' AND (NEW.coexistence_app_id IS NOT NULL OR NEW.coexistence_verified_at IS NOT NULL))
      OR (TG_OP = 'UPDATE' AND ROW(NEW.coexistence_app_id, NEW.coexistence_verified_at)
        IS DISTINCT FROM ROW(OLD.coexistence_app_id, OLD.coexistence_verified_at)) THEN
      RAISE EXCEPTION 'coexistence_binding_service_only' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.access_token, NEW.verify_token, NEW.phone_number_id, NEW.waba_id, NEW.account_id, NEW.status,
           NEW.coexistence_app_id, NEW.coexistence_verified_at)
      IS DISTINCT FROM ROW(OLD.access_token, OLD.verify_token, OLD.phone_number_id, OLD.waba_id, OLD.account_id, OLD.status,
           OLD.coexistence_app_id, OLD.coexistence_verified_at) THEN
      NEW.coexistence_generation := gen_random_uuid();
      -- Replacing credentials invalidates old verification unless explicitly reverified.
      IF ROW(NEW.access_token, NEW.phone_number_id, NEW.waba_id, NEW.account_id, NEW.status)
        IS DISTINCT FROM ROW(OLD.access_token, OLD.phone_number_id, OLD.waba_id, OLD.account_id, OLD.status)
        AND NEW.coexistence_verified_at IS NOT DISTINCT FROM OLD.coexistence_verified_at THEN
        NEW.coexistence_verified_at := NULL;
      END IF;
    ELSE
      NEW.coexistence_generation := OLD.coexistence_generation;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS coexistence_rotate_generation ON public.whatsapp_config;
CREATE TRIGGER coexistence_rotate_generation BEFORE INSERT OR UPDATE ON public.whatsapp_config
  FOR EACH ROW EXECUTE FUNCTION public.coexistence_rotate_generation();

ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS message_source text NOT NULL DEFAULT 'cloud_api';
-- Realtime UPDATE consumers need the previous source to distinguish live promotion from status changes.
ALTER TABLE public.messages REPLICA IDENTITY FULL;
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_message_source_check;
ALTER TABLE public.messages ADD CONSTRAINT messages_message_source_check
  CHECK (message_source IN ('history', 'phone_app', 'cloud_api'));

CREATE TABLE IF NOT EXISTS public.coexistence_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id uuid NOT NULL REFERENCES public.whatsapp_config(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  generation uuid NOT NULL,
  payload jsonb NOT NULL,
  dedupe_key text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 256),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'quarantined')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (config_id, generation, dedupe_key)
);
CREATE INDEX IF NOT EXISTS coexistence_jobs_ready ON public.coexistence_jobs(available_at, created_at)
  WHERE status IN ('pending', 'processing');
DROP INDEX IF EXISTS public.coexistence_jobs_retention;
CREATE INDEX coexistence_jobs_retention ON public.coexistence_jobs(created_at)
  WHERE status IN ('completed', 'quarantined') AND payload <> '{}'::jsonb;

CREATE TABLE IF NOT EXISTS public.coexistence_message_metadata (
  message_id uuid PRIMARY KEY REFERENCES public.messages(id) ON DELETE CASCADE,
  media_id text,
  media_type text,
  placeholder boolean NOT NULL DEFAULT false,
  reply_wamid text
);
CREATE TABLE IF NOT EXISTS public.coexistence_contact_state (
  config_id uuid NOT NULL REFERENCES public.whatsapp_config(id) ON DELETE CASCADE,
  generation uuid NOT NULL,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  source_at timestamptz NOT NULL,
  action text NOT NULL CHECK (action IN ('add', 'remove')),
  managed_name text,
  PRIMARY KEY (config_id, generation, contact_id)
);
CREATE TABLE IF NOT EXISTS public.coexistence_progress (
  config_id uuid NOT NULL REFERENCES public.whatsapp_config(id) ON DELETE CASCADE,
  generation uuid NOT NULL,
  phase integer,
  chunk_order integer,
  progress integer,
  error_code integer,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (config_id, generation)
);
ALTER TABLE public.coexistence_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coexistence_message_metadata ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coexistence_contact_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coexistence_progress ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.coexistence_jobs, public.coexistence_message_metadata,
  public.coexistence_contact_state, public.coexistence_progress FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.coexistence_jobs, public.coexistence_message_metadata,
  public.coexistence_contact_state, public.coexistence_progress TO service_role;

CREATE OR REPLACE FUNCTION public.coexistence_capture(p_app_id text, p_deliveries jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d jsonb; c whatsapp_config%ROWTYPE; n integer := 0; inserted integer;
BEGIN
  IF nullif(p_app_id, '') IS NULL OR jsonb_typeof(p_deliveries) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_deliveries) NOT BETWEEN 1 AND 1000
    OR octet_length(p_deliveries::text) > 8388608 THEN
    RAISE EXCEPTION 'coexistence_invalid_deliveries';
  END IF;
  -- Consistent ordering avoids capture/capture deadlocks for mixed deliveries.
  FOR d IN SELECT value FROM jsonb_array_elements(p_deliveries) ORDER BY value->>'config_id' LOOP
    SELECT * INTO c FROM whatsapp_config WHERE id = (d->>'config_id')::uuid FOR SHARE;
    IF NOT FOUND OR c.account_id IS DISTINCT FROM (d->>'account_id')::uuid
      OR c.coexistence_generation IS DISTINCT FROM (d->>'generation')::uuid
      OR c.waba_id IS DISTINCT FROM d->>'waba_id' OR nullif(c.waba_id, '') IS NULL
      OR c.phone_number_id IS DISTINCT FROM d->>'phone_number_id'
      OR c.coexistence_app_id IS DISTINCT FROM p_app_id OR c.coexistence_verified_at IS NULL
      OR c.status <> 'connected' THEN
      RAISE EXCEPTION 'coexistence_unverified_binding';
    END IF;
    IF jsonb_typeof(d->'payload') NOT IN ('object', 'array') OR d->'payload' IS NULL
      OR octet_length((d->'payload')::text) > 4194304
      OR coalesce(length(d->>'dedupe_key'), 0) NOT BETWEEN 1 AND 256 THEN
      RAISE EXCEPTION 'coexistence_invalid_delivery';
    END IF;
    INSERT INTO coexistence_jobs(config_id, account_id, generation, payload, dedupe_key)
      VALUES(c.id, c.account_id, c.coexistence_generation, d->'payload', d->>'dedupe_key')
      ON CONFLICT (config_id, generation, dedupe_key) DO NOTHING;
    GET DIAGNOSTICS inserted = ROW_COUNT;
    n := n + inserted;
  END LOOP;
  RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION public.coexistence_claim(p_limit integer)
RETURNS TABLE(id uuid, payload jsonb, lease_token uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 5 THEN
    RAISE EXCEPTION 'coexistence_invalid_limit';
  END IF;
  -- Keep dedupe tombstones; measure raw retention from intake, not completion.
  WITH expired AS (
    SELECT j.id FROM coexistence_jobs j
    WHERE j.created_at < now() - interval '7 days' AND j.status IN ('completed', 'quarantined')
      AND j.payload <> '{}'::jsonb ORDER BY j.created_at LIMIT 100 FOR UPDATE SKIP LOCKED
  ) UPDATE coexistence_jobs j SET payload = '{}'::jsonb, last_error = 'retention_expired'
    FROM expired e WHERE j.id = e.id;
  WITH expired AS (
    SELECT j.id FROM coexistence_jobs j
    WHERE j.status IN ('pending', 'processing')
      AND (j.status = 'pending' OR j.lease_until <= now())
      AND (j.attempts >= 5 OR j.created_at < now() - interval '7 days')
    ORDER BY j.created_at LIMIT 100 FOR UPDATE SKIP LOCKED
  ) UPDATE coexistence_jobs j SET status = 'quarantined', completed_at = now(),
      last_error = 'retry_expired', lease_token = NULL, lease_until = NULL,
      payload = CASE WHEN j.created_at < now() - interval '7 days' THEN '{}'::jsonb ELSE j.payload END
    FROM expired e WHERE j.id = e.id;
  RETURN QUERY WITH ready AS (
    SELECT j.id FROM coexistence_jobs j
    WHERE ((j.status = 'pending' AND j.available_at <= now())
      OR (j.status = 'processing' AND j.lease_until <= now()))
      AND j.attempts < 5 AND j.created_at >= now() - interval '7 days'
    ORDER BY j.available_at, j.created_at, j.id LIMIT p_limit FOR UPDATE SKIP LOCKED
  ) UPDATE coexistence_jobs j SET status = 'processing', attempts = j.attempts + 1,
      lease_token = gen_random_uuid(), lease_until = now() + interval '2 minutes'
    FROM ready r WHERE j.id = r.id RETURNING j.id, j.payload, j.lease_token;
END;
$$;

-- One resolver for contacts and message participants. Caller holds the config lock;
-- unique indexes still arbitrate concurrent writes by the ordinary live webhook.
CREATE OR REPLACE FUNCTION public.coexistence_resolve_contact(p_account_id uuid, p_user_id uuid, p_identity jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE phone_key text := regexp_replace(coalesce(p_identity->>'phone', ''), '\D', '', 'g');
  bsuid text := nullif(p_identity->>'wa_user_id', '');
  by_phone contacts%ROWTYPE; by_bsuid contacts%ROWTYPE; chosen contacts%ROWTYPE;
BEGIN
  IF phone_key = '' AND bsuid IS NULL THEN
    RAISE EXCEPTION 'identity_missing' USING ERRCODE = 'P2001';
  END IF;
  SELECT * INTO by_phone FROM contacts WHERE account_id = p_account_id AND phone_normalized = phone_key AND phone_key <> '' FOR UPDATE;
  SELECT * INTO by_bsuid FROM contacts WHERE account_id = p_account_id AND wa_user_id = bsuid FOR UPDATE;
  IF (by_phone.id IS NOT NULL AND by_bsuid.id IS NOT NULL AND by_phone.id <> by_bsuid.id)
    OR (by_phone.wa_user_id IS NOT NULL AND bsuid IS NOT NULL AND by_phone.wa_user_id <> bsuid)
    OR (by_bsuid.phone_normalized <> '' AND phone_key <> '' AND by_bsuid.phone_normalized <> phone_key) THEN
    RAISE EXCEPTION 'identity_conflict' USING ERRCODE = 'P2001';
  END IF;
  IF by_bsuid.id IS NOT NULL THEN chosen := by_bsuid; ELSE chosen := by_phone; END IF;
  IF chosen.id IS NULL THEN
    INSERT INTO contacts(account_id, user_id, phone, wa_user_id, wa_parent_user_id, wa_username)
    VALUES(p_account_id, p_user_id, phone_key, bsuid, nullif(p_identity->>'wa_parent_user_id', ''), nullif(p_identity->>'wa_username', ''))
    RETURNING * INTO chosen;
  ELSE
    UPDATE contacts SET phone = CASE WHEN phone_normalized = '' THEN phone_key ELSE phone END,
      wa_user_id = coalesce(wa_user_id, bsuid),
      wa_parent_user_id = coalesce(wa_parent_user_id, nullif(p_identity->>'wa_parent_user_id', ''))
    WHERE id = chosen.id;
  END IF;
  RETURN chosen.id;
EXCEPTION WHEN unique_violation THEN
  -- Retry the whole leased transaction; never create a second identity on a race.
  RAISE EXCEPTION 'identity_race' USING ERRCODE = '40001';
END;
$$;

CREATE OR REPLACE FUNCTION public.coexistence_commit(p_job_id uuid, p_lease_token uuid, p_operations jsonb)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE j coexistence_jobs%ROWTYPE; c whatsapp_config%ROWTYPE; op jsonb; contact uuid;
  conv uuid; msg messages%ROWTYPE; stamp timestamptz; managed text; old_state coexistence_contact_state%ROWTYPE;
  source text; normalized_status text; reply_id uuid; code text;
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
        END IF;
        INSERT INTO coexistence_message_metadata(message_id, media_id, media_type, placeholder)
        VALUES(msg.id, op->>'media_id', op->>'media_type', false)
        ON CONFLICT (message_id) DO UPDATE SET media_id = EXCLUDED.media_id, media_type = EXCLUDED.media_type, placeholder = false;
      ELSIF op->>'kind' IN ('message', 'contact') THEN
        stamp := (op->>'occurred_at')::timestamptz;
        IF stamp IS NULL OR NOT isfinite(stamp) THEN RAISE EXCEPTION 'invalid_timestamp' USING ERRCODE = 'P2001'; END IF;
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
          IF source IS NULL OR source NOT IN ('history', 'phone_app') OR nullif(op->>'wamid', '') IS NULL
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
          SELECT id INTO conv FROM conversations WHERE account_id = j.account_id AND contact_id = contact FOR UPDATE;
          IF EXISTS (SELECT 1 FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
            WHERE cv.account_id = j.account_id AND m.message_id = op->>'wamid' AND cv.id <> conv) THEN
            RAISE EXCEPTION 'message_identity_conflict' USING ERRCODE = 'P2001';
          END IF;
          SELECT id INTO reply_id FROM messages WHERE conversation_id = conv AND message_id = op->>'reply_wamid';
          INSERT INTO messages(conversation_id, sender_type, content_type, content_text, message_id, status, created_at, message_source, reply_to_message_id)
          VALUES(conv, op->>'sender_type', op->>'content_type', op->>'content_text', op->>'wamid', normalized_status, stamp, source, reply_id)
          ON CONFLICT (conversation_id, message_id) DO NOTHING;
          SELECT * INTO msg FROM messages WHERE conversation_id = conv AND message_id = op->>'wamid' FOR UPDATE;
          IF msg.sender_type <> op->>'sender_type' THEN RAISE EXCEPTION 'direction_conflict' USING ERRCODE = 'P2001'; END IF;
          IF msg.message_source <> 'cloud_api' THEN
            UPDATE messages SET
              content_type = CASE WHEN coalesce((op->>'placeholder')::boolean, false) THEN content_type ELSE op->>'content_type' END,
              content_text = CASE WHEN coalesce((op->>'placeholder')::boolean, false) THEN content_text ELSE coalesce(op->>'content_text', content_text) END,
              -- Match message-status.ts: failure is terminal, but cannot replace delivery/read.
              status = CASE
                WHEN status = 'failed' THEN status
                WHEN normalized_status = 'failed' AND status IN ('sending', 'sent') THEN 'failed'
                WHEN array_position(ARRAY['sending','sent','delivered','read'], normalized_status)
                  > array_position(ARRAY['sending','sent','delivered','read'], status) THEN normalized_status
                ELSE status END,
              message_source = CASE WHEN source = 'phone_app' THEN 'phone_app' ELSE message_source END,
              reply_to_message_id = coalesce(reply_to_message_id, reply_id)
            WHERE id = msg.id;
          END IF;
          INSERT INTO coexistence_message_metadata(message_id, media_id, media_type, placeholder, reply_wamid)
          VALUES(msg.id, op->>'media_id', op->>'media_type', coalesce((op->>'placeholder')::boolean, false), op->>'reply_wamid')
          ON CONFLICT (message_id) DO UPDATE SET
            media_id = CASE WHEN EXCLUDED.placeholder AND NOT coexistence_message_metadata.placeholder
              THEN coexistence_message_metadata.media_id ELSE coalesce(EXCLUDED.media_id, coexistence_message_metadata.media_id) END,
            media_type = CASE WHEN EXCLUDED.placeholder AND NOT coexistence_message_metadata.placeholder
              THEN coexistence_message_metadata.media_type ELSE coalesce(EXCLUDED.media_type, coexistence_message_metadata.media_type) END,
            placeholder = coexistence_message_metadata.placeholder AND EXCLUDED.placeholder,
            reply_wamid = coalesce(coexistence_message_metadata.reply_wamid, EXCLUDED.reply_wamid);
          -- Resolve reply context in either arrival order, scoped to this conversation.
          UPDATE messages m SET reply_to_message_id = msg.id FROM coexistence_message_metadata md
            WHERE md.message_id = m.id AND md.reply_wamid = msg.message_id
              AND m.conversation_id = conv AND m.message_source <> 'cloud_api' AND m.reply_to_message_id IS NULL;
          UPDATE conversations cv SET last_message_at = m.created_at, last_message_text = m.content_text
            FROM messages m WHERE m.id = msg.id AND cv.id = conv
              AND (cv.last_message_at IS NULL OR m.created_at > cv.last_message_at);
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

CREATE OR REPLACE FUNCTION public.coexistence_fail(p_job_id uuid, p_lease_token uuid, p_code text, p_quarantine boolean)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE j coexistence_jobs%ROWTYPE; next_status text;
BEGIN
  SELECT * INTO j FROM coexistence_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR j.status <> 'processing' OR j.lease_token IS DISTINCT FROM p_lease_token
    OR j.lease_until <= now() THEN RETURN 'stale'; END IF;
  next_status := CASE WHEN coalesce(p_quarantine, false) OR j.attempts >= 5 THEN 'quarantined' ELSE 'pending' END;
  UPDATE coexistence_jobs SET status = next_status, lease_token = NULL, lease_until = NULL,
    -- Only the fixed diagnostic vocabulary is persisted, never exception/body text.
    last_error = CASE WHEN p_code IN ('decode_failed','commit_failed','worker_failed','hydration_parent_missing','unsupported_payload')
      THEN p_code ELSE 'processing_failed' END,
    available_at = now() + make_interval(secs => 30 * j.attempts),
    completed_at = CASE WHEN next_status = 'quarantined' THEN now() ELSE NULL END WHERE id = j.id;
  RETURN next_status;
END;
$$;

CREATE OR REPLACE FUNCTION public.track_conversation_message_times()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.message_source = 'history' THEN RETURN NULL; END IF;
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND OLD.message_source = 'history') THEN
    IF NEW.sender_type = 'customer' THEN
      UPDATE conversations SET last_inbound_at = greatest(last_inbound_at, NEW.created_at) WHERE id = NEW.conversation_id;
    ELSIF (NEW.sender_type = 'agent' OR NEW.ai_generated) AND NEW.status <> 'failed' THEN
      UPDATE conversations SET last_reply_at = greatest(last_reply_at, NEW.created_at) WHERE id = NEW.conversation_id;
    END IF;
  ELSIF NEW.status = 'failed' AND OLD.status <> 'failed' AND (NEW.sender_type = 'agent' OR NEW.ai_generated) THEN
    UPDATE conversations SET last_reply_at = (
      SELECT max(m.created_at) FROM messages m WHERE m.conversation_id = NEW.conversation_id
        AND m.message_source <> 'history' AND (m.sender_type = 'agent' OR m.ai_generated) AND m.status <> 'failed'
    ) WHERE id = NEW.conversation_id;
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS messages_track_conversation_times ON public.messages;
CREATE TRIGGER messages_track_conversation_times AFTER INSERT OR UPDATE OF status, message_source ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.track_conversation_message_times();

ALTER FUNCTION public.coexistence_rotate_generation() OWNER TO postgres;
ALTER FUNCTION public.coexistence_capture(text, jsonb) OWNER TO postgres;
ALTER FUNCTION public.coexistence_claim(integer) OWNER TO postgres;
ALTER FUNCTION public.coexistence_resolve_contact(uuid, uuid, jsonb) OWNER TO postgres;
ALTER FUNCTION public.coexistence_commit(uuid, uuid, jsonb) OWNER TO postgres;
ALTER FUNCTION public.coexistence_fail(uuid, uuid, text, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.coexistence_rotate_generation(), public.track_conversation_message_times(),
  public.coexistence_resolve_contact(uuid, uuid, jsonb), public.coexistence_capture(text, jsonb),
  public.coexistence_claim(integer), public.coexistence_commit(uuid, uuid, jsonb),
  public.coexistence_fail(uuid, uuid, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.coexistence_capture(text, jsonb), public.coexistence_claim(integer),
  public.coexistence_commit(uuid, uuid, jsonb), public.coexistence_fail(uuid, uuid, text, boolean) TO service_role;
