-- Disposable database only, after migrations 091 and 092.
BEGIN;
DO $$
DECLARE
  uid uuid := gen_random_uuid();
  email text := uid::text || '@example.test';
  token text := 'pkce_' || repeat('a', 56);
  first_challenge text := repeat('b', 43);
  latest_challenge text := repeat('c', 43);
BEGIN
  INSERT INTO auth.users (id, email, raw_user_meta_data, confirmation_token, confirmation_sent_at)
  VALUES (uid, email, '{"wacrm_email_first":true}', token, now());
  INSERT INTO auth.one_time_tokens (id, user_id, token_type, token_hash, relates_to)
  VALUES (gen_random_uuid(), uid, 'confirmation_token', token, email);
  ASSERT NOT public.can_finish_public_registration(token, first_challenge);
  INSERT INTO auth.flow_state (id, user_id, auth_code, code_challenge, code_challenge_method, provider_type, authentication_method, created_at)
  VALUES (gen_random_uuid(), uid, gen_random_uuid(), first_challenge, 's256', 'email', 'email/signup', now() - interval '1 minute'),
         (gen_random_uuid(), uid, gen_random_uuid(), latest_challenge, 's256', 'email', 'email/signup', now());
  ASSERT NOT public.can_finish_public_registration(token, first_challenge);
  ASSERT public.can_finish_public_registration(token, latest_challenge);
  ASSERT NOT public.can_finish_public_registration(token, NULL);
  ASSERT NOT public.can_finish_public_registration(NULL, latest_challenge);
  UPDATE auth.flow_state SET created_at = created_at - interval '5 minutes' WHERE user_id = uid;
  ASSERT NOT public.can_finish_public_registration(token, latest_challenge);
  ASSERT has_function_privilege('anon', 'public.can_finish_public_registration(text,text)', 'EXECUTE');
  ASSERT NOT has_function_privilege('authenticated', 'public.can_finish_public_registration(text,text)', 'EXECUTE');
END;
$$;
ROLLBACK;
