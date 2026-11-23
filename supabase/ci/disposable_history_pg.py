"""Owned, socket-only PG17 loaded from the reviewed offline SQL074 schema."""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import uuid

ROOT = Path(__file__).resolve().parents[1]
BASELINE_SHA = 'c404a45858b5396e17a14c720d09ff5d2642cf610b71a55bfc97aa2e6c4da47f'
IMAGE = 'supabase/postgres:17.6.1.136'
CONTEXT = 'desktop-linux' if os.name == 'nt' else 'default'
DOCKER = ['docker', '--context', CONTEXT]


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def docker_output(*args):
    return subprocess.check_output([*DOCKER, *args], timeout=100)


@contextmanager
def disposable_history_pg(baseline_path, *, end):
    """Replay migrations 075 up to (but not including) end."""
    baseline = baseline_path.read_bytes()
    require(hashlib.sha256(baseline).hexdigest() == BASELINE_SHA, 'Refusing unrecognized schema-only snapshot')
    endpoint = json.loads(docker_output('context', 'inspect', CONTEXT))[0]['Endpoints']['docker']['Host']
    require(endpoint in ('npipe:////./pipe/dockerDesktopLinuxEngine', 'unix:///var/run/docker.sock'),
            'Refusing nonlocal Docker engine')
    name = 'wacrm-disposable-history-intent-' + uuid.uuid4().hex
    cid = docker_output('create', '--pull=never', '--network', 'none', '--name', name,
                        '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', IMAGE, 'postgres', '-c', 'listen_addresses=',
                        '-c', 'shared_preload_libraries=pg_net,pg_stat_statements').decode().strip()
    require(re.fullmatch('[0-9a-f]{64}', cid), 'Missing exact created container ID')
    try:
        info = json.loads(docker_output('inspect', cid))[0]
        host = info['HostConfig']
        require(info['Id'] == cid and info['Name'] == '/' + name and host['NetworkMode'] == 'none'
                and not (host['PortBindings'] or host['PublishAllPorts'] or host['Binds'] or info['Mounts']),
                'Refusing unsafe disposable database container')
        docker_output('start', cid)
        # Wait for the image's final postmaster, not the initdb temporary instance.
        docker_output('exec', cid, 'sh', '-ec', 'for i in $(seq 1 90); do '
                      'if [ "$(head -1 "$PGDATA/postmaster.pid" 2>/dev/null)" = 1 ] && pg_isready -U postgres -q; '
                      'then exit 0; fi; sleep 1; done; exit 1')

        def sql(script, *, user='postgres', db='history_intent', label='SQL fixture'):
            result = subprocess.run([*DOCKER, 'exec', '-i', cid, 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1',
                                     '-U', user, '-d', db], input=script if isinstance(script, bytes) else script.encode(),
                                    capture_output=True, timeout=90)
            require(result.returncode == 0, f'{label} failed (SQL, errors and data withheld)')
            return result.stdout.strip()

        sql('ALTER ROLE postgres SUPERUSER;', user='supabase_admin', db='postgres', label='Fixture bootstrap')
        sql('CREATE ROLE supabase_functions_admin NOLOGIN; CREATE ROLE supabase_realtime_admin NOLOGIN; '
            'CREATE DATABASE history_intent TEMPLATE template0;', db='postgres', label='Fixture database creation')
        sql(baseline, label='SQL074 snapshot restore')
        sql('ALTER ROLE postgres NOSUPERUSER;', user='supabase_admin', db='postgres', label='Fixture bootstrap demotion')
        for number in range(75, end):
            migration, = (ROOT / 'migrations').glob(f'{number:03d}_*.sql')
            sql(b'BEGIN;\n' + migration.read_bytes() + b'\nCOMMIT;', label=f'SQL{number:03d}')
        yield name, sql
    finally:
        docker_output('rm', '-fv', cid)
        print('Removed owned disposable history database.', flush=True)
