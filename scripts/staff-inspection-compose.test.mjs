import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const composeFile = fileURLToPath(
  new URL('../docker-compose.staff-inspection.dokploy.yml', import.meta.url)
);

const required = {
  STAFF_CRM_IMAGE: `fixture/crm@sha256:${'1'.repeat(64)}`,
  STAFF_INSPECTION_IMAGE: `fixture/inspection@sha256:${'2'.repeat(64)}`,
  STAFF_INSPECTION_ORIGIN: 'https://inspection.fixture.invalid',
  STAFF_SUPABASE_ANON_KEY: 'fixture-anon-not-a-credential',
  STAFF_SUPABASE_SERVICE_KEY: 'fixture-service-not-a-credential',
  STAFF_APP_ID: '1001',
  STAFF_LOGIN_CONFIG_ID: '1002',
  STAFF_WABA_ID: '1003',
  STAFF_PHONE_ID: '1004',
};

function composeConfig(t) {
  const directory = mkdtempSync(join(tmpdir(), 'staff-compose-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const emptyEnv = join(directory, 'empty.env');
  writeFileSync(emptyEnv, '');

  // Neither the repository env files nor ambient deployment values enter the test.
  return (project, overrides = {}) =>
    spawnSync(
      'docker',
      [
        'compose',
        '-p',
        project,
        '--env-file',
        emptyEnv,
        '-f',
        composeFile,
        'config',
        '--format',
        'json',
      ],
      {
        cwd: directory,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          ProgramFiles: process.env.ProgramFiles,
          USERPROFILE: process.env.USERPROFILE,
          HOME: process.env.HOME,
          DOCKER_CONFIG: process.env.DOCKER_CONFIG,
          ...required,
          ...overrides,
        },
      }
    );
}

test('staff services have only the intended runtime settings and project-local network', (t) => {
  const config = composeConfig(t);
  const project = 'staff-fixture';

  const flags = {
    WHATSAPP_COEXISTENCE_ENABLED: 'false',
    WHATSAPP_COEXISTENCE_HISTORY_REQUEST_ENABLED: 'false',
    WHATSAPP_COEXISTENCE_IMPORT_SETTINGS_ENABLED: 'false',
  };

  const result = config(project, {
    STAFF_BACKEND_ORIGIN: 'https://ignored.fixture.invalid',
    ...Object.fromEntries(Object.keys(flags).map((key) => [key, 'true'])),
  });

  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);

  const common = {
    pull_policy: 'never',
    user: 'nextjs',
    cap_drop: ['ALL'],
    security_opt: ['no-new-privileges:true'],
    read_only: true,
    restart: 'no',
    cpus: 1,
    networks: { staff: null },
  };

  const rendered = JSON.parse(result.stdout);

  // Compose versions differ in which implicit defaults they emit.
  for (const service of Object.values(rendered.services)) {
    if (service.command === null) delete service.command;

    if (service.entrypoint === null) delete service.entrypoint;

    if (service.tty === false) delete service.tty;
  }

  if (rendered.networks.staff.ipam) {
    assert.deepEqual(rendered.networks.staff.ipam, {});
    delete rendered.networks.staff.ipam;
  }

  // Allowlists also reject new mounts, labels, published ports, and passthrough secrets.
  assert.deepEqual(rendered, {
    name: project,
    networks: { staff: { name: `${project}_staff`, internal: true } },
    services: {
      crm: {
        ...common,
        image: required.STAFF_CRM_IMAGE,
        mem_limit: '536870912',
        pids_limit: 128,
        environment: {
          NEXT_PUBLIC_SUPABASE_URL: 'https://supabase.fixture.invalid',
          NEXT_PUBLIC_SITE_URL: 'https://crm.fixture.invalid',
          NEXT_PUBLIC_SUPABASE_ANON_KEY: required.STAFF_SUPABASE_ANON_KEY,
          ...flags,
        },
      },
      inspection: {
        ...common,
        image: required.STAFF_INSPECTION_IMAGE,
        mem_limit: '268435456',
        pids_limit: 64,
        stdin_open: true,
        environment: {
          STAFF_INSPECTION_ORIGIN: required.STAFF_INSPECTION_ORIGIN,
          STAFF_BACKEND_ORIGIN: 'http://inspection-gateway:8000',
          STAFF_AUTH_PUBLIC_URL: 'https://supabase.fixture.invalid',
          STAFF_SUPABASE_ANON_KEY: required.STAFF_SUPABASE_ANON_KEY,
          STAFF_SUPABASE_SERVICE_KEY: required.STAFF_SUPABASE_SERVICE_KEY,
          STAFF_APP_ID: required.STAFF_APP_ID,
          STAFF_LOGIN_CONFIG_ID: required.STAFF_LOGIN_CONFIG_ID,
          STAFF_WABA_ID: required.STAFF_WABA_ID,
          STAFF_PHONE_ID: required.STAFF_PHONE_ID,
        },
      },
    },
  });
});

test('staff config rejects an empty required setting before deployment', (t) => {
  const config = composeConfig(t);

  for (const key of Object.keys(required)) {
    const result = config('staff-fixture', { [key]: '' });
    assert.ifError(result.error);
    assert.notEqual(result.status, 0, key);
    assert.match(
      result.stderr,
      new RegExp(`required variable ${key} is missing`)
    );
  }
});

test('inspection Dockerfile stages only the standalone host on the supplied runtime', () => {
  const dockerfile = readFileSync(
    new URL('../deploy/staff-inspection/Dockerfile', import.meta.url),
    'utf8'
  );

  assert.deepEqual(
    dockerfile
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#')),
    [
      'ARG STAFF_RUNTIME_IMAGE',
      'FROM ${STAFF_RUNTIME_IMAGE}',
      'USER nextjs',
      'COPY --chmod=0444 host.cjs /app/staff-inspection.cjs',
      'CMD ["node", "/app/staff-inspection.cjs"]',
    ]
  );
});
