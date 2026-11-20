-- Owner Settings decisions reuse SQL079; viewing Settings does not authorize projection.
CREATE FUNCTION public.coexistence_import_settings_snapshot(p_actor_id uuid,p_account_id uuid,p_session_id uuid,
  p_allowed_app_id text,p_allowed_waba_id text,p_allowed_phone_id text)
RETURNS TABLE(context text, revision uuid, config_id uuid, generation uuid, app_id text, waba_id text, phone_id text,
  pinned boolean, can_grant boolean, can_withdraw boolean, effective boolean, decision public.coexistence_import_decisions)
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT encode(sha256(convert_to(jsonb_build_array('coexistence-import-settings:projection-v1',
      p_actor_id,p_session_id,a.id,a.connection_revision,c.id,c.coexistence_generation,
      c.coexistence_app_id,scope.waba,scope.phone)::text,'UTF8')),'hex'),
    a.connection_revision,c.id,c.coexistence_generation,c.coexistence_app_id,scope.waba,scope.phone,pins.match,
    pins.match AND coexistence_import_binding_ready(c,scope.waba,scope.phone),
    coalesce(d.history OR d.contacts,false),
    coexistence_import_decision_usable(d,c,1) OR coexistence_import_decision_usable(d,c,2),d
  FROM accounts a JOIN whatsapp_config c ON c.account_id=a.id
  CROSS JOIN LATERAL (SELECT connection_operation_resource_id(c.waba_id) AS waba,
    connection_operation_resource_id(c.phone_number_id) AS phone) scope
  CROSS JOIN LATERAL (SELECT coalesce(ROW(p_allowed_app_id COLLATE "C",p_allowed_waba_id COLLATE "C",p_allowed_phone_id COLLATE "C")
    = ROW(c.coexistence_app_id,scope.waba,scope.phone)
    AND p_allowed_app_id<>p_allowed_waba_id AND p_allowed_app_id<>p_allowed_phone_id
    AND p_allowed_waba_id<>p_allowed_phone_id,false) AS match) pins
  LEFT JOIN LATERAL coexistence_import_latest(a.id,c.id,c.coexistence_generation) d
    ON ROW(d.app_id,d.waba_id,d.phone_number_id)=ROW(c.coexistence_app_id,scope.waba,scope.phone)
  WHERE a.id=p_account_id AND c.coexistence_generation IS NOT NULL
    AND c.coexistence_app_id COLLATE "C" ~ '^[1-9][0-9]{0,31}$'
    AND scope.waba COLLATE "C" ~ '^[1-9][0-9]{0,31}$' AND scope.phone COLLATE "C" ~ '^[1-9][0-9]{0,31}$'
$$;

