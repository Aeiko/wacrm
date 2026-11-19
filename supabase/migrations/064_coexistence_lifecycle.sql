-- Lifecycle authority follows Meta's account_update reference (retrieved 2026-11-17):
-- https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_update
CREATE OR REPLACE FUNCTION public.coexistence_rotate_generation()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF current_user NOT IN ('postgres', 'service_role') THEN
    IF (TG_OP = 'INSERT' AND (NEW.coexistence_app_id IS NOT NULL OR NEW.coexistence_verified_at IS NOT NULL))
      OR (TG_OP = 'UPDATE' AND ROW(NEW.coexistence_app_id, NEW.coexistence_verified_at, NEW.coexistence_generation)
        IS DISTINCT FROM ROW(OLD.coexistence_app_id, OLD.coexistence_verified_at, OLD.coexistence_generation)) THEN
      RAISE EXCEPTION 'coexistence_binding_service_only' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.coexistence_generation := gen_random_uuid();
  ELSIF ROW(NEW.access_token, NEW.verify_token, NEW.phone_number_id, NEW.waba_id, NEW.account_id, NEW.user_id,
      NEW.status, NEW.coexistence_app_id, NEW.coexistence_verified_at)
    IS DISTINCT FROM ROW(OLD.access_token, OLD.verify_token, OLD.phone_number_id, OLD.waba_id, OLD.account_id, OLD.user_id,
      OLD.status, OLD.coexistence_app_id, OLD.coexistence_verified_at) THEN
    NEW.coexistence_generation := gen_random_uuid();
    IF ROW(NEW.access_token, NEW.phone_number_id, NEW.waba_id, NEW.account_id, NEW.user_id, NEW.status, NEW.coexistence_app_id)
      IS DISTINCT FROM ROW(OLD.access_token, OLD.phone_number_id, OLD.waba_id, OLD.account_id, OLD.user_id, OLD.status, OLD.coexistence_app_id)
      AND NEW.coexistence_verified_at IS NOT DISTINCT FROM OLD.coexistence_verified_at THEN
      NEW.coexistence_verified_at := NULL;
    END IF;
  ELSE
    NEW.coexistence_generation := OLD.coexistence_generation;
  END IF;
  RETURN NEW;
END;
$$;

-- Keep the managed marker: deleting it must not reopen the legacy registration path.
CREATE POLICY coexistence_bound_config_delete_guard ON public.whatsapp_config
  AS RESTRICTIVE FOR DELETE TO authenticated USING (coexistence_app_id IS NULL);

-- Generation-independent tombstones outlive raw job retention; no raw webhook data here.
CREATE TABLE public.coexistence_lifecycle_evidence (
  config_id uuid NOT NULL REFERENCES public.whatsapp_config(id) ON DELETE CASCADE,
  dedupe_key text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 256),
  event text NOT NULL CHECK (event IN ('PARTNER_REMOVED','PARTNER_APP_UNINSTALLED','ACCOUNT_OFFBOARDED',
    'PARTNER_ADDED','PARTNER_APP_INSTALLED','ACCOUNT_RECONNECTED','unknown')),
  action text NOT NULL CHECK (action IN ('stop','require_verification','ignored','quarantined')),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (config_id, dedupe_key)
);
ALTER TABLE public.coexistence_lifecycle_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.coexistence_lifecycle_evidence FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.coexistence_lifecycle_evidence TO service_role;

