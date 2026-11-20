-- A receiver veto is a local refusal, never a Meta lifecycle event or a delivery receipt.
CREATE TABLE public.coexistence_receiver_vetoes (
  app_id text NOT NULL,
  waba_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('ACCOUNT_OFFBOARDED','PARTNER_REMOVED','PARTNER_APP_UNINSTALLED')),
  source_sha256 text NOT NULL CHECK (source_sha256 COLLATE "C" ~ '^[0-9a-f]{64}$'),
  entry_index integer NOT NULL CHECK (entry_index BETWEEN 0 AND 999),
  change_index integer NOT NULL CHECK (change_index BETWEEN 0 AND 999),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (app_id,waba_id)
);
ALTER TABLE public.coexistence_receiver_vetoes OWNER TO postgres;
ALTER TABLE public.coexistence_receiver_vetoes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.coexistence_receiver_vetoes FROM PUBLIC,anon,authenticated,service_role;

-- Acquire after account/config rows and any SQL075 resource keys. An advisory lock alone does not refresh a frozen snapshot.
CREATE FUNCTION public.coexistence_receiver_scope_lock(p_app_id text,p_waba_id text)
RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF current_setting('transaction_isolation')<>'read committed'
    OR NOT pg_try_advisory_xact_lock(hashtextextended('coexistence-receiver-veto:'||p_app_id||':'||p_waba_id,0)) THEN
    RAISE lock_not_available;
  END IF;
END $$;

CREATE FUNCTION public.coexistence_receiver_veto_locked(p_app_id text,p_waba_ids text[])
RETURNS boolean LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE waba text;
BEGIN
  IF (p_app_id COLLATE "C" ~ '^[1-9][0-9]{0,31}$') IS NOT TRUE THEN RETURN false; END IF;
  FOR waba IN SELECT DISTINCT x FROM unnest(p_waba_ids) x WHERE x IS NOT NULL ORDER BY x LOOP
    PERFORM coexistence_receiver_scope_lock(p_app_id,waba);
  END LOOP;
  RETURN EXISTS(SELECT 1 FROM coexistence_receiver_vetoes v WHERE v.app_id=p_app_id AND v.waba_id=ANY(p_waba_ids));
END $$;

