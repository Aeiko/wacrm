-- Offline rollout payload. The deployment owner must independently attest the app's owning partner portfolio.
-- psql -X -v ON_ERROR_STOP=1 -v partner_id=<attested numeric ID> -f partner-disconnect.sql
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='12s';
LOCK TABLE wacrm_pilot_worker.selection,wacrm_history_worker.selection IN SHARE MODE;
SELECT set_config('wacrm_deploy.partner_id', :'partner_id', true);
DO $deploy$
DECLARE
  partner text:=current_setting('wacrm_deploy.partner_id');
  f record;
  fn oid;
  src text;
  ddl text;
BEGIN
  IF partner !~ '^[1-9][0-9]{0,31}$' OR partner='2199799637618270' THEN
    RAISE EXCEPTION 'expected distinct canonical attested partner business ID';
  END IF;
  IF EXISTS(SELECT FROM wacrm_pilot_worker.selection) OR EXISTS(SELECT FROM wacrm_history_worker.selection) THEN
    RAISE EXCEPTION 'both worker selectors must be empty';
  END IF;
  FOR f IN SELECT * FROM (VALUES
    ('wacrm_pilot_receiver_2199799637618270.coexistence_ingress', '17bdb888e99ac206bbdf35b7b5d31d0c',
      'p_partner_business_id IS NOT NULL', 'p_partner_business_id IS DISTINCT FROM %L'),
    ('wacrm_pilot_receiver_2199799637618270.coexistence_ingress_unbound', 'c7efd54099011f53e999a8874fb07406',
      'partner constant text := NULL;', 'partner constant text := %L;'),
    ('wacrm_managed_receiver.coexistence_ingress', 'fe03c7b3066e75e963ec78a03d739eee',
      'partner constant text := NULL;', 'partner constant text := %L;')
  ) AS x(name,digest,anchor,replacement) LOOP
    fn:=to_regprocedure(f.name||'(text,text,boolean,boolean,jsonb)');
    SELECT p.prosrc INTO src FROM pg_proc p WHERE p.oid=fn AND p.proowner='postgres'::regrole AND p.prosecdef;
    IF src IS NULL OR md5(src)<>f.digest OR
      length(src)-length(replace(src,f.anchor,''))<>length(f.anchor) THEN
      RAISE EXCEPTION 'unexpected receiver function: %',f.name;
    END IF;
    ddl:=replace(pg_get_functiondef(fn),f.anchor,format(f.replacement,partner));
    IF f.anchor='partner constant text := NULL;' THEN
      -- The old null-partner guards explicitly reject this event even with a valid SQL075 target.
      ddl:=replace(ddl,'WHEN ''PARTNER_REMOVED'' THEN true',
        'WHEN ''PARTNER_REMOVED'' THEN entry IS DISTINCT FROM partner');
    END IF;
    EXECUTE ddl;
  END LOOP;
END $deploy$;
COMMIT;
