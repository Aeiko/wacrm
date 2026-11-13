import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('Dokploy overlay preserves data/network and isolates maintenance jobs', (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'wacrm-compose-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const envFile = join(temp, '.env');
  writeFileSync(envFile, '');
  // Never load or print real credentials; Compose itself checks merge semantics.
  const args = ['compose', '--project-directory', '.', '--env-file', envFile,
    '-f', 'deploy/supabase/docker-compose.yml'];
  const config = (overlay = false) => JSON.parse(execFileSync('docker', [
    ...args,
    ...(overlay ? ['-f', 'deploy/supabase/docker-compose.dokploy.yml'] : []),
    'config', '--no-interpolate', '--format', 'json',
  ], { cwd: root, encoding: 'utf8' }));
  const base = config();
  const merged = config(true);
  assert.deepEqual(merged.volumes, base.volumes);
  assert.deepEqual(merged.networks, base.networks);
  let binds = 0;
  for (const [name, service] of Object.entries(base.services)) {
    const actual = merged.services[name];
    assert.deepEqual(actual.networks, service.networks);
    if (name === 'api-gw' || name === 'db') {
      assert.ok(!actual.ports?.length, `${name} must not publish production host ports`);
    } else {
      assert.deepEqual(actual.ports, service.ports);
    }
    assert.deepEqual(actual.profiles, service.profiles);
    assert.equal(actual.volumes?.length, service.volumes?.length);
    for (const volume of service.volumes ?? []) {
      const replacement = actual.volumes.find((v) => v.target === volume.target);
      if (volume.type === 'volume') {
        assert.deepEqual(replacement, volume);
      } else {
        binds++;
        assert.equal(replacement.type, 'bind');
        const relativeSource = volume.source.replaceAll('\\', '/').split('/volumes/')[1];
        assert.ok(relativeSource);
        assert.equal(replacement.source.replaceAll('\\', '/'),
          resolve(root, '../files/supabase', relativeSource).replaceAll('\\', '/'));
        assert.equal(replacement.read_only, volume.read_only);
        assert.deepEqual(replacement.bind, volume.bind);
      }
    }
  }
  assert.equal(binds, 11);
  for (const name of ['migrate', 'verify']) {
    const job = merged.services[name];
    // An explicit run selects the job; an ordinary up enables neither profile.
    assert.deepEqual(job.profiles, ['maintenance']);
    assert.equal(job.restart, 'no');
    assert.equal(job.ports, undefined);
    assert.equal(job.working_dir, '/workspace');
    assert.deepEqual(job.networks, merged.services.db.networks);
    assert.equal(job.depends_on.db.condition, 'service_healthy');
    assert.equal(job.environment.PGPASSWORD, '${POSTGRES_PASSWORD}');
    assert.equal(job.volumes.length, 1);
    assert.equal(job.volumes[0].source, root);
    assert.equal(job.volumes[0].target, '/workspace');
    assert.equal(job.volumes[0].read_only, true);
  }
  const migrate = merged.services.migrate;
  assert.equal(migrate.image, 'node:22-alpine');
  assert.equal(migrate.environment.npm_config_ignore_scripts, 'true');
  assert.deepEqual(migrate.command, ['npx', '--yes', '--package=supabase@2.113.0',
    'supabase', 'db', 'push', '--db-url',
    'postgresql://postgres@db:5432/postgres?sslmode=disable', '--yes']);
  assert.equal(merged.services.verify.image, merged.services.db.image);
  assert.deepEqual(merged.services.verify.entrypoint, ['psql']);
  assert.deepEqual(merged.services.verify.command, ['-X', '-w', '-h', 'db', '-p',
    '5432', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
    '-f', 'supabase/ci/verify-schema.sql']);
});
