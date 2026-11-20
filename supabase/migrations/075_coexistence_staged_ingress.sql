-- Private, unassigned ingress only. No activation, replay, import or global pause.
CREATE TABLE public.coexistence_staged_receipts (
  app_id text NOT NULL,
  dedupe_key text NOT NULL CONSTRAINT coexistence_staged_key_check CHECK (length(dedupe_key) BETWEEN 1 AND 256),
  waba_id text,
  phone_number_id text,
  field text NOT NULL,
  payload jsonb,
  payload_hash text NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  raw_expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '7 days',
  tombstone_until timestamptz NOT NULL DEFAULT clock_timestamp()+interval '30 days',
  CONSTRAINT coexistence_staged_receipts_pkey PRIMARY KEY(app_id,dedupe_key),
  CONSTRAINT coexistence_staged_app_check CHECK (app_id ~ '^[1-9][0-9]{0,31}$'),
  CONSTRAINT coexistence_staged_waba_check CHECK (waba_id IS NULL OR waba_id ~ '^[1-9][0-9]{0,31}$'),
  CONSTRAINT coexistence_staged_phone_check CHECK (phone_number_id IS NULL OR phone_number_id ~ '^[1-9][0-9]{0,31}$'),
  CONSTRAINT coexistence_staged_hash_check CHECK (payload_hash ~ '^[a-f0-9]{64}$')
);
CREATE INDEX coexistence_staged_receipts_identity ON public.coexistence_staged_receipts(dedupe_key);
CREATE TABLE public.coexistence_negative_evidence (
  app_id text NOT NULL,
  waba_id text NOT NULL,
  dedupe_key text NOT NULL,
  kind text NOT NULL CONSTRAINT coexistence_negative_kind_check CHECK (kind IN ('ACCOUNT_OFFBOARDED','PARTNER_REMOVED','PARTNER_APP_UNINSTALLED')),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT coexistence_negative_evidence_pkey PRIMARY KEY(app_id,dedupe_key),
  CONSTRAINT coexistence_negative_key_check CHECK (length(dedupe_key) BETWEEN 1 AND 256)
);
CREATE INDEX coexistence_negative_evidence_target ON public.coexistence_negative_evidence(app_id,waba_id,observed_at);
ALTER TABLE public.coexistence_staged_receipts OWNER TO postgres;
ALTER TABLE public.coexistence_negative_evidence OWNER TO postgres;
ALTER TABLE public.coexistence_staged_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coexistence_negative_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.coexistence_staged_receipts,public.coexistence_negative_evidence FROM PUBLIC,anon,authenticated,service_role;

