-- Exact-WAMID outbound persistence. Applied migrations 060-069 remain immutable.
-- Private provenance is recorded only by new writes; old quiet rows are never backfilled by inference.
ALTER TABLE public.coexistence_message_metadata
  ADD COLUMN source_config_id uuid,
  ADD COLUMN source_generation uuid,
  -- The CRM request time can differ from the retained quiet/provider row time.
  ADD COLUMN outbound_created_at timestamptz,
  ADD COLUMN outbound_preview text,
  ADD CONSTRAINT coexistence_outbound_request_pair CHECK ((outbound_created_at IS NULL) = (outbound_preview IS NULL)),
  ADD CONSTRAINT coexistence_message_source_pair CHECK ((source_config_id IS NULL) = (source_generation IS NULL)),
  ADD CONSTRAINT coexistence_outbound_time_finite CHECK (outbound_created_at IS NULL OR isfinite(outbound_created_at));
ALTER TABLE public.coexistence_updates
  ADD COLUMN advanced_message_id uuid REFERENCES public.messages(id) ON DELETE SET NULL;
CREATE INDEX coexistence_updates_advanced_message ON public.coexistence_updates(advanced_message_id)
  WHERE advanced_message_id IS NOT NULL;

CREATE FUNCTION public.persist_outbound_message(
  p_account_id uuid, p_contact_id uuid, p_config_id uuid, p_generation uuid,
  p_recipient jsonb, p_message jsonb, p_preview text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cfg whatsapp_config%ROWTYPE; ct contacts%ROWTYPE; cv conversations%ROWTYPE;
  msg messages%ROWTYPE; md coexistence_message_metadata%ROWTYPE;
  conv uuid; parent uuid; sender uuid; stamp timestamptz; kind text; wamid text;
  payload jsonb; item jsonb; section jsonb; ids text[] := '{}'; total integer := 0;
  keys text[] := ARRAY['conversation_id','message_id','created_at','sender_type','sender_id','ai_generated',
    'content_type','content_text','media_url','template_name','interactive_payload','reply_to_message_id'];
  inserted integer := 0; promoted boolean; prior_lock_timeout text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL
      OR NOT is_account_member(p_account_id,'agent') THEN
      RAISE EXCEPTION 'outbound_forbidden' USING ERRCODE='42501';
    END IF;
  END IF;
  IF p_account_id IS NULL OR p_contact_id IS NULL
    OR (p_config_id IS NULL) <> (p_generation IS NULL)
    OR jsonb_typeof(p_recipient) IS DISTINCT FROM 'object'
    OR NOT p_recipient ?& ARRAY['phone','wa_user_id']
    OR p_recipient - ARRAY['phone','wa_user_id'] <> '{}'::jsonb
    OR EXISTS (SELECT 1 FROM jsonb_each(p_recipient) v WHERE jsonb_typeof(v.value) NOT IN ('string','null'))
    OR (p_recipient->>'phone' IS NOT NULL AND p_recipient->>'phone' !~ '^[0-9]{6,15}$')
    OR (p_recipient->>'wa_user_id' IS NOT NULL AND p_recipient->>'wa_user_id' !~ '^[A-Za-z]{2}\.(ENT\.)?[A-Za-z0-9]{4,}$')
    OR (p_recipient->>'phone' IS NULL AND p_recipient->>'wa_user_id' IS NULL)
    OR jsonb_typeof(p_message) IS DISTINCT FROM 'object'
    OR NOT p_message ?& keys OR p_message - keys <> '{}'::jsonb
    OR octet_length(p_message::text)>8388608 OR p_preview IS NULL
    OR EXISTS (SELECT 1 FROM unnest(ARRAY['conversation_id','message_id','created_at','sender_type','content_type']) k
      WHERE jsonb_typeof(p_message->k) IS DISTINCT FROM 'string')
    OR EXISTS (SELECT 1 FROM unnest(ARRAY['sender_id','content_text','media_url','template_name','reply_to_message_id']) k
      WHERE jsonb_typeof(p_message->k) NOT IN ('string','null'))
    OR jsonb_typeof(p_message->'ai_generated') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(p_message->'interactive_payload') NOT IN ('object','null')
    OR p_message->>'sender_type' NOT IN ('agent','bot')
    OR p_message->>'content_type' NOT IN ('text','template','interactive','image','video','document','audio')
    OR length(p_message->>'message_id') NOT BETWEEN 1 AND 1024 OR length(btrim(p_message->>'message_id'))=0 THEN
    RAISE EXCEPTION 'invalid_outbound_message' USING ERRCODE='22023';
  END IF;
  BEGIN
    conv := (p_message->>'conversation_id')::uuid;
    parent := (p_message->>'reply_to_message_id')::uuid;
    sender := (p_message->>'sender_id')::uuid;
    stamp := (p_message->>'created_at')::timestamptz;
  EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'invalid_outbound_message' USING ERRCODE='22023';
  END;
  IF NOT isfinite(stamp) THEN RAISE EXCEPTION 'invalid_outbound_timestamp' USING ERRCODE='22023'; END IF;
  IF auth.role() <> 'service_role' AND (p_message->>'sender_type' <> 'agent'
    OR sender IS DISTINCT FROM auth.uid() OR (p_message->>'ai_generated')::boolean) THEN
    RAISE EXCEPTION 'outbound_attribution_forbidden' USING ERRCODE='42501';
  END IF;
  kind := p_message->>'content_type'; wamid := p_message->>'message_id'; payload := p_message->'interactive_payload';
  IF kind <> 'interactive' AND payload <> 'null'::jsonb THEN
    RAISE EXCEPTION 'invalid_outbound_interactive' USING ERRCODE='22023';
  END IF;
  IF kind='interactive' THEN
    IF jsonb_typeof(payload) IS DISTINCT FROM 'object'
      OR NOT payload ?& ARRAY['kind','body']
      OR jsonb_typeof(payload->'kind') IS DISTINCT FROM 'string'
      OR payload->>'kind' NOT IN ('buttons','list')
      OR jsonb_typeof(payload->'body') IS DISTINCT FROM 'string'
      OR length(btrim(payload->>'body'))=0 OR length(payload->>'body')>1024
      OR EXISTS (SELECT 1 FROM unnest(ARRAY['header','footer']) k WHERE payload ? k
        AND (jsonb_typeof(payload->k) IS DISTINCT FROM 'string' OR length(payload->>k)>60))
      OR p_message->>'content_text' IS DISTINCT FROM payload->>'body' THEN
      RAISE EXCEPTION 'invalid_outbound_interactive' USING ERRCODE='22023';
    END IF;
    IF payload->>'kind'='buttons' THEN
      IF payload - ARRAY['kind','body','header','footer','buttons'] <> '{}'::jsonb
        OR jsonb_typeof(payload->'buttons') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'invalid_outbound_interactive' USING ERRCODE='22023'; END IF;
      IF jsonb_array_length(payload->'buttons') NOT BETWEEN 1 AND 3 THEN
        RAISE EXCEPTION 'invalid_outbound_interactive' USING ERRCODE='22023'; END IF;
      FOR item IN SELECT value FROM jsonb_array_elements(payload->'buttons') LOOP
        IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR NOT item ?& ARRAY['id','title']
          OR item - ARRAY['id','title'] <> '{}'::jsonb
          OR jsonb_typeof(item->'id') IS DISTINCT FROM 'string' OR length(btrim(item->>'id'))=0
          OR item->>'id'=ANY(ids) OR jsonb_typeof(item->'title') IS DISTINCT FROM 'string'
          OR length(btrim(item->>'title'))=0 OR length(item->>'title')>20 THEN
          RAISE EXCEPTION 'invalid_outbound_interactive' USING ERRCODE='22023'; END IF;
        ids := array_append(ids,item->>'id');
      END LOOP;
    ELSE
      IF payload - ARRAY['kind','body','header','footer','button_label','sections'] <> '{}'::jsonb
        OR jsonb_typeof(payload->'button_label') IS DISTINCT FROM 'string'
        OR length(btrim(payload->>'button_label'))=0 OR length(payload->>'button_label')>20
        OR jsonb_typeof(payload->'sections') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'invalid_outbound_interactive' USING ERRCODE='22023'; END IF;
      IF jsonb_array_length(payload->'sections') NOT BETWEEN 1 AND 10 THEN
        RAISE EXCEPTION 'invalid_outbound_interactive' USING ERRCODE='22023'; END IF;
      FOR section IN SELECT value FROM jsonb_array_elements(payload->'sections') LOOP
        IF jsonb_typeof(section) IS DISTINCT FROM 'object' OR section - ARRAY['title','rows'] <> '{}'::jsonb
          OR (section ? 'title' AND (jsonb_typeof(section->'title') IS DISTINCT FROM 'string' OR length(section->>'title')>24))
          OR jsonb_typeof(section->'rows') IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'invalid_outbound_interactive' USING ERRCODE='22023'; END IF;
        IF jsonb_array_length(section->'rows')=0 THEN RAISE EXCEPTION 'invalid_outbound_interactive' USING ERRCODE='22023'; END IF;
        FOR item IN SELECT value FROM jsonb_array_elements(section->'rows') LOOP
          total := total+1;
          IF total>10 OR jsonb_typeof(item) IS DISTINCT FROM 'object' OR NOT item ?& ARRAY['id','title']
            OR item - ARRAY['id','title','description'] <> '{}'::jsonb
            OR jsonb_typeof(item->'id') IS DISTINCT FROM 'string' OR length(btrim(item->>'id'))=0
            OR item->>'id'=ANY(ids) OR jsonb_typeof(item->'title') IS DISTINCT FROM 'string'
            OR length(btrim(item->>'title'))=0 OR length(item->>'title')>24
            OR (item ? 'description' AND (jsonb_typeof(item->'description') IS DISTINCT FROM 'string' OR length(item->>'description')>72)) THEN
            RAISE EXCEPTION 'invalid_outbound_interactive' USING ERRCODE='22023'; END IF;
          ids := array_append(ids,item->>'id');
        END LOOP;
      END LOOP;
    END IF;
  END IF;
  -- Same ordering as commit/recovery: config, account, contact, conversation, message.
  SELECT * INTO cfg FROM whatsapp_config WHERE account_id=p_account_id FOR UPDATE;
  IF cfg.id IS NULL OR cfg.status<>'connected'
    OR NOT EXISTS (SELECT 1 FROM profiles WHERE user_id=cfg.user_id AND account_id=p_account_id)
    OR (p_config_id IS NULL AND cfg.coexistence_app_id IS NOT NULL)
    OR (p_config_id IS NOT NULL AND (cfg.id IS DISTINCT FROM p_config_id
      OR cfg.coexistence_generation IS DISTINCT FROM p_generation
      OR cfg.coexistence_app_id IS NULL OR cfg.coexistence_verified_at IS NULL)) THEN
    RAISE EXCEPTION 'outbound_binding_changed' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM accounts WHERE id=p_account_id FOR UPDATE;
  SELECT * INTO ct FROM contacts WHERE id=p_contact_id AND account_id=p_account_id FOR UPDATE;
  SELECT * INTO cv FROM conversations WHERE id=conv AND account_id=p_account_id AND contact_id=p_contact_id FOR UPDATE;
  IF ct.id IS NULL OR cv.id IS NULL
    OR (p_recipient->>'phone' IS NOT NULL AND ct.phone_normalized IS DISTINCT FROM p_recipient->>'phone')
    OR (p_recipient->>'wa_user_id' IS NOT NULL AND ct.wa_user_id IS DISTINCT FROM p_recipient->>'wa_user_id') THEN
    RAISE EXCEPTION 'outbound_recipient_conflict' USING ERRCODE='22023';
  END IF;
  IF sender IS NOT NULL AND NOT EXISTS (SELECT 1 FROM profiles WHERE user_id=sender AND account_id=p_account_id
    AND account_role IN ('owner','admin','agent')) THEN
    RAISE EXCEPTION 'outbound_sender_conflict' USING ERRCODE='22023'; END IF;
  IF parent IS NOT NULL AND NOT EXISTS (SELECT 1 FROM messages WHERE id=parent AND conversation_id=conv) THEN
    RAISE EXCEPTION 'outbound_reply_conflict' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM messages m JOIN conversations c ON c.id=m.conversation_id
    WHERE c.account_id=p_account_id AND m.message_id=wamid AND c.id<>conv) THEN
    RAISE EXCEPTION 'outbound_message_identity_conflict' USING ERRCODE='22023'; END IF;
  -- Legacy writers lock message before conversation; never wait on an existing row in reverse order.
  SELECT * INTO msg FROM messages WHERE conversation_id=conv AND message_id=wamid FOR UPDATE NOWAIT;
  IF NOT FOUND THEN
    prior_lock_timeout := current_setting('lock_timeout');
    -- 1ms is the minimum nonzero timeout; it cannot weaken a caller's tighter limit.
    -- The subtransaction restores it on error; success restores it explicitly.
    BEGIN
      PERFORM set_config('lock_timeout','1ms',true);
      INSERT INTO messages(conversation_id,message_id,created_at,sender_type,sender_id,ai_generated,
        content_type,content_text,media_url,template_name,interactive_payload,reply_to_message_id,status,message_source)
      VALUES(conv,wamid,stamp,p_message->>'sender_type',sender,(p_message->>'ai_generated')::boolean,
        kind,p_message->>'content_text',p_message->>'media_url',p_message->>'template_name',nullif(payload,'null'::jsonb),parent,'sent','cloud_api')
      ON CONFLICT (conversation_id,message_id) DO NOTHING;
      GET DIAGNOSTICS inserted=ROW_COUNT;
      PERFORM set_config('lock_timeout',prior_lock_timeout,true);
    EXCEPTION WHEN OTHERS THEN RAISE;
    END;
    SELECT * INTO STRICT msg FROM messages WHERE conversation_id=conv AND message_id=wamid FOR UPDATE NOWAIT;
  END IF;
  SELECT * INTO md FROM coexistence_message_metadata WHERE message_id=msg.id FOR UPDATE;
  promoted := msg.message_source IN ('history','phone_app');
  IF msg.sender_type NOT IN ('agent','bot') OR (promoted AND (msg.sender_type<>'agent' OR p_config_id IS NULL
    OR md.source_config_id IS DISTINCT FROM p_config_id OR md.source_generation IS DISTINCT FROM p_generation)) THEN
    RAISE EXCEPTION 'outbound_direction_or_origin_conflict' USING ERRCODE='22023';
  END IF;
  IF inserted=0 AND NOT promoted THEN
    IF md.message_id IS NULL OR md.source_config_id IS DISTINCT FROM p_config_id OR md.source_generation IS DISTINCT FROM p_generation
      OR md.outbound_preview IS DISTINCT FROM p_preview
      OR msg.sender_type IS DISTINCT FROM p_message->>'sender_type' OR msg.sender_id IS DISTINCT FROM sender
      OR msg.ai_generated IS DISTINCT FROM (p_message->>'ai_generated')::boolean
      OR msg.content_type IS DISTINCT FROM kind OR msg.content_text IS DISTINCT FROM p_message->>'content_text'
      OR msg.media_url IS DISTINCT FROM p_message->>'media_url' OR msg.template_name IS DISTINCT FROM p_message->>'template_name'
      OR msg.interactive_payload IS DISTINCT FROM nullif(payload,'null'::jsonb) OR msg.reply_to_message_id IS DISTINCT FROM parent THEN
      RAISE EXCEPTION 'outbound_retry_conflict' USING ERRCODE='22023'; END IF;
  ELSE
    IF promoted THEN
      UPDATE messages SET message_source='cloud_api',sender_type=p_message->>'sender_type',sender_id=sender,
        ai_generated=(p_message->>'ai_generated')::boolean,content_type=kind,content_text=p_message->>'content_text',
        media_url=p_message->>'media_url',template_name=p_message->>'template_name',interactive_payload=nullif(payload,'null'::jsonb),
        reply_to_message_id=parent,interactive_reply_id=NULL,
        status=CASE WHEN status='sending' THEN 'sent' ELSE status END
      WHERE id=msg.id RETURNING * INTO msg;
    END IF;
    INSERT INTO coexistence_message_metadata(message_id,source_config_id,source_generation,outbound_created_at,outbound_preview)
      VALUES(msg.id,p_config_id,p_generation,stamp,p_preview)
    ON CONFLICT(message_id) DO UPDATE SET source_config_id=EXCLUDED.source_config_id,source_generation=EXCLUDED.source_generation,
      outbound_created_at=EXCLUDED.outbound_created_at,outbound_preview=EXCLUDED.outbound_preview,
      media_id=NULL,media_type=NULL,placeholder=false,reply_wamid=NULL;
    -- Preserve unrelated/newer activity; equality repairs this row's quiet preview, not a tied sibling.
    UPDATE conversations SET last_message_at=msg.created_at,last_message_text=p_preview,updated_at=now()
      WHERE id=conv AND (last_message_at IS NULL OR msg.created_at>last_message_at
        OR (msg.created_at=last_message_at AND NOT EXISTS (SELECT 1 FROM messages m
          WHERE m.conversation_id=conv AND m.created_at=msg.created_at AND m.id<>msg.id)));
    -- Phone-app agents may already have contributed before becoming a non-AI bot.
    IF promoted THEN
      UPDATE conversations SET last_reply_at=(SELECT max(m.created_at) FROM messages m WHERE m.conversation_id=conv
        AND m.message_source<>'history' AND (m.sender_type='agent' OR m.ai_generated) AND m.status<>'failed') WHERE id=conv;
    END IF;
  END IF;
  -- Actual receipt transitions, not imported status/current state, prove a deferred public intent.
  INSERT INTO coexistence_status_events(message_id,config_id,account_id,generation,status,occurred_at)
    SELECT msg.id,u.config_id,u.account_id,u.generation,u.operation->>'status',(u.operation->>'occurred_at')::timestamptz
    FROM coexistence_updates u WHERE u.advanced_message_id=msg.id AND u.config_id=p_config_id
      AND u.generation=p_generation AND u.account_id=p_account_id AND u.target_wamid=wamid
      AND u.state='applied' AND u.captured_at>now()-interval '7 days'
      AND u.operation->>'kind'='message_status'
      AND u.operation->>'status' IN ('sent','delivered','read','failed')
      AND CASE WHEN jsonb_typeof(u.operation->'occurred_at')='string'
        AND pg_input_is_valid(u.operation->>'occurred_at','timestamp with time zone')
        THEN isfinite((u.operation->>'occurred_at')::timestamptz) ELSE false END
    ON CONFLICT(message_id,status) DO NOTHING;
  RETURN jsonb_build_object('id',msg.id,'message_id',msg.message_id,'status',msg.status);
