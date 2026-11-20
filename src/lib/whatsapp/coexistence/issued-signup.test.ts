import { createClient } from '@supabase/supabase-js';
import { afterEach, expect, it, vi } from 'vitest';
import { findIssuedSignupInvitation, issuedSignup } from './issued-signup';
import type { SupervisedSignupInvitation } from './supervised-signup';

const invite: SupervisedSignupInvitation = {
  actorId: '10000000-0000-4000-8000-000000000001',
  sessionId: '10000000-0000-4000-8000-000000000002',
  accountId: '10000000-0000-4000-8000-000000000003',
  attemptId: '10000000-0000-4000-8000-000000000004',
  nonce: '10000000-0000-4000-8000-000000000005',
  appId: '123',
  loginConfigId: '456',
  wabaId: '777',
  phoneId: '888',
  intendedPhone: '+12025550124',
  intentId: '10000000-0000-4000-8000-000000000006',
  revision: '10000000-0000-4000-8000-000000000007',
};

const other = '10000000-0000-4000-8000-000000000008';

afterEach(() => vi.restoreAllMocks());

function fixture(actorId = invite.actorId, sessionId = invite.sessionId) {
  const db = createClient('http://127.0.0.1:54321', 'fixture-public-key', {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const user = {
    id: actorId,
    app_metadata: {},
    user_metadata: {},
    aud: 'authenticated',
    created_at: '2026-01-01T00:00:00Z',
  };

  const token = 'ssr-token';
  vi.spyOn(db.auth, 'getSession').mockResolvedValue({
    data: {
      session: {
        access_token: token,
        refresh_token: 'fixture-refresh',
        token_type: 'bearer',
        expires_in: 3600,
        user: { ...user, id: other },
      },
    },
    error: null,
  });

  const getUser = vi.spyOn(db.auth, 'getUser').mockResolvedValue({
    data: { user },
    error: null,
  });

  const getClaims = vi.spyOn(db.auth, 'getClaims').mockResolvedValue({
    data: {
      claims: {
        sub: invite.actorId,
        session_id: sessionId,
        aud: 'authenticated',
        iss: 'fixture',
        exp: 4102444800,
        iat: 0,
        role: 'authenticated',
        aal: 'aal1',
      },
      header: { alg: 'HS256', typ: 'JWT', kid: 'fixture' },
      signature: new Uint8Array(),
    },
    error: null,
  });

  const request = new Request('https://worker.invalid/supervised-signup', {
    headers: { cookie: 'opaque=serialized-cookie' },
  });

  return { db, request, getUser, getClaims, token };
}

it('selects only the document bound to the verified SSR token actor and session', async () => {
  const { db, request, getUser, getClaims, token } = fixture();
  const differentLogin = { ...invite, sessionId: other };
  expect(
    await findIssuedSignupInvitation(request, db, [differentLogin, invite])
  ).toEqual(invite);
  expect(getUser).toHaveBeenCalledExactlyOnceWith(token);
  expect(getClaims).toHaveBeenCalledExactlyOnceWith(token);
});

it('denies foreign actors, new logins and conflicting proof', async () => {
  for (const { db, request } of [
    fixture(other),
    fixture(invite.actorId, other),
  ]) {
    expect(await findIssuedSignupInvitation(request, db, [invite])).toBeNull();
  }

  const { db, request, getClaims } = fixture();
  getClaims.mockRejectedValueOnce(new Error('private auth detail'));
  expect(await findIssuedSignupInvitation(request, db, [invite])).toBeNull();
});

it('denies ambiguous and malformed issuer documents', async () => {
  const { db, request } = fixture();
  expect(
    await findIssuedSignupInvitation(request, db, [
      invite,
      { ...invite, nonce: other },
    ])
  ).toBeNull();
  expect(
    await findIssuedSignupInvitation(request, db, [
      { ...invite, nonce: 'not-a-uuid' },
    ])
  ).toBeNull();
});

it('ignores URL selectors and denies non-cookie credentials with a sanitized response', async () => {
  const { db, getUser } = fixture();
  const url = `https://worker.invalid/supervised-signup?attemptId=${invite.attemptId}&nonce=${invite.nonce}`;
  const transport = vi.fn();

  const response = await issuedSignup(
    new Request(url, {
      headers: { authorization: 'Bearer fixture', cookie: 'opaque=cookie' },
    }),
    db,
    [invite],
    transport
  );

  expect(response.status).toBe(401);
  expect(response.headers.get('cache-control')).toContain('no-store');
  expect(await response.json()).toEqual({ error: 'signup_unavailable' });
  expect(getUser).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();

  const cookieResponse = await issuedSignup(
    new Request(url, { headers: { cookie: 'opaque=cookie' } }),
    db,
    [invite],
    transport
  );

  expect(cookieResponse.status).toBe(400);
  expect(transport).not.toHaveBeenCalled();
});