-- Never coerce nested provider IDs from JSON numbers: JavaScript may already have rounded them.
CREATE FUNCTION public.coexistence_staged_lifecycle_ids_valid(p_value jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT jsonb_typeof(p_value) IS NOT DISTINCT FROM 'object'
    AND coalesce(jsonb_typeof(p_value->'waba_info'),'null') IN ('object','null')
    AND CASE coalesce(jsonb_typeof(p_value#>'{waba_info,waba_id}'),'null')
      WHEN 'null' THEN true
      WHEN 'string' THEN connection_operation_resource_id(p_value#>>'{waba_info,waba_id}') IS NOT NULL
      ELSE false END
    AND coalesce(jsonb_typeof(p_value#>'{waba_info,partner_app_id}'),'null') IN ('string','null')
    AND CASE WHEN p_value->>'event' IN ('PARTNER_REMOVED','PARTNER_ADDED','PARTNER_APP_UNINSTALLED','PARTNER_APP_INSTALLED')
      THEN jsonb_typeof(p_value#>'{waba_info,waba_id}') IS NOT DISTINCT FROM 'string' ELSE true END
    AND CASE WHEN p_value->>'event' IN ('PARTNER_APP_UNINSTALLED','PARTNER_APP_INSTALLED')
      THEN jsonb_typeof(p_value#>'{waba_info,partner_app_id}') IS NOT DISTINCT FROM 'string' ELSE true END
$$;
CREATE FUNCTION public.coexistence_staged_target(p_entry text,p_field text,p_value jsonb)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN p_field='account_update' AND NOT coexistence_staged_lifecycle_ids_valid(p_value) THEN NULL
   ELSE connection_operation_resource_id(CASE WHEN p_field='account_update'
     AND p_value->>'event' IN ('PARTNER_REMOVED','PARTNER_ADDED','PARTNER_APP_UNINSTALLED','PARTNER_APP_INSTALLED')
     THEN p_value#>>'{waba_info,waba_id}' ELSE p_entry END) END
$$;
-- Lifecycle metadata never participates in routing, precollection or resource locks.
CREATE FUNCTION public.coexistence_staged_phone(p_field text,p_value jsonb)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT CASE WHEN p_field<>'account_update' AND jsonb_typeof(p_value#>'{metadata,phone_number_id}')='string'
    THEN connection_operation_resource_id(p_value#>>'{metadata,phone_number_id}') END
$$;
-- Validate each managed sibling before composing the atomic capture batch; malformed data
-- must not make the stricter direct-capture boundary roll back an independent signed stop.
CREATE FUNCTION public.coexistence_staged_valid_source(p_field text,p_value jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT CASE WHEN p_field='account_update' THEN true
    WHEN jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN false
    WHEN p_value ? 'metadata' THEN jsonb_typeof(p_value->'metadata')='object'
      AND coexistence_staged_phone(p_field,p_value) IS NOT NULL
    WHEN p_field IN ('messages','smb_app_state_sync','smb_message_echoes') THEN false
    WHEN p_field='history' THEN jsonb_typeof(p_value->'history')='array'
      AND jsonb_array_length(CASE WHEN jsonb_typeof(p_value->'history')='array' THEN p_value->'history' ELSE '[]'::jsonb END)>0
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_value->'history')='array'
        THEN p_value->'history' ELSE '[]'::jsonb END) h
        WHERE jsonb_typeof(h) IS DISTINCT FROM 'object'
          OR CASE WHEN jsonb_typeof(h)='object' THEN h-ARRAY['errors']::text[] ELSE '{}'::jsonb END<>'{}'::jsonb
          OR jsonb_typeof(h->'errors') IS DISTINCT FROM 'array'
          OR jsonb_array_length(CASE WHEN jsonb_typeof(h->'errors')='array' THEN h->'errors' ELSE '[]'::jsonb END)=0
          OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(h->'errors')='array' THEN h->'errors' ELSE '[]'::jsonb END) e
            WHERE jsonb_typeof(e->'code') IS DISTINCT FROM 'number' OR e->>'code' !~ '^-?[0-9]+([.]0+)?$'))
    ELSE true END
$$;
-- Authority remains exact: the configured partner/app is not inferred from a resource claim.
CREATE FUNCTION public.coexistence_staged_negative(p_app text,p_partner text,p_entry text,p_value jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE ev text:=p_value->>'event'; inner_id text:=CASE WHEN jsonb_typeof(p_value#>'{waba_info,waba_id}')='string'
  THEN p_value#>>'{waba_info,waba_id}' END; target text;
BEGIN
  IF NOT coexistence_staged_lifecycle_ids_valid(p_value) THEN RETURN NULL; END IF;
  IF ev='ACCOUNT_OFFBOARDED' AND (inner_id IS NULL OR (connection_operation_resource_id(inner_id) IS NOT NULL
    AND connection_operation_resource_id(inner_id)=connection_operation_resource_id(p_entry))) THEN target:=p_entry;
  ELSIF ev='PARTNER_REMOVED' AND connection_operation_resource_id(p_entry)=connection_operation_resource_id(p_partner)
    AND connection_operation_resource_id(p_partner) IS NOT NULL THEN target:=inner_id;
  ELSIF ev='PARTNER_APP_UNINSTALLED' AND (p_value#>>'{waba_info,partner_app_id}'=p_app OR (
    connection_operation_resource_id(p_app) IS NOT NULL AND connection_operation_resource_id(p_value#>>'{waba_info,partner_app_id}')=connection_operation_resource_id(p_app))) THEN target:=inner_id;
  END IF;
  RETURN connection_operation_resource_id(target);
END $$;
-- Positive lifecycle events need the same source/target proof, but never create or clear a negative.
CREATE FUNCTION public.coexistence_staged_lifecycle_target(p_app text,p_partner text,p_entry text,p_value jsonb)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT coexistence_staged_negative(p_app,p_partner,p_entry,CASE
    WHEN p_value->>'event' IN ('ACCOUNT_RECONNECTED','PARTNER_ADDED','PARTNER_APP_INSTALLED') THEN
      p_value||jsonb_build_object('event',CASE p_value->>'event' WHEN 'ACCOUNT_RECONNECTED' THEN 'ACCOUNT_OFFBOARDED'
        WHEN 'PARTNER_ADDED' THEN 'PARTNER_REMOVED' ELSE 'PARTNER_APP_UNINSTALLED' END)
    ELSE p_value END)
$$;
CREATE FUNCTION public.coexistence_staged_record_negative(p_app text,p_partner text,p_entry text,p_key text,p_value jsonb)
RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE target text:=coexistence_staged_negative(p_app,p_partner,p_entry,p_value); prior coexistence_negative_evidence%ROWTYPE;
  previous_timeout text:=current_setting('lock_timeout');
BEGIN
  IF target IS NULL THEN RETURN; END IF;
  IF previous_timeout='0' OR previous_timeout::interval>interval '1 millisecond' THEN PERFORM set_config('lock_timeout','1ms',true); END IF;
  INSERT INTO coexistence_negative_evidence(app_id,waba_id,dedupe_key,kind)
    VALUES(p_app,target,p_key,p_value->>'event') ON CONFLICT DO NOTHING;
  SELECT * INTO prior FROM coexistence_negative_evidence WHERE app_id=p_app AND dedupe_key=p_key;
  IF prior.waba_id IS DISTINCT FROM target OR prior.kind IS DISTINCT FROM p_value->>'event' THEN
    RAISE EXCEPTION 'coexistence_receipt_conflict' USING ERRCODE='P7501'; END IF;
  PERFORM set_config('lock_timeout',previous_timeout,true);
END $$;
CREATE FUNCTION public.coexistence_staged_media(p_value jsonb)
RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE m jsonb; slot text; media text; alias text; previous_timeout text:=current_setting('lock_timeout');
BEGIN
  IF previous_timeout='0' OR previous_timeout::interval>interval '1 millisecond' THEN PERFORM set_config('lock_timeout','1ms',true); END IF;
  FOR m IN
    SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_value->'messages')='array' THEN p_value->'messages' ELSE '[]'::jsonb END)
    UNION ALL SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_value->'message_echoes')='array' THEN p_value->'message_echoes' ELSE '[]'::jsonb END)
    UNION ALL SELECT msg.value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_value->'history')='array' THEN p_value->'history' ELSE '[]'::jsonb END) h
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(h.value->'threads')='array' THEN h.value->'threads' ELSE '[]'::jsonb END) t
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t.value->'messages')='array' THEN t.value->'messages' ELSE '[]'::jsonb END) msg
  LOOP
    -- Placeholder/unsupported message types can still carry a documented private media slot.
    FOREACH slot IN ARRAY ARRAY['image','audio','video','document','sticker'] LOOP
      IF jsonb_typeof(m#>ARRAY[slot,'id']) IS DISTINCT FROM 'string' THEN CONTINUE; END IF;
      media:=m#>>ARRAY[slot,'id'];
      IF length(media) NOT BETWEEN 1 AND 512 THEN CONTINUE; END IF;
      INSERT INTO coexistence_private_media_ids VALUES(sha256(convert_to(media,'UTF8'))) ON CONFLICT DO NOTHING;
      -- Numeric raw proxy aliases must not bypass the durable exact-string proof.
      alias:=CASE WHEN media ~ '^[0-9]+$' THEN coalesce(nullif(ltrim(media,'0'),''),'0') END;
      IF alias IS NOT NULL AND alias<>media THEN
        INSERT INTO coexistence_private_media_ids VALUES(sha256(convert_to(alias,'UTF8'))) ON CONFLICT DO NOTHING;
      END IF;
    END LOOP;
  END LOOP;
  PERFORM set_config('lock_timeout',previous_timeout,true);
END $$;
-- Keep exact-ID hashes, and consult the additional canonical proof for numeric proxy aliases.
CREATE OR REPLACE FUNCTION public.coexistence_is_private_media(p_media_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT nullif(p_media_id,'') IS NOT NULL AND EXISTS(SELECT 1 FROM coexistence_private_media_ids
    WHERE media_id_hash=sha256(convert_to(p_media_id,'UTF8')) OR (p_media_id ~ '^[0-9]+$'
      AND media_id_hash=sha256(convert_to(coalesce(nullif(ltrim(p_media_id,'0'),''),'0'),'UTF8'))))
$$;
-- Preserve every SQL071 projection/locking/timeout branch; augment only the two deny-ledger writes.
DO $$ DECLARE body text:=pg_get_functiondef('public.coexistence_project_private_media()'::regprocedure);
  marker text; replacement text; source text;
BEGIN
  FOREACH source IN ARRAY ARRAY['OLD','NEW'] LOOP
    marker:=format('VALUES(sha256(convert_to(%s.media_id,''UTF8''))) ON CONFLICT DO NOTHING;',source);
    IF (length(body)-length(replace(body,marker,'')))/length(marker)<>1 THEN
      RAISE EXCEPTION 'coexistence_private_media_projection_body_changed'; END IF;
    replacement:=marker||format(E'\n    IF %s.media_id ~ ''^[0-9]+$'' THEN\n      INSERT INTO coexistence_private_media_ids(media_id_hash)\n        VALUES(sha256(convert_to(coalesce(nullif(ltrim(%s.media_id,''0''),''''),''0''),''UTF8''))) ON CONFLICT DO NOTHING;\n    END IF;',source,source);
    body:=replace(body,marker,replacement);
  END LOOP;
  EXECUTE body;
END $$;
-- Only IDs still present in metadata can be recovered; erased padded IDs cannot be reversed from hashes.
DO $$ DECLARE previous_timeout text:=current_setting('lock_timeout'); BEGIN
  IF previous_timeout='0' OR previous_timeout::interval>interval '1 millisecond' THEN
    PERFORM set_config('lock_timeout','1ms',true); END IF;
  INSERT INTO public.coexistence_private_media_ids(media_id_hash)
    SELECT DISTINCT sha256(convert_to(coalesce(nullif(ltrim(media_id,'0'),''),'0'),'UTF8'))
    FROM public.coexistence_message_metadata WHERE media_id ~ '^[0-9]+$' ON CONFLICT DO NOTHING;
  PERFORM set_config('lock_timeout',previous_timeout,true);
END $$;
CREATE FUNCTION public.coexistence_staged_store(p_app text,p_entry text,p_field text,p_value jsonb,p_key text,p_waba text,p_phone text)
RETURNS integer LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE body jsonb:=jsonb_build_object('entry_id',p_entry,'field',p_field,'value',p_value);
  fingerprint text; prior coexistence_staged_receipts%ROWTYPE; n integer; stamp timestamptz:=clock_timestamp();
  previous_timeout text:=current_setting('lock_timeout');
BEGIN
  fingerprint:=encode(sha256(convert_to(body::text,'UTF8')),'hex');
  IF previous_timeout='0' OR previous_timeout::interval>interval '1 millisecond' THEN PERFORM set_config('lock_timeout','1ms',true); END IF;
  INSERT INTO coexistence_staged_receipts(app_id,dedupe_key,waba_id,phone_number_id,field,payload,payload_hash,captured_at,raw_expires_at,tombstone_until)
    VALUES(p_app,p_key,p_waba,p_phone,p_field,body,fingerprint,stamp,stamp+interval '7 days',stamp+interval '30 days') ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n=ROW_COUNT;
  SELECT * INTO prior FROM coexistence_staged_receipts WHERE app_id=p_app AND dedupe_key=p_key;
  IF prior.payload_hash IS DISTINCT FROM fingerprint THEN RAISE EXCEPTION 'coexistence_receipt_conflict' USING ERRCODE='P7501'; END IF;
  PERFORM set_config('lock_timeout',previous_timeout,true);
  RETURN n;
END $$;

-- A previously acquired operation does not hold advisory locks across HTTP.
ALTER FUNCTION public.connection_operation_finish(uuid,uuid,uuid,jsonb) RENAME TO connection_operation_finish_before_075;
REVOKE ALL ON FUNCTION public.connection_operation_finish_before_075(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.connection_operation_finish(p_actor_id uuid,p_operation_id uuid,p_token uuid,p_config jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o connection_operations%ROWTYPE; k text;
BEGIN
  o:=connection_operation_lock(p_actor_id,p_operation_id,p_token);
  IF o.id IS NULL THEN RETURN jsonb_build_object('status','not_found'); END IF;
  FOREACH k IN ARRAY o.resource_keys LOOP
    IF NOT pg_try_advisory_xact_lock(hashtextextended('connection-operation:'||k,0)) THEN RAISE lock_not_available; END IF;
  END LOOP;
  RETURN connection_operation_finish_before_075(p_actor_id,p_operation_id,p_token,p_config);
EXCEPTION WHEN lock_not_available THEN RETURN jsonb_build_object('status','busy');
END $$;

ALTER FUNCTION public.coexistence_capture(text,jsonb,text) RENAME TO coexistence_capture_before_075;
REVOKE ALL ON FUNCTION public.coexistence_capture_before_075(text,jsonb,text) FROM PUBLIC,anon,authenticated,service_role;
-- Keep SQL065's epoch/replay algorithm; guard JSON ID types and physical decimal identity comparisons.
-- Assert the expected body rather than silently missing an upstream lifecycle guard.
DO $$ DECLARE body text:=pg_get_functiondef('public.coexistence_capture_before_075(text,jsonb,text)'::regprocedure); BEGIN
  IF body NOT LIKE '%inner_waba <> c.waba_id%' OR body NOT LIKE '%target <> c.waba_id%'
    OR body NOT LIKE '%target <> p_partner_business_id%' OR body NOT LIKE '%target <> p_app_id%' THEN
    RAISE EXCEPTION 'coexistence_capture_lifecycle_body_changed'; END IF;
  IF (length(body)-length(replace(body,'    IF ev IN (''PARTNER_REMOVED'',''PARTNER_ADDED'') THEN','')))
    /length('    IF ev IN (''PARTNER_REMOVED'',''PARTNER_ADDED'') THEN')<>1
    OR body NOT LIKE '%inner_waba := nullif(v#>>''{waba_info,waba_id}'', '''');%'
    OR body NOT LIKE '%target := nullif(v#>>''{waba_info,partner_app_id}'','''');%' THEN
    RAISE EXCEPTION 'coexistence_capture_lifecycle_type_body_changed'; END IF;
  body:=replace(body,'    IF ev IN (''PARTNER_REMOVED'',''PARTNER_ADDED'') THEN',
    E'    IF NOT coexistence_staged_lifecycle_ids_valid(v) THEN\n      action := ''quarantined'';\n    ELSIF ev IN (''PARTNER_REMOVED'',''PARTNER_ADDED'') THEN');
  body:=replace(body,'inner_waba := nullif(v#>>''{waba_info,waba_id}'', '''');',
    'inner_waba := CASE WHEN jsonb_typeof(v#>''{waba_info,waba_id}'')=''string'' THEN nullif(v#>>''{waba_info,waba_id}'', '''') END;');
  body:=replace(body,'target := nullif(v#>>''{waba_info,partner_app_id}'','''');',
    'target := CASE WHEN jsonb_typeof(v#>''{waba_info,partner_app_id}'')=''string'' THEN nullif(v#>>''{waba_info,partner_app_id}'','''') END;');
  body:=replace(body,'inner_waba <> c.waba_id','(connection_operation_resource_id(inner_waba) IS NULL OR connection_operation_resource_id(inner_waba) IS DISTINCT FROM connection_operation_resource_id(c.waba_id))');
  body:=replace(body,'target <> c.waba_id','(connection_operation_resource_id(target) IS NULL OR connection_operation_resource_id(target) IS DISTINCT FROM connection_operation_resource_id(c.waba_id))');
  body:=replace(body,'target <> p_partner_business_id','(connection_operation_resource_id(target) IS NULL OR connection_operation_resource_id(target) IS DISTINCT FROM connection_operation_resource_id(p_partner_business_id))');
  body:=replace(body,'target <> p_app_id','(target <> p_app_id AND (connection_operation_resource_id(p_app_id) IS NULL OR connection_operation_resource_id(target) IS DISTINCT FROM connection_operation_resource_id(p_app_id)))');
  EXECUTE body;
END $$;
CREATE FUNCTION public.coexistence_capture(p_app_id text,p_deliveries jsonb,p_partner_business_id text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d jsonb; change jsonb; bound whatsapp_config%ROWTYPE; aid uuid; cid uuid; k text; phone text; target text;
  keys text[]; deliveries jsonb:='[]'::jsonb; stage_after jsonb:='[]'::jsonb; seen_jobs uuid[]; result integer;
BEGIN
  IF nullif(p_app_id,'') IS NULL OR jsonb_typeof(p_deliveries) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_deliveries) NOT BETWEEN 1 AND 1000 OR octet_length(p_deliveries::text)>8388608 THEN
    RAISE EXCEPTION 'coexistence_invalid_deliveries'; END IF;
  FOR aid IN SELECT DISTINCT account_id FROM whatsapp_config WHERE id IN
    (SELECT (value->>'config_id')::uuid FROM jsonb_array_elements(p_deliveries)) ORDER BY account_id LOOP
    -- KEY SHARE preserves SQL073's guarantee that human account gates cannot suppress lifecycle stops.
    PERFORM 1 FROM accounts WHERE id=aid FOR KEY SHARE NOWAIT;
  END LOOP;
  FOR cid IN SELECT DISTINCT (value->>'config_id')::uuid FROM jsonb_array_elements(p_deliveries) ORDER BY 1 LOOP
    PERFORM 1 FROM whatsapp_config WHERE id=cid FOR UPDATE NOWAIT;
  END LOOP;
  SELECT ARRAY(SELECT DISTINCT x FROM whatsapp_config c CROSS JOIN LATERAL unnest(ARRAY[
    'phone:'||connection_operation_resource_id(c.phone_number_id),'waba:'||connection_operation_resource_id(c.waba_id)]) x
    WHERE c.id IN (SELECT (value->>'config_id')::uuid FROM jsonb_array_elements(p_deliveries)) AND x IS NOT NULL ORDER BY x) INTO keys;
  FOREACH k IN ARRAY keys LOOP
    IF NOT pg_try_advisory_xact_lock(hashtextextended('connection-operation:'||k,0)) THEN RAISE lock_not_available; END IF;
  END LOOP;
  FOR k IN SELECT DISTINCT value->>'dedupe_key' FROM jsonb_array_elements(p_deliveries) ORDER BY 1 LOOP
    IF NOT pg_try_advisory_xact_lock(hashtextextended('coexistence-stage-receipt:'||k,0)) THEN RAISE lock_not_available; END IF;
  END LOOP;
  FOR d IN SELECT value FROM jsonb_array_elements(p_deliveries) LOOP
    SELECT * INTO bound FROM whatsapp_config WHERE id=(d->>'config_id')::uuid;
    -- Any-app private identity forbids ordinary adoption, but is not another app's observation receipt.
    IF EXISTS(SELECT 1 FROM coexistence_staged_receipts WHERE dedupe_key=d->>'dedupe_key') THEN
      IF EXISTS(SELECT 1 FROM coexistence_staged_receipts WHERE app_id=p_app_id AND dedupe_key=d->>'dedupe_key')
        OR jsonb_typeof(d#>'{payload,deliveries}') IS DISTINCT FROM 'array'
        OR jsonb_array_length(CASE WHEN jsonb_typeof(d#>'{payload,deliveries}')='array' THEN d#>'{payload,deliveries}' ELSE '[]'::jsonb END)<>1 THEN CONTINUE; END IF;
      change:=d#>'{payload,deliveries,0}';
      target:=coexistence_staged_lifecycle_target(p_app_id,p_partner_business_id,d->>'entry_id',change->'value');
      IF change->>'field' IS DISTINCT FROM 'account_update' OR target IS NULL
        OR bound.coexistence_app_id IS DISTINCT FROM p_app_id
        OR target IS DISTINCT FROM connection_operation_resource_id(bound.waba_id) THEN CONTINUE; END IF;
      stage_after:=stage_after||jsonb_build_array(d);
    END IF;
    FOR change IN SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d#>'{payload,deliveries}')='array'
      THEN d#>'{payload,deliveries}' ELSE '[]'::jsonb END) LOOP
      IF change->>'field'='account_update' THEN CONTINUE; END IF;
      phone:=connection_operation_resource_id(bound.phone_number_id); target:=connection_operation_resource_id(bound.waba_id);
      IF EXISTS(SELECT 1 FROM whatsapp_config other WHERE other.id<>bound.id AND (
        connection_operation_resource_id(other.phone_number_id)=phone OR (other.coexistence_app_id IS NOT NULL
        AND other.coexistence_app_id IS DISTINCT FROM p_app_id AND connection_operation_resource_id(other.waba_id)=target)))
        OR (change ? 'waba_id' AND connection_operation_resource_id(change->>'waba_id') IS DISTINCT FROM target)
        OR (d->>'entry_id' IS NOT NULL AND connection_operation_resource_id(d->>'entry_id') IS DISTINCT FROM target)
        OR (change->'value'->'metadata' ? 'phone_number_id' AND (
          jsonb_typeof(change#>'{value,metadata,phone_number_id}') IS DISTINCT FROM 'string'
          OR connection_operation_resource_id(change#>>'{value,metadata,phone_number_id}') IS DISTINCT FROM phone)) THEN
        RAISE EXCEPTION 'coexistence_unverified_payload_binding'; END IF;
    END LOOP;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d#>'{payload,legacy,entry}')='array'
      THEN d#>'{payload,legacy,entry}' ELSE '[]'::jsonb END) e
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e->'changes')='array' THEN e->'changes' ELSE '[]'::jsonb END) item
      WHERE item->>'field' NOT IN ('message_template_status_update','message_template_quality_update','message_template_components_update')
        OR item->>'field' IS NULL OR connection_operation_resource_id(e->>'id') IS DISTINCT FROM connection_operation_resource_id(bound.waba_id)) THEN
      RAISE EXCEPTION 'coexistence_invalid_legacy_delivery'; END IF;
    deliveries:=deliveries||jsonb_build_array(d);
  END LOOP;
  IF jsonb_array_length(deliveries)=0 THEN RETURN 0; END IF;
  -- Existing receipts (including old epochs and scrubbed/leased work) are immutable on replay.
  SELECT ARRAY(SELECT j.id FROM coexistence_jobs j WHERE EXISTS(
    SELECT 1 FROM jsonb_array_elements(deliveries) incoming
      WHERE (incoming->>'config_id')::uuid=j.config_id AND incoming->>'dedupe_key'=j.dedupe_key)) INTO seen_jobs;
  result:=coexistence_capture_before_075(p_app_id,deliveries,p_partner_business_id);
  UPDATE coexistence_jobs j SET status='quarantined',completed_at=clock_timestamp(),last_error='unsupported_field'
    WHERE NOT j.id=ANY(seen_jobs) AND j.status='pending'
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(deliveries) delivery
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(delivery#>'{payload,deliveries}')='array'
        THEN delivery#>'{payload,deliveries}' ELSE '[]'::jsonb END) item
      WHERE (delivery->>'config_id')::uuid=j.config_id AND delivery->>'dedupe_key'=j.dedupe_key
        AND (delivery->>'generation')::uuid=j.generation
        AND item->>'field' NOT IN ('messages','history','smb_app_state_sync','smb_message_echoes','account_update'));
  FOR d IN SELECT value FROM jsonb_array_elements(deliveries) LOOP
    FOR change IN SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d#>'{payload,deliveries}')='array'
      THEN d#>'{payload,deliveries}' ELSE '[]'::jsonb END) LOOP
      PERFORM coexistence_staged_media(change->'value');
      IF change->>'field'='account_update' THEN
        SELECT * INTO bound FROM whatsapp_config WHERE id=(d->>'config_id')::uuid;
        -- Old capture may keep an unrelated diagnostic, but headers A confer no authority over B.
        IF coexistence_staged_negative(p_app_id,p_partner_business_id,d->>'entry_id',change->'value')
          =connection_operation_resource_id(bound.waba_id) THEN
          PERFORM coexistence_staged_record_negative(p_app_id,p_partner_business_id,d->>'entry_id',d->>'dedupe_key',change->'value');
        END IF;
      END IF;
    END LOOP;
  END LOOP;
  -- Only after normal capture and immediate stops: future same-app retries must remain private,
  -- including after config deletion/rebinding. Foreign app receipts are never changed.
  FOR d IN SELECT value FROM jsonb_array_elements(stage_after) LOOP
    change:=d#>'{payload,deliveries,0}';
    PERFORM coexistence_staged_store(p_app_id,d->>'entry_id','account_update',change->'value',d->>'dedupe_key',
      coexistence_staged_target(d->>'entry_id','account_update',change->'value'),NULL);
  END LOOP;
  RETURN result;
END $$;
CREATE OR REPLACE FUNCTION public.coexistence_capture(p_app_id text,p_deliveries jsonb)
RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT public.coexistence_capture(p_app_id,p_deliveries,NULL)
$$;

CREATE FUNCTION public.coexistence_ingress(p_app_id text,p_partner_business_id text,p_enabled boolean,p_authorized boolean,p_changes jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE ch jsonb; c whatsapp_config%ROWTYPE; aid uuid; cid uuid; k text; waba text; phone text;
  config_ids uuid[]; account_ids uuid[]; keys text[]; matches uuid[]; managed uuid[]; phone_matches uuid[];
  entry_id text; field text; v jsonb; key text; valid_app boolean; private_field boolean; shaped boolean; template boolean;
  is_staged boolean; current_staged boolean; bound_stage_keys text[]:='{}'::text[];
  rejected integer:=200; legacy jsonb:='[]'::jsonb; batch jsonb:='[]'::jsonb; staged integer:=0; captured integer:=0;
  idx integer:=0; has_lifecycle boolean:=false; payload jsonb; candidate jsonb;
BEGIN
  IF jsonb_typeof(p_changes) IS DISTINCT FROM 'array' OR jsonb_array_length(p_changes)>1000
    OR octet_length(p_changes::text)>8388608 THEN
    RETURN jsonb_build_object('status',400,'legacy_indices','[]'::jsonb,'captured',0,'staged',0); END IF;
  valid_app:=p_app_id ~ '^[1-9][0-9]{0,31}$';
  -- Precollect all known row locks before resource locks. A new binding after this snapshot is a retry, never adoption.
  SELECT coalesce(array_agg(DISTINCT cfg.id),'{}'::uuid[]),coalesce(array_agg(DISTINCT cfg.account_id),'{}'::uuid[])
    INTO config_ids,account_ids FROM whatsapp_config cfg WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(p_changes) x
      WHERE connection_operation_resource_id(cfg.waba_id)=coexistence_staged_target(x->>'entry_id',x->>'field',x->'value')
        OR connection_operation_resource_id(cfg.phone_number_id)=coexistence_staged_phone(x->>'field',x->'value'));
  FOR aid IN SELECT unnest(account_ids) ORDER BY 1 LOOP PERFORM 1 FROM accounts WHERE id=aid FOR KEY SHARE NOWAIT; END LOOP;
  FOR cid IN SELECT unnest(config_ids) ORDER BY 1 LOOP PERFORM 1 FROM whatsapp_config WHERE id=cid FOR UPDATE NOWAIT; END LOOP;
  SELECT ARRAY(SELECT DISTINCT x FROM (
    SELECT 'waba:'||coexistence_staged_target(value->>'entry_id',value->>'field',value->'value') AS x FROM jsonb_array_elements(p_changes)
    UNION ALL SELECT 'phone:'||coexistence_staged_phone(value->>'field',value->'value') FROM jsonb_array_elements(p_changes)
    UNION ALL SELECT unnest(ARRAY['waba:'||connection_operation_resource_id(waba_id),'phone:'||connection_operation_resource_id(phone_number_id)]) FROM whatsapp_config WHERE id=ANY(config_ids)
    ) all_keys WHERE x IS NOT NULL ORDER BY x) INTO keys;
  FOREACH k IN ARRAY keys LOOP
    IF NOT pg_try_advisory_xact_lock(hashtextextended('connection-operation:'||k,0)) THEN RAISE lock_not_available; END IF;
  END LOOP;
  FOR k IN SELECT DISTINCT value->>'dedupe_key' FROM jsonb_array_elements(p_changes) WHERE value->>'dedupe_key' IS NOT NULL ORDER BY 1 LOOP
    IF NOT pg_try_advisory_xact_lock(hashtextextended('coexistence-stage-receipt:'||k,0)) THEN RAISE lock_not_available; END IF;
  END LOOP;
  FOR ch IN SELECT value FROM jsonb_array_elements(p_changes) LOOP
    entry_id:=ch->>'entry_id'; field:=ch->>'field'; v:=ch->'value'; key:=ch->>'dedupe_key';
    IF jsonb_typeof(ch) IS DISTINCT FROM 'object' OR jsonb_typeof(ch->'field') IS DISTINCT FROM 'string'
      OR length(field) NOT BETWEEN 1 AND 128 OR jsonb_typeof(ch->'dedupe_key') IS DISTINCT FROM 'string'
      OR length(key) NOT BETWEEN 1 AND 256 OR NOT ch ? 'value'
      OR (jsonb_typeof(ch->'entry_id') IS DISTINCT FROM 'string' AND jsonb_typeof(ch->'entry_id') IS DISTINCT FROM 'null')
      OR (ch ? 'invalid' AND ch->'invalid'<>'true'::jsonb) OR ch->'invalid'='true'::jsonb THEN
      rejected:=CASE WHEN rejected=200 THEN 400 ELSE rejected END; idx:=idx+1; CONTINUE;
    END IF;
    IF field='account_update' AND NOT coexistence_staged_lifecycle_ids_valid(v) THEN
      rejected:=CASE WHEN rejected=200 THEN 400 ELSE rejected END; idx:=idx+1; CONTINUE;
    END IF;
    waba:=coexistence_staged_target(entry_id,field,v);
    phone:=coexistence_staged_phone(field,v);
    private_field:=field IN ('history','smb_app_state_sync','smb_message_echoes','account_update') OR field LIKE 'smb\_%' ESCAPE '\';
    shaped:=field='messages' OR v ?| ARRAY['messages','message_echoes','history','statuses'];
    template:=field IN ('message_template_status_update','message_template_quality_update','message_template_components_update');
    SELECT EXISTS(SELECT 1 FROM coexistence_staged_receipts WHERE dedupe_key=key),
      EXISTS(SELECT 1 FROM coexistence_staged_receipts WHERE app_id=p_app_id AND dedupe_key=key)
      INTO is_staged,current_staged;
    SELECT coalesce(array_agg(id ORDER BY id),'{}'::uuid[]),coalesce(array_agg(id ORDER BY id) FILTER(WHERE coexistence_app_id IS NOT NULL),'{}'::uuid[]),
      coalesce(array_agg(id ORDER BY id) FILTER(WHERE connection_operation_resource_id(phone_number_id)=phone),'{}'::uuid[])
      INTO matches,managed,phone_matches FROM whatsapp_config
      WHERE connection_operation_resource_id(waba_id)=waba OR connection_operation_resource_id(phone_number_id)=phone;
    IF EXISTS(SELECT 1 FROM whatsapp_config WHERE id=ANY(matches) AND (NOT id=ANY(config_ids) OR NOT account_id=ANY(account_ids))) THEN RAISE lock_not_available; END IF;
    -- Unrelated fields retain the legacy handler, but never if a managed/private collision exists.
    IF NOT is_staged AND cardinality(managed)=0 AND NOT private_field AND NOT shaped THEN
      legacy:=legacy||jsonb_build_array(idx); idx:=idx+1; CONTINUE;
    END IF;
    IF NOT is_staged AND cardinality(managed)=0 AND field='messages' AND cardinality(phone_matches)=1 THEN
      SELECT * INTO c FROM whatsapp_config WHERE id=phone_matches[1];
      IF waba IS NULL OR phone IS NULL OR (c.waba_id IS NOT NULL AND connection_operation_resource_id(c.waba_id) IS DISTINCT FROM waba) THEN
        rejected:=CASE WHEN rejected=200 THEN 400 ELSE rejected END;
      ELSE legacy:=legacy||jsonb_build_array(idx); END IF;
      idx:=idx+1; CONTINUE;
    END IF;
    IF NOT coalesce(valid_app,false) OR p_enabled IS DISTINCT FROM true THEN rejected:=503; idx:=idx+1; CONTINUE; END IF;
    IF p_authorized IS DISTINCT FROM true THEN rejected:=CASE WHEN rejected=503 THEN 503 ELSE 401 END; idx:=idx+1; CONTINUE; END IF;
    -- Reject unsupported private routing IDs before any per-change write can abort a valid sibling stop.
    IF length(waba)>32 OR length(phone)>32 THEN
      rejected:=CASE WHEN rejected=200 THEN 400 ELSE rejected END; idx:=idx+1; CONTINUE;
    END IF;
    IF is_staged AND (current_staged OR field<>'account_update' OR cardinality(managed)=0
      OR coexistence_staged_lifecycle_target(p_app_id,p_partner_business_id,entry_id,v) IS NULL) THEN
      staged:=staged+coexistence_staged_store(p_app_id,entry_id,field,v,key,waba,phone);
      PERFORM coexistence_staged_media(v);
      IF field='account_update' THEN PERFORM coexistence_staged_record_negative(p_app_id,p_partner_business_id,entry_id,key,v); END IF;
      idx:=idx+1; CONTINUE;
    END IF;
    IF cardinality(managed)>0 THEN
      IF NOT coexistence_staged_valid_source(field,v) THEN
        rejected:=CASE WHEN rejected=200 THEN 400 ELSE rejected END; idx:=idx+1; CONTINUE;
      END IF;
      IF waba IS NULL OR (field<>'account_update' AND ((phone IS NOT NULL AND cardinality(phone_matches)<>1)
        OR (phone IS NULL AND cardinality(managed)<>1))) OR (field='messages' AND phone IS NULL)
        OR EXISTS(SELECT 1 FROM whatsapp_config WHERE id=ANY(managed) AND (coexistence_app_id IS DISTINCT FROM p_app_id
          OR connection_operation_resource_id(waba_id) IS DISTINCT FROM waba)) THEN
        rejected:=CASE WHEN rejected=200 THEN 403 ELSE rejected END; idx:=idx+1; CONTINUE;
      END IF;
      FOR c IN SELECT * FROM whatsapp_config WHERE id=ANY(managed)
        AND (field='account_update' OR phone IS NULL OR connection_operation_resource_id(phone_number_id)=phone) ORDER BY id LOOP
        payload:=CASE WHEN template THEN jsonb_build_object('deliveries','[]'::jsonb,'legacy',jsonb_build_object('entry',jsonb_build_array(jsonb_build_object(
          'id',entry_id,'changes',jsonb_build_array(jsonb_build_object('field',field,'value',v))))))
          ELSE jsonb_build_object('deliveries',jsonb_build_array(jsonb_build_object('waba_id',waba,'field',field,'value',v)),'legacy',jsonb_build_object('entry','[]'::jsonb)) END;
        IF octet_length(payload::text)>4194304 THEN
          rejected:=CASE WHEN rejected=200 THEN 400 ELSE rejected END; CONTINUE;
        END IF;
        candidate:=jsonb_build_object('config_id',c.id,'account_id',c.account_id,'generation',c.coexistence_generation,'entry_id',entry_id,
          'waba_id',c.waba_id,'phone_number_id',c.phone_number_id,'dedupe_key',key,'payload',payload);
        batch:=batch||jsonb_build_array(candidate);
        IF field='account_update' THEN
          has_lifecycle:=true;
          IF is_staged AND NOT current_staged THEN bound_stage_keys:=array_append(bound_stage_keys,key); END IF;
        END IF;
      END LOOP;
      IF field<>'account_update' AND phone IS NOT NULL AND NOT EXISTS(SELECT 1 FROM whatsapp_config WHERE id=ANY(managed)
        AND connection_operation_resource_id(phone_number_id)=phone) THEN rejected:=CASE WHEN rejected=200 THEN 403 ELSE rejected END; END IF;
    ELSIF cardinality(matches)>0 AND field='messages' THEN
      rejected:=CASE WHEN rejected=200 THEN 403 ELSE rejected END;
    ELSE
      staged:=staged+coexistence_staged_store(p_app_id,entry_id,field,v,key,waba,phone);
      PERFORM coexistence_staged_media(v);
      IF field='account_update' THEN PERFORM coexistence_staged_record_negative(p_app_id,p_partner_business_id,entry_id,key,v); END IF;
    END IF;
    idx:=idx+1;
  END LOOP;
  IF jsonb_array_length(batch)>0 AND (rejected=200 OR has_lifecycle) THEN
    captured:=coexistence_capture(p_app_id,batch,p_partner_business_id);
    staged:=staged+(SELECT count(*)::integer FROM coexistence_staged_receipts
      WHERE app_id=p_app_id AND dedupe_key=ANY(bound_stage_keys));
  END IF;
  RETURN jsonb_build_object('status',rejected,'legacy_indices',CASE WHEN rejected=200 THEN legacy ELSE '[]'::jsonb END,'captured',captured,'staged',staged);
EXCEPTION WHEN lock_not_available OR deadlock_detected OR unique_violation THEN
  RETURN jsonb_build_object('status',503,'legacy_indices','[]'::jsonb,'captured',0,'staged',0);
  WHEN SQLSTATE 'P7501' OR invalid_text_representation OR invalid_parameter_value OR data_exception THEN
  RETURN jsonb_build_object('status',400,'legacy_indices','[]'::jsonb,'captured',0,'staged',0);
END $$;

-- Signup fences use immutable launch time and persistent first observations under shared resource locks.
-- Negative retries never advance observation time; scrubbed raw is '{}'::jsonb (NULL also counts as scrubbed).

ALTER TABLE public.coexistence_signup_attempts ADD COLUMN launched_at timestamptz;
-- Existing dispatch receipts must never gain a newer launch window.
UPDATE public.coexistence_signup_attempts t SET launched_at=o.created_at
  FROM public.connection_operations o
  WHERE o.id=t.operation_id AND o.steps ? 'launch';

CREATE FUNCTION public.coexistence_signup_launch_time_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.launched_at IS NOT NULL THEN RAISE EXCEPTION 'signup_launch_time_private' USING ERRCODE='23514'; END IF;
  ELSIF OLD.launched_at IS NOT NULL THEN
    IF NEW.launched_at IS DISTINCT FROM OLD.launched_at THEN
      RAISE EXCEPTION 'signup_launch_time_immutable' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.launched_at IS NOT NULL THEN
    IF NOT EXISTS(SELECT 1 FROM connection_operations WHERE id=NEW.operation_id AND steps ? 'launch') THEN
      RAISE EXCEPTION 'signup_launch_not_authorized' USING ERRCODE='23514';
    END IF;
    NEW.launched_at:=clock_timestamp();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER coexistence_signup_launch_time_guard
  BEFORE INSERT OR UPDATE OF launched_at ON public.coexistence_signup_attempts
  FOR EACH ROW EXECUTE FUNCTION public.coexistence_signup_launch_time_guard();

-- Private: caller already owns SQL074's account/config/operation/attempt locks, in that order.
-- Never acquire another tenant's rows after resource keys; foreign candidate reads confer no authority.
CREATE FUNCTION public.coexistence_signup_negative_fence(p_attempt_id uuid,
  p_candidate_phone text DEFAULT NULL,p_candidate_waba text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE t coexistence_signup_attempts%ROWTYPE; o connection_operations%ROWTYPE;
  keys text[]; wabas text[]; k text; candidate_owned boolean;
BEGIN
  SELECT * INTO t FROM coexistence_signup_attempts WHERE id=p_attempt_id;
  SELECT * INTO o FROM connection_operations WHERE id=t.operation_id;
  IF t.id IS NULL OR o.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P7401'; END IF;
  SELECT ARRAY(SELECT DISTINCT x FROM unnest(o.resource_keys||ARRAY[
    'phone:'||connection_operation_resource_id(p_candidate_phone),
    'waba:'||connection_operation_resource_id(p_candidate_waba)]) x
    WHERE x IS NOT NULL ORDER BY x) INTO keys;
  FOREACH k IN ARRAY keys LOOP
    IF NOT pg_try_advisory_xact_lock(hashtextextended('connection-operation:'||k,0)) THEN
      RAISE lock_not_available;
    END IF;
  END LOOP;
  IF t.launched_at IS NULL THEN RETURN false; END IF;
  -- A selected foreign phone OR WABA must not invalidate anyone merely because it was selected.
  candidate_owned:=p_candidate_waba IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM whatsapp_config WHERE account_id<>o.original_account_id AND (
      connection_operation_resource_id(phone_number_id)=p_candidate_phone
      OR connection_operation_resource_id(waba_id)=p_candidate_waba))
    AND NOT EXISTS(SELECT 1 FROM connection_operation_resources WHERE operation_id<>o.id
      AND resource_key=ANY(ARRAY['phone:'||p_candidate_phone,'waba:'||p_candidate_waba]));
  SELECT ARRAY(SELECT DISTINCT target FROM (
    SELECT substring(resource_key FROM 6) AS target FROM connection_operation_resources
      WHERE operation_id=o.id AND resource_key LIKE 'waba:%'
    UNION ALL SELECT p_candidate_waba WHERE candidate_owned
  ) targets ORDER BY target) INTO wabas;
  IF NOT EXISTS(SELECT 1 FROM coexistence_negative_evidence e
    WHERE e.app_id=t.app_id AND e.waba_id=ANY(wabas) AND e.observed_at>=t.launched_at
      AND e.kind IN ('ACCOUNT_OFFBOARDED','PARTNER_REMOVED','PARTNER_APP_UNINSTALLED')) THEN RETURN false; END IF;
  UPDATE coexistence_signup_attempts SET access_token=NULL,reason='verification_failed' WHERE id=t.id;
  UPDATE connection_operations SET state='blocked' WHERE id=o.id AND state='active';
  RETURN true;
END $$;

CREATE FUNCTION public.coexistence_signup_fenced_lock(p_actor_id uuid,p_account_id uuid,p_session_id uuid,
  p_attempt_id uuid,p_nonce_hash text,p_fresh boolean,
  p_candidate_phone text DEFAULT NULL,p_candidate_waba text DEFAULT NULL)
RETURNS public.coexistence_signup_attempts LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE t coexistence_signup_attempts%ROWTYPE; o connection_operations%ROWTYPE; negative boolean;
BEGIN
  SELECT * INTO t FROM coexistence_signup_attempts WHERE id=p_attempt_id;
  SELECT * INTO o FROM connection_operations WHERE id=t.operation_id;
  IF t.id IS NULL OR o.actor_id IS DISTINCT FROM p_actor_id OR o.original_account_id IS DISTINCT FROM p_account_id
    OR t.session_id IS DISTINCT FROM p_session_id OR t.nonce_hash IS DISTINCT FROM p_nonce_hash THEN
    RAISE EXCEPTION USING ERRCODE='P7401';
  END IF;
  o:=connection_operation_lock(p_actor_id,o.id,o.token);
  SELECT * INTO t FROM coexistence_signup_attempts WHERE id=p_attempt_id FOR UPDATE NOWAIT;
  IF p_fresh THEN
    PERFORM 1 FROM auth.sessions WHERE id=p_session_id FOR SHARE NOWAIT;
    IF NOT coexistence_signup_owner(p_actor_id,p_account_id,p_session_id) THEN RAISE EXCEPTION USING ERRCODE='P7401'; END IF;
  END IF;
  negative:=coexistence_signup_negative_fence(t.id,
    CASE WHEN p_candidate_phone ~ '^[1-9][0-9]{0,31}$' THEN p_candidate_phone END,
    CASE WHEN p_candidate_waba ~ '^[1-9][0-9]{0,31}$' THEN p_candidate_waba END);
  -- A lifecycle stop rotates config generation: negative review takes precedence over binding conflict.
  IF p_fresh AND NOT negative AND NOT connection_operation_binding(o) THEN
    RAISE EXCEPTION USING ERRCODE='P7402'; END IF;
  IF negative THEN SELECT * INTO t FROM coexistence_signup_attempts WHERE id=p_attempt_id; END IF;
  RETURN t;
END $$;

CREATE OR REPLACE FUNCTION public.coexistence_signup_launch(p_actor_id uuid,p_account_id uuid,p_session_id uuid,p_attempt_id uuid,p_nonce_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t coexistence_signup_attempts%ROWTYPE; o connection_operations%ROWTYPE;
BEGIN
  t:=coexistence_signup_fenced_lock(p_actor_id,p_account_id,p_session_id,p_attempt_id,p_nonce_hash,true);
  IF coexistence_signup_negative_fence(t.id) THEN RETURN jsonb_build_object('status','blocked'); END IF;
  SELECT * INTO o FROM connection_operations WHERE id=t.operation_id;
  IF o.steps ? 'launch' THEN RETURN jsonb_build_object('status','duplicate','dispatch',false); END IF;
  IF o.state<>'reserved' OR t.reason IS NOT NULL THEN RETURN jsonb_build_object('status','blocked'); END IF;
  IF o.lease_until<=clock_timestamp() THEN RETURN jsonb_build_object('status','expired'); END IF;
  UPDATE connection_operations SET state='active',steps=jsonb_build_object('launch','started') WHERE id=o.id;
  UPDATE coexistence_signup_attempts SET launched_at=coalesce(launched_at,clock_timestamp()) WHERE id=t.id;
  RETURN jsonb_build_object('status','started','dispatch',true,'app_id',t.app_id,'login_config_id',t.login_config_id);
EXCEPTION WHEN lock_not_available THEN RETURN jsonb_build_object('status','busy');
  WHEN SQLSTATE 'P7401' THEN RETURN jsonb_build_object('status','forbidden');
  WHEN SQLSTATE 'P7402' THEN RETURN jsonb_build_object('status','conflict');
END $$;

CREATE OR REPLACE FUNCTION public.coexistence_signup_exchange_start(p_actor_id uuid,p_account_id uuid,p_session_id uuid,
  p_attempt_id uuid,p_nonce_hash text,p_code_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t coexistence_signup_attempts%ROWTYPE; o connection_operations%ROWTYPE;
BEGIN
  t:=coexistence_signup_fenced_lock(p_actor_id,p_account_id,p_session_id,p_attempt_id,p_nonce_hash,true);
  IF coexistence_signup_negative_fence(t.id) THEN RETURN jsonb_build_object('status','blocked'); END IF;
  IF p_code_hash IS NULL OR p_code_hash !~ '^[a-f0-9]{64}$' THEN RETURN jsonb_build_object('status','invalid'); END IF;
  SELECT * INTO o FROM connection_operations WHERE id=t.operation_id;
  IF t.code_hash IS NOT NULL THEN RETURN jsonb_build_object('status','duplicate','dispatch',false); END IF;
  IF o.state<>'active' OR o.steps->>'launch' IS DISTINCT FROM 'started' OR t.reason IS NOT NULL THEN RETURN jsonb_build_object('status','blocked'); END IF;
  UPDATE coexistence_signup_attempts SET code_hash=p_code_hash,token_deadline=clock_timestamp()+interval '1 hour' WHERE id=t.id;
  UPDATE connection_operations SET steps=steps||jsonb_build_object('exchange','started') WHERE id=o.id;
  RETURN jsonb_build_object('status','started','dispatch',true,'app_id',t.app_id,'login_config_id',t.login_config_id);
EXCEPTION WHEN lock_not_available THEN RETURN jsonb_build_object('status','busy');
  WHEN unique_violation THEN RETURN jsonb_build_object('status','conflict');
  WHEN SQLSTATE 'P7401' THEN RETURN jsonb_build_object('status','forbidden');
  WHEN SQLSTATE 'P7402' THEN RETURN jsonb_build_object('status','conflict');
END $$;

CREATE OR REPLACE FUNCTION public.coexistence_signup_store_token(p_actor_id uuid,p_account_id uuid,p_session_id uuid,
  p_attempt_id uuid,p_nonce_hash text,p_access_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t coexistence_signup_attempts%ROWTYPE;
BEGIN
  t:=coexistence_signup_fenced_lock(p_actor_id,p_account_id,p_session_id,p_attempt_id,p_nonce_hash,false);
  IF coexistence_signup_negative_fence(t.id) THEN RETURN jsonb_build_object('status','blocked'); END IF;
  IF p_access_token IS NULL OR length(p_access_token)>196666 OR p_access_token !~ '^[a-f0-9]{24}:([a-f0-9]{2})+:[a-f0-9]{32}$' THEN
    RETURN jsonb_build_object('status','invalid'); END IF;
  IF t.code_hash IS NULL OR t.token_deadline<=clock_timestamp() OR t.token_expires_at<=clock_timestamp() THEN
    UPDATE coexistence_signup_attempts SET access_token=NULL WHERE id=t.id;
    RETURN jsonb_build_object('status','expired'); END IF;
  IF t.token_hash IS NOT NULL AND t.token_hash IS DISTINCT FROM encode(sha256(convert_to(p_access_token,'UTF8')),'hex') THEN
    RETURN jsonb_build_object('status','conflict'); END IF;
  UPDATE coexistence_signup_attempts SET token_hash=encode(sha256(convert_to(p_access_token,'UTF8')),'hex'),
    access_token=CASE WHEN reason IS NULL AND coexistence_signup_owner(p_actor_id,p_account_id,p_session_id)
      THEN p_access_token END WHERE id=t.id;
  RETURN jsonb_build_object('status','recorded');
EXCEPTION WHEN lock_not_available THEN RETURN jsonb_build_object('status','busy');
  WHEN SQLSTATE 'P7401' THEN RETURN jsonb_build_object('status','forbidden');
END $$;

CREATE OR REPLACE FUNCTION public.coexistence_signup_token(p_actor_id uuid,p_account_id uuid,p_session_id uuid,p_attempt_id uuid,p_nonce_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t coexistence_signup_attempts%ROWTYPE; o connection_operations%ROWTYPE;
BEGIN
  t:=coexistence_signup_fenced_lock(p_actor_id,p_account_id,p_session_id,p_attempt_id,p_nonce_hash,true);
  IF coexistence_signup_negative_fence(t.id) THEN RETURN jsonb_build_object('status','blocked'); END IF;
  SELECT * INTO o FROM connection_operations WHERE id=t.operation_id;
  IF t.access_token IS NULL OR t.token_deadline<=clock_timestamp() OR t.token_expires_at<=clock_timestamp() THEN
    UPDATE coexistence_signup_attempts SET access_token=NULL WHERE id=t.id;
    RETURN jsonb_build_object('status','expired'); END IF;
  IF o.state<>'active' OR t.reason IS NOT NULL THEN RETURN jsonb_build_object('status','blocked'); END IF;
  RETURN jsonb_build_object('status','token','access_token',t.access_token,'intended_phone',t.intended_phone,
    'app_id',t.app_id,'login_config_id',t.login_config_id);
EXCEPTION WHEN lock_not_available THEN RETURN jsonb_build_object('status','busy');
  WHEN SQLSTATE 'P7401' THEN RETURN jsonb_build_object('status','forbidden');
  WHEN SQLSTATE 'P7402' THEN RETURN jsonb_build_object('status','conflict');
END $$;

CREATE OR REPLACE FUNCTION public.coexistence_signup_verify(p_actor_id uuid,p_account_id uuid,p_session_id uuid,p_attempt_id uuid,
  p_nonce_hash text,p_phone_number_id text,p_waba_id text,p_display_phone_number text,p_normalized_phone_number text,p_token_expires_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t coexistence_signup_attempts%ROWTYPE; o connection_operations%ROWTYPE; keys text[]; k text; candidate jsonb;
BEGIN
  t:=coexistence_signup_fenced_lock(p_actor_id,p_account_id,p_session_id,p_attempt_id,p_nonce_hash,true,p_phone_number_id,p_waba_id);
  SELECT * INTO o FROM connection_operations WHERE id=t.operation_id;
  IF p_phone_number_id IS NULL OR p_phone_number_id !~ '^[1-9][0-9]{0,31}$' OR p_waba_id IS NULL OR p_waba_id !~ '^[1-9][0-9]{0,31}$'
    OR p_normalized_phone_number IS DISTINCT FROM t.intended_phone OR p_display_phone_number IS NULL
    OR length(p_display_phone_number)>128 OR p_display_phone_number !~ '^\+?[0-9\s().-]+$' OR p_token_expires_at IS NULL
    OR NOT isfinite(p_token_expires_at) OR p_token_expires_at<=clock_timestamp() THEN RETURN jsonb_build_object('status','invalid'); END IF;
  -- Candidate keys participate before receipts or claims; a foreign candidate is never adopted.
  IF coexistence_signup_negative_fence(t.id,p_phone_number_id,p_waba_id) THEN
    RETURN jsonb_build_object('status','blocked'); END IF;
  IF o.state<>'active' OR t.reason IS NOT NULL OR t.access_token IS NULL OR t.token_deadline<=clock_timestamp()
    OR t.token_expires_at<=clock_timestamp() THEN RETURN jsonb_build_object('status','blocked'); END IF;
  candidate:=jsonb_build_object('phone_number_id',p_phone_number_id,'waba_id',p_waba_id,
    'display_phone_number',p_display_phone_number,'normalized_phone_number',p_normalized_phone_number);
  IF t.preview IS NOT NULL THEN
    IF t.preview=candidate AND t.token_expires_at=p_token_expires_at THEN RETURN jsonb_build_object('status','verified'); END IF;
    RETURN jsonb_build_object('status','conflict');
  END IF;
  IF EXISTS(SELECT 1 FROM whatsapp_config WHERE account_id<>p_account_id AND (
    connection_operation_resource_id(phone_number_id)=p_phone_number_id OR connection_operation_resource_id(waba_id)=p_waba_id)) THEN
    RETURN jsonb_build_object('status','conflict'); END IF;
  SELECT ARRAY(SELECT DISTINCT x FROM unnest(o.resource_keys||ARRAY['phone:'||p_phone_number_id,'waba:'||p_waba_id]) x ORDER BY x) INTO keys;
  FOREACH k IN ARRAY keys LOOP
    IF NOT pg_try_advisory_xact_lock(hashtextextended('connection-operation:'||k,0)) THEN RAISE lock_not_available; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM connection_operation_resources WHERE resource_key=ANY(keys) AND operation_id<>o.id) THEN
    RETURN jsonb_build_object('status','conflict'); END IF;
  INSERT INTO connection_operation_resources SELECT x,o.id FROM unnest(keys) x
    WHERE NOT EXISTS(SELECT 1 FROM connection_operation_resources WHERE resource_key=x AND operation_id=o.id);
  UPDATE connection_operations SET resource_keys=keys,phone_number_id=p_phone_number_id,waba_id=p_waba_id WHERE id=o.id RETURNING * INTO o;
  -- Locked recheck closes a previous holder finalizing after the initial binding read.
  IF NOT connection_operation_binding(o) THEN RAISE EXCEPTION USING ERRCODE='P7402'; END IF;
  UPDATE coexistence_signup_attempts SET preview=candidate,token_expires_at=p_token_expires_at WHERE id=t.id;
  RETURN jsonb_build_object('status','verified');
EXCEPTION WHEN lock_not_available OR unique_violation THEN RETURN jsonb_build_object('status','busy');
  WHEN SQLSTATE 'P7401' THEN RETURN jsonb_build_object('status','forbidden');
  WHEN SQLSTATE 'P7402' THEN RETURN jsonb_build_object('status','conflict');
END $$;

CREATE OR REPLACE FUNCTION public.coexistence_signup_confirm(p_actor_id uuid,p_account_id uuid,p_session_id uuid,p_attempt_id uuid,p_nonce_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t coexistence_signup_attempts%ROWTYPE; o connection_operations%ROWTYPE;
BEGIN
  t:=coexistence_signup_fenced_lock(p_actor_id,p_account_id,p_session_id,p_attempt_id,p_nonce_hash,true);
  IF coexistence_signup_negative_fence(t.id) THEN RETURN jsonb_build_object('status','blocked'); END IF;
  SELECT * INTO o FROM connection_operations WHERE id=t.operation_id;
  IF t.preview IS NULL OR t.reason IS NOT NULL OR o.state<>'active' OR t.access_token IS NULL
    OR t.token_expires_at<=clock_timestamp() OR t.token_deadline<=clock_timestamp() THEN RETURN jsonb_build_object('status','blocked'); END IF;
  UPDATE coexistence_signup_attempts SET confirmed_at=coalesce(confirmed_at,clock_timestamp()) WHERE id=t.id;
  RETURN jsonb_build_object('status','confirmed');
EXCEPTION WHEN lock_not_available THEN RETURN jsonb_build_object('status','busy');
  WHEN SQLSTATE 'P7401' THEN RETURN jsonb_build_object('status','forbidden');
  WHEN SQLSTATE 'P7402' THEN RETURN jsonb_build_object('status','conflict');
END $$;

CREATE OR REPLACE FUNCTION public.coexistence_signup_status(p_actor_id uuid,p_account_id uuid,p_session_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t coexistence_signup_attempts%ROWTYPE; o connection_operations%ROWTYPE; state text;
BEGIN
  PERFORM 1 FROM accounts WHERE id=p_account_id FOR NO KEY UPDATE NOWAIT;
  PERFORM 1 FROM profiles WHERE user_id=p_actor_id FOR SHARE NOWAIT;
  PERFORM 1 FROM auth.sessions WHERE id=p_session_id FOR SHARE NOWAIT;
  IF NOT coexistence_signup_owner(p_actor_id,p_account_id,p_session_id) THEN RETURN jsonb_build_object('status','forbidden'); END IF;
  SELECT x.* INTO t FROM coexistence_signup_attempts x JOIN connection_operations y ON y.id=x.operation_id
    WHERE y.original_account_id=p_account_id ORDER BY x.created_at DESC,x.id DESC LIMIT 1;
  IF t.id IS NULL THEN RETURN jsonb_build_object('status','ok','attempt',NULL); END IF;
  SELECT * INTO o FROM connection_operations WHERE id=t.operation_id;
  IF t.session_id IS DISTINCT FROM p_session_id THEN
    -- A different login cannot adopt work; provably unstarted expiry must still permit fresh admission.
    IF o.state='cancelled' OR (o.state='reserved' AND o.steps='{}'::jsonb AND o.lease_until<=clock_timestamp()) THEN
      RETURN jsonb_build_object('status','ok','attempt',NULL);
    END IF;
    RETURN jsonb_build_object('status','forbidden');
  END IF;
  t:=coexistence_signup_fenced_lock(p_actor_id,p_account_id,p_session_id,t.id,t.nonce_hash,false);
  PERFORM coexistence_signup_negative_fence(t.id);
  SELECT * INTO t FROM coexistence_signup_attempts WHERE id=t.id;
  SELECT * INTO o FROM connection_operations WHERE id=t.operation_id;
  PERFORM coexistence_signup_scrub();
  IF t.token_deadline<=clock_timestamp() OR t.token_expires_at<=clock_timestamp() THEN
    -- Scrub this row even when the bounded global batch did not reach it; expiry wins over preview/receipt.
    UPDATE coexistence_signup_attempts SET access_token=NULL WHERE id=t.id RETURNING * INTO t;
    t.reason:=coalesce(t.reason,'verification_failed');
  END IF;
  state:=CASE WHEN o.state='cancelled' OR (o.state='reserved' AND o.lease_until<=clock_timestamp()) THEN 'cancelled'
    WHEN o.state='blocked' OR t.reason IS NOT NULL THEN 'review_required' WHEN t.confirmed_at IS NOT NULL THEN 'confirmed'
    WHEN t.preview IS NOT NULL THEN 'verified' WHEN t.access_token IS NOT NULL THEN 'token_received'
    WHEN o.steps ? 'exchange' THEN 'exchanging' WHEN o.steps ? 'launch' THEN 'launch_possible' ELSE 'prepared' END;
  RETURN jsonb_build_object('status','ok','attempt',jsonb_build_object('id',t.id,'state',state,'intended_phone',t.intended_phone,
    'reason',t.reason,'preview',t.preview,'created_at',t.created_at,'lease_until',o.lease_until));
EXCEPTION WHEN lock_not_available THEN RETURN jsonb_build_object('status','busy');
  WHEN SQLSTATE 'P7401' THEN RETURN jsonb_build_object('status','forbidden');
END $$;

-- Each lane is separately bounded; neither evidence nor private-media hashes is ever deleted here.
CREATE INDEX coexistence_staged_receipts_raw_cleanup
  ON public.coexistence_staged_receipts(raw_expires_at,app_id,dedupe_key)
  WHERE payload IS NOT NULL AND payload<>'{}'::jsonb;
CREATE INDEX coexistence_staged_receipts_tombstone_cleanup
  ON public.coexistence_staged_receipts(tombstone_until,app_id,dedupe_key);
CREATE INDEX coexistence_signup_token_cleanup
  ON public.coexistence_signup_attempts(token_deadline,id) WHERE access_token IS NOT NULL;

CREATE FUNCTION public.coexistence_staged_maintenance(p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE scrubbed integer; deleted integer; tokens integer; cutoff timestamptz:=clock_timestamp();
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'coexistence_invalid_maintenance_limit' USING ERRCODE='22023';
  END IF;
  WITH batch AS (
    SELECT app_id,dedupe_key FROM coexistence_staged_receipts
    WHERE raw_expires_at<=cutoff AND payload IS NOT NULL AND payload<>'{}'::jsonb
    ORDER BY raw_expires_at,app_id,dedupe_key LIMIT p_limit FOR UPDATE SKIP LOCKED
  )
  UPDATE coexistence_staged_receipts r SET payload='{}'::jsonb FROM batch b
    WHERE r.app_id=b.app_id AND r.dedupe_key=b.dedupe_key;
  GET DIAGNOSTICS scrubbed=ROW_COUNT;
  WITH batch AS (
    SELECT r.app_id,r.dedupe_key FROM coexistence_staged_receipts r
    WHERE r.tombstone_until<=cutoff AND (r.payload IS NULL OR r.payload='{}'::jsonb)
      AND NOT EXISTS(SELECT 1 FROM coexistence_negative_evidence e
        WHERE e.app_id=r.app_id AND e.dedupe_key=r.dedupe_key)
    ORDER BY r.tombstone_until,r.app_id,r.dedupe_key LIMIT p_limit FOR UPDATE OF r SKIP LOCKED
  )
  DELETE FROM coexistence_staged_receipts r USING batch b
    WHERE r.app_id=b.app_id AND r.dedupe_key=b.dedupe_key;
  GET DIAGNOSTICS deleted=ROW_COUNT;
  WITH batch AS (
    SELECT t.id FROM coexistence_signup_attempts t
    LEFT JOIN connection_operations o ON o.id=t.operation_id
    WHERE t.access_token IS NOT NULL AND (
      t.token_deadline<=cutoff OR t.token_expires_at<=cutoff
      OR t.reason IS NOT NULL OR o.id IS NULL OR o.state<>'active'
      OR NOT coexistence_signup_owner(o.actor_id,o.original_account_id,t.session_id)
      OR EXISTS(SELECT 1 FROM coexistence_negative_evidence e
        WHERE e.app_id=t.app_id AND e.observed_at>=t.launched_at
          AND e.kind IN ('ACCOUNT_OFFBOARDED','PARTNER_REMOVED','PARTNER_APP_UNINSTALLED')
          AND e.waba_id=ANY(ARRAY(SELECT substring(r.resource_key FROM 6)
            FROM connection_operation_resources r WHERE r.operation_id=o.id AND r.resource_key LIKE 'waba:%'))))
    ORDER BY t.token_deadline,t.id LIMIT p_limit FOR UPDATE OF t SKIP LOCKED
  )
  UPDATE coexistence_signup_attempts t SET access_token=NULL FROM batch b WHERE t.id=b.id;
  GET DIAGNOSTICS tokens=ROW_COUNT;
  RETURN jsonb_build_object('scrubbed',scrubbed,'deleted',deleted,'signup_tokens_scrubbed',tokens);
END $$;

-- Helpers are not RPCs. Replacements retain SQL074's original service-only signatures.
DO $$ DECLARE f record; BEGIN
  FOR f IN SELECT p.oid::regprocedure signature,p.proname FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
      AND p.proname IN ('coexistence_signup_launch_time_guard','coexistence_signup_negative_fence','coexistence_signup_fenced_lock',
        'coexistence_signup_launch','coexistence_signup_exchange_start','coexistence_signup_store_token',
        'coexistence_signup_token','coexistence_signup_verify','coexistence_signup_confirm',
        'coexistence_signup_status','coexistence_staged_maintenance') LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',f.signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.signature);
    IF f.proname NOT IN ('coexistence_signup_launch_time_guard','coexistence_signup_negative_fence','coexistence_signup_fenced_lock') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
    END IF;
  END LOOP;
END $$;


DO $$ DECLARE f record; BEGIN
  FOR f IN SELECT p.oid::regprocedure signature,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND (p.proname LIKE 'coexistence_staged_%' OR p.proname IN (
      'coexistence_ingress','coexistence_capture','coexistence_capture_before_075','connection_operation_finish','connection_operation_finish_before_075')) LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',f.signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.signature);
    IF f.proname IN ('coexistence_ingress','coexistence_capture','connection_operation_finish','coexistence_staged_maintenance') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
    END IF;
  END LOOP;
END $$;
