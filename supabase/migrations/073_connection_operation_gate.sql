-- Shared connection coordination, independent of the Coexistence feature flag.
-- Started remote mutations never expire. Onboarding is reservation-only in this slice.
ALTER TABLE public.accounts ADD COLUMN connection_revision uuid NOT NULL DEFAULT gen_random_uuid();

CREATE TABLE public.connection_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  original_account_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  request_id uuid NOT NULL,
  token uuid NOT NULL DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('manual_save','manual_delete','onboarding')),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','active','blocked','completed','cancelled')),
  expected_revision uuid NOT NULL,
  expected_config_id uuid,
  expected_generation uuid,
  phone_number_id text,
  waba_id text,
  register_planned boolean NOT NULL,
  subscribe_planned boolean NOT NULL,
  steps jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(steps)='object' AND steps - ARRAY['register','subscribe']::text[]='{}'::jsonb
    AND (NOT steps ? 'register' OR steps->>'register' IN ('started','success','rejected','unknown'))
    AND (NOT steps ? 'subscribe' OR steps->>'subscribe' IN ('started','success','rejected','unknown'))
    AND NOT jsonb_path_exists(steps,'$.* ? (@ == null)')),
  resource_keys text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_until timestamptz NOT NULL DEFAULT clock_timestamp()+interval '2 minutes',
  finished_at timestamptz,
  result jsonb,
  UNIQUE(original_account_id,request_id),
  CHECK ((expected_config_id IS NULL)=(expected_generation IS NULL)),
  CHECK (phone_number_id IS NULL OR phone_number_id ~ '^[1-9][0-9]{0,31}$'),
  CHECK (waba_id IS NULL OR waba_id ~ '^[1-9][0-9]{0,31}$'),
  CHECK (NOT subscribe_planned OR waba_id IS NOT NULL),
  CHECK ((kind='manual_save' AND phone_number_id IS NOT NULL)
    OR (kind='manual_delete' AND phone_number_id IS NULL AND waba_id IS NULL AND NOT register_planned AND NOT subscribe_planned)
    OR (kind='onboarding' AND phone_number_id IS NOT NULL AND waba_id IS NOT NULL AND NOT register_planned AND NOT subscribe_planned)),
  CHECK ((state IN ('completed','cancelled'))=(finished_at IS NOT NULL)),
  CHECK (state NOT IN ('reserved','cancelled') OR steps='{}'::jsonb),
  CHECK (state NOT IN ('active','blocked') OR steps<>'{}'::jsonb),
  CHECK (state IN ('completed','cancelled') OR account_id IS NOT NULL)
);
CREATE UNIQUE INDEX connection_operations_one_active_account ON public.connection_operations(account_id)
  WHERE state IN ('reserved','active','blocked');
