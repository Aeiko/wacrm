BEGIN;

CREATE FUNCTION public.can_finish_public_registration(p_token text, p_challenge text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(public.can_confirm_public_registration(p_token) AND EXISTS (
    SELECT 1
    FROM auth.one_time_tokens AS token
    CROSS JOIN LATERAL (
      SELECT f.code_challenge, f.code_challenge_method, f.created_at
      FROM auth.flow_state AS f
      WHERE f.user_id = token.user_id AND f.authentication_method = 'email/signup'
      ORDER BY f.created_at DESC, f.id DESC
      LIMIT 1
    ) AS flow
    WHERE token.token_hash = p_token AND token.token_type = 'confirmation_token'
      AND flow.code_challenge_method = 's256'
      AND flow.code_challenge = p_challenge
      -- Match the pinned GoTrue default and fail closed before it expires.
      AND flow.created_at > statement_timestamp() - interval '290 seconds'
  ), false);
$$;

REVOKE ALL ON FUNCTION public.can_finish_public_registration(text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_finish_public_registration(text, text) TO anon;
NOTIFY pgrst, 'reload schema';

COMMIT;
