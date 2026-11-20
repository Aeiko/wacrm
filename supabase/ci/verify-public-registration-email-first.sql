-- Run only against a disposable database after the GoTrue and WACRM migrations.
BEGIN;

DO $$
DECLARE
  marked constant uuid := gen_random_uuid();
  legacy constant uuid := gen_random_uuid();
  marked_email constant text := marked::text || '@example.test';
  legacy_email constant text := legacy::text || '@example.test';
  marked_token constant text := 'pkce_' || repeat('a', 56);
  legacy_token constant text := 'pkce_' || repeat('b', 56);
BEGIN
  INSERT INTO auth.users (id, email, encrypted_password, raw_user_meta_data, raw_app_meta_data, confirmation_token, confirmation_sent_at)
  VALUES (marked, marked_email, 'placeholder', '{"wacrm_email_first":true,"full_name":"Email First Fixture"}', '{"provider":"email"}', marked_token, now()),
         (legacy, legacy_email, 'legacy-password', '{}', '{}', legacy_token, now());

  ASSERT EXISTS (SELECT 1 FROM auth.users WHERE id = marked AND encrypted_password IS NULL
    AND raw_app_meta_data = '{"provider":"email","wacrm_email_first":true}'
    AND raw_user_meta_data = '{"full_name":"Email First Fixture"}');
  ASSERT EXISTS (SELECT 1 FROM public.accounts WHERE owner_user_id = marked AND name = 'Email First Fixture');
  ASSERT EXISTS (SELECT 1 FROM auth.users WHERE id = legacy AND encrypted_password = 'legacy-password');
  ASSERT NOT public.can_confirm_public_registration(marked_token);

  INSERT INTO auth.one_time_tokens (id, user_id, token_type, token_hash, relates_to)
  VALUES (gen_random_uuid(), marked, 'confirmation_token', marked_token, marked_email),
         (gen_random_uuid(), legacy, 'confirmation_token', legacy_token, legacy_email);

  ASSERT public.can_confirm_public_registration(marked_token);
  ASSERT NOT public.can_confirm_public_registration(legacy_token);
  ASSERT NOT public.can_confirm_public_registration(NULL);
  ASSERT NOT public.can_confirm_public_registration('123456');

  UPDATE auth.users SET confirmation_sent_at = now() - interval '31 minutes' WHERE id = marked;
  ASSERT NOT public.can_confirm_public_registration(marked_token);
  UPDATE auth.users SET confirmation_sent_at = now(), raw_app_meta_data = '{"provider":"email","fixture":true}',
     raw_user_meta_data = raw_user_meta_data || '{"wacrm_email_first":true}' WHERE id = marked;
  ASSERT public.can_confirm_public_registration(marked_token);
  ASSERT EXISTS (SELECT 1 FROM auth.users WHERE id = marked AND NOT raw_user_meta_data ? 'wacrm_email_first');

  BEGIN
    UPDATE auth.users SET encrypted_password = 'fixture', email_confirmed_at = now() WHERE id = marked;
    RAISE EXCEPTION 'Pre-confirmation password write unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  UPDATE auth.users SET email_confirmed_at = now() WHERE id = marked;
  ASSERT NOT public.can_confirm_public_registration(marked_token);
  UPDATE auth.users SET encrypted_password = 'fixture' WHERE id = marked;
  ASSERT EXISTS (SELECT 1 FROM auth.users WHERE id = marked AND encrypted_password = 'fixture'
    AND raw_app_meta_data = '{"provider":"email","fixture":true}');
  UPDATE auth.users SET raw_app_meta_data = raw_app_meta_data || '{"wacrm_email_first":true}' WHERE id = marked;
  ASSERT EXISTS (SELECT 1 FROM auth.users WHERE id = marked AND NOT raw_app_meta_data ? 'wacrm_email_first');

  ASSERT has_function_privilege('anon', 'public.can_confirm_public_registration(text)', 'EXECUTE');
  ASSERT NOT has_function_privilege('authenticated', 'public.can_confirm_public_registration(text)', 'EXECUTE');
  ASSERT NOT has_function_privilege('service_role', 'public.can_confirm_public_registration(text)', 'EXECUTE');
END;
$$;

ROLLBACK;
