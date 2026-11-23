-- Install unselected and without runtime grants.
BEGIN;
CREATE SCHEMA wacrm_history_worker AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA wacrm_history_worker FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE wacrm_history_worker.selection(slot boolean PRIMARY KEY CHECK(slot), config_id uuid NOT NULL);
-- A generic or preexisting SQL079-stamped job is not proof of admission through the joined receiver.
CREATE TABLE wacrm_history_worker.admission(job_id uuid PRIMARY KEY REFERENCES public.coexistence_jobs(id) ON DELETE CASCADE);
REVOKE ALL ON ALL TABLES IN SCHEMA wacrm_history_worker FROM PUBLIC,anon,authenticated,service_role;

-- An operator can review an existing owner decision; this does not grant consent or start dispatch.
CREATE FUNCTION wacrm_history_worker.review(p_actor uuid,p_account uuid,p_session uuid,
  p_context text,p_decision uuid,p_request uuid)
RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp SET lock_timeout='250ms' AS $$
DECLARE s record; d public.coexistence_import_decisions; c public.whatsapp_config;
BEGIN
  IF current_user<>'postgres' OR current_setting('transaction_isolation')<>'read committed'
    OR NOT public.coexistence_signup_owner(p_actor,p_account,p_session) THEN RETURN false; END IF;
  PERFORM public.coexistence_signup_recovery_lock_actor(p_actor,p_account,p_session);
  SELECT * INTO c FROM public.whatsapp_config WHERE account_id=p_account FOR UPDATE NOWAIT;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM public.coexistence_import_resource_locks(c.waba_id,c.phone_number_id);
  PERFORM public.coexistence_receiver_scope_lock(c.coexistence_app_id,c.waba_id);
  IF NOT wacrm_pilot_worker.binding_current(c.id,c.account_id,c.coexistence_generation)
    OR NOT public.coexistence_signup_owner(p_actor,p_account,p_session) THEN RETURN false; END IF;
  SELECT * INTO s FROM public.coexistence_import_settings_snapshot(p_actor,p_account,p_session,
    c.coexistence_app_id,c.waba_id,c.phone_number_id);
  IF NOT FOUND OR s.effective IS NOT TRUE OR s.pinned IS NOT TRUE
    OR s.context IS DISTINCT FROM p_context THEN RETURN false; END IF;
  d:=s.decision;
  IF d.history IS NOT TRUE OR d.contacts IS NOT FALSE
    OR (d.actor_id,d.session_id,d.request_id) IS DISTINCT FROM (p_actor,p_session,p_decision)
    OR c.coexistence_verified_at+interval '24 hours'<=clock_timestamp()
    OR EXISTS (SELECT FROM public.coexistence_history_reviews r WHERE r.phone_number_id=c.phone_number_id AND r.outcome IS NOT NULL)
    THEN RETURN false; END IF;
  INSERT INTO public.coexistence_history_reviews(request_id,actor_id,session_id,account_id,config_id,generation,
    app_id,waba_id,phone_number_id,decision_id,launch_lower_bound)
  VALUES(p_request,p_actor,p_session,p_account,c.id,c.coexistence_generation,c.coexistence_app_id,
    c.waba_id,c.phone_number_id,p_decision,c.coexistence_verified_at);
  RETURN true;
EXCEPTION WHEN lock_not_available OR deadlock_detected OR unique_violation THEN RETURN false;
END $$;

