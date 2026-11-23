-- Isolated release only. Run as postgres, after SQL090 and before enabling member signup.
BEGIN;
CREATE ROLE member_signup_runtime NOLOGIN NOINHERIT;
CREATE ROLE member_signup_authenticator LOGIN NOINHERIT;
ALTER ROLE member_signup_authenticator SET statement_timeout = '5s';
ALTER ROLE member_signup_runtime SET statement_timeout = '5s';
GRANT member_signup_runtime TO member_signup_authenticator WITH INHERIT FALSE, SET TRUE;

CREATE SCHEMA member_signup_private AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA member_signup_private FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA member_signup_private TO member_signup_runtime;

ALTER FUNCTION public.coexistence_member_signup(uuid,uuid,uuid,text,jsonb) SET SCHEMA member_signup_private;
REVOKE ALL ON FUNCTION member_signup_private.coexistence_member_signup(uuid,uuid,uuid,text,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION member_signup_private.coexistence_member_signup(uuid,uuid,uuid,text,jsonb)
  TO member_signup_runtime;
NOTIFY pgrst, 'reload schema';
COMMIT;
