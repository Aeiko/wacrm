import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseEnv } from 'node:util';
import { initialize } from './selfhost.mjs';

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'wacrm-selfhost-'));
  mkdirSync(join(root, 'deploy/supabase'), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('generates matching app/backend credentials and signed role keys', (t) => {
  const root = workspace(t);
  initialize(root);
  const backend = parseEnv(
    readFileSync(join(root, 'deploy/supabase/.env'), 'utf8')
  );
  const app = parseEnv(readFileSync(join(root, '.env.local'), 'utf8'));
  assert.equal(app.NEXT_PUBLIC_SUPABASE_URL, backend.SUPABASE_PUBLIC_URL);
  assert.equal(app.NEXT_PUBLIC_SUPABASE_ANON_KEY, backend.ANON_KEY);
  assert.equal(app.SUPABASE_SERVICE_ROLE_KEY, backend.SERVICE_ROLE_KEY);
  assert.match(app.ENCRYPTION_KEY, /^[a-f0-9]{64}$/);
  assert.match(backend.POSTGRES_PASSWORD, /^[a-f0-9]{64}$/);
  assert.equal(backend.REALTIME_DB_ENC_KEY.length, 16);
  assert.equal(backend.VAULT_ENC_KEY.length, 32);
  for (const [key, role] of [
    ['ANON_KEY', 'anon'],
    ['SERVICE_ROLE_KEY', 'service_role'],
  ]) {
    const [header, payload, signature] = backend[key].split('.');
    assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'HS256');
    const claims = JSON.parse(Buffer.from(payload, 'base64url'));
    assert.equal(claims.role, role);
    assert.ok(claims.exp > Date.now() / 1000);
    assert.equal(
      signature,
      createHmac('sha256', backend.JWT_SECRET)
        .update(`${header}.${payload}`)
        .digest('base64url')
    );
  }
  assert.equal(backend.ENABLE_EMAIL_AUTOCONFIRM, 'false');
  assert.equal(backend.ENABLE_PHONE_SIGNUP, 'false');
});

for (const existing of ['.env.local', 'deploy/supabase/.env']) {
  test(`refuses to overwrite ${existing} or create mismatched credentials`, (t) => {
    const root = workspace(t);
    writeFileSync(join(root, existing), 'keep-existing-secret');
    assert.throws(() => initialize(root), /already exists/);
    assert.equal(
      readFileSync(join(root, existing), 'utf8'),
      'keep-existing-secret'
    );
    assert.throws(() =>
      readFileSync(
        join(
          root,
          existing === '.env.local' ? 'deploy/supabase/.env' : '.env.local'
        )
      )
    );
  });
}

test('separate installations get different secrets', (t) => {
  const first = workspace(t);
  const second = workspace(t);
  initialize(first);
  initialize(second);
  assert.notEqual(
    readFileSync(join(first, '.env.local'), 'utf8'),
    readFileSync(join(second, '.env.local'), 'utf8')
  );
});
