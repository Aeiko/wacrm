BEGIN;

CREATE FUNCTION public.guard_public_registration_email_first()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  marker constant text := 'wacrm_email_first';
  pending boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Only the private signup gateway supplies this input on self-service signup.
    pending := (NEW.raw_user_meta_data -> marker) = 'true'::jsonb;
    IF pending THEN
      NEW.encrypted_password := NULL;
    END IF;
  ELSE
    pending := (OLD.raw_app_meta_data -> marker) = 'true'::jsonb;
    IF pending AND NULLIF(NEW.encrypted_password, '') IS NOT NULL THEN
      IF OLD.email_confirmed_at IS NULL OR NEW.email_confirmed_at IS NULL THEN
        RAISE EXCEPTION 'Email confirmation is required before setting a password'
          USING ERRCODE = '23514';
      END IF;
      pending := false;
    END IF;
  END IF;

  IF jsonb_typeof(NEW.raw_user_meta_data) = 'object' AND NEW.raw_user_meta_data ? marker THEN
    NEW.raw_user_meta_data := NEW.raw_user_meta_data - marker;
  END IF;
  IF pending THEN
    NEW.raw_app_meta_data := CASE WHEN jsonb_typeof(NEW.raw_app_meta_data) = 'object'
      THEN NEW.raw_app_meta_data ELSE '{}'::jsonb END || jsonb_build_object(marker, true);
  ELSIF jsonb_typeof(NEW.raw_app_meta_data) = 'object' AND NEW.raw_app_meta_data ? marker THEN
    NEW.raw_app_meta_data := NEW.raw_app_meta_data - marker;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_public_registration_email_first() FROM PUBLIC, anon, authenticated, service_role;

-- Rewrite the row before the existing AFTER INSERT workspace provisioning trigger.
CREATE TRIGGER wacrm_public_registration_email_first
BEFORE INSERT OR UPDATE ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.guard_public_registration_email_first();

CREATE FUNCTION public.can_confirm_public_registration(p_token text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  -- GoTrue hashes a numeric OTP; the hash length is not its entropy. Keep this RPC private.
  SELECT CASE WHEN octet_length(p_token) = 61 AND p_token ~ '^pkce_[0-9a-f]{56}$' THEN EXISTS (
    SELECT 1
    FROM auth.one_time_tokens AS token
    JOIN auth.users AS u ON u.id = token.user_id
    WHERE token.token_hash = p_token
      AND token.token_type = 'confirmation_token'
      AND NOT EXISTS (
        SELECT 1 FROM auth.one_time_tokens AS other
        WHERE other.token_hash = p_token
          AND other.token_type = 'confirmation_token'
          AND other.user_id <> token.user_id
      )
      AND token.relates_to = u.email
      AND u.confirmation_token = p_token
      AND u.email_confirmed_at IS NULL
      AND u.deleted_at IS NULL
      AND NOT u.is_anonymous
      AND u.raw_app_meta_data -> 'wacrm_email_first' = 'true'::jsonb
      AND u.encrypted_password IS NULL
      -- Match GOTRUE_MAILER_OTP_EXP in the public registration Auth stack.
      AND u.confirmation_sent_at >= statement_timestamp() - interval '1800 seconds'
  ) ELSE false END;
$$;

REVOKE ALL ON FUNCTION public.can_confirm_public_registration(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_confirm_public_registration(text) TO anon;

NOTIFY pgrst, 'reload schema';

COMMIT;