CREATE TABLE public.connection_operation_resources (
  resource_key text PRIMARY KEY CHECK (resource_key ~ '^(phone|waba):[1-9][0-9]*$'),
  operation_id uuid NOT NULL REFERENCES public.connection_operations(id) ON DELETE RESTRICT
);
CREATE INDEX connection_operation_resources_operation ON public.connection_operation_resources(operation_id);
ALTER TABLE public.connection_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connection_operation_resources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.connection_operations,public.connection_operation_resources FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.connection_config_write_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  -- Only vetted definer functions (and postgres fixture/maintenance) control bindings.
  IF current_user<>'postgres' THEN
    IF TG_OP<>'UPDATE' THEN
      RAISE EXCEPTION 'connection_gate_required' USING ERRCODE='42501';
    END IF;
    IF (to_jsonb(NEW)-ARRAY['mirror_inbound_media','updated_at'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['mirror_inbound_media','updated_at']) THEN
      RAISE EXCEPTION 'connection_gate_required' USING ERRCODE='42501';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER connection_config_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public.whatsapp_config
  FOR EACH ROW EXECUTE FUNCTION public.connection_config_write_guard();
REVOKE INSERT,DELETE,UPDATE ON public.whatsapp_config FROM PUBLIC,anon,authenticated;
REVOKE TRUNCATE ON public.whatsapp_config,public.accounts FROM PUBLIC,anon,authenticated,service_role;
GRANT UPDATE(mirror_inbound_media) ON public.whatsapp_config TO authenticated;
DROP POLICY whatsapp_config_insert ON public.whatsapp_config;
DROP POLICY whatsapp_config_delete ON public.whatsapp_config;

-- Account lock serializes expiry cleanup with dispatch authorization; never retire started work.
CREATE FUNCTION public.connection_operation_retire_unstarted(p_account_id uuid)
RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE o connection_operations%ROWTYPE;
BEGIN
  PERFORM 1 FROM accounts WHERE id=p_account_id FOR NO KEY UPDATE NOWAIT;
  FOR o IN SELECT * FROM connection_operations WHERE account_id=p_account_id
    AND state='reserved' AND steps='{}'::jsonb AND lease_until<=clock_timestamp() ORDER BY id FOR UPDATE NOWAIT LOOP
    PERFORM 1 FROM connection_operation_resources WHERE operation_id=o.id ORDER BY resource_key FOR UPDATE NOWAIT;
    DELETE FROM connection_operation_resources WHERE operation_id=o.id;
    UPDATE connection_operations SET state='cancelled',finished_at=clock_timestamp() WHERE id=o.id;
  END LOOP;
END;
$$;

CREATE FUNCTION public.connection_account_write_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    PERFORM connection_operation_retire_unstarted(OLD.id);
    IF EXISTS(SELECT 1 FROM connection_operations WHERE account_id=OLD.id AND state IN ('reserved','active','blocked')) THEN
      RAISE EXCEPTION 'connection_operation_outstanding' USING ERRCODE='23503';
    END IF;
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER connection_account_delete_guard BEFORE DELETE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.connection_account_write_guard();
CREATE FUNCTION public.connection_revision_write_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF current_user<>'postgres' AND (TG_OP='INSERT' OR NEW.connection_revision IS DISTINCT FROM OLD.connection_revision) THEN
    RAISE EXCEPTION 'connection_revision_private' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER connection_revision_write_guard BEFORE INSERT OR UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.connection_revision_write_guard();

CREATE FUNCTION public.connection_profile_move_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    -- Invitation redemption already owns this row; NOWAIT also covers alternate movers.
    PERFORM connection_operation_retire_unstarted(OLD.account_id);
    IF EXISTS(SELECT 1 FROM connection_operations WHERE account_id=OLD.account_id AND state IN ('reserved','active','blocked')) THEN
      RAISE EXCEPTION 'connection_operation_outstanding' USING ERRCODE='23503';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER connection_profile_move_guard BEFORE UPDATE OF account_id ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.connection_profile_move_guard();

-- Historical IDs are compared as decimal strings; never rewrite bindings or coerce to numbers.
CREATE FUNCTION public.connection_operation_resource_id(p_id text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT CASE WHEN p_id ~ '^[0-9]+$' THEN nullif(ltrim(p_id,'0'),'') END
$$;

CREATE FUNCTION public.connection_operation_authorized(p_actor_id uuid,p_account_id uuid,p_kind text)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM profiles p JOIN accounts a ON a.id=p.account_id
    WHERE p.user_id=p_actor_id AND p.account_id=p_account_id AND p.account_role IN ('owner','admin')
      AND (p_kind<>'onboarding' OR (p.account_role='owner' AND a.owner_user_id=p_actor_id)))
$$;

-- Caller holds the account and config locks before checking this helper.
CREATE FUNCTION public.connection_operation_binding(o public.connection_operations)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM accounts a WHERE a.id=o.account_id AND a.connection_revision=o.expected_revision)
    AND CASE WHEN o.expected_config_id IS NULL THEN
      NOT EXISTS(SELECT 1 FROM whatsapp_config WHERE account_id=o.account_id)
    ELSE EXISTS(SELECT 1 FROM whatsapp_config WHERE account_id=o.account_id AND id=o.expected_config_id
      AND coexistence_generation=o.expected_generation AND (o.kind='onboarding' OR coexistence_app_id IS NULL)) END
    AND (SELECT count(*) FROM connection_operation_resources r WHERE r.operation_id=o.id)=cardinality(o.resource_keys)
    AND NOT EXISTS(SELECT 1 FROM unnest(o.resource_keys) k WHERE NOT EXISTS(
      SELECT 1 FROM connection_operation_resources r WHERE r.resource_key=k AND r.operation_id=o.id))
    AND (o.kind<>'manual_save' OR NOT EXISTS(SELECT 1 FROM whatsapp_config
      WHERE connection_operation_resource_id(waba_id)=o.waba_id AND coexistence_app_id IS NOT NULL))
    AND (o.kind<>'onboarding' OR NOT EXISTS(SELECT 1 FROM whatsapp_config WHERE connection_operation_resource_id(waba_id)=o.waba_id AND account_id<>o.account_id))
    AND NOT EXISTS(SELECT 1 FROM whatsapp_config WHERE connection_operation_resource_id(phone_number_id)=o.phone_number_id AND account_id<>o.account_id)
$$;

