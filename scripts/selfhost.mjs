import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backendFile = 'deploy/supabase/.env';
const composeFile = 'deploy/supabase/docker-compose.yml';
const hex = (bytes) => randomBytes(bytes).toString('hex');

function replaceValues(template, values) {
  return template.replace(/^(\w+)=(.*)$/gm, (line, key) =>
    key in values ? `${key}=${values[key]}` : line
  );
}

export function initialize(destination = root) {
  for (const file of [backendFile, '.env.local']) {
    if (existsSync(join(destination, file)))
      throw new Error(`${file} already exists; refusing to overwrite secrets.`);
  }
  const secret = hex(32);
  const issued = Math.floor(Date.now() / 1000);
  const token = (role) => {
    const header = Buffer.from(
      JSON.stringify({ alg: 'HS256', typ: 'JWT' })
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        role,
        iss: 'supabase',
        iat: issued,
        exp: issued + 5 * 365 * 86400,
      })
    ).toString('base64url');
    const signature = createHmac('sha256', secret)
      .update(`${header}.${payload}`)
      .digest('base64url');
    return `${header}.${payload}.${signature}`;
  };
  const anon = token('anon');
  const service = token('service_role');
  const backend = replaceValues(
    readFileSync(join(root, 'deploy/supabase/.env.example'), 'utf8'),
    {
      POSTGRES_PASSWORD: hex(32),
      JWT_SECRET: secret,
      ANON_KEY: anon,
      SERVICE_ROLE_KEY: service,
      DASHBOARD_PASSWORD: hex(24),
      SECRET_KEY_BASE: hex(64),
      REALTIME_DB_ENC_KEY: hex(8),
      VAULT_ENC_KEY: hex(16),
      PG_META_CRYPTO_KEY: hex(32),
      S3_PROTOCOL_ACCESS_KEY_ID: hex(16),
      S3_PROTOCOL_ACCESS_KEY_SECRET: hex(32),
    }
  );
  const app =
    replaceValues(readFileSync(join(root, '.env.local.example'), 'utf8'), {
      NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:8000',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: anon,
      SUPABASE_SERVICE_ROLE_KEY: service,
      NEXT_PUBLIC_SITE_URL: 'http://localhost:3000',
      ENCRYPTION_KEY: hex(32),
      META_APP_SECRET: 'local-development-not-a-meta-secret',
    }) + '\nWHATSAPP_TEMPLATES_DRY_RUN=true\n';
  writeFileSync(join(destination, backendFile), backend, {
    flag: 'wx',
    mode: 0o600,
  });
  writeFileSync(join(destination, '.env.local'), app, {
    flag: 'wx',
    mode: 0o600,
  });
}

function run(command, args, env = process.env) {
  // npx is a .cmd on Windows; all its arguments here are constants or a validated port.
  const windowsNpx = process.platform === 'win32' && command === 'npx';
  const result = spawnSync(
    windowsNpx ? 'cmd.exe' : command,
    windowsNpx ? ['/d', '/s', '/c', `npx ${args.join(' ')}`] : args,
    {
      cwd: root,
      stdio: 'inherit',
      env,
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed (${result.status ?? result.signal}).`);
}

function main() {
  const [action, ...flags] = process.argv.slice(2);
  if (action === 'init' && flags.length === 0) {
    initialize();
    console.log(
      'Created deploy/supabase/.env and .env.local. Secrets were not printed.'
    );
    return;
  }
  const compose = ['compose', '--env-file', backendFile, '-f', composeFile];
  const commands = {
    up: ['--profile', 'local', 'up', '-d', '--wait', '--wait-timeout', '240'],
    down: ['--profile', 'local', 'down'],
    status: ['--profile', 'local', 'ps'],
    verify: [
      'exec',
      '-T',
      'db',
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
    ],
  };
  if (
    action === 'migrate' &&
    (flags.length === 0 || (flags.length === 1 && flags[0] === '--dry-run'))
  ) {
    const backend = parseEnv(readFileSync(join(root, backendFile), 'utf8'));
    const port = backend.DB_HOST_PORT;
    if (!/^\d+$/.test(port ?? '') || Number(port) < 1 || Number(port) > 65535)
      throw new Error('Invalid DB_HOST_PORT.');
    run(
      'npx',
      [
        '--yes',
        'supabase@2.113.0',
        'db',
        'push',
        '--db-url',
        `postgresql://postgres@127.0.0.1:${port}/postgres?sslmode=disable`,
        ...flags,
      ],
      {
        ...process.env,
        PGPASSWORD: backend.POSTGRES_PASSWORD,
        SUPABASE_DB_PASSWORD: backend.POSTGRES_PASSWORD,
      }
    );
  } else if (action in commands && flags.length === 0 && action !== 'verify') {
    run('docker', [...compose, ...commands[action]]);
  } else if (action === 'verify' && flags.length === 0) {
    const sql = readFileSync(
      join(root, 'supabase/ci/verify-schema.sql'),
      'utf8'
    );
    const result = spawnSync('docker', [...compose, ...commands.verify], {
      cwd: root,
      input: sql,
      encoding: 'utf8',
    });
    if (result.error) throw result.error;
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    if (result.status !== 0) throw new Error('Schema verification failed.');
  } else {
    throw new Error(
      'Usage: node scripts/selfhost.mjs init|up|down|status|migrate [--dry-run]|verify'
    );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
