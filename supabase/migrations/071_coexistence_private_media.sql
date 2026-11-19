-- Private delivery is a UUID-only projection, never a public storage mirror.
-- Retain irreversible deny proofs even after CRM promotion or account/message deletion.
CREATE TABLE public.coexistence_private_media_ids (
  media_id_hash bytea PRIMARY KEY CHECK (octet_length(media_id_hash)=32)
);
ALTER TABLE public.coexistence_private_media_ids OWNER TO postgres;
ALTER TABLE public.coexistence_private_media_ids ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.coexistence_private_media_ids FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.coexistence_owns_media_url(p_message_id uuid,p_url text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT coalesce(p_url='/api/whatsapp/coexistence/media/' || p_message_id
    OR p_url ~ ('^/api/whatsapp/coexistence/media/' || p_message_id
      || '[?]v=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),false)
$$;

CREATE FUNCTION public.coexistence_project_private_media()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE md coexistence_message_metadata%ROWTYPE; msg messages%ROWTYPE;
  desired text; changed boolean; previous_timeout text := current_setting('lock_timeout');
BEGIN
  IF TG_OP='DELETE' THEN md:=OLD; ELSE md:=NEW; END IF;
  -- Metadata-first callers must never wait for a message-first writer holding the parent.
  SELECT * INTO msg FROM messages WHERE id=md.message_id FOR UPDATE NOWAIT;
  -- Global hash uniqueness can conflict across accounts/batches; cap that wait too.
  IF previous_timeout='0' OR previous_timeout::interval>interval '1 millisecond' THEN
    PERFORM set_config('lock_timeout','1ms',true);
  END IF;
  IF TG_OP<>'INSERT' AND nullif(OLD.media_id,'') IS NOT NULL THEN
    INSERT INTO coexistence_private_media_ids(media_id_hash)
      VALUES(sha256(convert_to(OLD.media_id,'UTF8'))) ON CONFLICT DO NOTHING;
  END IF;
  IF TG_OP<>'DELETE' AND nullif(NEW.media_id,'') IS NOT NULL THEN
    INSERT INTO coexistence_private_media_ids(media_id_hash)
      VALUES(sha256(convert_to(NEW.media_id,'UTF8'))) ON CONFLICT DO NOTHING;
  END IF;
  IF msg.id IS NOT NULL AND (msg.media_url IS NULL OR coexistence_owns_media_url(msg.id,msg.media_url)) THEN
    desired:=NULL;
    IF TG_OP<>'DELETE' AND NOT md.placeholder AND nullif(md.media_id,'') IS NOT NULL
      AND md.source_config_id IS NOT NULL AND md.source_generation IS NOT NULL
      AND msg.content_type IN ('image','audio','video','document') THEN
      changed:=TG_OP='INSERT';
      IF TG_OP='UPDATE' THEN
        changed:=ROW(NEW.media_id,NEW.media_type,NEW.source_config_id,NEW.source_generation,NEW.placeholder)
          IS DISTINCT FROM ROW(OLD.media_id,OLD.media_type,OLD.source_config_id,OLD.source_generation,OLD.placeholder);
      END IF;
      desired:=CASE WHEN msg.media_url IS NOT NULL AND NOT changed THEN msg.media_url
        ELSE '/api/whatsapp/coexistence/media/' || msg.id || '?v=' || gen_random_uuid() END;
    END IF;
    UPDATE messages SET media_url=desired WHERE id=msg.id AND media_url IS DISTINCT FROM desired;
  END IF;
  PERFORM set_config('lock_timeout',previous_timeout,true);
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.coexistence_media_context(p_account_id uuid,p_message_id uuid,p_app_id text)
RETURNS TABLE(config_id uuid,generation uuid,phone_number_id text,access_token text,
  media_id text,media_type text,content_type text,media_url text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT cfg.id,cfg.coexistence_generation,cfg.phone_number_id,cfg.access_token,
    md.media_id,md.media_type,m.content_type,m.media_url
  FROM messages m
  JOIN conversations cv ON cv.id=m.conversation_id AND cv.account_id=p_account_id
  JOIN contacts ct ON ct.id=cv.contact_id AND ct.account_id=p_account_id
  JOIN coexistence_message_metadata md ON md.message_id=m.id
  JOIN whatsapp_config cfg ON cfg.id=md.source_config_id AND cfg.account_id=p_account_id
    AND cfg.coexistence_generation=md.source_generation
  WHERE m.id=p_message_id AND NOT md.placeholder AND nullif(md.media_id,'') IS NOT NULL
    AND m.content_type IN ('image','audio','video','document')
    AND coexistence_owns_media_url(m.id,m.media_url)
    AND cfg.status='connected' AND cfg.coexistence_verified_at IS NOT NULL
    AND cfg.coexistence_app_id=p_app_id AND nullif(p_app_id,'') IS NOT NULL
    AND EXISTS(SELECT 1 FROM profiles p WHERE p.user_id=cfg.user_id AND p.account_id=p_account_id)
$$;

CREATE FUNCTION public.coexistence_is_private_media(p_media_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT nullif(p_media_id,'') IS NOT NULL AND EXISTS(
    SELECT 1 FROM coexistence_private_media_ids WHERE media_id_hash=sha256(convert_to(p_media_id,'UTF8')))
$$;

ALTER FUNCTION public.coexistence_owns_media_url(uuid,text) OWNER TO postgres;
ALTER FUNCTION public.coexistence_project_private_media() OWNER TO postgres;
ALTER FUNCTION public.coexistence_media_context(uuid,uuid,text) OWNER TO postgres;
ALTER FUNCTION public.coexistence_is_private_media(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.coexistence_owns_media_url(uuid,text),public.coexistence_project_private_media(),
  public.coexistence_media_context(uuid,uuid,text),public.coexistence_is_private_media(text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.coexistence_media_context(uuid,uuid,text),public.coexistence_is_private_media(text)
  TO service_role;

CREATE TRIGGER coexistence_project_private_media
  AFTER INSERT OR UPDATE OF media_id,media_type,source_config_id,source_generation,placeholder OR DELETE
  ON public.coexistence_message_metadata FOR EACH ROW EXECUTE FUNCTION public.coexistence_project_private_media();

-- Only still-known IDs can be backfilled; IDs erased before 071 cannot be reconstructed.
-- Old unproven rows are fenced from the raw-ID proxy, but never assigned guessed provenance.
DO $$
DECLARE previous_timeout text := current_setting('lock_timeout');
BEGIN
  IF previous_timeout='0' OR previous_timeout::interval>interval '1 millisecond' THEN
    PERFORM set_config('lock_timeout','1ms',true);
  END IF;
  INSERT INTO public.coexistence_private_media_ids(media_id_hash)
    SELECT DISTINCT sha256(convert_to(media_id,'UTF8')) FROM public.coexistence_message_metadata
    WHERE nullif(media_id,'') IS NOT NULL ON CONFLICT DO NOTHING;
  UPDATE public.coexistence_message_metadata SET media_id=media_id
    WHERE source_config_id IS NOT NULL AND source_generation IS NOT NULL AND nullif(media_id,'') IS NOT NULL;
  PERFORM set_config('lock_timeout',previous_timeout,true);
END;
$$;