CREATE FUNCTION public.coexistence_receiver_stop(p_app_id text,p_waba_id text,p_phone_number_id text,
  p_kind text,p_source_sha256 text,p_entry_index integer,p_change_index integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cfgs uuid[]; accts uuid[];
BEGIN
  IF (p_app_id COLLATE "C" ~ '^[1-9][0-9]{0,31}$') IS NOT TRUE
    OR (p_waba_id COLLATE "C" ~ '^[1-9][0-9]{0,31}$') IS NOT TRUE
    OR (p_phone_number_id COLLATE "C" ~ '^[1-9][0-9]{0,31}$') IS NOT TRUE
    OR (p_kind IN ('ACCOUNT_OFFBOARDED','PARTNER_REMOVED','PARTNER_APP_UNINSTALLED')) IS NOT TRUE
    OR (p_source_sha256 COLLATE "C" ~ '^[0-9a-f]{64}$') IS NOT TRUE
    OR (p_entry_index BETWEEN 0 AND 999) IS NOT TRUE OR (p_change_index BETWEEN 0 AND 999) IS NOT TRUE THEN
    RETURN '{"status":"invalid"}';
  END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE lock_not_available; END IF;

  -- The independently pinned phone is a handoff check, not a config selector or tenant hint.
  SELECT ARRAY(SELECT id FROM whatsapp_config WHERE coexistence_app_id=p_app_id
    AND connection_operation_resource_id(waba_id)=p_waba_id ORDER BY id),
    ARRAY(SELECT account_id FROM whatsapp_config WHERE coexistence_app_id=p_app_id
      AND connection_operation_resource_id(waba_id)=p_waba_id ORDER BY account_id)
    INTO cfgs,accts;
  PERFORM 1 FROM accounts WHERE id=ANY(accts) ORDER BY id FOR NO KEY UPDATE NOWAIT;
  PERFORM 1 FROM whatsapp_config WHERE id=ANY(cfgs) ORDER BY id FOR UPDATE NOWAIT;
  PERFORM coexistence_receiver_scope_lock(p_app_id,p_waba_id);
  -- A config may have entered or left scope before its scope lock became ours. Never lock new rows out of order.
  IF cfgs IS DISTINCT FROM ARRAY(SELECT id FROM whatsapp_config WHERE coexistence_app_id=p_app_id
      AND connection_operation_resource_id(waba_id)=p_waba_id ORDER BY id)
    OR accts IS DISTINCT FROM ARRAY(SELECT account_id FROM whatsapp_config WHERE coexistence_app_id=p_app_id
      AND connection_operation_resource_id(waba_id)=p_waba_id ORDER BY account_id) THEN RAISE lock_not_available; END IF;

  INSERT INTO coexistence_receiver_vetoes(app_id,waba_id,kind,source_sha256,entry_index,change_index)
    VALUES(p_app_id,p_waba_id,p_kind,p_source_sha256,p_entry_index,p_change_index)
    ON CONFLICT (app_id,waba_id) DO NOTHING;
  UPDATE whatsapp_config SET status='disconnected',coexistence_verified_at=NULL
    WHERE id=ANY(cfgs) AND (status IS DISTINCT FROM 'disconnected' OR coexistence_verified_at IS NOT NULL);
  RETURN '{"status":"blocked"}';
EXCEPTION WHEN lock_not_available THEN RETURN '{"status":"busy"}';
END $$;

-- Run after generation rotation so metadata-only writes remain independent and binding writes cannot bypass the veto.
CREATE FUNCTION public.coexistence_receiver_veto_config_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE waba text:=connection_operation_resource_id(NEW.waba_id);
BEGIN
  IF NEW.coexistence_app_id IS NULL OR waba IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.coexistence_generation=OLD.coexistence_generation THEN RETURN NEW; END IF;
    IF NEW.status='disconnected' AND NEW.coexistence_verified_at IS NULL
      AND ROW(NEW.coexistence_app_id,NEW.waba_id,NEW.phone_number_id,NEW.account_id,NEW.user_id,NEW.access_token,NEW.verify_token)
        IS NOT DISTINCT FROM ROW(OLD.coexistence_app_id,OLD.waba_id,OLD.phone_number_id,OLD.account_id,OLD.user_id,OLD.access_token,OLD.verify_token)
    THEN RETURN NEW; END IF;
  END IF;
  IF coexistence_receiver_veto_locked(NEW.coexistence_app_id,ARRAY[waba]) THEN
    RAISE EXCEPTION 'coexistence_receiver_veto' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER receiver_veto_config_guard BEFORE INSERT OR UPDATE ON public.whatsapp_config
  FOR EACH ROW EXECUTE FUNCTION public.coexistence_receiver_veto_config_guard();

ALTER FUNCTION public.coexistence_signup_negative_fence(uuid,text,text) RENAME TO coexistence_receiver_meta_signup_fence;
CREATE FUNCTION public.coexistence_signup_negative_fence(p_attempt_id uuid,
  p_candidate_phone text DEFAULT NULL,p_candidate_waba text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE t coexistence_signup_attempts; o connection_operations; wabas text[];
BEGIN
  IF coexistence_receiver_meta_signup_fence(p_attempt_id,p_candidate_phone,p_candidate_waba) THEN RETURN true; END IF;
  SELECT * INTO STRICT t FROM coexistence_signup_attempts WHERE id=p_attempt_id;
  SELECT * INTO STRICT o FROM connection_operations WHERE id=t.operation_id;
  wabas:=ARRAY(SELECT substring(k FROM 6) FROM unnest(o.resource_keys) k WHERE k LIKE 'waba:%');
  IF NOT coexistence_receiver_veto_locked(t.app_id,wabas||ARRAY[connection_operation_resource_id(p_candidate_waba)]) THEN
    RETURN false;
  END IF;
  -- Late, unbound candidate hints may only deny that step; they do not adopt or mutate a tenant binding.
  IF EXISTS(SELECT 1 FROM coexistence_receiver_vetoes v WHERE v.app_id=t.app_id AND v.waba_id=ANY(wabas)) THEN
    UPDATE coexistence_signup_attempts SET access_token=NULL,reason=coalesce(reason,'verification_failed') WHERE id=t.id;
    UPDATE connection_operations SET state='blocked' WHERE id=o.id AND state='active';
  END IF;
  RETURN true;
END $$;

ALTER FUNCTION public.coexistence_history_intent_record(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,boolean,boolean)
  RENAME TO coexistence_history_intent_record_before_078;
CREATE FUNCTION public.coexistence_history_intent_record(p_actor_id uuid,p_account_id uuid,p_session_id uuid,
  p_attempt_id uuid,p_request_id uuid,p_expected_revision uuid,p_expected_config_id uuid,p_expected_generation uuid,
  p_app_id text,p_waba_id text,p_phone_number_id text,p_consent_version text,p_history boolean,p_contacts boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
  result:=coexistence_history_intent_record_before_078(p_actor_id,p_account_id,p_session_id,p_attempt_id,
    p_request_id,p_expected_revision,p_expected_config_id,p_expected_generation,p_app_id,p_waba_id,p_phone_number_id,
    p_consent_version,p_history,p_contacts);
  -- Successful SQL077 already owns the row/resource locks and established the scope; rollback a new receipt if vetoed.
  IF result->>'status'='intent_recorded' AND coexistence_receiver_veto_locked(p_app_id,ARRAY[p_waba_id]) THEN
    RAISE SQLSTATE 'P7801';
  END IF;
  RETURN result;
EXCEPTION WHEN SQLSTATE 'P7801' THEN RETURN '{"status":"blocked"}';
  WHEN lock_not_available THEN RETURN '{"status":"busy"}';
END $$;

ALTER FUNCTION public.coexistence_receiver_stop(text,text,text,text,text,integer,integer) OWNER TO postgres;
ALTER FUNCTION public.coexistence_receiver_scope_lock(text,text) OWNER TO postgres;
ALTER FUNCTION public.coexistence_receiver_veto_locked(text,text[]) OWNER TO postgres;
ALTER FUNCTION public.coexistence_receiver_veto_config_guard() OWNER TO postgres;
ALTER FUNCTION public.coexistence_signup_negative_fence(uuid,text,text) OWNER TO postgres;
ALTER FUNCTION public.coexistence_history_intent_record(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,boolean,boolean)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.coexistence_receiver_stop(text,text,text,text,text,integer,integer),
  public.coexistence_receiver_scope_lock(text,text),public.coexistence_receiver_veto_locked(text,text[]),
  public.coexistence_receiver_veto_config_guard(),public.coexistence_signup_negative_fence(uuid,text,text),
  public.coexistence_receiver_meta_signup_fence(uuid,text,text),
  public.coexistence_history_intent_record_before_078(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,boolean,boolean),
  public.coexistence_history_intent_record(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,boolean,boolean)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.coexistence_receiver_stop(text,text,text,text,text,integer,integer),
  public.coexistence_history_intent_record(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,boolean,boolean)
  TO service_role;
