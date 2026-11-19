import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const manifest = fileURLToPath(new URL('../../docker-compose.staff-login.dokploy.yml', import.meta.url));

test('two services are discoverable without a profile; no hidden extras', (t) => {
  const path = mkdtempSync(join(tmpdir(), 'login-compose-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const empty = join(path, 'empty.env');
  writeFileSync(empty, '');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
    /^(path|systemroot|programfiles|programw6432|home|userprofile|localappdata|appdata|temp|tmp|pathext)$/i.test(k)));
  // Never pass real values or print full rendered Compose. These dummy values must not propagate.
  const markers = Object.fromEntries(['SUPABASE_SERVICE_ROLE_KEY', 'STAFF_SUPABASE_SERVICE_KEY', 'JWT_SECRET', 'POSTGRES_PASSWORD', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'LOGIN_ANON'].map(k => [k, `sentinel-${k}`]));
  function config(profiles, ...args) {
    const r = spawnSync('docker', ['compose', '--env-file', empty, '-p', 'login-contract', '-f', manifest, ...profiles, 'config', ...args], { encoding: 'utf8', env: { ...env, ...markers }, cwd: path });
    assert.equal(r.status, 0, 'Compose failed (output withheld)');
    assert.ok(Object.values(markers).every(value => !r.stdout.includes(value)), 'unexpected runtime input in config');
    return r.stdout.trim();
  }
  assert.equal(config([], '--profiles'), '');
  for (const profiles of [[], ['--profile', '*']]) {
    assert.deepEqual(config(profiles, '--services').split(/\s+/).sort(), ['crm', 'login-gateway']);
  }
  const c = JSON.parse(config([], '--format', 'json'));
  assert.deepEqual(Object.keys(c.services.crm.networks), ['login-front']);
  assert.deepEqual(Object.keys(c.services['login-gateway'].networks).sort(), ['login-front', 'login-upstream']);
  assert.equal(c.networks['login-front'].external, true);
  assert.equal(c.networks['login-front'].name, 'staff-login-front-unconfigured');
  assert.deepEqual(c.services.crm.extra_hosts, ['supabase.fixture.invalid=127.0.0.1']);
  assert.equal(c.networks['login-upstream'].external, true);
  assert.equal(c.networks['login-upstream'].name, 'staff-login-upstream-unconfigured');
  const gateway = c.services['login-gateway'];
  assert.equal(gateway.networks['login-front'].ipv4_address, '192.0.2.11');
  assert.equal(c.services.crm.networks['login-front'].ipv4_address, '192.0.2.10');
  assert.equal(gateway.sysctls, undefined);
  assert.deepEqual(gateway.expose.map(String), ['8080']);
  assert.deepEqual(gateway.environment, { LOGIN_API_HOST:'supabase.fixture.invalid', LOGIN_CRM_HOST:'crm.fixture.invalid', LOGIN_GATEWAY_MODE:'disabled' });
  for (const s of Object.values(c.services)) {
    assert.ok(!s.ports && !s.labels && !s.privileged && !s.profiles && !s.network_mode);
    assert.equal(s.read_only, true);
    assert.equal(s.pull_policy, 'never');
    assert.equal(s.logging.driver, 'none');
    assert.deepEqual(s.cap_drop, ['ALL']);
    assert.ok(s.volumes.every(m => m.read_only && !m.bind.create_host_path));
  }
});