-- Only an independently accepted owner request on the current binding admits history.
CREATE FUNCTION wacrm_history_worker.history_consent(c public.whatsapp_config)
RETURNS uuid LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE d public.coexistence_import_decisions;
BEGIN
  IF NOT wacrm_pilot_worker.binding_current(c.id,c.account_id,c.coexistence_generation) THEN RETURN NULL; END IF;
  d:=public.coexistence_import_latest(c.account_id,c.id,c.coexistence_generation);
  IF d.history IS NOT TRUE OR d.contacts IS NOT FALSE THEN RETURN NULL; END IF;
  PERFORM FROM public.profiles p WHERE p.user_id=d.actor_id AND p.account_id=d.account_id
    AND p.account_role='owner' FOR SHARE NOWAIT;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM FROM auth.sessions s WHERE s.id=d.session_id AND s.user_id=d.actor_id FOR SHARE NOWAIT;
  IF NOT FOUND OR NOT public.coexistence_import_decision_usable(d,c,1) THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT FROM public.coexistence_history_reviews r WHERE r.outcome='accepted'
      AND ROW(r.account_id,r.config_id,r.generation,r.actor_id,r.session_id,r.app_id,r.waba_id,r.phone_number_id,r.decision_id)
        =ROW(d.account_id,d.config_id,d.generation,d.actor_id,d.session_id,d.app_id,d.waba_id,d.phone_number_id,d.request_id)) THEN RETURN NULL; END IF;
  RETURN d.id;
END $$;

CREATE FUNCTION wacrm_history_worker.selected_consent(p_config uuid)
RETURNS uuid LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE c public.whatsapp_config; account uuid;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE lock_not_available; END IF;
  PERFORM FROM wacrm_history_worker.selection s WHERE s.config_id=p_config FOR SHARE NOWAIT;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT w.account_id INTO account FROM public.whatsapp_config w WHERE w.id=p_config;
  PERFORM FROM public.accounts a WHERE a.id=account FOR NO KEY UPDATE NOWAIT;
  SELECT * INTO c FROM public.whatsapp_config WHERE id=p_config AND account_id=account FOR UPDATE NOWAIT;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM public.coexistence_import_resource_locks(c.waba_id,c.phone_number_id);
  PERFORM public.coexistence_receiver_scope_lock(c.coexistence_app_id,c.waba_id);
  RETURN wacrm_history_worker.history_consent(c);
END $$;

