-- Staging follows the SQL090 launch/session deadline; confirmation does not extend it.
ALTER TABLE public.coexistence_member_signup_attempts ADD COLUMN access_token text COLLATE "C";
CREATE INDEX coexistence_member_signup_token_cleanup ON public.coexistence_member_signup_attempts(expires_at,account_id)
  WHERE access_token IS NOT NULL;

-- Preserve the existing RPC OID and ACL even when the sidecar install already moved it.
DO $upgrade$
DECLARE
  public_rpc regprocedure:=to_regprocedure('public.coexistence_member_signup(uuid,uuid,uuid,text,jsonb)');
  private_rpc regprocedure:=to_regprocedure('member_signup_private.coexistence_member_signup(uuid,uuid,uuid,text,jsonb)');
BEGIN
  IF (public_rpc IS NULL)=(private_rpc IS NULL) THEN RAISE EXCEPTION 'expected exactly one SQL090 RPC'; END IF;
  EXECUTE replace($definition$
CREATE OR REPLACE FUNCTION @signup_schema@.coexistence_member_signup(p_actor_id uuid,p_session_id uuid,p_account_id uuid,p_action text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET lock_timeout='250ms' AS $$
DECLARE
  invalid CONSTANT jsonb := '{"status":"invalid"}'; forbidden CONSTANT jsonb := '{"status":"forbidden"}';
  conflict CONSTANT jsonb := '{"status":"conflict"}'; busy CONSTANT jsonb := '{"status":"busy"}';
  expired CONSTANT jsonb := '{"status":"expired"}'; duplicate CONSTANT jsonb := '{"status":"duplicate"}';
  pins CONSTANT text[] := ARRAY['app_id','login_config_id','partner_id'];
  target CONSTANT text[] := ARRAY['waba_id','phone_number_id'];
  id_pattern CONSTANT text := '^[1-9][0-9]{0,31}$';
  activation boolean := p_action IN ('activation_read','activation_abort','activate');
  op_receipt connection_operations%ROWTYPE; linked_cfg whatsapp_config%ROWTYPE;
  checked_at timestamptz;
  fields text[]; k text; keys text[]; t coexistence_member_signup_attempts%ROWTYPE;
  rev uuid; session_end timestamptz; deadline timestamptz; token_end timestamptz; claim uuid;
  input_state text; number text; waba text; phone text;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN RETURN forbidden; END IF;
  fields:=CASE p_action
    WHEN 'inspect' THEN '{}'::text[]
    WHEN 'launch' THEN pins||ARRAY['intended_phone']
    WHEN 'exchange_start' THEN pins||ARRAY['state','code_hash']
    WHEN 'exchange_authorized' THEN pins||ARRAY['state']
    WHEN 'verify' THEN pins||target||ARRAY['state','normalized_phone_number','token_expires_at','access_token']
    WHEN 'confirm' THEN pins||target||ARRAY['state']
    WHEN 'activation_read' THEN pins||target||ARRAY['state']
    WHEN 'activation_abort' THEN pins||target||ARRAY['state']
    WHEN 'activate' THEN pins||target||ARRAY['state','normalized_phone_number'] END;
  IF fields IS NULL OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
    OR (p_payload-fields)<>'{}'::jsonb THEN RETURN invalid; END IF;
  FOREACH k IN ARRAY fields LOOP
    IF jsonb_typeof(p_payload->k) IS DISTINCT FROM 'string' THEN RETURN invalid; END IF;
    IF k=ANY(pins||target) AND (p_payload->>k) COLLATE "C" !~ id_pattern THEN RETURN invalid; END IF;
  END LOOP;
  input_state:=p_payload->>'state';
  IF input_state IS NOT NULL AND input_state COLLATE "C" !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN RETURN invalid; END IF;
  IF p_action='exchange_start' AND (p_payload->>'code_hash') COLLATE "C" !~ '^[a-f0-9]{64}$' THEN RETURN invalid; END IF;
  number:=p_payload->>'intended_phone';
  IF p_action='launch' AND number COLLATE "C" !~ '^\+[1-9][0-9]{7,14}$' THEN RETURN invalid; END IF;

  SELECT connection_revision INTO rev FROM accounts WHERE id=p_account_id FOR NO KEY UPDATE NOWAIT;
  IF NOT FOUND THEN RETURN forbidden; END IF;
  PERFORM 1 FROM profiles WHERE user_id=p_actor_id AND account_id=p_account_id AND account_role IS NOT NULL FOR SHARE NOWAIT;
  IF NOT FOUND THEN RETURN forbidden; END IF;
  PERFORM 1 FROM auth.users WHERE id=p_actor_id AND email_confirmed_at<=clock_timestamp() AND NOT is_anonymous
    AND deleted_at IS NULL AND (banned_until IS NULL OR banned_until<=clock_timestamp()) FOR SHARE NOWAIT;
  IF NOT FOUND THEN RETURN forbidden; END IF;
  SELECT not_after INTO session_end FROM auth.sessions WHERE id=p_session_id AND user_id=p_actor_id FOR SHARE NOWAIT;
  IF NOT FOUND OR session_end<=clock_timestamp() THEN RETURN forbidden; END IF;

  SELECT * INTO t FROM coexistence_member_signup_attempts WHERE account_id=p_account_id FOR UPDATE NOWAIT;
  IF p_action NOT IN ('inspect','launch') THEN
    IF ROW(t.actor_id,t.session_id,t.state,t.revision) IS DISTINCT FROM ROW(p_actor_id,p_session_id,input_state::uuid,rev) THEN RETURN forbidden; END IF;
    IF NOT activation AND t.expires_at<=clock_timestamp() THEN RETURN expired; END IF;
    IF ROW(t.app_id,t.login_config_id,t.partner_id) IS DISTINCT FROM ROW(p_payload->>'app_id',p_payload->>'login_config_id',p_payload->>'partner_id') THEN RETURN conflict; END IF;
    number:=t.intended_phone;
  END IF;
  IF activation THEN
    IF t.confirmed_at IS NULL OR NOT t.exchanged THEN RETURN conflict; END IF;
    waba:=p_payload->>'waba_id'; phone:=p_payload->>'phone_number_id';
    IF ROW(t.waba_id,t.phone_number_id) IS DISTINCT FROM ROW(waba,phone)
      OR (p_action='activate' AND number IS DISTINCT FROM p_payload->>'normalized_phone_number') THEN RETURN conflict; END IF;
    IF p_action='activation_abort' THEN
      UPDATE coexistence_member_signup_attempts SET access_token=NULL WHERE account_id=p_account_id;
      RETURN '{"status":"activation_aborted"}';
    END IF;
    IF NOT pg_try_advisory_xact_lock(hashtextextended('coexistence-discovery:'||number,0)) THEN RETURN busy; END IF;
    keys:=ARRAY['phone:'||phone,'waba:'||waba];
    FOREACH k IN ARRAY keys LOOP
      IF NOT pg_try_advisory_xact_lock(hashtextextended('connection-operation:'||k,0)) THEN RETURN busy; END IF;
    END LOOP;
    IF coexistence_receiver_veto_locked(t.app_id,ARRAY[waba])
      OR EXISTS(SELECT 1 FROM coexistence_negative_evidence e WHERE e.app_id=t.app_id AND e.waba_id=waba) THEN RETURN '{"status":"blocked"}'; END IF;

    SELECT * INTO op_receipt FROM connection_operations
      WHERE original_account_id=p_account_id AND request_id=t.state FOR UPDATE NOWAIT;
    IF NOT FOUND OR ROW(op_receipt.account_id,op_receipt.actor_id,op_receipt.waba_id,op_receipt.phone_number_id,op_receipt.resource_keys)
      IS DISTINCT FROM ROW(p_account_id,p_actor_id,waba,phone,keys)
      OR op_receipt.kind<>'onboarding' OR op_receipt.state<>'completed' OR op_receipt.steps<>'{}'::jsonb
      OR op_receipt.expected_config_id IS NOT NULL OR op_receipt.register_planned OR op_receipt.subscribe_planned THEN RETURN conflict; END IF;

    SELECT * INTO linked_cfg FROM whatsapp_config WHERE account_id=p_account_id FOR UPDATE NOWAIT;
    IF op_receipt.result->>'status'='activated' THEN
      IF linked_cfg.status='connected' AND linked_cfg.coexistence_verified_at IS NOT NULL
        AND ROW(linked_cfg.id::text,linked_cfg.coexistence_generation::text,linked_cfg.coexistence_app_id,linked_cfg.waba_id,linked_cfg.phone_number_id,linked_cfg.user_id)
          IS NOT DISTINCT FROM ROW(op_receipt.result->>'config_id',op_receipt.result->>'generation',t.app_id,waba,phone,p_actor_id)
        AND t.token_expires_at>clock_timestamp() THEN RETURN '{"status":"activated"}'; END IF;
      RETURN conflict;
    END IF;
    IF linked_cfg.id IS NOT NULL OR op_receipt.result IS DISTINCT FROM '{"status":"confirmed"}'::jsonb
      OR ARRAY(SELECT r.resource_key FROM connection_operation_resources r WHERE r.operation_id=op_receipt.id ORDER BY r.resource_key COLLATE "C") IS DISTINCT FROM keys
      OR EXISTS(SELECT 1 FROM whatsapp_config x WHERE connection_operation_resource_id(x.phone_number_id)=phone OR connection_operation_resource_id(x.waba_id)=waba)
      OR EXISTS(SELECT 1 FROM connection_operations x WHERE x.id<>op_receipt.id AND x.state IN ('reserved','active','blocked','completed')
        AND (x.account_id=p_account_id OR x.original_account_id=p_account_id OR x.phone_number_id=phone OR x.waba_id=waba OR x.resource_keys && keys))
      OR EXISTS(SELECT 1 FROM coexistence_signup_discovery_issues d WHERE d.account_id=p_account_id OR d.intended_phone=number)
      OR EXISTS(SELECT 1 FROM coexistence_signup_invitation_issues i WHERE i.account_id=p_account_id OR i.intended_phone=number OR i.phone_number_id=phone OR i.waba_id=waba)
      OR EXISTS(SELECT 1 FROM coexistence_pilot_bindings b WHERE b.account_id=p_account_id OR b.phone_number_id=phone OR b.waba_id=waba)
      THEN RETURN conflict; END IF;
    checked_at:=clock_timestamp();
    IF t.access_token IS NULL OR t.token_expires_at IS NULL OR least(t.expires_at,session_end,t.token_expires_at)<=checked_at THEN RETURN expired; END IF;
    IF p_action='activation_read' THEN
      RETURN jsonb_build_object('status','activation_ready','access_token',t.access_token,
        'token_expires_at',t.token_expires_at,'normalized_phone_number',number);
    END IF;

    -- The trusted caller attests a fresh read-only readiness check. No dispatch or import grant.
    INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,waba_id,access_token,status,
      connected_at,subscribed_apps_at,coexistence_app_id,coexistence_verified_at)
      VALUES(p_account_id,p_actor_id,phone,waba,t.access_token,'connected',checked_at,checked_at,t.app_id,checked_at)
      RETURNING * INTO linked_cfg;
    UPDATE accounts SET connection_revision=gen_random_uuid() WHERE id=p_account_id RETURNING connection_revision INTO rev;
    UPDATE coexistence_member_signup_attempts SET access_token=NULL,revision=rev WHERE account_id=p_account_id;
    UPDATE connection_operations SET finished_at=checked_at,
      result=jsonb_build_object('status','activated','config_id',linked_cfg.id,'generation',linked_cfg.coexistence_generation) WHERE id=op_receipt.id;
    DELETE FROM connection_operation_resources WHERE operation_id=op_receipt.id;
    RETURN '{"status":"activated"}';
  END IF;

  IF EXISTS(SELECT 1 FROM whatsapp_config WHERE account_id=p_account_id) THEN
    IF p_action='inspect' THEN RETURN '{"status":"linked"}'; END IF;
    RETURN conflict;
  END IF;
  IF t.confirmed_at IS NOT NULL THEN
    IF p_action='inspect' THEN RETURN '{"status":"pending"}'; END IF;
    RETURN conflict;
  END IF;
  IF number IS NOT NULL AND NOT pg_try_advisory_xact_lock(hashtextextended('coexistence-discovery:'||number,0)) THEN RETURN busy; END IF;
  IF EXISTS(SELECT 1 FROM connection_operations o WHERE (o.account_id=p_account_id OR o.original_account_id=p_account_id)
      AND o.state IN ('reserved','active','blocked','completed'))
    OR EXISTS(SELECT 1 FROM coexistence_signup_discovery_issues d WHERE d.account_id=p_account_id OR d.intended_phone=number)
    OR EXISTS(SELECT 1 FROM coexistence_signup_invitation_issues i WHERE i.account_id=p_account_id OR i.intended_phone=number)
    OR EXISTS(SELECT 1 FROM coexistence_pilot_bindings b WHERE b.account_id=p_account_id)
    OR EXISTS(SELECT 1 FROM coexistence_signup_attempts a JOIN connection_operations o ON o.id=a.operation_id
      WHERE a.intended_phone=number AND o.state IN ('reserved','active','blocked','completed'))
    OR EXISTS(SELECT 1 FROM coexistence_member_signup_attempts m WHERE m.intended_phone=number AND m.confirmed_at IS NOT NULL)
    THEN RETURN conflict; END IF;

  CASE p_action
    WHEN 'inspect' THEN
      IF t.expires_at>clock_timestamp() THEN RETURN busy; END IF;
      RETURN '{"status":"available"}';
    WHEN 'launch' THEN
      IF t.expires_at>clock_timestamp() THEN RETURN busy; END IF;
      deadline:=least(session_end,clock_timestamp()+interval '15 minutes');
      IF deadline<=clock_timestamp() THEN RETURN forbidden; END IF;
      DELETE FROM coexistence_member_signup_attempts WHERE account_id=p_account_id;
      INSERT INTO coexistence_member_signup_attempts(account_id,actor_id,session_id,revision,state,app_id,login_config_id,partner_id,intended_phone,expires_at)
      VALUES(p_account_id,p_actor_id,p_session_id,rev,gen_random_uuid(),p_payload->>'app_id',p_payload->>'login_config_id',p_payload->>'partner_id',number,deadline)
      RETURNING * INTO t;
      RETURN jsonb_build_object('status','launch_authorized','state',t.state,'expires_at',deadline);
    WHEN 'exchange_start' THEN
      IF t.exchanged THEN RETURN duplicate; END IF;
      INSERT INTO coexistence_signup_spent_codes VALUES (p_payload->>'code_hash');
      -- A competing code claim can briefly block on the unique index.
      IF t.expires_at<=clock_timestamp() THEN RAISE SQLSTATE 'P9002'; END IF;
      UPDATE coexistence_member_signup_attempts SET exchanged=true WHERE account_id=p_account_id;
      RETURN jsonb_build_object('status','started','dispatch',true,'intended_phone',number);
    WHEN 'exchange_authorized' THEN
      IF NOT t.exchanged OR t.waba_id IS NOT NULL THEN RETURN conflict; END IF;
      RETURN '{"status":"authorized"}';
    ELSE
      IF NOT t.exchanged THEN RETURN conflict; END IF;
  END CASE;

  waba:=p_payload->>'waba_id'; phone:=p_payload->>'phone_number_id';
  IF waba=phone OR waba IN (t.app_id,t.login_config_id,t.partner_id) OR phone IN (t.app_id,t.login_config_id,t.partner_id) THEN RETURN conflict; END IF;
  IF p_action='verify' THEN
    IF t.waba_id IS NOT NULL THEN RETURN duplicate; END IF;
    IF p_payload->>'normalized_phone_number'<>number THEN RETURN conflict; END IF;
    IF octet_length(p_payload->>'access_token')>16384 OR (p_payload->>'access_token') COLLATE "C" !~ '^[a-f0-9]{24}:([a-f0-9]{2})+:[a-f0-9]{32}$'
      OR (p_payload->>'token_expires_at') COLLATE "C" !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN RETURN invalid; END IF;
    token_end:=(p_payload->>'token_expires_at')::timestamptz;
  ELSE
    IF ROW(t.waba_id,t.phone_number_id) IS DISTINCT FROM ROW(waba,phone) THEN RETURN conflict; END IF;
    IF t.access_token IS NULL THEN RETURN expired; END IF;
    token_end:=t.token_expires_at;
  END IF;

  keys:=ARRAY['phone:'||phone,'waba:'||waba];
  FOREACH k IN ARRAY keys LOOP
    IF NOT pg_try_advisory_xact_lock(hashtextextended('connection-operation:'||k,0)) THEN RETURN busy; END IF;
  END LOOP;
  IF coexistence_receiver_veto_locked(t.app_id,ARRAY[waba])
    OR EXISTS(SELECT 1 FROM coexistence_negative_evidence e WHERE e.app_id=t.app_id AND e.waba_id=waba) THEN RETURN '{"status":"blocked"}'; END IF;
  IF EXISTS(SELECT 1 FROM whatsapp_config c WHERE connection_operation_resource_id(c.phone_number_id)=phone OR connection_operation_resource_id(c.waba_id)=waba)
    OR EXISTS(SELECT 1 FROM connection_operation_resources r WHERE r.resource_key=ANY(keys))
    OR EXISTS(SELECT 1 FROM connection_operations o WHERE o.state IN ('reserved','active','blocked','completed')
      AND (o.phone_number_id=phone OR o.waba_id=waba OR o.resource_keys && keys))
    OR EXISTS(SELECT 1 FROM coexistence_signup_invitation_issues i WHERE i.phone_number_id=phone OR i.waba_id=waba)
    OR EXISTS(SELECT 1 FROM coexistence_pilot_bindings b WHERE b.phone_number_id=phone OR b.waba_id=waba) THEN RETURN conflict; END IF;
  IF least(t.expires_at,session_end,token_end)<=clock_timestamp() THEN RETURN expired; END IF;
  IF p_action='verify' THEN
    UPDATE coexistence_member_signup_attempts SET waba_id=waba,phone_number_id=phone,token_expires_at=token_end,
      access_token=p_payload->>'access_token' WHERE account_id=p_account_id;
    RETURN '{"status":"verified"}';
  END IF;

  -- Share durable resource claims with the existing operation gate, without any
  -- dispatch permission, active operation, config row or history side effect.
  INSERT INTO connection_operations(account_id,original_account_id,actor_id,request_id,kind,state,expected_revision,
    phone_number_id,waba_id,register_planned,subscribe_planned,resource_keys,finished_at,result)
  VALUES(p_account_id,p_account_id,p_actor_id,t.state,'onboarding','completed',rev,phone,waba,false,false,keys,
    clock_timestamp(),'{"status":"confirmed"}') RETURNING id INTO claim;
  INSERT INTO connection_operation_resources(resource_key,operation_id) SELECT unnest(keys),claim;
  UPDATE accounts SET connection_revision=gen_random_uuid() WHERE id=p_account_id RETURNING connection_revision INTO rev;
  UPDATE coexistence_member_signup_attempts SET confirmed_at=clock_timestamp(),revision=rev WHERE account_id=p_account_id;
  RETURN '{"status":"confirmed"}';
EXCEPTION WHEN lock_not_available OR deadlock_detected THEN RETURN busy;
  WHEN unique_violation THEN RETURN conflict;
  WHEN SQLSTATE 'P9002' THEN RETURN expired;
  WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_time_zone_displacement_value THEN RETURN invalid;
END $$;
$definition$, '@signup_schema@', CASE WHEN private_rpc IS NULL THEN 'public' ELSE 'member_signup_private' END);
END $upgrade$;