END;
$$;
ALTER FUNCTION public.persist_outbound_message(uuid,uuid,uuid,uuid,jsonb,jsonb,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.persist_outbound_message(uuid,uuid,uuid,uuid,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.persist_outbound_message(uuid,uuid,uuid,uuid,jsonb,jsonb,text) TO authenticated,service_role;

-- Preserve the existing update policy; record proof only after an actual message advance.
CREATE OR REPLACE FUNCTION public.coexistence_apply_update(p_id uuid)
RETURNS text LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE u coexistence_updates%ROWTYPE; op jsonb; actor uuid; cv conversations%ROWTYPE;
  msg messages%ROWTYPE; prior coexistence_reaction_order%ROWTYPE; stamp timestamptz; incoming text;
  outcome text := 'applied'; n integer; parent uuid;
BEGIN
  SELECT * INTO u FROM coexistence_updates WHERE id=p_id FOR UPDATE;
  IF NOT FOUND OR u.state NOT IN ('pending','applied') THEN RETURN 'noop'; END IF;
  IF u.captured_at <= now()-interval '7 days' THEN
    UPDATE coexistence_updates SET state='expired',operation=NULL WHERE id=u.id; RETURN 'expired';
  END IF;
  op := u.operation; stamp := (op->>'occurred_at')::timestamptz;
  BEGIN
    actor := coexistence_update_contact(u.account_id,op->'identity');
    parent:=coexistence_update_parent(u.account_id,u.target_wamid,op->'identity',op->>'kind');
    IF parent IS NULL AND (op->>'kind'='reaction' OR NOT EXISTS (
      SELECT 1 FROM broadcast_recipients r JOIN broadcasts b ON b.id=r.broadcast_id
      WHERE b.account_id=u.account_id AND r.contact_id=actor AND r.whatsapp_message_id=u.target_wamid
    )) THEN RETURN 'pending'; END IF;
    IF actor IS NULL THEN RAISE EXCEPTION 'recipient_conflict' USING ERRCODE='P2001'; END IF;
    IF parent IS NOT NULL THEN
      SELECT c.* INTO cv FROM conversations c JOIN messages m ON m.conversation_id=c.id
        WHERE m.id=parent AND c.account_id=u.account_id FOR UPDATE OF c;
      IF cv.contact_id IS DISTINCT FROM actor THEN
        RAISE EXCEPTION 'recipient_conflict' USING ERRCODE='P2001'; END IF;
      -- Legacy direct status writers lock message then conversation via their trigger.
      -- Never wait on their message while holding its conversation: retry next drain instead.
      SELECT * INTO msg FROM messages WHERE conversation_id=cv.id AND message_id=u.target_wamid FOR UPDATE NOWAIT;
      IF NOT FOUND THEN RETURN 'pending'; END IF;
    END IF;
    IF op->>'kind'='message_status' THEN
      IF msg.id IS NOT NULL AND msg.sender_type NOT IN ('agent','bot','ai','system') THEN
        RAISE EXCEPTION 'status_direction_conflict' USING ERRCODE='P2001'; END IF;
      incoming := op->>'status';
      -- A bounded sweep may leave older successes outside its selected rows; failure must wait.
      IF incoming='failed' AND EXISTS (
        SELECT 1 FROM coexistence_updates success JOIN contacts ct ON ct.id=actor
        WHERE success.config_id=u.config_id AND success.account_id=u.account_id AND success.generation=u.generation
          AND success.target_wamid=u.target_wamid AND success.id<>u.id
          AND success.operation->>'kind'='message_status' AND success.operation->>'status' IN ('sent','delivered','read')
          AND ((ct.phone_normalized<>'' AND ct.phone_normalized=coalesce(success.operation#>>'{identity,phone}',''))
            OR ct.wa_user_id=nullif(success.operation#>>'{identity,wa_user_id}',''))
          AND coexistence_update_ready(success)
      ) THEN RETURN 'pending'; END IF;
      UPDATE messages SET status=incoming,
        error_code=CASE WHEN incoming='failed' THEN coalesce((op->>'error_code')::integer,error_code) ELSE error_code END,
        error_title=CASE WHEN incoming='failed' THEN coalesce(op->>'error_title',error_title) ELSE error_title END,
        error_details=CASE WHEN incoming='failed' THEN coalesce(op->>'error_details',error_details) ELSE error_details END
      WHERE id=msg.id AND status<>'failed' AND
        ((incoming='failed' AND status IN ('sending','sent')) OR
        array_position(ARRAY['sending','sent','delivered','read'],incoming)>
          array_position(ARRAY['sending','sent','delivered','read'],status));
      GET DIAGNOSTICS n=ROW_COUNT;
      IF n=1 THEN
        UPDATE coexistence_updates SET advanced_message_id=msg.id WHERE id=u.id;
      END IF;
      IF n=1 AND msg.message_source='cloud_api' THEN
        INSERT INTO coexistence_status_events(message_id,config_id,account_id,generation,status,occurred_at)
        VALUES(msg.id,u.config_id,u.account_id,u.generation,incoming,stamp)
        ON CONFLICT(message_id,status) DO NOTHING;
      END IF;
      -- Recipient triggers own aggregate counts. Never match by wamid without both account and recipient.
      UPDATE broadcast_recipients r SET status=incoming,
        sent_at=CASE WHEN incoming='sent' THEN stamp ELSE r.sent_at END,
        delivered_at=CASE WHEN incoming='delivered' THEN stamp ELSE r.delivered_at END,
        read_at=CASE WHEN incoming='read' THEN stamp ELSE r.read_at END,
        error_message=CASE WHEN incoming='failed' THEN coalesce(
          nullif(concat(CASE WHEN op->>'error_code' IS NOT NULL THEN '['||(op->>'error_code')||'] ' END,
            op->>'error_title',CASE WHEN nullif(op->>'error_details','') IS NOT NULL THEN ': '||(op->>'error_details') END),''),r.error_message)
          ELSE r.error_message END
      FROM broadcasts b WHERE b.id=r.broadcast_id AND b.account_id=u.account_id AND r.contact_id=actor
        AND r.whatsapp_message_id=u.target_wamid AND r.status<>'failed' AND
        ((incoming='failed' AND r.status IN ('pending','sent')) OR
          array_position(ARRAY['pending','sent','delivered','read','replied'],incoming)>
          array_position(ARRAY['pending','sent','delivered','read','replied'],r.status));
    ELSE
      SELECT * INTO prior FROM coexistence_reaction_order WHERE message_id=msg.id AND actor_id=actor;
      IF prior.source_at IS NOT NULL AND stamp<prior.source_at THEN outcome := 'stale';
      ELSIF stamp=prior.source_at AND prior.emoji IS DISTINCT FROM op->>'emoji' THEN
        -- No lexical event-id clock: preserve evidence of a tie, with removal winning in either arrival order.
        outcome := 'quarantined';
        IF op->>'emoji'='' THEN
          UPDATE coexistence_reaction_order SET emoji='' WHERE message_id=msg.id AND actor_id=actor;
          DELETE FROM message_reactions WHERE message_id=msg.id AND actor_type='customer' AND actor_id=actor;
        END IF;
      ELSIF prior.source_at IS NULL OR stamp>prior.source_at THEN
        INSERT INTO coexistence_reaction_order(message_id,actor_id,source_at,emoji) VALUES(msg.id,actor,stamp,op->>'emoji')
          ON CONFLICT(message_id,actor_id) DO UPDATE SET source_at=EXCLUDED.source_at,emoji=EXCLUDED.emoji;
        IF op->>'emoji'='' THEN
          DELETE FROM message_reactions WHERE message_id=msg.id AND actor_type='customer' AND actor_id=actor;
        ELSE
          INSERT INTO message_reactions(message_id,conversation_id,actor_type,actor_id,emoji,created_at)
          VALUES(msg.id,cv.id,'customer',actor,op->>'emoji',stamp)
          ON CONFLICT(message_id,actor_type,actor_id) DO UPDATE SET emoji=EXCLUDED.emoji,created_at=EXCLUDED.created_at;
        END IF;
      END IF;
    END IF;
  EXCEPTION WHEN lock_not_available THEN RETURN 'pending';
    WHEN SQLSTATE 'P2001' THEN outcome := 'conflict';
  END;
  UPDATE coexistence_updates SET state=CASE WHEN outcome='conflict' THEN 'quarantined' ELSE outcome END WHERE id=u.id;
  RETURN outcome;
END;
$$;


-- Forward replacement: provenance and outbound protection; inbound acceptance is unchanged.
CREATE OR REPLACE FUNCTION public.coexistence_commit(p_job_id uuid, p_lease_token uuid, p_operations jsonb)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE j coexistence_jobs%ROWTYPE; c whatsapp_config%ROWTYPE; op jsonb; contact uuid;
  conv uuid; msg messages%ROWTYPE; stamp timestamptz; managed text; old_state coexistence_contact_state%ROWTYPE;
  source text; normalized_status text; reply_id uuid; code text;
  is_live boolean; new_contact boolean; new_conversation boolean; first_inbound boolean;
  accepted boolean; inserted integer; update_id uuid; update_result text; current_update_ids uuid[] := '{}';
  update_target text; blocked_target text; prior_lock_timeout text;
BEGIN
  -- Config first everywhere: capture, generation rotation and commit cannot race.
  SELECT wc.* INTO c FROM whatsapp_config wc JOIN coexistence_jobs cj ON cj.config_id = wc.id WHERE cj.id = p_job_id FOR UPDATE OF wc;
  SELECT * INTO j FROM coexistence_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR j.status <> 'processing' OR p_lease_token IS NULL OR j.lease_token IS DISTINCT FROM p_lease_token
    OR j.lease_until IS NULL OR j.lease_until <= now() THEN RETURN 'stale'; END IF;
  IF c.id IS NULL OR c.account_id <> j.account_id OR c.coexistence_generation <> j.generation
    OR c.coexistence_verified_at IS NULL OR c.coexistence_app_id IS NULL OR c.status <> 'connected'
    OR NOT EXISTS (SELECT 1 FROM profiles WHERE user_id=c.user_id AND account_id=c.account_id) THEN
    UPDATE coexistence_jobs SET status = 'quarantined', last_error = 'binding_changed', completed_at = now(),
      lease_token = NULL, lease_until = NULL WHERE id = j.id;
    RETURN 'quarantined';
  END IF;
  IF jsonb_typeof(p_operations) IS DISTINCT FROM 'array' OR jsonb_array_length(p_operations) > 5000
    OR octet_length(p_operations::text) > 8388608 THEN RAISE EXCEPTION 'coexistence_invalid_operations'; END IF;
  -- Serialize identity creation across configs in the same account as well as this config.
  PERFORM 1 FROM accounts WHERE id = j.account_id FOR UPDATE;
  -- The subtransaction makes an unsupported operation or identity conflict all-or-nothing.
  BEGIN
    FOR op IN SELECT value FROM jsonb_array_elements(p_operations) LOOP
      IF op->>'kind' = 'quarantine' THEN
        RAISE EXCEPTION 'unsupported_payload' USING ERRCODE = 'P2001';
      ELSIF op->>'kind' IN ('message_status','reaction') THEN
        current_update_ids := array_append(current_update_ids,coexistence_capture_update(j.id,op));
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
        IF EXISTS (SELECT 1 FROM coexistence_message_metadata md WHERE md.message_id=msg.id
          AND md.source_config_id IS NOT NULL
          AND (md.source_config_id IS DISTINCT FROM c.id OR md.source_generation IS DISTINCT FROM j.generation)) THEN
          RAISE EXCEPTION 'message_origin_conflict' USING ERRCODE='P2001'; END IF;
        IF op->>'content_type' IS NULL OR op->>'content_type' NOT IN ('text','image','document','audio','video','location','interactive')
          OR nullif(op->>'media_id', '') IS NULL THEN RAISE EXCEPTION 'invalid_hydration' USING ERRCODE = 'P2001'; END IF;
        IF msg.message_source <> 'cloud_api' THEN
          UPDATE messages SET content_type = op->>'content_type', content_text = coalesce(op->>'content_text', content_text)
            WHERE id = msg.id;
          INSERT INTO coexistence_message_metadata(message_id, media_id, media_type, placeholder)
          VALUES(msg.id, op->>'media_id', op->>'media_type', false)
          ON CONFLICT (message_id) DO UPDATE SET media_id = EXCLUDED.media_id, media_type = EXCLUDED.media_type, placeholder = false;
        END IF;
      ELSIF op->>'kind' IN ('message', 'contact', 'live_message') THEN
        is_live := op->>'kind' = 'live_message';
        IF is_live THEN
          IF NOT op ?& ARRAY['kind','source','sender_type','identity','wamid','occurred_at',
              'content_type','content_text','status','reply_wamid','media_id','media_type','placeholder','interactive_reply_id']
            OR op->>'source' IS DISTINCT FROM 'cloud_api' OR op->>'sender_type' IS DISTINCT FROM 'customer'
            OR op->>'status' IS DISTINCT FROM 'delivered'
            OR jsonb_typeof(op->'identity') IS DISTINCT FROM 'object'
            OR jsonb_typeof(op->'wamid') IS DISTINCT FROM 'string' OR nullif(op->>'wamid', '') IS NULL
            OR jsonb_typeof(op->'occurred_at') IS DISTINCT FROM 'string'
            OR jsonb_typeof(op->'content_type') IS DISTINCT FROM 'string'
            OR op->>'content_type' NOT IN ('text','image','document','audio','video','location','interactive')
            OR jsonb_typeof(op->'placeholder') IS DISTINCT FROM 'boolean'
            OR EXISTS (SELECT 1 FROM unnest(ARRAY['content_text','reply_wamid','media_id','media_type','interactive_reply_id']) k
              WHERE jsonb_typeof(op->k) NOT IN ('string','null'))
            OR EXISTS (SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(op->'identity') = 'object'
                THEN op->'identity' ELSE '{}'::jsonb END) kv
              WHERE kv.key IN ('phone','wa_user_id','wa_parent_user_id','wa_username','name')
                AND jsonb_typeof(kv.value) NOT IN ('string','null')) THEN
            RAISE EXCEPTION 'invalid_live_message' USING ERRCODE = 'P2001';
          END IF;
        END IF;
        BEGIN
          stamp := (op->>'occurred_at')::timestamptz;
        EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
          IF is_live THEN RAISE EXCEPTION 'invalid_timestamp' USING ERRCODE = 'P2001'; END IF;
          RAISE;
        END;
        IF stamp IS NULL OR NOT isfinite(stamp) THEN RAISE EXCEPTION 'invalid_timestamp' USING ERRCODE = 'P2001'; END IF;
        new_contact := NOT EXISTS (SELECT 1 FROM contacts ct WHERE ct.account_id = j.account_id
          AND ((ct.phone_normalized <> '' AND ct.phone_normalized = regexp_replace(coalesce(op->'identity'->>'phone', ''), '\D', '', 'g'))
            OR ct.wa_user_id = nullif(op->'identity'->>'wa_user_id', '')));
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
          IF (NOT is_live AND (source IS NULL OR source NOT IN ('history', 'phone_app'))) OR nullif(op->>'wamid', '') IS NULL
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
          GET DIAGNOSTICS inserted = ROW_COUNT;
          new_conversation := inserted = 1;
          SELECT id, first_inbound_at IS NULL INTO conv, first_inbound FROM conversations
            WHERE account_id = j.account_id AND contact_id = contact FOR UPDATE;
          IF EXISTS (SELECT 1 FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
            WHERE cv.account_id = j.account_id AND m.message_id = op->>'wamid' AND cv.id <> conv) THEN
            RAISE EXCEPTION 'message_identity_conflict' USING ERRCODE = 'P2001';
          END IF;
          SELECT m.id INTO reply_id FROM messages m WHERE m.conversation_id = conv AND m.message_id = coalesce(
            op->>'reply_wamid', (SELECT md.reply_wamid FROM coexistence_message_metadata md
              JOIN messages existing ON existing.id = md.message_id
              WHERE existing.conversation_id = conv AND existing.message_id = op->>'wamid'));
          inserted := 0;
          -- Legacy writers may hold this message while waiting on our conversation.
          SELECT * INTO msg FROM messages WHERE conversation_id = conv AND message_id = op->>'wamid' FOR UPDATE NOWAIT;
          IF NOT FOUND THEN
            prior_lock_timeout := current_setting('lock_timeout');
            -- Bound an uncommitted direct-insert conflict too; errors escape for worker retry.
            BEGIN
              PERFORM set_config('lock_timeout','1ms',true);
              INSERT INTO messages(conversation_id, sender_type, content_type, content_text, message_id, status, created_at, message_source, reply_to_message_id)
              VALUES(conv, op->>'sender_type', op->>'content_type', op->>'content_text', op->>'wamid', normalized_status, stamp, source, reply_id)
              ON CONFLICT (conversation_id, message_id) DO NOTHING;
              GET DIAGNOSTICS inserted = ROW_COUNT;
              PERFORM set_config('lock_timeout',prior_lock_timeout,true);
            EXCEPTION WHEN OTHERS THEN RAISE;
            END;
            SELECT * INTO STRICT msg FROM messages WHERE conversation_id = conv AND message_id = op->>'wamid' FOR UPDATE NOWAIT;
          END IF;
          -- Stamp only genuinely new rows; replay cannot prove an older row's origin.
          IF inserted=1 THEN
            INSERT INTO coexistence_message_metadata(message_id,source_config_id,source_generation,placeholder)
              VALUES(msg.id,c.id,j.generation,coalesce((op->>'placeholder')::boolean,false));
          ELSIF EXISTS (SELECT 1 FROM coexistence_message_metadata md WHERE md.message_id=msg.id
            AND ((md.source_config_id IS NOT NULL AND (md.source_config_id IS DISTINCT FROM c.id OR md.source_generation IS DISTINCT FROM j.generation))
              OR (md.outbound_created_at IS NOT NULL AND (md.source_config_id IS DISTINCT FROM c.id OR md.source_generation IS DISTINCT FROM j.generation)))) THEN
            RAISE EXCEPTION 'message_origin_conflict' USING ERRCODE='P2001';
          END IF;
          accepted := is_live AND (inserted = 1 OR msg.message_source = 'history');
          IF accepted THEN
            -- Live context is authoritative, including null; only duplicates may use stored context.
            SELECT id INTO reply_id FROM messages WHERE conversation_id = conv AND message_id = op->>'reply_wamid';
          ELSIF msg.message_source = 'cloud_api' AND msg.sender_type='customer' AND (NOT is_live OR EXISTS (
            SELECT 1 FROM coexistence_message_metadata WHERE message_id = msg.id)) THEN
            SELECT m.id INTO reply_id FROM messages m JOIN coexistence_message_metadata md
              ON md.message_id = msg.id AND md.reply_wamid = m.message_id
              WHERE m.conversation_id = conv;
          END IF;
          IF msg.sender_type <> op->>'sender_type' AND NOT (NOT is_live AND msg.message_source='cloud_api'
            AND msg.sender_type='bot' AND op->>'sender_type'='agent') THEN
            RAISE EXCEPTION 'direction_conflict' USING ERRCODE = 'P2001'; END IF;
          IF msg.message_source <> 'cloud_api' OR accepted THEN
            UPDATE messages SET
              content_type = CASE WHEN accepted THEN op->>'content_type'
                WHEN coalesce((op->>'placeholder')::boolean, false) THEN content_type ELSE op->>'content_type' END,
              content_text = CASE WHEN accepted THEN op->>'content_text'
                WHEN coalesce((op->>'placeholder')::boolean, false) THEN content_text ELSE coalesce(op->>'content_text', content_text) END,
              -- Match message-status.ts: failure is terminal, but cannot replace delivery/read.
              status = CASE
                WHEN status = 'failed' THEN status
                WHEN normalized_status = 'failed' AND status IN ('sending', 'sent') THEN 'failed'
                WHEN array_position(ARRAY['sending','sent','delivered','read'], normalized_status)
                  > array_position(ARRAY['sending','sent','delivered','read'], status) THEN normalized_status
                ELSE status END,
              message_source = CASE WHEN is_live THEN 'cloud_api' WHEN source = 'phone_app' THEN 'phone_app' ELSE message_source END,
              created_at = CASE WHEN accepted THEN stamp ELSE created_at END,
              interactive_reply_id = CASE WHEN accepted THEN op->>'interactive_reply_id' ELSE interactive_reply_id END,
              reply_to_message_id = CASE WHEN accepted THEN reply_id ELSE coalesce(reply_to_message_id, reply_id) END
            WHERE id = msg.id;
          END IF;
          -- A legacy cloud row is already accepted; repair reply context without replaying effects.
          UPDATE messages SET reply_to_message_id = reply_id
            WHERE id = msg.id AND reply_to_message_id IS NULL AND reply_id IS NOT NULL
              AND (message_source<>'cloud_api' OR sender_type='customer');
          IF accepted THEN
            INSERT INTO coexistence_live_effects(message_id, config_id, generation,
              was_new_contact, was_new_conversation, was_first_inbound)
            VALUES(msg.id, c.id, j.generation, new_contact, new_conversation, first_inbound);
            UPDATE conversations SET unread_count = coalesce(unread_count, 0) + 1,
              status = CASE WHEN status = 'closed' THEN 'open' ELSE status END,
              first_inbound_at = coalesce(first_inbound_at, stamp)
              WHERE id = conv;
          END IF;
          -- Late history/duplicates cannot replace accepted live metadata.
          IF msg.message_source <> 'cloud_api' OR accepted OR (msg.sender_type='customer' AND NOT EXISTS (
            SELECT 1 FROM coexistence_message_metadata WHERE message_id = msg.id)) THEN
            INSERT INTO coexistence_message_metadata(message_id, media_id, media_type, placeholder, reply_wamid)
            VALUES(msg.id, op->>'media_id', op->>'media_type', coalesce((op->>'placeholder')::boolean, false), op->>'reply_wamid')
            ON CONFLICT (message_id) DO UPDATE SET
              media_id = CASE WHEN accepted THEN EXCLUDED.media_id
                WHEN EXCLUDED.placeholder AND NOT coexistence_message_metadata.placeholder
                THEN coexistence_message_metadata.media_id ELSE coalesce(EXCLUDED.media_id, coexistence_message_metadata.media_id) END,
              media_type = CASE WHEN accepted THEN EXCLUDED.media_type
                WHEN EXCLUDED.placeholder AND NOT coexistence_message_metadata.placeholder
                THEN coexistence_message_metadata.media_type ELSE coalesce(EXCLUDED.media_type, coexistence_message_metadata.media_type) END,
              placeholder = CASE WHEN accepted THEN EXCLUDED.placeholder
                ELSE coexistence_message_metadata.placeholder AND EXCLUDED.placeholder END,
              reply_wamid = CASE WHEN accepted THEN EXCLUDED.reply_wamid
                ELSE coalesce(coexistence_message_metadata.reply_wamid, EXCLUDED.reply_wamid) END;
          END IF;
          -- Resolve reply context in either arrival order, scoped to this conversation.
          UPDATE messages m SET reply_to_message_id = msg.id FROM coexistence_message_metadata md
            WHERE md.message_id = m.id AND md.reply_wamid = msg.message_id
              AND m.conversation_id = conv AND m.reply_to_message_id IS NULL
              AND (m.message_source<>'cloud_api' OR m.sender_type='customer');
          UPDATE conversations cv SET last_message_at = m.created_at, last_message_text = m.content_text
            FROM messages m WHERE m.id = msg.id AND cv.id = conv
              AND (msg.message_source<>'cloud_api' OR accepted OR msg.sender_type='customer')
              AND (cv.last_message_at IS NULL OR m.created_at > cv.last_message_at
                OR (accepted AND m.created_at = cv.last_message_at AND NOT EXISTS (
                  SELECT 1 FROM messages other WHERE other.conversation_id = conv
                    AND other.created_at = m.created_at AND other.id <> m.id)));
        END IF;
      ELSE RAISE EXCEPTION 'unsupported_operation' USING ERRCODE = 'P2001';
      END IF;
    END LOOP;
    -- Revalidate EVERY current receipt, even a deduped/quarantined/expired one, after its siblings.
    -- Ordering quarantine is not an identity failure, but must never hide one on a rebatch.
    FOR op IN SELECT value FROM jsonb_array_elements(p_operations) WHERE value->>'kind' IN ('message_status','reaction') LOOP
      PERFORM coexistence_update_parent(j.account_id,
        CASE WHEN op->>'kind'='reaction' THEN op->>'target_wamid' ELSE op->>'wamid' END,op->'identity',op->>'kind');
    END LOOP;
    -- Current receipts cannot starve behind backlog; old work is capped at 100 per commit.
    -- Successful statuses precede failure; same-change parents are now visible. No INSERT trigger.
    FOR update_id, update_target IN SELECT u.id,u.target_wamid FROM coexistence_updates u WHERE u.config_id=c.id
      AND u.generation=j.generation AND u.account_id=j.account_id AND coexistence_update_ready(u)
      AND (u.id=ANY(current_update_ids) OR u.id IN (
        SELECT old.id FROM coexistence_updates old WHERE old.config_id=c.id
          AND old.generation=j.generation AND old.account_id=j.account_id
          AND NOT old.id=ANY(current_update_ids) AND coexistence_update_ready(old)
        ORDER BY old.target_wamid,
          CASE old.operation->>'status' WHEN 'sent' THEN 0 WHEN 'delivered' THEN 1 WHEN 'read' THEN 2 WHEN 'failed' THEN 3 ELSE 4 END,
          old.captured_at,old.id LIMIT 100
      ))
      ORDER BY u.target_wamid,
        CASE u.operation->>'status' WHEN 'sent' THEN 0 WHEN 'delivered' THEN 1 WHEN 'read' THEN 2 WHEN 'failed' THEN 3 ELSE 4 END,
        u.captured_at,u.id
    LOOP
      IF update_target=blocked_target THEN CONTINUE; END IF;
      update_result := coexistence_apply_update(update_id);
      -- A failed event must not overtake a successful event deferred by a legacy writer's lock.
      IF update_result='pending' THEN blocked_target:=update_target; END IF;
      -- An old bad receipt must not poison a later legitimate parent's transaction.
      IF update_result='conflict' AND update_id=ANY(current_update_ids) THEN
        RAISE EXCEPTION 'update_identity_conflict' USING ERRCODE='P2001'; END IF;
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

ALTER FUNCTION public.coexistence_commit(uuid, uuid, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.coexistence_commit(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.coexistence_commit(uuid, uuid, jsonb) TO service_role;