CREATE FUNCTION wacrm_history_worker.coexistence_claim(p_limit integer)
RETURNS TABLE(id uuid,payload jsonb,lease_token uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET lock_timeout='250ms' AS $$
DECLARE selected uuid; consent uuid;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 5 THEN RAISE EXCEPTION 'coexistence_invalid_limit'; END IF;
  SELECT s.config_id INTO selected FROM wacrm_history_worker.selection s FOR SHARE NOWAIT;
  IF NOT FOUND THEN RETURN; END IF;
  consent:=wacrm_history_worker.selected_consent(selected);
  -- Preserve dedupe tombstones and scrub expired raw jobs even after consent ends.
  WITH expired AS (
    SELECT j.id FROM public.coexistence_jobs j JOIN wacrm_history_worker.admission a ON a.job_id=j.id
    WHERE j.config_id=selected AND j.payload<>'{}'::jsonb
      AND (j.status<>'processing' OR j.lease_until<=clock_timestamp())
      AND (j.created_at<clock_timestamp()-interval '7 days' OR (j.status IN ('pending','processing') AND j.attempts>=5))
    ORDER BY j.created_at LIMIT 100 FOR UPDATE OF j SKIP LOCKED
  ) UPDATE public.coexistence_jobs j SET
    status=CASE WHEN j.status IN ('pending','processing') THEN 'quarantined' ELSE j.status END,
    completed_at=coalesce(j.completed_at,clock_timestamp()), lease_token=NULL, lease_until=NULL,
    payload=CASE WHEN j.created_at<clock_timestamp()-interval '7 days' THEN '{}'::jsonb ELSE j.payload END,
    last_error=CASE WHEN j.created_at<clock_timestamp()-interval '7 days' THEN 'retention_expired' ELSE 'retry_expired' END
    FROM expired e WHERE j.id=e.id;
  IF consent IS NULL THEN RETURN; END IF;
  RETURN QUERY WITH ready AS (
    SELECT j.id FROM public.coexistence_jobs j JOIN wacrm_history_worker.admission a ON a.job_id=j.id
    WHERE j.config_id=selected AND j.import_consent_id=consent AND public.coexistence_import_payload_scope(j.payload)=1
      AND ((j.status='pending' AND j.available_at<=clock_timestamp()) OR (j.status='processing' AND j.lease_until<=clock_timestamp()))
      AND j.attempts<5 AND j.created_at>=clock_timestamp()-interval '7 days'
    ORDER BY j.available_at,j.created_at,j.id LIMIT p_limit FOR UPDATE OF j SKIP LOCKED
  ) UPDATE public.coexistence_jobs j SET status='processing',attempts=j.attempts+1,
    lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '2 minutes'
    FROM ready r WHERE j.id=r.id RETURNING j.id,j.payload,j.lease_token;
END $$;

CREATE FUNCTION wacrm_history_worker.current_lease(p_job_id uuid,p_lease_token uuid)
RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE j public.coexistence_jobs; consent uuid;
BEGIN
  SELECT j0.* INTO j FROM public.coexistence_jobs j0 JOIN wacrm_history_worker.admission a ON a.job_id=j0.id
    WHERE j0.id=p_job_id AND j0.status='processing' AND j0.lease_token=p_lease_token AND j0.lease_until>clock_timestamp();
  IF NOT FOUND THEN RETURN false; END IF;
  consent:=wacrm_history_worker.selected_consent(j.config_id);
  IF consent IS NULL THEN RETURN false; END IF;
  PERFORM FROM public.coexistence_jobs j0 WHERE j0.id=p_job_id AND j0.status='processing'
    AND j0.lease_token=p_lease_token AND j0.lease_until>clock_timestamp() AND j0.import_consent_id=consent
    AND public.coexistence_import_payload_scope(j0.payload)=1 FOR UPDATE NOWAIT;
  RETURN FOUND;
END $$;

CREATE FUNCTION wacrm_history_worker.coexistence_commit(p_job_id uuid,p_lease_token uuid,p_operations jsonb)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET lock_timeout='250ms' AS $$
BEGIN
  IF NOT wacrm_history_worker.current_lease(p_job_id,p_lease_token) THEN RETURN 'stale'; END IF;
  -- SQL079 rechecks the decision and operation allowlist before delegating projection.
  RETURN public.coexistence_commit(p_job_id,p_lease_token,p_operations);
END $$;

CREATE FUNCTION wacrm_history_worker.coexistence_fail(p_job_id uuid,p_lease_token uuid,p_code text,p_quarantine boolean)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET lock_timeout='250ms' AS $$
BEGIN
  IF NOT wacrm_history_worker.current_lease(p_job_id,p_lease_token) THEN RETURN 'stale'; END IF;
  RETURN public.coexistence_fail(p_job_id,p_lease_token,p_code,p_quarantine);
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA wacrm_history_worker FROM PUBLIC,anon,authenticated,service_role;
-- Alternative private listener for the selected connection; it does not replace the existing receiver.
CREATE SCHEMA wacrm_managed_receiver AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA wacrm_managed_receiver FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION wacrm_managed_receiver.coexistence_ingress(
  p_app_id text,p_partner_business_id text,p_enabled boolean,p_authorized boolean,p_changes jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET lock_timeout='250ms' AS $$
DECLARE
  app text := p_app_id;
  partner constant text := NULL;
  id_pattern constant text := '^[1-9][0-9]{0,31}$';
  ch jsonb; v jsonb; metadata jsonb; entry text; field text; waba text; phone text; k text;
  digest text; seen text[] := '{}'; wabas text[] := '{}'; slots text[]; required_slots text[];
  slot text; expected jsonb := '[]'; body jsonb; rejected integer := 400;
  cfg_ids uuid[]; cfg public.whatsapp_config; selected uuid;
  receipt public.coexistence_staged_receipts; job_payload jsonb;
  batch jsonb := '[]'; staged integer := 0; captured integer := 0;
  consent_id uuid; history_count integer := 0; admitted integer;
BEGIN
  IF p_app_id IS NULL AND p_partner_business_id IS NULL AND p_enabled IS FALSE AND p_authorized IS FALSE AND p_changes='[]'::jsonb THEN
    RETURN '{"status":200,"legacy_indices":[],"staged":0,"captured":0}'::jsonb;
  END IF;
  IF (app COLLATE "C" ~ id_pattern) IS NOT TRUE OR p_partner_business_id IS DISTINCT FROM partner THEN
    RAISE insufficient_privilege USING MESSAGE='private receiver scope mismatch';
  END IF;
  IF p_enabled IS DISTINCT FROM true THEN rejected:=503; RAISE SQLSTATE 'P8501'; END IF;
  IF p_authorized IS DISTINCT FROM true THEN rejected:=401; RAISE SQLSTATE 'P8501'; END IF;
  IF jsonb_typeof(p_changes) IS DISTINCT FROM 'array' THEN RAISE SQLSTATE 'P8501'; END IF;
  IF jsonb_array_length(p_changes) NOT BETWEEN 1 AND 1000 OR octet_length(p_changes::text)>8388608 THEN
    RAISE SQLSTATE 'P8501';
  END IF;

  FOR ch IN SELECT value FROM jsonb_array_elements(p_changes) LOOP
    IF jsonb_typeof(ch) IS DISTINCT FROM 'object' OR ch-ARRAY['entry_id','field','value','dedupe_key']<>'{}'::jsonb
      OR coalesce(jsonb_typeof(ch->'entry_id'),'') NOT IN ('string','null')
      OR jsonb_typeof(ch->'field') IS DISTINCT FROM 'string'
      OR jsonb_typeof(ch->'value') IS DISTINCT FROM 'object'
      OR jsonb_typeof(ch->'dedupe_key') IS DISTINCT FROM 'string' THEN RAISE SQLSTATE 'P8501'; END IF;
    entry:=ch->>'entry_id'; field:=ch->>'field'; v:=ch->'value'; k:=ch->>'dedupe_key';
    IF k COLLATE "C" !~ '^[a-f0-9]{64}:(0|[1-9][0-9]{0,2}):(0|[1-9][0-9]{0,2})$'
      OR k=ANY(seen) OR (digest IS NOT NULL AND digest<>left(k,64)) THEN RAISE SQLSTATE 'P8501'; END IF;
    digest:=left(k,64); seen:=array_append(seen,k);
    metadata:=v->'metadata'; phone:=metadata->>'phone_number_id';
    IF metadata ? 'phone_number_id' AND (jsonb_typeof(metadata->'phone_number_id') IS DISTINCT FROM 'string'
      OR (phone COLLATE "C" ~ id_pattern) IS NOT TRUE) THEN RAISE SQLSTATE 'P8501'; END IF;

    IF field='account_update' THEN
      waba:=public.coexistence_staged_lifecycle_target(app,partner,entry,v);
      IF jsonb_typeof(v->'event') IS DISTINCT FROM 'string' OR waba IS NULL
        OR v-ARRAY['event','waba_info','metadata','disconnection_info']<>'{}'::jsonb
        OR coalesce(jsonb_typeof(metadata),'null') NOT IN ('object','null')
        OR coalesce(jsonb_typeof(v->'disconnection_info'),'null') NOT IN ('object','null')
        OR (v#>>'{waba_info,partner_app_id}' IS NOT NULL AND v#>>'{waba_info,partner_app_id}'<>app)
        OR (v#>>'{waba_info,waba_id}' IS NOT NULL AND v#>>'{waba_info,waba_id}'<>waba)
        OR (CASE v->>'event'
          WHEN 'PARTNER_REMOVED' THEN true
          WHEN 'PARTNER_ADDED' THEN true
          WHEN 'PARTNER_APP_UNINSTALLED' THEN entry IS NOT NULL AND entry NOT IN (waba,app)
          WHEN 'PARTNER_APP_INSTALLED' THEN entry IS NOT NULL AND entry NOT IN (waba,app)
          ELSE entry IS DISTINCT FROM waba END) THEN RAISE SQLSTATE 'P8501'; END IF;
    ELSE
      waba:=entry;
      CASE field
        WHEN 'messages' THEN slots:=ARRAY['messages','statuses','contacts']; required_slots:=ARRAY['messages','statuses'];
        WHEN 'smb_message_echoes' THEN slots:=ARRAY['message_echoes','contacts']; required_slots:=ARRAY['message_echoes'];
        WHEN 'history' THEN slots:=ARRAY['history','messages']; required_slots:=slots;
        ELSE RAISE SQLSTATE 'P8501';
      END CASE;
      IF (waba COLLATE "C" ~ id_pattern) IS NOT TRUE
        OR v-(slots||ARRAY['metadata','messaging_product'])<>'{}'::jsonb
        OR (v ? 'messaging_product' AND v->'messaging_product'<>'"whatsapp"'::jsonb)
        OR NOT (v ?| required_slots) THEN RAISE SQLSTATE 'P8501'; END IF;
      FOREACH slot IN ARRAY slots LOOP
        IF NOT v ? slot THEN CONTINUE; END IF;
        IF jsonb_typeof(v->slot) IS DISTINCT FROM 'array' THEN RAISE SQLSTATE 'P8501'; END IF;
        IF (slot<>'contacts' AND v->slot='[]'::jsonb) OR EXISTS (
          SELECT FROM jsonb_array_elements(v->slot) e WHERE jsonb_typeof(e)<>'object') THEN RAISE SQLSTATE 'P8501'; END IF;
      END LOOP;
      IF NOT public.coexistence_staged_valid_source(field,v) OR phone IS NULL
        OR (field='history' AND jsonb_path_exists(v,'$.** ? (exists(@.contacts) || exists(@.state_sync))'))
        THEN RAISE SQLSTATE 'P8501'; END IF;
    END IF;
    wabas:=array_append(wabas,waba);
    body:=jsonb_build_object('entry_id',entry,'field',field,'value',v);
    expected:=expected||jsonb_build_array(jsonb_build_object('key',k,'body',body,'waba',waba,
      'phone',phone,
      'negative',CASE WHEN field='account_update' THEN public.coexistence_staged_negative(app,partner,entry,v) END));
  END LOOP;

  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE lock_not_available; END IF;
  -- Match account/profile/config → SQL075 resource and receipt fences. Recheck routing once locked.
  SELECT ARRAY(SELECT c.id FROM public.whatsapp_config c WHERE
    public.connection_operation_resource_id(c.waba_id)=ANY(wabas) OR EXISTS (
      SELECT FROM jsonb_array_elements(expected) e
      WHERE e->>'phone'=public.connection_operation_resource_id(c.phone_number_id)) ORDER BY c.id) INTO cfg_ids;
  PERFORM FROM public.accounts a WHERE a.id IN (SELECT c.account_id FROM public.whatsapp_config c WHERE c.id=ANY(cfg_ids))
    ORDER BY a.id FOR NO KEY UPDATE NOWAIT;
  SELECT config_id INTO selected FROM wacrm_pilot_worker.selection FOR SHARE NOWAIT;
  PERFORM FROM public.whatsapp_config c WHERE c.id=ANY(cfg_ids) ORDER BY c.id FOR UPDATE NOWAIT;
  FOR k IN SELECT x FROM (
    SELECT 'waba:'||w AS x FROM unnest(wabas) w
    UNION SELECT 'phone:'||(e->>'phone') FROM jsonb_array_elements(expected) e WHERE e->>'phone' IS NOT NULL
    UNION SELECT 'phone:'||public.connection_operation_resource_id(c.phone_number_id)
      FROM public.whatsapp_config c WHERE c.id=ANY(cfg_ids)) keys WHERE x IS NOT NULL ORDER BY x LOOP
    IF NOT pg_try_advisory_xact_lock(hashtextextended('connection-operation:'||k,0)) THEN RAISE lock_not_available; END IF;
  END LOOP;
  FOR waba IN SELECT DISTINCT w FROM unnest(wabas) w ORDER BY w LOOP
    PERFORM public.coexistence_receiver_scope_lock(app,waba);
  END LOOP;
  FOR k IN SELECT unnest(seen) ORDER BY 1 LOOP
    IF NOT pg_try_advisory_xact_lock(hashtextextended('coexistence-stage-receipt:'||k,0)) THEN RAISE lock_not_available; END IF;
  END LOOP;

  FOR ch IN SELECT value FROM jsonb_array_elements(expected) LOOP
    body:=ch->'body'; entry:=body->>'entry_id'; field:=body->>'field'; v:=body->'value';
    k:=ch->>'key'; waba:=ch->>'waba'; phone:=ch->>'phone';
    rejected:=403;
    SELECT c.* INTO cfg FROM public.whatsapp_config c WHERE
      public.connection_operation_resource_id(c.waba_id)=waba OR public.connection_operation_resource_id(c.phone_number_id)=phone
      ORDER BY c.id LIMIT 1;
    IF cfg.id IS NOT NULL AND NOT cfg.id=ANY(cfg_ids) THEN RAISE lock_not_available; END IF;
    IF cfg.id IS NULL OR cfg.id IS DISTINCT FROM selected
      OR ROW(cfg.coexistence_app_id,cfg.waba_id) IS DISTINCT FROM ROW(app,waba)
      OR (phone IS NOT NULL AND phone<>cfg.phone_number_id)
      OR EXISTS (SELECT FROM public.whatsapp_config c WHERE c.id<>cfg.id AND (
        public.connection_operation_resource_id(c.waba_id)=waba
        OR public.connection_operation_resource_id(c.phone_number_id)=cfg.phone_number_id)) THEN RAISE SQLSTATE 'P8501'; END IF;

    -- A private receipt is never adopted as tenant work, even after raw payload scrubbing or activation.
    rejected:=400;
    SELECT r.* INTO receipt FROM public.coexistence_staged_receipts r WHERE r.app_id=app AND r.dedupe_key=k FOR SHARE NOWAIT;
    IF EXISTS (SELECT FROM public.coexistence_staged_receipts r WHERE r.app_id<>app AND r.dedupe_key=k)
      OR EXISTS (SELECT FROM public.coexistence_jobs j WHERE j.dedupe_key=k AND j.config_id IS DISTINCT FROM cfg.id)
      THEN RAISE SQLSTATE 'P8501'; END IF;
    IF receipt.app_id IS NOT NULL THEN
      IF ROW(receipt.waba_id,receipt.phone_number_id,receipt.field,receipt.payload_hash) IS DISTINCT FROM
        ROW(waba,CASE WHEN field<>'account_update' THEN phone END,field,encode(sha256(convert_to(body::text,'UTF8')),'hex'))
        OR (receipt.payload IS DISTINCT FROM body AND NOT ((receipt.payload IS NULL OR receipt.payload='{}'::jsonb)
            AND receipt.raw_expires_at<=clock_timestamp()))
        OR (ch->>'negative' IS NOT NULL AND NOT EXISTS (SELECT FROM public.coexistence_negative_evidence n
          WHERE n.app_id=app AND n.waba_id=waba AND n.dedupe_key=k AND n.kind=v->>'event')) THEN RAISE SQLSTATE 'P8501'; END IF;
      CONTINUE;
    END IF;
    IF ch->>'negative' IS NOT NULL THEN
      IF public.coexistence_receiver_stop(app,waba,cfg.phone_number_id,v->>'event',left(k,64),
        split_part(k,':',2)::integer,split_part(k,':',3)::integer) <> '{"status":"blocked"}'::jsonb THEN
        rejected:=503; RAISE SQLSTATE 'P8501';
      END IF;
      staged:=staged+public.coexistence_staged_store(app,entry,field,v,k,waba,NULL);
      PERFORM public.coexistence_staged_record_negative(app,partner,entry,k,v);
      CONTINUE;
    END IF;

    job_payload:=jsonb_build_object('deliveries',jsonb_build_array(jsonb_build_object('waba_id',waba,'field',field,'value',v)),
      'legacy','{"entry":[]}'::jsonb);
    IF octet_length(job_payload::text)>4194304 OR EXISTS (SELECT FROM public.coexistence_jobs j
      WHERE j.config_id=cfg.id AND j.dedupe_key=k AND j.payload<>'{}'::jsonb AND j.payload IS DISTINCT FROM job_payload)
      THEN RAISE SQLSTATE 'P8501'; END IF;
    -- No replay may reapply lifecycle effects after the original delivery rotates the generation.
    IF EXISTS (SELECT FROM public.coexistence_jobs j WHERE j.config_id=cfg.id AND j.dedupe_key=k) THEN CONTINUE; END IF;

    rejected:=403;
    IF NOT wacrm_pilot_worker.binding_current(cfg.id,cfg.account_id,cfg.coexistence_generation)
      THEN RAISE SQLSTATE 'P8501'; END IF;
    IF field='history' THEN
      consent_id:=wacrm_history_worker.history_consent(cfg);
      IF consent_id IS NULL THEN RAISE SQLSTATE 'P8501'; END IF;
      history_count:=history_count+1;
    ELSE
      consent_id:=NULL;
    END IF;
    batch:=batch||jsonb_build_array(jsonb_build_object('import_consent_id',consent_id,'config_id',cfg.id,'account_id',cfg.account_id,
      'generation',cfg.coexistence_generation,'entry_id',entry,'waba_id',waba,'phone_number_id',cfg.phone_number_id,
      'dedupe_key',k,'payload',job_payload));
  END LOOP;

  IF batch<>'[]'::jsonb THEN
    rejected:=400;
    IF octet_length(batch::text)>8388608 THEN RAISE SQLSTATE 'P8501'; END IF;
    captured:=public.coexistence_capture(app,batch,partner);
    rejected:=503;
    IF captured IS DISTINCT FROM jsonb_array_length(batch) THEN RAISE SQLSTATE 'P8501'; END IF;
    IF history_count>0 THEN
      INSERT INTO wacrm_history_worker.admission(job_id)
      SELECT j.id FROM jsonb_array_elements(batch) d JOIN public.coexistence_jobs j
        ON j.config_id=(d->>'config_id')::uuid AND j.generation=(d->>'generation')::uuid
        AND j.dedupe_key=d->>'dedupe_key' AND j.import_consent_id=(d->>'import_consent_id')::uuid
        AND j.payload=d->'payload';
      GET DIAGNOSTICS admitted=ROW_COUNT;
      IF admitted<>history_count THEN RAISE SQLSTATE 'P8501'; END IF;
    END IF;
  END IF;
  RETURN jsonb_build_object('status',200,'legacy_indices','[]'::jsonb,'staged',staged,'captured',captured);
EXCEPTION WHEN SQLSTATE 'P8501' OR SQLSTATE 'P7501' OR lock_not_available OR deadlock_detected OR unique_violation THEN
  RETURN jsonb_build_object('status',CASE SQLSTATE WHEN 'P8501' THEN rejected WHEN 'P7501' THEN 400 ELSE 503 END,
    'legacy_indices','[]'::jsonb,'staged',0,'captured',0);
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA wacrm_managed_receiver FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
