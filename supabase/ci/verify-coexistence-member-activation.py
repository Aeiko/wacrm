"""Test SQL093 using only a disposable socket-only PG17 and synthetic fixtures."""
import argparse
from pathlib import Path

from disposable_history_pg import ROOT, disposable_history_pg


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', required=True, type=Path)
    args = parser.parse_args()
    with disposable_history_pg(args.baseline, end=86) as (_, sql):
        migrations = ROOT / 'migrations'
        for migration in sorted(p for p in migrations.glob('*.sql') if '086' <= p.name[:3] < '093'):
            sql(b'BEGIN;\n' + migration.read_bytes() + b'\nCOMMIT;', label=migration.name)
        activation = (migrations / '093_coexistence_member_activation.sql').read_bytes()
        assertions = [Path(__file__).with_name(f'verify-coexistence-member-{name}.sql').read_bytes()
                      for name in ('signup', 'activation')]
        sql(b'\n'.join([b'BEGIN;', activation, *assertions, b'ROLLBACK;']), label='SQL093 public RPC assertions')

        sql((ROOT.parent / 'deploy/member-runtime/install.sql').read_bytes(), label='Restricted runtime install')
        sql(b'BEGIN;\n' + activation + b'\nCOMMIT;', label='SQL093 restricted RPC upgrade')
        sql("""DO $$ DECLARE f text:='member_signup_private.coexistence_member_signup(uuid,uuid,uuid,text,jsonb)'; BEGIN
          ASSERT to_regprocedure('public.coexistence_member_signup(uuid,uuid,uuid,text,jsonb)') IS NULL;
          ASSERT has_function_privilege('member_signup_runtime',f,'EXECUTE');
          ASSERT NOT has_function_privilege('service_role',f,'EXECUTE');
          ASSERT NOT has_function_privilege('authenticated',f,'EXECUTE');
        END $$;""", label='SQL093 restricted RPC grants')
        sql("""DO $$ BEGIN
          SET LOCAL ROLE member_signup_runtime;
          ASSERT member_signup_private.coexistence_member_signup(NULL,NULL,NULL,'activation_read',
            '{"app_id":"1","login_config_id":"2","partner_id":"3","state":"00000000-0000-4000-8000-000000000000","waba_id":"4","phone_number_id":"5"}')='{"status":"forbidden"}';
        END $$;""", user='member_signup_authenticator', label='SQL093 restricted RPC access assertions')
        print('SQL090 regression and SQL093 member activation assertions passed.')


if __name__ == '__main__':
    main()