-- Reuse the existing staged maintenance runner; keep its existing counters.
ALTER FUNCTION public.coexistence_staged_maintenance(integer) RENAME TO coexistence_staged_maintenance_before_092;
REVOKE ALL ON FUNCTION public.coexistence_staged_maintenance_before_092(integer) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.coexistence_staged_maintenance(p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE receipt jsonb; scrubbed integer; cutoff timestamptz;
BEGIN
  receipt:=coexistence_staged_maintenance_before_092(p_limit);
  cutoff:=clock_timestamp();
  WITH batch AS (
    SELECT t.account_id FROM coexistence_member_signup_attempts t
    WHERE t.access_token IS NOT NULL AND (
      least(t.expires_at,t.token_expires_at)<=cutoff
      OR NOT EXISTS(SELECT 1 FROM accounts a JOIN profiles p ON p.account_id=a.id
        JOIN auth.users u ON u.id=p.user_id JOIN auth.sessions s ON s.user_id=u.id
        WHERE a.id=t.account_id AND a.connection_revision=t.revision AND p.user_id=t.actor_id AND p.account_role IS NOT NULL
          AND u.email_confirmed_at<=cutoff AND NOT u.is_anonymous AND u.deleted_at IS NULL
          AND (u.banned_until IS NULL OR u.banned_until<=cutoff) AND s.id=t.session_id AND (s.not_after IS NULL OR s.not_after>cutoff))
      OR EXISTS(SELECT 1 FROM coexistence_receiver_vetoes v WHERE v.app_id=t.app_id AND v.waba_id=t.waba_id)
      OR EXISTS(SELECT 1 FROM coexistence_negative_evidence e WHERE e.app_id=t.app_id AND e.waba_id=t.waba_id))
    ORDER BY t.expires_at,t.account_id LIMIT p_limit FOR UPDATE OF t SKIP LOCKED
  )
  UPDATE coexistence_member_signup_attempts t SET access_token=NULL FROM batch b WHERE t.account_id=b.account_id;
  GET DIAGNOSTICS scrubbed=ROW_COUNT;
  RETURN receipt||jsonb_build_object('member_signup_tokens_scrubbed',scrubbed);
END $$;
ALTER FUNCTION public.coexistence_staged_maintenance(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.coexistence_staged_maintenance(integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.coexistence_staged_maintenance(integer) TO service_role;
