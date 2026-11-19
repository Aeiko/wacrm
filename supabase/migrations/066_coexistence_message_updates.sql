-- Live Cloud API recipient statuses and remote customer reactions only.
-- Raw normalized updates expire seven days after webhook capture, not provider time.
-- Event receipts and reaction ordering tombstones survive payload expiry/rebatching.
-- Identity fences use current contact identity; historical ownership of a recycled number is not provable here.
-- provider_status is retained verbatim in the private operation; played projects to read.
-- Omitted provider_status accepts the original normalized contract, treating status as provider_status.
CREATE TABLE public.coexistence_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id uuid NOT NULL REFERENCES public.whatsapp_config(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  generation uuid NOT NULL,
  event_key text NOT NULL,
  target_wamid text NOT NULL,
  operation jsonb,
  captured_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','applied','quarantined','stale','expired')),
  UNIQUE(config_id,event_key)
);
CREATE INDEX coexistence_updates_ready ON public.coexistence_updates(config_id,target_wamid,captured_at)
  WHERE state IN ('pending','applied') AND operation IS NOT NULL;
CREATE INDEX coexistence_updates_expiry ON public.coexistence_updates(captured_at) WHERE operation IS NOT NULL;
-- 067 owns leasing/dispatch. Only actual Cloud API outbound advances enqueue public status events.
CREATE TABLE public.coexistence_status_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  config_id uuid NOT NULL REFERENCES public.whatsapp_config(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  generation uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('sent','delivered','read','failed')),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','completed','ambiguous','stale')),
  lease_token uuid,
  lease_until timestamptz,
  last_error text,
  UNIQUE(message_id,status)
);
ALTER TABLE public.coexistence_status_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.coexistence_status_events FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.coexistence_status_events TO service_role;

CREATE TABLE public.coexistence_reaction_order (
  message_id uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  source_at timestamptz NOT NULL CHECK (isfinite(source_at)),
  emoji text NOT NULL,
  PRIMARY KEY(message_id,actor_id)
);
ALTER TABLE public.coexistence_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coexistence_reaction_order ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.coexistence_updates, public.coexistence_reaction_order FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.coexistence_updates, public.coexistence_reaction_order TO service_role;

-- Read-only identity lookup: early updates must never manufacture participants.
CREATE FUNCTION public.coexistence_update_contact(p_account uuid, p_identity jsonb)
RETURNS uuid LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE ph text := regexp_replace(coalesce(p_identity->>'phone',''),'\D','','g');
  bs text := nullif(p_identity->>'wa_user_id',''); a contacts%ROWTYPE; b contacts%ROWTYPE;
BEGIN
  SELECT * INTO a FROM contacts WHERE account_id=p_account AND ph<>'' AND phone_normalized=ph;
  SELECT * INTO b FROM contacts WHERE account_id=p_account AND wa_user_id=bs;
  IF (a.id IS NOT NULL AND b.id IS NOT NULL AND a.id<>b.id)
    OR (a.wa_user_id IS NOT NULL AND bs IS NOT NULL AND a.wa_user_id<>bs)
    OR (b.phone_normalized<>'' AND ph<>'' AND b.phone_normalized<>ph) THEN
    RAISE EXCEPTION 'identity_conflict' USING ERRCODE='P2001';
  END IF;
  RETURN coalesce(b.id,a.id);
END;
$$;

-- A wamid may be reused by another participant; only that participant's own duplicate is ambiguous.
CREATE FUNCTION public.coexistence_update_parent(p_account uuid,p_target text,p_identity jsonb,p_kind text)
RETURNS uuid LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE actor uuid; parent uuid; n integer; direction text;
BEGIN
  actor:=coexistence_update_contact(p_account,p_identity);
  SELECT count(*) INTO n FROM messages m JOIN conversations cv ON cv.id=m.conversation_id
    WHERE cv.account_id=p_account AND cv.contact_id=actor AND m.message_id=p_target;
  IF n>1 THEN RAISE EXCEPTION 'ambiguous_parent' USING ERRCODE='P2001'; END IF;
  IF n=0 THEN
    IF EXISTS (SELECT 1 FROM messages m JOIN conversations cv ON cv.id=m.conversation_id
      WHERE cv.account_id=p_account AND m.message_id=p_target) THEN
      RAISE EXCEPTION 'recipient_conflict' USING ERRCODE='P2001';
    END IF;
    RETURN NULL;
  END IF;
  SELECT m.id,m.sender_type INTO parent,direction FROM messages m JOIN conversations cv ON cv.id=m.conversation_id
    WHERE cv.account_id=p_account AND cv.contact_id=actor AND m.message_id=p_target;
  IF p_kind='message_status' AND direction NOT IN ('agent','bot','ai','system') THEN
    RAISE EXCEPTION 'status_direction_conflict' USING ERRCODE='P2001';
  END IF;
  RETURN parent;
