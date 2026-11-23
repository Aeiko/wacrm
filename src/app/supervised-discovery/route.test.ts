import { afterEach, expect, it, vi } from 'vitest';
import { GET, POST } from './route';
import { createClient } from '@supabase/supabase-js';
import { memberSignup } from '@/lib/whatsapp/coexistence/member-signup';

const invitation = {
  actorId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  accountId: '33333333-3333-4333-8333-333333333333',
  attemptId: '44444444-4444-4444-8444-444444444444',
  nonce: '55555555-5555-4555-8555-555555555555',
  intentId: '66666666-6666-4666-8666-666666666666',
  revision: '77777777-7777-4777-8777-777777777777',
  intendedPhone: '+12025550124',
  appId: '123',
  loginConfigId: '456',
};

afterEach(() => vi.unstubAllEnvs());

it.each([
  ['https://crm.example.invalid', 400],
  ['https://evil.example.invalid', 403],
])('uses the pinned origin for member POST: %s', async (origin, status) => {
  const request = new Request('http://localhost:3000/supervised-discovery', {
    method: 'POST',
    headers: {
      cookie: 'fixture=session',
      origin,
      'x-forwarded-host': 'evil.example.invalid',
      'x-forwarded-proto': 'https',
    },
  });

  const db = createClient('http://localhost:3200', 'fixture');

  expect((await memberSignup(request, db, undefined, undefined, undefined, 'https://crm.example.invalid')).status).toBe(status);
});

it('denies direct anonymous inspection or launch even with flags and a legacy invitation configured', async () => {
  vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
  vi.stubEnv('WHATSAPP_COEXISTENCE_DISCOVERY_ENABLED', 'true');
  vi.stubEnv(
    'WHATSAPP_COEXISTENCE_DISCOVERY_INVITATION',
    JSON.stringify(invitation)
  );
  vi.stubEnv('WHATSAPP_COEXISTENCE_APP_ID', invitation.appId);
  vi.stubEnv('WHATSAPP_COEXISTENCE_LOGIN_CONFIG_ID', invitation.loginConfigId);

  const response = await POST(
    new Request('https://private.invalid/supervised-discovery', {
      method: 'POST',
      body: '{"action":"launch"}',
    })
  );

  expect(response.status).toBe(401);
  expect(
    (await GET(new Request('https://private.invalid/supervised-discovery')))
      .status
  ).toBe(401);
  expect(response.headers.get('cache-control')).toContain('no-store');
  expect(await response.text()).not.toContain(invitation.nonce);
});