CREATE FUNCTION public.coexistence_capture(p_app_id text, p_deliveries jsonb, p_partner_business_id text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d jsonb; c whatsapp_config%ROWTYPE; change jsonb; v jsonb; ev text; action text;
  inner_waba text; target text; inserted integer; n integer := 0; lifecycle boolean; job_status text;
BEGIN
  IF nullif(p_app_id, '') IS NULL OR jsonb_typeof(p_deliveries) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_deliveries) NOT BETWEEN 1 AND 1000
    OR octet_length(p_deliveries::text) > 8388608 THEN
    RAISE EXCEPTION 'coexistence_invalid_deliveries';
  END IF;
  -- Lock and validate the entire batch before any rotation. No lock upgrades or order-dependent intake.
  FOR d IN SELECT value FROM jsonb_array_elements(p_deliveries) ORDER BY (value->>'config_id')::uuid LOOP
    SELECT * INTO c FROM whatsapp_config WHERE id = (d->>'config_id')::uuid FOR UPDATE;
    IF NOT FOUND OR c.account_id IS DISTINCT FROM (d->>'account_id')::uuid
      OR c.coexistence_generation IS DISTINCT FROM (d->>'generation')::uuid
      OR c.waba_id IS DISTINCT FROM d->>'waba_id' OR nullif(c.waba_id, '') IS NULL
      OR c.phone_number_id IS DISTINCT FROM d->>'phone_number_id' OR nullif(c.phone_number_id, '') IS NULL
      OR c.coexistence_app_id IS DISTINCT FROM p_app_id
      OR NOT EXISTS (SELECT 1 FROM profiles WHERE user_id=c.user_id AND account_id=c.account_id) THEN
      RAISE EXCEPTION 'coexistence_unverified_binding';
    END IF;
    IF jsonb_typeof(d->'payload') NOT IN ('object', 'array') OR d->'payload' IS NULL
      OR octet_length((d->'payload')::text) > 4194304
      OR coalesce(length(d->>'dedupe_key'), 0) NOT BETWEEN 1 AND 256 THEN
      RAISE EXCEPTION 'coexistence_invalid_delivery';
    END IF;
    -- account_update must be isolated, never smuggled into the ordinary import/legacy lane.
    lifecycle := EXISTS (SELECT 1 FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(d#>'{payload,deliveries}')='array' THEN d#>'{payload,deliveries}' ELSE '[]'::jsonb END
    ) x WHERE x->>'field'='account_update');
    IF lifecycle AND jsonb_array_length(d#>'{payload,deliveries}') <> 1 THEN
      RAISE EXCEPTION 'coexistence_invalid_delivery';
    END IF;
    job_status := CASE WHEN lifecycle OR c.status <> 'connected' OR c.coexistence_verified_at IS NULL
      THEN 'quarantined' ELSE 'pending' END;
    INSERT INTO coexistence_jobs(config_id, account_id, generation, payload, dedupe_key, status, completed_at, last_error)
      VALUES(c.id, c.account_id, c.coexistence_generation, d->'payload', d->>'dedupe_key', job_status,
        CASE WHEN job_status='quarantined' THEN now() END,
        CASE WHEN NOT lifecycle AND job_status='quarantined' THEN 'binding_paused' END)
      ON CONFLICT (config_id, generation, dedupe_key) DO NOTHING;
    GET DIAGNOSTICS inserted = ROW_COUNT;
    n := n + inserted;
    IF inserted=0 AND EXISTS (
      SELECT 1 FROM coexistence_jobs WHERE config_id=c.id AND generation=c.coexistence_generation
        AND dedupe_key=d->>'dedupe_key' AND payload <> '{}'::jsonb AND payload IS DISTINCT FROM d->'payload'
    ) THEN RAISE EXCEPTION 'coexistence_dedupe_payload_mismatch'; END IF;
  END LOOP;
  -- All normal rows are durable in their originating epoch before lifecycle state changes.
  FOR d IN SELECT value FROM jsonb_array_elements(p_deliveries) ORDER BY (value->>'config_id')::uuid LOOP
    change := d#>'{payload,deliveries,0}';
    IF change->>'field' IS DISTINCT FROM 'account_update' THEN CONTINUE; END IF;
    SELECT * INTO c FROM whatsapp_config WHERE id=(d->>'config_id')::uuid;
    v := change->'value'; ev := v->>'event'; inner_waba := nullif(v#>>'{waba_info,waba_id}', '');
    action := 'quarantined';
    IF ev IN ('PARTNER_REMOVED','PARTNER_ADDED') THEN
      target := nullif(d->>'entry_id','');
      IF inner_waba IS NOT NULL AND target ~ '^[0-9]+$' AND p_partner_business_id ~ '^[0-9]+$' THEN
        action := CASE WHEN inner_waba <> c.waba_id OR target <> p_partner_business_id THEN 'ignored'
          WHEN ev='PARTNER_REMOVED' THEN 'stop' ELSE 'require_verification' END;
      END IF;
    ELSIF ev IN ('PARTNER_APP_UNINSTALLED','PARTNER_APP_INSTALLED') THEN
      target := nullif(v#>>'{waba_info,partner_app_id}','');
      IF inner_waba IS NOT NULL AND target IS NOT NULL THEN
        action := CASE WHEN inner_waba <> c.waba_id OR target <> p_app_id THEN 'ignored'
          WHEN ev='PARTNER_APP_UNINSTALLED' THEN 'stop' ELSE 'require_verification' END;
      END IF;
    ELSIF ev IN ('ACCOUNT_OFFBOARDED','ACCOUNT_RECONNECTED') THEN
      target := nullif(d->>'entry_id','');
      IF target IS NOT NULL THEN
        action := CASE WHEN target <> c.waba_id OR (inner_waba IS NOT NULL AND inner_waba <> c.waba_id) THEN 'ignored'
          WHEN ev='ACCOUNT_OFFBOARDED' THEN 'stop' ELSE 'require_verification' END;
      END IF;
    END IF;
    INSERT INTO coexistence_lifecycle_evidence(config_id,dedupe_key,event,action)
      VALUES(c.id,d->>'dedupe_key',CASE WHEN ev IN ('PARTNER_REMOVED','PARTNER_APP_UNINSTALLED','ACCOUNT_OFFBOARDED',
        'PARTNER_ADDED','PARTNER_APP_INSTALLED','ACCOUNT_RECONNECTED') THEN ev ELSE 'unknown' END,action)
      ON CONFLICT (config_id,dedupe_key) DO UPDATE SET action=EXCLUDED.action
        WHERE coexistence_lifecycle_evidence.action='quarantined'
          AND coexistence_lifecycle_evidence.event=EXCLUDED.event
          AND EXCLUDED.action IN ('stop','require_verification');
    GET DIAGNOSTICS inserted = ROW_COUNT;
    SELECT e.action INTO action FROM coexistence_lifecycle_evidence e
      WHERE e.config_id=c.id AND e.dedupe_key=d->>'dedupe_key';
    IF inserted=1 THEN
      IF action='stop' THEN
        UPDATE whatsapp_config SET status='disconnected',coexistence_verified_at=NULL WHERE id=c.id;
      ELSIF action='require_verification' THEN
        UPDATE whatsapp_config SET coexistence_verified_at=NULL WHERE id=c.id;
      END IF;
    END IF;
    UPDATE coexistence_jobs SET status=CASE WHEN action='quarantined' THEN 'quarantined' ELSE 'completed' END,
      completed_at=now(),last_error=CASE WHEN action='quarantined' THEN 'lifecycle_target_unknown' ELSE NULL END
      WHERE config_id=c.id AND generation=(d->>'generation')::uuid AND dedupe_key=d->>'dedupe_key';
  END LOOP;
  RETURN n;
END;
$$;
CREATE OR REPLACE FUNCTION public.coexistence_capture(p_app_id text, p_deliveries jsonb)
RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.coexistence_capture(p_app_id, p_deliveries, NULL);
$$;
ALTER FUNCTION public.coexistence_capture(text,jsonb,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.coexistence_capture(text,jsonb,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.coexistence_capture(text,jsonb,text) TO service_role;

-- No backfill: NULL is the legacy origin, not permission to adopt a later binding.
ALTER TABLE public.flow_runs ADD COLUMN send_config_id uuid, ADD COLUMN send_generation uuid,
  ADD CONSTRAINT flow_runs_send_epoch_pair CHECK ((send_config_id IS NULL) = (send_generation IS NULL));
ALTER TABLE public.automation_logs ADD COLUMN send_config_id uuid, ADD COLUMN send_generation uuid,
  ADD CONSTRAINT automation_logs_send_epoch_pair CHECK ((send_config_id IS NULL) = (send_generation IS NULL));
ALTER TABLE public.automation_pending_executions ADD COLUMN send_config_id uuid, ADD COLUMN send_generation uuid,
  ADD CONSTRAINT automation_pending_send_epoch_pair CHECK ((send_config_id IS NULL) = (send_generation IS NULL));
ALTER TABLE public.broadcasts ADD COLUMN send_config_id uuid, ADD COLUMN send_generation uuid,
  ADD CONSTRAINT broadcasts_send_epoch_pair CHECK ((send_config_id IS NULL) = (send_generation IS NULL));

CREATE FUNCTION public.coexistence_queue_epoch()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE c whatsapp_config%ROWTYPE; l automation_logs%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.account_id,NEW.user_id,NEW.send_config_id,NEW.send_generation)
      IS DISTINCT FROM ROW(OLD.account_id,OLD.user_id,OLD.send_config_id,OLD.send_generation)
      OR (TG_TABLE_NAME='automation_pending_executions' AND
        to_jsonb(NEW)->'log_id' IS DISTINCT FROM to_jsonb(OLD)->'log_id') THEN
      RAISE EXCEPTION 'coexistence_immutable_send_epoch' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME='broadcasts' THEN
    SELECT * INTO c FROM whatsapp_config WHERE account_id=NEW.account_id FOR SHARE;
    NEW.send_config_id := NULL; NEW.send_generation := NULL;
    IF c.coexistence_app_id IS NOT NULL THEN
      NEW.send_config_id := c.id; NEW.send_generation := c.coexistence_generation;
    END IF;
  ELSE
    IF current_user NOT IN ('postgres','service_role') AND (NEW.send_config_id IS NOT NULL OR NEW.send_generation IS NOT NULL) THEN
      RAISE EXCEPTION 'coexistence_epoch_service_only' USING ERRCODE='42501';
    END IF;
    IF TG_TABLE_NAME='automation_pending_executions' THEN
      IF NEW.log_id IS NOT NULL THEN
        SELECT * INTO l FROM automation_logs WHERE id=NEW.log_id FOR SHARE;
        IF NOT FOUND OR l.account_id IS DISTINCT FROM NEW.account_id THEN
          RAISE EXCEPTION 'coexistence_log_account_mismatch' USING ERRCODE='23514';
        END IF;
        IF (NEW.send_config_id IS NOT NULL OR NEW.send_generation IS NOT NULL)
          AND ROW(NEW.send_config_id,NEW.send_generation) IS DISTINCT FROM ROW(l.send_config_id,l.send_generation) THEN
          RAISE EXCEPTION 'coexistence_log_epoch_mismatch' USING ERRCODE='23514';
        END IF;
        NEW.send_config_id := l.send_config_id; NEW.send_generation := l.send_generation;
        -- The originating config may since have moved or been deleted; the immutable log is authority.
        RETURN NEW;
      END IF;
    END IF;
    IF NEW.send_config_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM whatsapp_config WHERE id=NEW.send_config_id AND account_id=NEW.account_id
    ) THEN RAISE EXCEPTION 'coexistence_epoch_account_mismatch' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER coexistence_queue_epoch BEFORE INSERT OR UPDATE ON public.flow_runs
  FOR EACH ROW EXECUTE FUNCTION public.coexistence_queue_epoch();
CREATE TRIGGER coexistence_queue_epoch BEFORE INSERT OR UPDATE ON public.automation_logs
  FOR EACH ROW EXECUTE FUNCTION public.coexistence_queue_epoch();
CREATE TRIGGER coexistence_queue_epoch BEFORE INSERT OR UPDATE ON public.automation_pending_executions
  FOR EACH ROW EXECUTE FUNCTION public.coexistence_queue_epoch();
CREATE TRIGGER coexistence_queue_epoch BEFORE INSERT OR UPDATE ON public.broadcasts
  FOR EACH ROW EXECUTE FUNCTION public.coexistence_queue_epoch();
ALTER FUNCTION public.coexistence_queue_epoch() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.coexistence_queue_epoch() FROM PUBLIC, anon, authenticated, service_role;

-- Existing RLS leaves engine queues service-writable only; broadcast RLS remains account-scoped.
REVOKE INSERT, UPDATE, DELETE ON public.flow_runs, public.automation_logs, public.automation_pending_executions FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.coexistence_effect_begin(p_message_id uuid, p_lease_token uuid, p_app_id text)
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
    'config_id',e.config_id,'generation',e.generation,
    'content_consumed',e.content_consumed,'account_id',c.account_id,'config_owner_user_id',c.user_id,
    'conversation_id',m.conversation_id,'contact_id',cv.contact_id,'whatsapp_message_id',m.message_id,
    'content_type',m.content_type,'content_text',m.content_text,'interactive_reply_id',m.interactive_reply_id,
    'was_new_contact',e.was_new_contact,'was_new_conversation',e.was_new_conversation,
    'was_first_inbound',e.was_first_inbound,'occurred_at',m.created_at)
    INTO result FROM messages m JOIN conversations cv ON cv.id = m.conversation_id WHERE m.id = p_message_id;
  RETURN result;
END;
$$;