END;
$$;

CREATE FUNCTION public.coexistence_capture_update(p_job uuid, p_op jsonb)
RETURNS uuid LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE j coexistence_jobs%ROWTYPE; stamp timestamptz; ident jsonb; key_data jsonb; ph text; bs text; receipt_id uuid;
BEGIN
  IF jsonb_typeof(p_op) IS DISTINCT FROM 'object'
    OR NOT p_op ?& ARRAY['kind','wamid','occurred_at','identity']
    OR jsonb_typeof(p_op->'wamid') IS DISTINCT FROM 'string' OR length(p_op->>'wamid') NOT BETWEEN 1 AND 1024
    OR jsonb_typeof(p_op->'occurred_at') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_op->'identity') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid_update' USING ERRCODE='P2001';
  END IF;
  ident := p_op->'identity';
  IF NOT ident ?& ARRAY['phone','wa_user_id','wa_parent_user_id','wa_username','name']
    OR EXISTS (SELECT 1 FROM jsonb_each(ident) kv WHERE jsonb_typeof(kv.value) NOT IN ('string','null')) THEN
    RAISE EXCEPTION 'invalid_update_identity' USING ERRCODE='P2001';
  END IF;
  ph := coalesce(ident->>'phone',''); bs := nullif(ident->>'wa_user_id','');
  IF (ph<>'' AND ph !~ '^[0-9]{6,15}$')
    OR (bs IS NOT NULL AND bs !~ '^[A-Za-z]{2}\.(ENT\.)?[A-Za-z0-9]{4,}$')
    OR (nullif(ident->>'wa_parent_user_id','') IS NOT NULL
      AND ident->>'wa_parent_user_id' !~ '^[A-Za-z]{2}\.(ENT\.)?[A-Za-z0-9]{4,}$') THEN
    RAISE EXCEPTION 'invalid_update_identity' USING ERRCODE='P2001';
  END IF;
  IF ph='' AND bs IS NULL THEN RAISE EXCEPTION 'identity_missing' USING ERRCODE='P2001'; END IF;
  BEGIN
    stamp := (p_op->>'occurred_at')::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'invalid_timestamp' USING ERRCODE='P2001';
  END;
  IF stamp IS NULL OR NOT isfinite(stamp) THEN RAISE EXCEPTION 'invalid_timestamp' USING ERRCODE='P2001'; END IF;
  IF p_op->>'kind'='message_status' THEN
    IF NOT p_op ?& ARRAY['status','error_code','error_title','error_details']
      OR p_op->>'status' IS NULL OR p_op->>'status' NOT IN ('sent','delivered','read','failed')
      OR jsonb_typeof(p_op->'error_code') NOT IN ('number','null')
      OR EXISTS (SELECT 1 FROM unnest(ARRAY['error_title','error_details']) k WHERE jsonb_typeof(p_op->k) NOT IN ('string','null')) THEN
      RAISE EXCEPTION 'invalid_message_status' USING ERRCODE='P2001';
    END IF;
    IF p_op ? 'provider_status' AND (jsonb_typeof(p_op->'provider_status') IS DISTINCT FROM 'string'
      OR p_op->>'provider_status' NOT IN ('sent','delivered','read','played','failed')
      OR (CASE WHEN p_op->>'provider_status'='played' THEN 'read' ELSE p_op->>'provider_status' END)
        IS DISTINCT FROM p_op->>'status') THEN
      RAISE EXCEPTION 'invalid_provider_status' USING ERRCODE='P2001';
    END IF;
    BEGIN
      PERFORM (p_op->>'error_code')::integer;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'invalid_error_code' USING ERRCODE='P2001';
    END;
    key_data := jsonb_build_array('message_status',p_op->>'wamid',extract(epoch FROM stamp),ph,bs,p_op->>'status',
      coalesce(p_op->>'provider_status',p_op->>'status'),p_op->'error_code',p_op->'error_title',p_op->'error_details');
  ELSIF p_op->>'kind'='reaction' THEN
    IF jsonb_typeof(p_op->'target_wamid') IS DISTINCT FROM 'string' OR length(p_op->>'target_wamid') NOT BETWEEN 1 AND 1024
      OR jsonb_typeof(p_op->'emoji') IS DISTINCT FROM 'string' OR octet_length(p_op->>'emoji')>256 THEN
      RAISE EXCEPTION 'invalid_reaction' USING ERRCODE='P2001';
    END IF;
    key_data := jsonb_build_array('reaction',p_op->>'wamid',p_op->>'target_wamid',extract(epoch FROM stamp),ph,bs,p_op->>'emoji');
  ELSE RAISE EXCEPTION 'unsupported_update' USING ERRCODE='P2001';
  END IF;
  PERFORM coexistence_update_contact((SELECT account_id FROM coexistence_jobs WHERE id=p_job),ident);
  SELECT * INTO STRICT j FROM coexistence_jobs WHERE id=p_job;
  INSERT INTO coexistence_updates(config_id,account_id,generation,event_key,target_wamid,operation,captured_at,state)
  VALUES(j.config_id,j.account_id,j.generation,encode(sha256(convert_to(key_data::text,'UTF8')),'hex'),
    CASE WHEN p_op->>'kind'='reaction' THEN p_op->>'target_wamid' ELSE p_op->>'wamid' END,
    CASE WHEN j.created_at>now()-interval '7 days' THEN p_op END,j.created_at,
    CASE WHEN j.created_at>now()-interval '7 days' THEN 'pending' ELSE 'expired' END)
  ON CONFLICT(config_id,event_key) DO UPDATE SET
    captured_at=least(coexistence_updates.captured_at,EXCLUDED.captured_at),
    operation=CASE WHEN least(coexistence_updates.captured_at,EXCLUDED.captured_at)<=now()-interval '7 days'
      THEN NULL ELSE coexistence_updates.operation END,
    state=CASE WHEN coexistence_updates.state='pending'
      AND least(coexistence_updates.captured_at,EXCLUDED.captured_at)<=now()-interval '7 days'
      THEN 'expired' ELSE coexistence_updates.state END
  RETURNING id INTO receipt_id;
  RETURN receipt_id;
