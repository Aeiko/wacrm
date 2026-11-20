-- Preserve the existing one-use code fence across both lanes, even after cleanup.
CREATE TABLE public.coexistence_signup_spent_codes (
  code_hash text COLLATE "C" PRIMARY KEY CHECK (code_hash ~ '^[a-f0-9]{64}$')
);
LOCK TABLE public.coexistence_signup_attempts IN SHARE ROW EXCLUSIVE MODE;
INSERT INTO public.coexistence_signup_spent_codes
  SELECT code_hash FROM public.coexistence_signup_attempts WHERE code_hash IS NOT NULL;

CREATE FUNCTION public.coexistence_signup_spend_legacy_code()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.code_hash IS NOT NULL THEN
    IF TG_OP='INSERT' THEN
      INSERT INTO coexistence_signup_spent_codes VALUES(NEW.code_hash);
    ELSIF OLD.code_hash IS DISTINCT FROM NEW.code_hash THEN
      INSERT INTO coexistence_signup_spent_codes VALUES(NEW.code_hash);
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER coexistence_signup_spend_legacy_code BEFORE INSERT OR UPDATE OF code_hash
  ON public.coexistence_signup_attempts FOR EACH ROW EXECUTE FUNCTION public.coexistence_signup_spend_legacy_code();

-- One replaceable expired receipt per account; a confirmed receipt is sticky.
-- Deliberately independent of profile, session and config deletion. No secrets at rest.
CREATE TABLE public.coexistence_member_signup_attempts (
  account_id uuid PRIMARY KEY,
  actor_id uuid NOT NULL,
  session_id uuid NOT NULL,
  revision uuid NOT NULL,
  state uuid UNIQUE NOT NULL,
  app_id text COLLATE "C" NOT NULL,
  login_config_id text COLLATE "C" NOT NULL,
  partner_id text COLLATE "C" NOT NULL,
  intended_phone text COLLATE "C" NOT NULL,
  expires_at timestamptz NOT NULL,
  exchanged boolean NOT NULL DEFAULT false,
  waba_id text COLLATE "C",
  phone_number_id text COLLATE "C",
  token_expires_at timestamptz,
  confirmed_at timestamptz
);
CREATE UNIQUE INDEX coexistence_member_signup_pending_phone ON public.coexistence_member_signup_attempts(intended_phone)
  WHERE confirmed_at IS NOT NULL;
ALTER TABLE public.coexistence_signup_spent_codes OWNER TO postgres;
ALTER TABLE public.coexistence_member_signup_attempts OWNER TO postgres;
ALTER TABLE public.coexistence_signup_spent_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coexistence_member_signup_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.coexistence_signup_spent_codes,public.coexistence_member_signup_attempts
  FROM PUBLIC,anon,authenticated,service_role;

-- Current connection paths already lock the account and sorted resource keys. Keep
-- a selected account out of a second connection operation, even with unrelated IDs.
CREATE FUNCTION public.coexistence_member_signup_operation_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM coexistence_member_signup_attempts t
    WHERE t.account_id=NEW.original_account_id AND t.confirmed_at IS NOT NULL) THEN RAISE lock_not_available; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER coexistence_member_signup_operation_guard BEFORE INSERT ON public.connection_operations
  FOR EACH ROW EXECUTE FUNCTION public.coexistence_member_signup_operation_guard();

CREATE FUNCTION public.coexistence_member_signup_legacy_phone_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  -- SQL085 acquired the same intended-number lock on this INSERT.
  IF EXISTS(SELECT 1 FROM coexistence_member_signup_attempts t
    WHERE t.intended_phone=NEW.intended_phone AND t.confirmed_at IS NOT NULL) THEN RAISE lock_not_available; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER coexistence_member_signup_legacy_phone_guard BEFORE INSERT ON public.coexistence_signup_attempts
  FOR EACH ROW EXECUTE FUNCTION public.coexistence_member_signup_legacy_phone_guard();

-- Serialize signed legacy negatives with the same target lock as receiver vetoes.
CREATE FUNCTION public.coexistence_member_signup_negative_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  -- The intake path already enforces a short lock timeout; preserve idempotence.
  PERFORM pg_advisory_xact_lock(hashtextextended('coexistence-receiver-veto:'||NEW.app_id||':'||NEW.waba_id,0));
  RETURN NEW;