CREATE FUNCTION public.connection_operation_acquire(p_actor_id uuid,p_account_id uuid,p_request_id uuid,
  p_kind text,p_expected_revision uuid,p_expected_config_id uuid,p_expected_generation uuid,
  p_phone_number_id text,p_waba_id text,p_register boolean,p_subscribe boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a accounts%ROWTYPE; c whatsapp_config%ROWTYPE; o connection_operations%ROWTYPE;
  old_op connection_operations%ROWTYPE; collision connection_operations%ROWTYPE; keys text[]; k text;
BEGIN
  IF p_actor_id IS NULL OR p_account_id IS NULL OR p_request_id IS NULL OR p_expected_revision IS NULL
    OR p_kind IS NULL OR p_kind NOT IN ('manual_save','manual_delete','onboarding')
    OR (p_expected_config_id IS NULL)<>(p_expected_generation IS NULL)
    OR p_register IS NULL OR p_subscribe IS NULL
    OR (p_phone_number_id IS NOT NULL AND p_phone_number_id !~ '^[1-9][0-9]{0,31}$')
    OR (p_waba_id IS NOT NULL AND p_waba_id !~ '^[1-9][0-9]{0,31}$')
    OR (p_kind='manual_save' AND p_phone_number_id IS NULL)
    OR (p_subscribe AND p_waba_id IS NULL)
    OR (p_kind='manual_delete' AND (p_phone_number_id IS NOT NULL OR p_waba_id IS NOT NULL OR p_register OR p_subscribe))
    OR (p_kind='onboarding' AND (p_phone_number_id IS NULL OR p_waba_id IS NULL OR p_register OR p_subscribe)) THEN
    RETURN jsonb_build_object('status','invalid');
  END IF;
  -- NO KEY UPDATE preserves lifecycle intake's account FK KEY SHARE locks.
  SELECT * INTO a FROM accounts WHERE id=p_account_id FOR NO KEY UPDATE NOWAIT;
  PERFORM 1 FROM profiles WHERE user_id=p_actor_id FOR SHARE NOWAIT;
  IF NOT FOUND OR NOT connection_operation_authorized(p_actor_id,p_account_id,p_kind) THEN
    RETURN jsonb_build_object('status','forbidden');
  END IF;
  SELECT * INTO o FROM connection_operations WHERE original_account_id=p_account_id AND request_id=p_request_id FOR UPDATE NOWAIT;
  IF FOUND THEN
    IF ROW(o.actor_id,o.kind,o.expected_revision,o.expected_config_id,o.expected_generation,o.phone_number_id,o.waba_id,o.register_planned,o.subscribe_planned)
      IS DISTINCT FROM ROW(p_actor_id,p_kind,p_expected_revision,p_expected_config_id,p_expected_generation,p_phone_number_id,p_waba_id,p_register,p_subscribe) THEN
      RETURN jsonb_build_object('status','conflict');
    END IF;
    IF o.state='completed' THEN RETURN o.result; END IF;
    IF o.state='cancelled' THEN RETURN jsonb_build_object('status','cancelled'); END IF;
    IF o.state='reserved' AND o.lease_until<=clock_timestamp() THEN RETURN jsonb_build_object('status','expired'); END IF;
    IF o.state<>'reserved' THEN RETURN jsonb_build_object('status','blocked','operation_id',o.id); END IF;
    RETURN jsonb_build_object('status','acquired','operation_id',o.id,'token',o.token,'lease_until',o.lease_until);
  END IF;
  SELECT * INTO c FROM whatsapp_config WHERE account_id=p_account_id FOR UPDATE NOWAIT;
  IF a.connection_revision IS DISTINCT FROM p_expected_revision
    OR c.id IS DISTINCT FROM p_expected_config_id OR c.coexistence_generation IS DISTINCT FROM p_expected_generation
    OR (p_kind<>'onboarding' AND c.coexistence_app_id IS NOT NULL)
    OR (p_kind='manual_save' AND EXISTS(SELECT 1 FROM whatsapp_config WHERE connection_operation_resource_id(waba_id)=p_waba_id AND coexistence_app_id IS NOT NULL))
    OR (p_kind='onboarding' AND EXISTS(SELECT 1 FROM whatsapp_config WHERE connection_operation_resource_id(waba_id)=p_waba_id AND account_id<>p_account_id))
    OR EXISTS(SELECT 1 FROM whatsapp_config WHERE connection_operation_resource_id(phone_number_id)=p_phone_number_id AND account_id<>p_account_id) THEN
    RETURN jsonb_build_object('status','conflict');
  END IF;
  SELECT * INTO old_op FROM connection_operations WHERE account_id=p_account_id AND state IN ('reserved','active','blocked') FOR UPDATE NOWAIT;
  IF FOUND THEN
    IF old_op.state<>'reserved' OR old_op.steps<>'{}'::jsonb THEN RETURN jsonb_build_object('status','blocked'); END IF;
    IF old_op.lease_until>clock_timestamp() THEN RETURN jsonb_build_object('status','busy'); END IF;
  END IF;
  SELECT coalesce(array_agg(DISTINCT value ORDER BY value),'{}'::text[]) INTO keys
    FROM unnest(ARRAY['phone:'||connection_operation_resource_id(c.phone_number_id),
      'waba:'||connection_operation_resource_id(c.waba_id),
      CASE WHEN p_phone_number_id IS NOT NULL THEN 'phone:'||p_phone_number_id END,
      CASE WHEN p_waba_id IS NOT NULL THEN 'waba:'||p_waba_id END]) value WHERE value IS NOT NULL;
  -- Try-lock also covers concurrent first insertion into the global resource index.
  FOREACH k IN ARRAY (SELECT ARRAY(SELECT DISTINCT x FROM unnest(keys||coalesce(old_op.resource_keys,'{}'::text[])) x ORDER BY x)) LOOP
    IF NOT pg_try_advisory_xact_lock(hashtextextended('connection-operation:'||k,0)) THEN
      RAISE lock_not_available;
    END IF;
  END LOOP;
  IF old_op.id IS NOT NULL THEN
    PERFORM 1 FROM connection_operation_resources WHERE operation_id=old_op.id ORDER BY resource_key FOR UPDATE NOWAIT;
    DELETE FROM connection_operation_resources WHERE operation_id=old_op.id;
    UPDATE connection_operations SET state='cancelled',finished_at=clock_timestamp() WHERE id=old_op.id;
  END IF;
  FOR collision IN SELECT DISTINCT x.* FROM connection_operations x JOIN connection_operation_resources r
    ON r.operation_id=x.id WHERE r.resource_key=ANY(keys) ORDER BY x.id LOOP
    -- Cross-account recovery is safe only before any dispatch authorization; all locks are nonblocking.
    PERFORM 1 FROM accounts WHERE id=collision.account_id FOR NO KEY UPDATE NOWAIT;
    SELECT * INTO collision FROM connection_operations WHERE id=collision.id FOR UPDATE NOWAIT;
    IF collision.state<>'reserved' OR collision.steps<>'{}'::jsonb OR collision.lease_until>clock_timestamp() THEN
      RAISE lock_not_available;
    END IF;
    PERFORM 1 FROM connection_operation_resources WHERE operation_id=collision.id ORDER BY resource_key FOR UPDATE NOWAIT;
    DELETE FROM connection_operation_resources WHERE operation_id=collision.id;
    UPDATE connection_operations SET state='cancelled',finished_at=clock_timestamp() WHERE id=collision.id;
  END LOOP;
  INSERT INTO connection_operations(account_id,original_account_id,actor_id,request_id,kind,expected_revision,
    expected_config_id,expected_generation,phone_number_id,waba_id,register_planned,subscribe_planned,resource_keys)
    VALUES(p_account_id,p_account_id,p_actor_id,p_request_id,p_kind,p_expected_revision,p_expected_config_id,
      p_expected_generation,p_phone_number_id,p_waba_id,p_register,p_subscribe,keys) RETURNING * INTO o;
  INSERT INTO connection_operation_resources(resource_key,operation_id) SELECT unnest(keys),o.id;
  -- A previous owner may have finalized between the initial read and resource acquisition.
  IF NOT connection_operation_binding(o) THEN RAISE EXCEPTION USING ERRCODE='P7301'; END IF;
  RETURN jsonb_build_object('status','acquired','operation_id',o.id,'token',o.token,'lease_until',o.lease_until);
EXCEPTION WHEN lock_not_available THEN RETURN jsonb_build_object('status','busy');
  WHEN SQLSTATE 'P7301' THEN RETURN jsonb_build_object('status','conflict');
END;
$$;

-- Private lock helper: no remote caller may use it to bypass transition validation.
CREATE FUNCTION public.connection_operation_lock(p_actor_id uuid,p_operation_id uuid,p_token uuid)
RETURNS public.connection_operations LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE o connection_operations%ROWTYPE;
BEGIN
  SELECT * INTO o FROM connection_operations WHERE id=p_operation_id;
  IF o.id IS NULL OR o.actor_id IS DISTINCT FROM p_actor_id OR o.token IS DISTINCT FROM p_token THEN RETURN NULL; END IF;
  PERFORM 1 FROM accounts WHERE id=o.account_id FOR NO KEY UPDATE NOWAIT;
  PERFORM 1 FROM whatsapp_config WHERE account_id=o.account_id FOR UPDATE NOWAIT;
  PERFORM 1 FROM profiles WHERE user_id=p_actor_id FOR SHARE NOWAIT;
  SELECT * INTO o FROM connection_operations WHERE id=p_operation_id FOR UPDATE NOWAIT;
  PERFORM 1 FROM connection_operation_resources WHERE operation_id=o.id ORDER BY resource_key FOR UPDATE NOWAIT;
  RETURN o;
END;
$$;

CREATE FUNCTION public.connection_operation_start_step(p_actor_id uuid,p_operation_id uuid,p_token uuid,p_step text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o connection_operations%ROWTYPE;
BEGIN
  o:=connection_operation_lock(p_actor_id,p_operation_id,p_token);
  IF o.id IS NULL THEN RETURN jsonb_build_object('status','not_found'); END IF;
  IF NOT connection_operation_authorized(p_actor_id,o.account_id,o.kind) THEN RETURN jsonb_build_object('status','forbidden'); END IF;
  IF o.kind<>'manual_save' THEN RETURN jsonb_build_object('status','unsupported'); END IF;
  IF p_step IS NULL OR p_step NOT IN ('register','subscribe')
    OR (p_step='register' AND NOT o.register_planned) OR (p_step='subscribe' AND NOT o.subscribe_planned) THEN
    RETURN jsonb_build_object('status','invalid');
  END IF;
  IF o.steps ? p_step THEN RETURN jsonb_build_object('status','duplicate','dispatch',false,'step_status',o.steps->>p_step); END IF;
  IF o.state NOT IN ('reserved','active') THEN RETURN jsonb_build_object('status','blocked'); END IF;
  IF o.state='reserved' AND o.lease_until<=clock_timestamp() THEN RETURN jsonb_build_object('status','expired'); END IF;
  IF NOT connection_operation_binding(o) THEN RETURN jsonb_build_object('status','conflict'); END IF;
  IF p_step='subscribe' AND o.register_planned AND coalesce(o.steps->>'register','') NOT IN ('success','rejected') THEN
    RETURN jsonb_build_object('status','blocked');
  END IF;
  UPDATE connection_operations SET state='active',steps=steps||jsonb_build_object(p_step,'started') WHERE id=o.id;
  RETURN jsonb_build_object('status','started','dispatch',true);
EXCEPTION WHEN lock_not_available THEN RETURN jsonb_build_object('status','busy');
END;
$$;

CREATE FUNCTION public.connection_operation_record_step(p_actor_id uuid,p_operation_id uuid,p_token uuid,p_step text,p_outcome text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o connection_operations%ROWTYPE;
BEGIN
  -- A late observation is useful after demotion; it grants no dispatch/finalization authority.
  o:=connection_operation_lock(p_actor_id,p_operation_id,p_token);
  IF o.id IS NULL THEN RETURN jsonb_build_object('status','not_found'); END IF;
  IF p_step IS NULL OR p_step NOT IN ('register','subscribe') OR p_outcome IS NULL OR p_outcome NOT IN ('success','rejected','unknown') THEN
    RETURN jsonb_build_object('status','invalid');
  END IF;
  IF o.steps->>p_step=p_outcome THEN RETURN jsonb_build_object('status','duplicate','step_status',p_outcome); END IF;
  IF o.state NOT IN ('active','blocked') OR o.steps->>p_step IS DISTINCT FROM 'started' THEN
    RETURN jsonb_build_object('status','conflict');
  END IF;
  UPDATE connection_operations SET steps=steps||jsonb_build_object(p_step,p_outcome),
    state=CASE WHEN p_outcome='unknown' OR (p_step='subscribe' AND p_outcome='rejected') OR state='blocked' THEN 'blocked' ELSE 'active' END
    WHERE id=o.id;
  RETURN jsonb_build_object('status','recorded','step_status',p_outcome);
EXCEPTION WHEN lock_not_available THEN RETURN jsonb_build_object('status','busy');
END;
$$;

CREATE FUNCTION public.connection_operation_finish(p_actor_id uuid,p_operation_id uuid,p_token uuid,p_config jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o connection_operations%ROWTYPE; c whatsapp_config%ROWTYPE; config_id uuid; revision uuid;
  rejected boolean; connected timestamptz; registered timestamptz; subscribed timestamptz; receipt jsonb;
BEGIN
  o:=connection_operation_lock(p_actor_id,p_operation_id,p_token);
  IF o.id IS NULL THEN RETURN jsonb_build_object('status','not_found'); END IF;
  IF NOT connection_operation_authorized(p_actor_id,o.account_id,o.kind) THEN RETURN jsonb_build_object('status','forbidden'); END IF;
  IF o.kind='onboarding' THEN RETURN jsonb_build_object('status','unsupported'); END IF;
  IF o.state='completed' THEN RETURN o.result; END IF;
  IF o.state NOT IN ('reserved','active') THEN RETURN jsonb_build_object('status','blocked'); END IF;
  IF o.state='reserved' AND o.lease_until<=clock_timestamp() THEN RETURN jsonb_build_object('status','expired'); END IF;
  IF NOT connection_operation_binding(o) THEN RETURN jsonb_build_object('status','conflict'); END IF;
  IF (o.register_planned AND coalesce(o.steps->>'register','') NOT IN ('success','rejected'))
    OR (o.subscribe_planned AND o.steps->>'subscribe' IS DISTINCT FROM 'success') THEN
    RETURN jsonb_build_object('status','blocked');
  END IF;
  SELECT * INTO c FROM whatsapp_config WHERE account_id=o.account_id;
  rejected:=coalesce(o.steps->>'register'='rejected',false);
  IF o.kind='manual_delete' THEN
    IF p_config IS NOT NULL AND p_config<>'{}'::jsonb THEN RETURN jsonb_build_object('status','invalid'); END IF;
    DELETE FROM whatsapp_config WHERE account_id=o.account_id;
  ELSE
    IF p_config IS NULL OR jsonb_typeof(p_config)<>'object'
      OR p_config-ARRAY['access_token','verify_token','connected_at','registered_at','subscribed_apps_at']<>'{}'::jsonb
      OR jsonb_typeof(p_config->'access_token') IS DISTINCT FROM 'string'
      OR length(p_config->>'access_token') NOT BETWEEN 1 AND 32768
      OR (p_config ? 'verify_token' AND jsonb_typeof(p_config->'verify_token') NOT IN ('string','null'))
      OR length(coalesce(p_config->>'verify_token',''))>32768 THEN RETURN jsonb_build_object('status','invalid'); END IF;
    connected:=(p_config->>'connected_at')::timestamptz;
    registered:=(p_config->>'registered_at')::timestamptz;
    subscribed:=(p_config->>'subscribed_apps_at')::timestamptz;
    IF (connected IS NOT NULL AND NOT isfinite(connected)) OR (registered IS NOT NULL AND NOT isfinite(registered))
      OR (subscribed IS NOT NULL AND NOT isfinite(subscribed))
      OR (rejected AND (connected IS NOT NULL OR registered IS NOT NULL))
      OR (NOT rejected AND connected IS NULL)
      OR (o.register_planned AND NOT rejected AND registered IS NULL)
      OR (o.subscribe_planned AND subscribed IS NULL)
      OR (NOT o.subscribe_planned AND subscribed IS NOT NULL)
      OR (NOT o.register_planned AND registered IS DISTINCT FROM CASE WHEN c.phone_number_id=o.phone_number_id THEN c.registered_at END) THEN
      RETURN jsonb_build_object('status','invalid');
    END IF;
    IF c.id IS NULL THEN
      INSERT INTO whatsapp_config(account_id,user_id,phone_number_id,waba_id,access_token,verify_token,status,
        connected_at,registered_at,subscribed_apps_at,last_registration_error)
        VALUES(o.account_id,o.actor_id,o.phone_number_id,o.waba_id,p_config->>'access_token',p_config->>'verify_token',
          CASE WHEN rejected THEN 'disconnected' ELSE 'connected' END,connected,registered,subscribed,
          CASE WHEN rejected THEN 'registration_rejected' END) RETURNING id INTO config_id;
    ELSE
      UPDATE whatsapp_config SET phone_number_id=o.phone_number_id,waba_id=o.waba_id,
        access_token=p_config->>'access_token',verify_token=p_config->>'verify_token',
        status=CASE WHEN rejected THEN 'disconnected' ELSE 'connected' END,connected_at=connected,
        registered_at=registered,subscribed_apps_at=subscribed,last_registration_error=CASE WHEN rejected THEN 'registration_rejected' END
        WHERE id=c.id RETURNING id INTO config_id;
    END IF;
  END IF;
  UPDATE accounts SET connection_revision=gen_random_uuid() WHERE id=o.account_id RETURNING connection_revision INTO revision;
  receipt:=jsonb_build_object('status','completed','operation_id',o.id,'config_id',config_id,'revision',revision,
    'saved',o.kind='manual_save','registered',registered IS NOT NULL,'registration_rejected',rejected);
  UPDATE connection_operations SET state='completed',finished_at=clock_timestamp(),result=receipt WHERE id=o.id;
  DELETE FROM connection_operation_resources WHERE operation_id=o.id;
  RETURN receipt;
EXCEPTION WHEN lock_not_available THEN RETURN jsonb_build_object('status','busy');
  WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN RETURN jsonb_build_object('status','invalid');
END;
$$;

CREATE FUNCTION public.connection_operation_cancel_unstarted(p_actor_id uuid,p_operation_id uuid,p_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o connection_operations%ROWTYPE;
BEGIN
  o:=connection_operation_lock(p_actor_id,p_operation_id,p_token);
  IF o.id IS NULL THEN RETURN jsonb_build_object('status','not_found'); END IF;
  IF NOT connection_operation_authorized(p_actor_id,o.account_id,o.kind) THEN RETURN jsonb_build_object('status','forbidden'); END IF;
  IF o.state='cancelled' THEN RETURN jsonb_build_object('status','cancelled'); END IF;
  IF o.state<>'reserved' OR o.steps<>'{}'::jsonb THEN RETURN jsonb_build_object('status','blocked'); END IF;
  UPDATE connection_operations SET state='cancelled',finished_at=clock_timestamp() WHERE id=o.id;
  DELETE FROM connection_operation_resources WHERE operation_id=o.id;
  RETURN jsonb_build_object('status','cancelled');
EXCEPTION WHEN lock_not_available THEN RETURN jsonb_build_object('status','busy');
END;
$$;

CREATE FUNCTION public.connection_operation_status(p_actor_id uuid,p_operation_id uuid,p_token uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o connection_operations%ROWTYPE;
BEGIN
  SELECT * INTO o FROM connection_operations WHERE id=p_operation_id AND actor_id=p_actor_id AND token=p_token;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','not_found'); END IF;
  IF NOT connection_operation_authorized(p_actor_id,o.account_id,o.kind) THEN RETURN jsonb_build_object('status','forbidden'); END IF;
  RETURN jsonb_build_object('status',o.state,'steps',o.steps,'result',o.result);
END;
$$;
CREATE FUNCTION public.connection_operation_account_status(p_actor_id uuid,p_account_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o connection_operations%ROWTYPE; admin boolean;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM profiles WHERE user_id=p_actor_id AND account_id=p_account_id) THEN
    RETURN jsonb_build_object('status','forbidden');
  END IF;
  admin:=connection_operation_authorized(p_actor_id,p_account_id,'manual_save');
  SELECT * INTO o FROM connection_operations WHERE account_id=p_account_id AND state IN ('reserved','active','blocked');
  IF NOT FOUND OR (o.state='reserved' AND o.lease_until<=statement_timestamp()) THEN RETURN jsonb_build_object('status','idle'); END IF;
  RETURN jsonb_build_object('status',CASE WHEN o.state='blocked' OR (o.state='active' AND o.lease_until<=statement_timestamp())
    THEN 'blocked' ELSE 'busy' END)||CASE WHEN admin THEN jsonb_build_object('operation_id',o.id) ELSE '{}'::jsonb END;
END;
$$;

-- Default function EXECUTE grants must not expose private helpers or trusted actor parameters.
DO $$ DECLARE f record; BEGIN
  FOR f IN SELECT p.oid::regprocedure AS signature,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND (p.proname LIKE 'connection_operation_%'
      OR p.proname IN ('connection_config_write_guard','connection_account_write_guard','connection_revision_write_guard','connection_profile_move_guard')) LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',f.signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.signature);
    IF f.proname IN ('connection_operation_acquire','connection_operation_start_step','connection_operation_record_step',
      'connection_operation_finish','connection_operation_cancel_unstarted','connection_operation_status','connection_operation_account_status') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
    END IF;
  END LOOP;
END $$;

-- Integration fragment AFTER 071 and SQL073's private gate tables/functions.
-- LIMIT: fences the automatic legacy mirror's ordinary fresh-version Storage upload.
-- Not a byte barrier for multipart/direct-backend writers or already-public content.
CREATE FUNCTION public.connection_legacy_media_publication_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE candidate record; parts text[]; owner_account uuid; cfg whatsapp_config%ROWTYPE;
  keys text[]; k text; media_id text;
BEGIN
  -- Validate the destination and a renamed source; DELETE remains available for cleanup.
  FOR candidate IN
    SELECT NEW.bucket_id AS bucket_id, NEW.name AS name
    UNION
    SELECT OLD.bucket_id, OLD.name WHERE TG_OP='UPDATE'
  LOOP
    IF candidate.bucket_id IS DISTINCT FROM 'chat-media'
      OR candidate.name !~ '^account-[^/]+/inbound(/|$)' THEN CONTINUE; END IF;
    parts:=regexp_match(candidate.name,
      '^account-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/inbound/([^/]+)$');
    IF parts IS NULL THEN RAISE insufficient_privilege; END IF;
    owner_account:=parts[1]::uuid;
    -- buildMediaPath truncates the basename to 40 chars. Without the '-' delimiter
    -- the complete numeric media ID is unprovable: reject and let the mirror use its proxy fallback.
    media_id:=substring(parts[2] FROM '^([0-9]{1,39})-[a-zA-Z0-9_-]*[.][a-z0-9]+$');
    IF media_id IS NULL OR length(regexp_replace(parts[2],'[.][^.]+$',''))>40 THEN
      RAISE insufficient_privilege;
    END IF;
    PERFORM 1 FROM accounts WHERE id=owner_account FOR NO KEY UPDATE NOWAIT;
    IF NOT FOUND THEN RAISE insufficient_privilege; END IF;
    SELECT * INTO cfg FROM whatsapp_config WHERE account_id=owner_account;
    IF NOT FOUND OR cfg.coexistence_app_id IS NOT NULL OR cfg.status IS DISTINCT FROM 'connected'
      OR connection_operation_resource_id(cfg.phone_number_id) IS NULL
      OR (cfg.waba_id IS NOT NULL AND connection_operation_resource_id(cfg.waba_id) IS NULL)
      OR NOT EXISTS(SELECT 1 FROM profiles WHERE user_id=cfg.user_id AND account_id=owner_account) THEN
      RAISE insufficient_privilege;
    END IF;
    -- The download's original epoch must survive a completed gate/reset, not adopt the current binding.
    IF jsonb_typeof(NEW.user_metadata) IS DISTINCT FROM 'object'
      OR NEW.user_metadata-ARRAY['connection_config_id','connection_generation']<>'{}'::jsonb
      OR jsonb_typeof(NEW.user_metadata->'connection_config_id') IS DISTINCT FROM 'string'
      OR jsonb_typeof(NEW.user_metadata->'connection_generation') IS DISTINCT FROM 'string'
      OR NEW.user_metadata->>'connection_config_id' IS DISTINCT FROM cfg.id::text
      OR NEW.user_metadata->>'connection_generation' IS DISTINCT FROM cfg.coexistence_generation::text THEN
      RAISE insufficient_privilege;
    END IF;
    SELECT ARRAY(SELECT x FROM unnest(ARRAY['phone:'||connection_operation_resource_id(cfg.phone_number_id),
      'waba:'||connection_operation_resource_id(cfg.waba_id)]) x
      WHERE x IS NOT NULL ORDER BY x) INTO keys;
    -- EXACT SQL073 resource namespace/order; also fences concurrent first resource insertion.
    FOREACH k IN ARRAY keys LOOP
      IF NOT pg_try_advisory_xact_lock(hashtextextended('connection-operation:'||k,0)) THEN
        RAISE insufficient_privilege;
      END IF;
    END LOOP;
    -- Never infer idle from lease expiry: only an explicit gate transition releases claims.
    IF EXISTS(SELECT 1 FROM connection_operations WHERE account_id=owner_account
        AND state IN ('reserved','active','blocked'))
      OR EXISTS(SELECT 1 FROM connection_operation_resources r JOIN connection_operations o ON o.id=r.operation_id
        WHERE r.resource_key=ANY(keys) AND o.state IN ('reserved','active','blocked'))
      OR EXISTS(SELECT 1 FROM whatsapp_config WHERE coexistence_app_id IS NOT NULL
        AND (connection_operation_resource_id(phone_number_id)=connection_operation_resource_id(cfg.phone_number_id)
          OR (cfg.waba_id IS NOT NULL AND connection_operation_resource_id(waba_id)=connection_operation_resource_id(cfg.waba_id))))
      OR coexistence_is_private_media(media_id) THEN
      RAISE insufficient_privilege;
    END IF;
  END LOOP;
  RETURN NEW;
EXCEPTION WHEN insufficient_privilege OR lock_not_available THEN
  -- No provider IDs, resource claims, account IDs, or gate details in public Storage errors.
  RAISE EXCEPTION 'Legacy media unavailable' USING ERRCODE='42501';
END;
$$;
ALTER FUNCTION public.connection_legacy_media_publication_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.connection_legacy_media_publication_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER connection_legacy_media_publication_guard BEFORE INSERT OR UPDATE ON storage.objects
  FOR EACH ROW EXECUTE FUNCTION public.connection_legacy_media_publication_guard();