CREATE FUNCTION public.coexistence_import_settings_status(p_actor_id uuid,p_account_id uuid,p_session_id uuid,
  p_allowed_app_id text,p_allowed_waba_id text,p_allowed_phone_id text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT CASE WHEN coexistence_signup_owner(p_actor_id,p_account_id,p_session_id) THEN
    jsonb_build_object('status','ok','connection',(
      SELECT jsonb_build_object('context',s.context,'phone_id_suffix',right(s.phone_id,4),
        'can_grant',s.can_grant,'can_withdraw',s.can_withdraw,
        'state',CASE WHEN (s.decision).id IS NULL THEN 'none' WHEN NOT s.can_withdraw THEN 'withdrawn'
          WHEN s.effective THEN 'effective' ELSE 'inactive' END,
        'history',coalesce((s.decision).history,false),'contacts',coalesce((s.decision).contacts,false),
        'previous_request_id',(s.decision).request_id,'expires_at',(s.decision).expires_at)
      FROM coexistence_import_settings_snapshot(p_actor_id,p_account_id,p_session_id,
        p_allowed_app_id,p_allowed_waba_id,p_allowed_phone_id) s))
    ELSE '{"status":"forbidden"}'::jsonb END
$$;

CREATE FUNCTION public.coexistence_import_settings_record(p_actor_id uuid,p_account_id uuid,p_session_id uuid,
  p_allowed_app_id text,p_allowed_waba_id text,p_allowed_phone_id text,p_context text,p_request_id uuid,
  p_previous_request_id uuid,p_history boolean,p_contacts boolean,p_version text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET lock_timeout='250ms' AS $$
DECLARE s record; prior coexistence_import_decisions; previous_id uuid; positive boolean;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed'
    OR p_context IS NULL OR octet_length(p_context)<>64 OR p_context COLLATE "C" !~ '^[0-9a-f]{64}$'
    OR p_request_id IS NULL OR p_history IS NULL OR p_contacts IS NULL
    OR p_version COLLATE "C" IS DISTINCT FROM 'projection-v1' THEN RETURN '{"status":"invalid"}'; END IF;
  IF NOT coexistence_signup_owner(p_actor_id,p_account_id,p_session_id) THEN RETURN '{"status":"forbidden"}'; END IF;
  -- Match SQL079's order so owner/revision and the decision CAS remain fixed through the write.
  PERFORM coexistence_signup_recovery_lock_actor(p_actor_id,p_account_id,p_session_id);
  PERFORM 1 FROM whatsapp_config WHERE account_id=p_account_id FOR UPDATE NOWAIT;
  IF NOT coexistence_signup_owner(p_actor_id,p_account_id,p_session_id) OR NOT EXISTS(
    SELECT 1 FROM auth.sessions WHERE id=p_session_id AND (not_after IS NULL OR not_after>clock_timestamp())
  ) THEN RETURN '{"status":"forbidden"}'; END IF;
  SELECT * INTO s FROM coexistence_import_settings_snapshot(p_actor_id,p_account_id,p_session_id,
    p_allowed_app_id,p_allowed_waba_id,p_allowed_phone_id);
  IF NOT FOUND OR s.context COLLATE "C" IS DISTINCT FROM p_context THEN RETURN '{"status":"conflict"}'; END IF;

  positive:=p_history OR p_contacts;
  IF positive AND NOT s.pinned THEN RETURN '{"status":"blocked"}'; END IF;
  SELECT * INTO prior FROM coexistence_import_decisions WHERE account_id=p_account_id AND request_id=p_request_id;
  IF FOUND THEN
    IF ROW(prior.actor_id,prior.session_id,prior.connection_revision,prior.config_id,prior.generation,prior.app_id,
        prior.waba_id,prior.phone_number_id,prior.history,prior.contacts)
      IS DISTINCT FROM ROW(p_actor_id,p_session_id,s.revision,s.config_id,s.generation,s.app_id,
        s.waba_id,s.phone_id,p_history,p_contacts)
      OR prior.id IS DISTINCT FROM (s.decision).id THEN RETURN '{"status":"conflict"}'; END IF;
    SELECT d.request_id INTO previous_id FROM coexistence_import_decisions d
      WHERE d.account_id=p_account_id AND d.config_id=s.config_id AND d.generation=s.generation
      AND d.decision_order<prior.decision_order ORDER BY d.decision_order DESC LIMIT 1;
    IF p_previous_request_id IS DISTINCT FROM previous_id THEN RETURN '{"status":"conflict"}'; END IF;
    -- A lost acknowledgment can recover the first receipt, but cannot extend or resurrect authority.
    RETURN jsonb_build_object('status','recorded','request_id',prior.request_id,'history',prior.history,
      'contacts',prior.contacts,'expires_at',prior.expires_at,'dispatch_authorized',false);
  END IF;
  IF p_previous_request_id IS DISTINCT FROM (s.decision).request_id THEN RETURN '{"status":"conflict"}'; END IF;
  IF (positive AND NOT s.can_grant) OR (NOT positive AND NOT s.can_withdraw) THEN RETURN '{"status":"blocked"}'; END IF;
  RETURN coexistence_import_consent(p_actor_id,p_account_id,p_session_id,s.config_id,s.generation,
    s.app_id,s.waba_id,s.phone_id,p_request_id,p_history,p_contacts,p_previous_request_id);
EXCEPTION WHEN lock_not_available OR deadlock_detected THEN RETURN '{"status":"busy"}';
  WHEN SQLSTATE 'P7401' THEN RETURN '{"status":"forbidden"}';
END $$;

ALTER FUNCTION public.coexistence_import_settings_snapshot(uuid,uuid,uuid,text,text,text) OWNER TO postgres;
ALTER FUNCTION public.coexistence_import_settings_status(uuid,uuid,uuid,text,text,text) OWNER TO postgres;
ALTER FUNCTION public.coexistence_import_settings_record(uuid,uuid,uuid,text,text,text,text,uuid,uuid,boolean,boolean,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.coexistence_import_settings_snapshot(uuid,uuid,uuid,text,text,text),
  public.coexistence_import_settings_status(uuid,uuid,uuid,text,text,text),
  public.coexistence_import_settings_record(uuid,uuid,uuid,text,text,text,text,uuid,uuid,boolean,boolean,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.coexistence_import_settings_status(uuid,uuid,uuid,text,text,text),
  public.coexistence_import_settings_record(uuid,uuid,uuid,text,text,text,text,uuid,uuid,boolean,boolean,text) TO service_role;