END $$;
CREATE TRIGGER coexistence_member_signup_negative_guard BEFORE INSERT ON public.coexistence_negative_evidence
  FOR EACH ROW EXECUTE FUNCTION public.coexistence_member_signup_negative_guard();

ALTER FUNCTION public.coexistence_signup_spend_legacy_code() OWNER TO postgres;
ALTER FUNCTION public.coexistence_member_signup_operation_guard() OWNER TO postgres;
ALTER FUNCTION public.coexistence_member_signup_legacy_phone_guard() OWNER TO postgres;
ALTER FUNCTION public.coexistence_member_signup_negative_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.coexistence_signup_spend_legacy_code(),public.coexistence_member_signup_operation_guard(),
  public.coexistence_member_signup_legacy_phone_guard(),public.coexistence_member_signup_negative_guard()
  FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.coexistence_member_signup(p_actor_id uuid,p_session_id uuid,p_account_id uuid,p_action text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET lock_timeout='250ms' AS $$
DECLARE
  invalid CONSTANT jsonb := '{"status":"invalid"}'; forbidden CONSTANT jsonb := '{"status":"forbidden"}';
  conflict CONSTANT jsonb := '{"status":"conflict"}'; busy CONSTANT jsonb := '{"status":"busy"}';
  expired CONSTANT jsonb := '{"status":"expired"}'; duplicate CONSTANT jsonb := '{"status":"duplicate"}';
  pins CONSTANT text[] := ARRAY['app_id','login_config_id','partner_id'];
  target CONSTANT text[] := ARRAY['waba_id','phone_number_id'];
  id_pattern CONSTANT text := '^[1-9][0-9]{0,31}$';
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
    WHEN 'confirm' THEN pins||target||ARRAY['state'] END;
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

  SELECT * INTO t FROM coexistence_member_signup_attempts WHERE account_id=p_account_id;
  IF p_action NOT IN ('inspect','launch') THEN
    IF ROW(t.actor_id,t.session_id,t.state,t.revision) IS DISTINCT FROM ROW(p_actor_id,p_session_id,input_state::uuid,rev) THEN RETURN forbidden; END IF;
    IF t.expires_at<=clock_timestamp() THEN RETURN expired; END IF;
    IF ROW(t.app_id,t.login_config_id,t.partner_id) IS DISTINCT FROM ROW(p_payload->>'app_id',p_payload->>'login_config_id',p_payload->>'partner_id') THEN RETURN conflict; END IF;
    number:=t.intended_phone;
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
    UPDATE coexistence_member_signup_attempts SET waba_id=waba,phone_number_id=phone,token_expires_at=token_end WHERE account_id=p_account_id;
    RETURN '{"status":"verified"}';
  END IF;

  -- Share durable resource claims with the existing operation gate, without any
  -- dispatch permission, active operation, config row or history side effect.
  INSERT INTO connection_operations(account_id,original_account_id,actor_id,request_id,kind,state,expected_revision,
    phone_number_id,waba_id,register_planned,subscribe_planned,resource_keys,finished_at,result)
  VALUES(p_account_id,p_account_id,p_actor_id,t.state,'onboarding','completed',rev,phone,waba,false,false,keys,
    clock_timestamp(),'{"status":"confirmed"}') RETURNING id INTO claim;
  INSERT INTO connection_operation_resources(resource_key,operation_id) SELECT unnest(keys),claim;
  UPDATE coexistence_member_signup_attempts SET confirmed_at=clock_timestamp() WHERE account_id=p_account_id;
  UPDATE accounts SET connection_revision=gen_random_uuid() WHERE id=p_account_id;
  RETURN '{"status":"confirmed"}';
EXCEPTION WHEN lock_not_available OR deadlock_detected THEN RETURN busy;
  WHEN unique_violation THEN RETURN conflict;
  WHEN SQLSTATE 'P9002' THEN RETURN expired;
  WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_time_zone_displacement_value THEN RETURN invalid;
END $$;
ALTER FUNCTION public.coexistence_member_signup(uuid,uuid,uuid,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.coexistence_member_signup(uuid,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.coexistence_member_signup(uuid,uuid,uuid,text,jsonb) TO service_role;
