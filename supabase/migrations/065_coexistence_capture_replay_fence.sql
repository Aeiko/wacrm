-- Ordinary delivery receipts survive reconnects: exact webhook retries keep their original epoch.
-- Config FOR UPDATE locks serialize the cross-generation receipt check with all captures.
CREATE INDEX coexistence_jobs_delivery_receipt ON public.coexistence_jobs(config_id, dedupe_key);

CREATE OR REPLACE FUNCTION public.coexistence_capture(p_app_id text, p_deliveries jsonb, p_partner_business_id text)
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
    -- Receipt identity is independent of verification epochs. A retry must never adopt a new epoch.
    -- Scrubbed jobs remain tombstones; raw retention must not erase replay protection.
    IF NOT lifecycle THEN
      IF EXISTS (
        SELECT 1 FROM coexistence_jobs WHERE config_id=c.id AND dedupe_key=d->>'dedupe_key'
          AND payload <> '{}'::jsonb AND payload IS DISTINCT FROM d->'payload'
      ) THEN RAISE EXCEPTION 'coexistence_dedupe_payload_mismatch'; END IF;
      IF EXISTS (
        SELECT 1 FROM coexistence_jobs WHERE config_id=c.id AND dedupe_key=d->>'dedupe_key'
      ) THEN CONTINUE; END IF;
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