END;
$$;

-- Caller holds config then account locks. Conversation precedes message because status triggers touch it.
CREATE FUNCTION public.coexistence_apply_update(p_id uuid)
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

-- Applied status receipts remain actionable for late message inserts or broadcast wamid attachment.
CREATE FUNCTION public.coexistence_update_ready(u public.coexistence_updates)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT u.state IN ('pending','applied') AND u.operation IS NOT NULL
    AND u.captured_at>now()-interval '7 days' AND (
      EXISTS (SELECT 1 FROM messages m JOIN conversations cv ON cv.id=m.conversation_id
        JOIN contacts mc ON mc.id=cv.contact_id AND mc.account_id=cv.account_id
        WHERE cv.account_id=u.account_id AND m.message_id=u.target_wamid AND
          (u.state='pending' OR (u.operation->>'kind'='message_status' AND m.status<>'failed'
            AND ((mc.phone_normalized<>'' AND mc.phone_normalized=coalesce(u.operation#>>'{identity,phone}',''))
              OR mc.wa_user_id=nullif(u.operation#>>'{identity,wa_user_id}','')) AND
            ((u.operation->>'status'='failed' AND m.status IN ('sending','sent')) OR
              array_position(ARRAY['sending','sent','delivered','read'],u.operation->>'status')>
              array_position(ARRAY['sending','sent','delivered','read'],m.status)))))
      OR (u.operation->>'kind'='message_status' AND EXISTS (
        SELECT 1 FROM broadcast_recipients r JOIN broadcasts b ON b.id=r.broadcast_id
          JOIN contacts ct ON ct.id=r.contact_id AND ct.account_id=b.account_id
        WHERE b.account_id=u.account_id AND r.whatsapp_message_id=u.target_wamid
          AND ((ct.phone_normalized<>'' AND ct.phone_normalized=regexp_replace(coalesce(u.operation#>>'{identity,phone}',''),'\D','','g'))
            OR ct.wa_user_id=nullif(u.operation#>>'{identity,wa_user_id}',''))
          AND (u.state='pending' OR (r.status<>'failed' AND
            ((u.operation->>'status'='failed' AND r.status IN ('pending','sent')) OR
              array_position(ARRAY['pending','sent','delivered','read','replied'],u.operation->>'status')>
              array_position(ARRAY['pending','sent','delivered','read','replied'],r.status)))))
    ));
$$;
ALTER FUNCTION public.coexistence_update_ready(public.coexistence_updates) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.coexistence_update_ready(public.coexistence_updates) FROM PUBLIC,anon,authenticated,service_role;

-- Run once per drain after jobs and before effects. Missing parents are filtered BEFORE LIMIT.
-- Counts are consumed event rows (including monotonic no-ops), not modified UI rows.
-- p_limit bounds ready receipt work and, separately, expired payload scrubbing (1..1000, default 100).
-- expired counts newly expired pending receipts, not payload scrubbing of already applied receipts.
CREATE FUNCTION public.coexistence_recover_updates(p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE ids uuid[]; u coexistence_updates%ROWTYPE; c whatsapp_config%ROWTYPE; result text;
  blocked_config uuid; blocked_target text;
  applied integer:=0; quarantined integer:=0; stale integer:=0; expired integer:=0; n_scrubbed integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'coexistence_invalid_limit'; END IF;
  SELECT array_agg(id) INTO ids FROM (
    SELECT q.id FROM coexistence_updates q JOIN whatsapp_config wc ON wc.id=q.config_id
    WHERE q.state IN ('pending','applied') AND q.operation IS NOT NULL
      AND q.captured_at>now()-interval '7 days'
      AND (q.account_id IS DISTINCT FROM wc.account_id OR q.generation<>wc.coexistence_generation
      OR wc.status<>'connected' OR wc.coexistence_verified_at IS NULL OR wc.coexistence_app_id IS NULL
      OR NOT EXISTS(SELECT 1 FROM profiles WHERE user_id=wc.user_id AND account_id=wc.account_id)
      OR coexistence_update_ready(q))
    ORDER BY q.config_id,q.target_wamid,
      CASE q.operation->>'status' WHEN 'sent' THEN 0 WHEN 'delivered' THEN 1 WHEN 'read' THEN 2 WHEN 'failed' THEN 3 ELSE 4 END,
      q.captured_at,q.id LIMIT p_limit
  ) ready;
  -- Acquire all config locks before accounts, including multi-account drains.
  PERFORM 1 FROM whatsapp_config WHERE id IN (SELECT config_id FROM coexistence_updates WHERE id=ANY(ids)) ORDER BY id FOR UPDATE;
  PERFORM 1 FROM accounts WHERE id IN (SELECT account_id FROM coexistence_updates WHERE id=ANY(ids)) ORDER BY id FOR UPDATE;
  FOR u IN SELECT * FROM coexistence_updates WHERE id=ANY(ids) ORDER BY config_id,target_wamid,
    CASE operation->>'status' WHEN 'sent' THEN 0 WHEN 'delivered' THEN 1 WHEN 'read' THEN 2 WHEN 'failed' THEN 3 ELSE 4 END,
    captured_at,id LOOP
    IF u.config_id=blocked_config AND u.target_wamid=blocked_target THEN CONTINUE; END IF;
    SELECT * INTO c FROM whatsapp_config WHERE id=u.config_id;
    IF u.account_id IS DISTINCT FROM c.account_id OR u.generation IS DISTINCT FROM c.coexistence_generation
      OR c.status<>'connected' OR c.coexistence_verified_at IS NULL OR c.coexistence_app_id IS NULL
      OR NOT EXISTS(SELECT 1 FROM profiles WHERE user_id=c.user_id AND account_id=c.account_id) THEN
      UPDATE coexistence_updates SET state='stale',operation=NULL WHERE id=u.id AND state IN ('pending','applied');
      IF FOUND THEN stale:=stale+1; END IF;
    ELSE
      result:=coexistence_apply_update(u.id);
      IF result='pending' THEN blocked_config:=u.config_id; blocked_target:=u.target_wamid; END IF;
      CASE result WHEN 'applied' THEN applied:=applied+1; WHEN 'quarantined' THEN quarantined:=quarantined+1;
        WHEN 'conflict' THEN quarantined:=quarantined+1;
        WHEN 'stale' THEN stale:=stale+1; WHEN 'expired' THEN expired:=expired+1; ELSE NULL; END CASE;
    END IF;
  END LOOP;
  -- Last: payload-row locks must never precede config/account locks in a drain.
  WITH due AS (SELECT id,state AS prior_state FROM coexistence_updates WHERE operation IS NOT NULL
    AND captured_at<=now()-interval '7 days' ORDER BY captured_at,id LIMIT p_limit FOR UPDATE SKIP LOCKED),
  scrubbed AS (UPDATE coexistence_updates q SET operation=NULL,state=CASE WHEN state='pending' THEN 'expired' ELSE state END
    FROM due WHERE q.id=due.id RETURNING due.prior_state)
  SELECT count(*) FILTER (WHERE prior_state='pending') INTO n_scrubbed FROM scrubbed;
  expired:=expired+n_scrubbed;
  RETURN jsonb_build_object('applied',applied,'quarantined',quarantined,'stale',stale,'expired',expired);
END;
$$;

ALTER FUNCTION public.coexistence_update_contact(uuid,jsonb) OWNER TO postgres;
ALTER FUNCTION public.coexistence_update_parent(uuid,text,jsonb,text) OWNER TO postgres;
ALTER FUNCTION public.coexistence_capture_update(uuid,jsonb) OWNER TO postgres;
ALTER FUNCTION public.coexistence_apply_update(uuid) OWNER TO postgres;
ALTER FUNCTION public.coexistence_recover_updates(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.coexistence_update_contact(uuid,jsonb),public.coexistence_update_parent(uuid,text,jsonb,text),
  public.coexistence_capture_update(uuid,jsonb),
  public.coexistence_apply_update(uuid),public.coexistence_recover_updates(integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.coexistence_recover_updates(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.coexistence_commit(p_job_id uuid, p_lease_token uuid, p_operations jsonb)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE j coexistence_jobs%ROWTYPE; c whatsapp_config%ROWTYPE; op jsonb; contact uuid;
  conv uuid; msg messages%ROWTYPE; stamp timestamptz; managed text; old_state coexistence_contact_state%ROWTYPE;
  source text; normalized_status text; reply_id uuid; code text;
  is_live boolean; new_contact boolean; new_conversation boolean; first_inbound boolean;
  accepted boolean; inserted integer; update_id uuid; update_result text; current_update_ids uuid[] := '{}';
  update_target text; blocked_target text;
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
          INSERT INTO messages(conversation_id, sender_type, content_type, content_text, message_id, status, created_at, message_source, reply_to_message_id)
          VALUES(conv, op->>'sender_type', op->>'content_type', op->>'content_text', op->>'wamid', normalized_status, stamp, source, reply_id)
          ON CONFLICT (conversation_id, message_id) DO NOTHING;
          GET DIAGNOSTICS inserted = ROW_COUNT;
          SELECT * INTO msg FROM messages WHERE conversation_id = conv AND message_id = op->>'wamid' FOR UPDATE;
          accepted := is_live AND (inserted = 1 OR msg.message_source = 'history');
          IF accepted THEN
            -- Live context is authoritative, including null; only duplicates may use stored context.
            SELECT id INTO reply_id FROM messages WHERE conversation_id = conv AND message_id = op->>'reply_wamid';
          ELSIF msg.message_source = 'cloud_api' AND (NOT is_live OR EXISTS (
            SELECT 1 FROM coexistence_message_metadata WHERE message_id = msg.id)) THEN
            SELECT m.id INTO reply_id FROM messages m JOIN coexistence_message_metadata md
              ON md.message_id = msg.id AND md.reply_wamid = m.message_id
              WHERE m.conversation_id = conv;
          END IF;
          IF msg.sender_type <> op->>'sender_type' THEN RAISE EXCEPTION 'direction_conflict' USING ERRCODE = 'P2001'; END IF;
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
            WHERE id = msg.id AND reply_to_message_id IS NULL AND reply_id IS NOT NULL;
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
          IF msg.message_source <> 'cloud_api' OR accepted OR NOT EXISTS (
            SELECT 1 FROM coexistence_message_metadata WHERE message_id = msg.id) THEN
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
              AND m.conversation_id = conv AND m.reply_to_message_id IS NULL;
          UPDATE conversations cv SET last_message_at = m.created_at, last_message_text = m.content_text
            FROM messages m WHERE m.id = msg.id AND cv.id = conv
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
