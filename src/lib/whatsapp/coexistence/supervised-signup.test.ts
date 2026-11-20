import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createServerClient } from '@supabase/ssr';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from 'vitest';
import { z } from 'zod';
import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { deadlineFetch } from '@/lib/request-deadline';
import { listenForFetch } from '@/test/http-server';
import { decrypt } from '../encryption';
import { signupPost, signupProtocol, signupStatus } from './signup';
import { signupLaunchUnavailable } from './signup-contract';
import {
  supervisedSignup,
  type SupervisedSignupInvitation,
} from './supervised-signup';

const invite = {
  actorId: '10000000-0000-4000-8000-000000000001',
  accountId: '20000000-0000-4000-8000-000000000001',
  sessionId: '30000000-0000-4000-8000-000000000001',
  attemptId: '40000000-0000-4000-8000-000000000001',
  nonce: '50000000-0000-4000-8000-000000000001',
  revision: '60000000-0000-4000-8000-000000000001',
  intentId: '70000000-0000-4000-8000-000000000001',
  appId: '123',
  loginConfigId: '456',
  wabaId: '777',
  phoneId: '888',
  intendedPhone: '+15550001234',
} satisfies SupervisedSignupInvitation;

const otherId = '90000000-0000-4000-8000-000000000001';
const code = 'synthetic-private-code';
const token = 'synthetic-business-token';
const rpcRoot = '/rest/v1/rpc/';
const rpcName = (phase: string) => `coexistence_signup_${phase}`;
const intentRpc = 'coexistence_history_intent_record';
const expiry = '2099-01-01T00:00:00Z';
const json = z.record(z.string(), z.json());

type JsonObject = z.infer<typeof json>;

const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

const identity = {
  p_actor_id: invite.actorId,
  p_account_id: invite.accountId,
  p_session_id: invite.sessionId,
};

const bound = {
  ...identity,
  p_attempt_id: invite.attemptId,
  p_nonce_hash: hash(invite.nonce),
};

let origin: string;
let calls: { path: string; method: string | undefined; body: JsonObject }[];

interface FixtureUser {
  actorId: string;
  accountId: string;
  sessionId: string;
  role: string;
  live: boolean;
  revision: string;
}

let user: FixtureUser;

let attempt: {
  id: string;
  state: string;
  reason: string | null;
  preview: JsonObject | null;
} | null;

let ciphertext: string;
let lostAck: string;
let providerDisplay: string;
let existingConfig: boolean;
let savedLogin: string;

// Auth/PostgREST and Graph wire fixture, following signup.test.ts. PostgreSQL
// locking/negative evidence are covered by the SQL074/075/077 fixtures, not here.
function receipt(name: string, body: JsonObject) {
  if (
    !user.live ||
    user.role !== 'owner' ||
    body.p_session_id !== user.sessionId ||
    body.p_account_id !== user.accountId ||
    body.p_actor_id !== user.actorId
  )
    return { status: 'forbidden' };

  const started = {
    status: 'started',
    dispatch: true,
    app_id: invite.appId,
    login_config_id: savedLogin,
  };

  switch (name) {
    case rpcName('prepare'):
      attempt = {
        id: invite.attemptId,
        state: 'prepared',
        reason: null,
        preview: null,
      };

      return {
        status: 'prepared',
        attempt_id: invite.attemptId,
        lease_until: expiry,
      };
    case rpcName('status'):
      return {
        status: 'ok',
        attempt: attempt && {
          ...attempt,
          intended_phone: invite.intendedPhone,
          created_at: '2026-01-01T00:00:00Z',
          lease_until: expiry,
        },
      };
  }

  if (
    !attempt ||
    body.p_attempt_id !== attempt.id ||
    (name !== intentRpc && body.p_nonce_hash !== bound.p_nonce_hash)
  )
    return { status: 'forbidden' };

  switch (name) {
    case rpcName('launch'):
      if (attempt.state !== 'prepared')
        return { status: 'duplicate', dispatch: false };
      attempt.state = 'launch_possible';

      return started;
    case rpcName('exchange_start'):
      if (attempt.state !== 'launch_possible')
        return { status: 'duplicate', dispatch: false };
      attempt.state = 'exchanging';

      return started;
    case rpcName('store_token'):
      ciphertext = z.string().parse(body.p_access_token);
      attempt.state = 'token_received';

      return { status: 'recorded' };
    case rpcName('token'):
      return {
        status: 'token',
        access_token: ciphertext,
        intended_phone: invite.intendedPhone,
        app_id: invite.appId,
        login_config_id: savedLogin,
      };
    case rpcName('verify'):
      if (attempt.state !== 'token_received') return { status: 'blocked' };
      attempt.preview = {
        waba_id: body.p_waba_id,
        phone_number_id: body.p_phone_number_id,
        display_phone_number: body.p_display_phone_number,
        normalized_phone_number: body.p_normalized_phone_number,
      };
      attempt.state = 'verified';

      return { status: 'verified' };
    case rpcName('confirm'):
      if (attempt.state !== 'verified') return { status: 'blocked' };
      attempt.state = 'confirmed';

      return { status: 'confirmed' };
    case rpcName('review'):
      attempt.state = 'review_required';
      attempt.reason = z.string().parse(body.p_reason);
      ciphertext = '';

      return { status: 'recorded' };
    case intentRpc:
      if (attempt.state !== 'confirmed') return { status: 'blocked' };

      return {
        status: 'intent_recorded',
        attempt_id: invite.attemptId,
        request_id: invite.intentId,
        expires_at: expiry,
        dispatch_authorized: false,
      };
  }
}

const server = createServer(async (req, res) => {
  try {
    const { pathname: path } = new URL(req.url!, origin);
    let raw = '';

    for await (const chunk of req) raw += chunk;
    const body = raw ? json.parse(JSON.parse(raw)) : {};
    calls.push({ path, method: req.method, body });
    const name = path.slice(rpcRoot.length);
    let result;

    if (path.startsWith(rpcRoot)) {
      expect(req.headers.authorization).toBe('Bearer service-fixture');
      result = receipt(name, body);
    } else if (path === '/auth/v1/user') {
      result = {
        id: user.actorId,
        aud: 'authenticated',
        role: 'authenticated',
      };
    } else if (path === '/rest/v1/profiles') {
      result = { account_id: user.accountId, account_role: user.role };
    } else if (path === '/rest/v1/accounts') {
      result = {
        id: user.accountId,
        name: 'Synthetic account',
        owner_user_id: user.actorId,
        connection_revision: user.revision,
      };
    } else if (path === '/rest/v1/whatsapp_config' && req.method === 'GET') {
      result = existingConfig
        ? { id: otherId, coexistence_generation: otherId }
        : null;
    } else if (path.endsWith('/oauth/access_token')) {
      result = { access_token: token, token_type: 'bearer' };
    } else if (path.endsWith('/debug_token')) {
      result = {
        data: {
          app_id: '123',
          is_valid: true,
          expires_at: 4102444800,
          scopes: [
            'whatsapp_business_management',
            'whatsapp_business_messaging',
          ],
          granular_scopes: [
            { scope: 'whatsapp_business_management', target_ids: ['777'] },
          ],
        },
      };
    } else if (path.endsWith('/777/phone_numbers')) {
      result = { data: [{ id: '999' }, { id: '888' }] };
    } else if (path.endsWith('/888')) {
      result = {
        id: '888',
        display_phone_number: providerDisplay,
        is_on_biz_app: true,
        platform_type: 'CLOUD_API',
      };
    }

    if (lostAck && (lostAck === name || path.endsWith(`/${lostAck}`))) {
      req.socket.destroy();

      return;
    }

    res.statusCode = result === undefined ? 404 : 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify(
        result === undefined ? { message: 'Unexpected fixture call' } : result
      )
    );
  } catch (error) {
    res.writeHead(500).end(String(error));
  }
});

beforeAll(async () => {
  origin = await listenForFetch(server);
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  __resetRateLimitForTests();
  calls = [];
  user = { ...invite, role: 'owner', live: true };
  attempt = null;
  ciphertext = '';
  lostAck = '';
  providerDisplay = '+1 555 000 1234';
  existingConfig = false;
  savedLogin = invite.loginConfigId;
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', origin);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-fixture');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-fixture');
  vi.stubEnv('ENCRYPTION_KEY', 'a'.repeat(64));
  vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
  vi.stubEnv('WHATSAPP_COEXISTENCE_APP_ID', invite.appId);
  vi.stubEnv('WHATSAPP_COEXISTENCE_LOGIN_CONFIG_ID', invite.loginConfigId);
  vi.stubEnv('WHATSAPP_COEXISTENCE_APP_SECRET', 'fixture-secret');
  vi.stubEnv('WHATSAPP_COEXISTENCE_PARTNER_BUSINESS_ID', '789');
  vi.stubEnv('WHATSAPP_COEXISTENCE_RELAY_WABA_ID', invite.wabaId);
  vi.stubEnv('WHATSAPP_COEXISTENCE_RELAY_PHONE_ID', invite.phoneId);
  const nativeFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));

    if (url.origin !== origin) throw new Error('External network forbidden');

    return nativeFetch(input, { ...init, redirect: 'error' });
  });

  const prepare = {
    request_id: otherId,
    nonce: invite.nonce,
    intended_phone: invite.intendedPhone,
    supervised: true,
  };

  const req = request(prepare, { path: '/api/whatsapp/coexistence/signup' });
  const reservation = await signupProtocol(req, db(req), prepare, transport);
  expect(await reservation.json()).toMatchObject({
    status: 'prepared',
    attempt_id: invite.attemptId,
  });
  calls = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function cookie() {
  const encode = (value: JsonObject) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');

  const jwt = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: user.actorId, session_id: user.sessionId, exp: 4102444800 })}.fixture`;

  return `sb-127-auth-token=base64-${encode({ access_token: jwt, refresh_token: 'fixture', expires_at: 4102444800, token_type: 'bearer', user: { id: user.actorId } })}`;
}

function db(req: Request) {
  const value = req.headers.get('cookie')?.split('sb-127-auth-token=')[1];

  return createServerClient(origin, 'anon-fixture', {
    global: { fetch: deadlineFetch },
    cookies: {
      getAll: () => (value ? [{ name: 'sb-127-auth-token', value }] : []),
      setAll: () => {},
    },
  });
}

function request(
  body?: JsonObject,
  options: {
    path?: string;
    headers?: Record<string, string>;
    anonymous?: boolean;
    method?: string;
  } = {}
) {
  const headers = new Headers({
    'sec-fetch-site': 'same-origin',
    ...options.headers,
  });

  if (!options.anonymous) headers.set('cookie', cookie());

  if (body) {
    if (!headers.has('origin')) headers.set('origin', origin);

    if (!headers.has('content-type'))
      headers.set('content-type', 'application/json');
  }

  return new Request(`${origin}${options.path ?? '/supervised-signup'}`, {
    method: options.method ?? (body ? 'POST' : 'GET'),
    headers,
    body: body && JSON.stringify(body),
  });
}

function transport(url: URL, init: RequestInit) {
  expect(url.origin).toBe('https://graph.facebook.com');

  return deadlineFetch(`${origin}${url.pathname}${url.search}`, init);
}

function run(body?: JsonObject, options?: Parameters<typeof request>[1]) {
  const req = request(body, options);

  return supervisedSignup(req, db(req), invite, transport);
}

function finish(phoneId = '888', wabaId = '777') {
  return {
    action: 'finish',
    code,
    finish: {
      type: 'WA_EMBEDDED_SIGNUP',
      event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
      data: {
        phone_number_id: phoneId,
        is_on_biz_app: true,
        messaging_account_ids: [wabaId],
        primary_waac_ids: [],
        page_ids: [],
        catalog_ids: [],
        dataset_ids: [],
        instagram_account_ids: [],
      },
    },
  };
}

const effects = () =>
  calls.filter(({ path, method }) =>
    path.startsWith(rpcRoot)
      ? path !== `${rpcRoot}${rpcName('status')}` &&
        path !== `${rpcRoot}${rpcName('token')}`
      : method !== 'GET' ||
        (!path.startsWith('/rest/') && !path.startsWith('/auth/'))
  );

const names = () => effects().map(({ path }) => path.replace(rpcRoot, ''));

const graphCalls = () =>
  calls
    .filter(
      ({ path }) => !path.startsWith('/rest/') && !path.startsWith('/auth/')
    )
    .map(({ path }) => path.split('/').slice(2).join('/'));

async function responseState(response: Response, state: string) {
  expect(response.ok).toBe(true);
  expect(response.headers.get('cache-control')).toContain('no-store');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(await response.json()).toEqual({ state, phone_suffix: '1234' });
}

async function denied(response: Response) {
  expect(response.ok).toBe(false);
  expect(response.headers.get('cache-control')).toContain('no-store');
  const error = await response.text();
  expect(error).not.toContain('phone_suffix');

  for (const value of [
    invite.actorId,
    invite.accountId,
    invite.sessionId,
    invite.attemptId,
    invite.nonce,
    invite.intendedPhone,
    code,
    token,
  ])
    expect(error).not.toContain(value);
}

it('inspects only the invited owner’s prepared attempt; GET never dispatches', async () => {
  await responseState(await run(), 'prepared');
  expect(effects()).toEqual([]);
  expect(calls).toContainEqual({
    path: `${rpcRoot}${rpcName('status')}`,
    method: 'POST',
    body: identity,
  });
});

it.each([
  ['different owner', { actorId: otherId }],
  ['different account', { accountId: otherId }],
  ['different login', { sessionId: otherId }],
  ['demoted owner', { role: 'admin' }],
  ['revoked login', { live: false }],
  ['stale revision', { revision: otherId }],
] as const)('does not disclose or launch for %s', async (_label, change) => {
  user = { ...user, ...change };
  await denied(await run());
  await denied(await run({ action: 'launch' }));
  expect(effects()).toEqual([]);
});

it('rejects an account with a config and an unrelated reserved attempt', async () => {
  existingConfig = true;
  await denied(await run({ action: 'launch' }));
  existingConfig = false;

  if (!attempt) throw new Error('Missing fixture reservation');
  attempt.id = otherId;
  await denied(await run());
  await denied(await run({ action: 'launch' }));
  expect(effects()).toEqual([]);
});

it('requires a cookie and rejects cross-origin and caller overrides', async () => {
  await denied(
    await run(
      { action: 'launch' },
      { anonymous: true, headers: { Authorization: 'Bearer untrusted' } }
    )
  );
  await denied(
    await run(
      { action: 'launch' },
      { headers: { Origin: 'https://foreign.invalid' } }
    )
  );
  await denied(
    await run(
      { action: 'launch' },
      { headers: { 'sec-fetch-site': 'cross-site' } }
    )
  );
  await denied(
    await run(
      { action: 'launch' },
      { headers: { 'content-type': 'text/plain' } }
    )
  );
  await denied(
    await run(
      { action: 'launch' },
      { path: '/supervised-signup?attemptId=override' }
    )
  );
  await denied(
    await run(undefined, { path: '/supervised-signup?accountId=override' })
  );
  await denied(
    await run({ action: 'launch', accountId: invite.accountId, deadline: 99 })
  );
  await denied(
    await run({
      action: 'prepare',
      nonce: invite.nonce,
      intended_phone: invite.intendedPhone,
    })
  );
  expect(effects()).toEqual([]);
});

it.each([
  ['889', '777'],
  ['888', '778'],
])(
  'holds a valid FINISH for the wrong pinned phone/WABA (%s / %s) before code exchange',
  async (phone, waba) => {
    await responseState(await run({ action: 'launch' }), 'launch_authorized');
    await responseState(await run(finish(phone, waba)), 'held');
    await responseState(await run(), 'held');
    await denied(await run(finish()));
    await denied(await run({ action: 'confirm' }));
    expect(effects()).toEqual([
      { path: `${rpcRoot}${rpcName('launch')}`, method: 'POST', body: bound },
      {
        path: `${rpcRoot}${rpcName('review')}`,
        method: 'POST',
        body: { ...bound, p_reason: 'selection_conflict' },
      },
    ]);
  }
);

it('records an explicit cancellation without exchanging or letting this attempt reopen', async () => {
  await responseState(await run({ action: 'launch' }), 'launch_authorized');
  await responseState(await run({ action: 'cancel' }), 'held');
  await responseState(await run(), 'held');
  await denied(await run({ action: 'launch' }));
  await denied(await run(finish()));
  expect(effects()).toEqual([
    { path: `${rpcRoot}${rpcName('launch')}`, method: 'POST', body: bound },
    {
      path: `${rpcRoot}${rpcName('review')}`,
      method: 'POST',
      body: { ...bound, p_reason: 'provider_cancelled' },
    },
  ]);
});

it('does not reissue launch permission after a durable launch loses its acknowledgement', async () => {
  lostAck = rpcName('launch');
  await denied(await run({ action: 'launch' }));
  lostAck = '';
  expect(names()).toEqual([rpcName('launch')]);
  await responseState(await run(), 'pending');
  await denied(await run({ action: 'launch' }));
  expect(names()).toEqual([rpcName('launch')]);
});

it.each([rpcName('exchange_start'), 'access_token'])(
  'never re-exchanges after a lost %s acknowledgement',
  async (step) => {
    await responseState(await run({ action: 'launch' }), 'launch_authorized');
    lostAck = step;
    await denied(await run(finish()));
    lostAck = '';
    await responseState(
      await run(),
      step === 'access_token' ? 'held' : 'pending'
    );
    await denied(await run(finish()));
    await denied(await run({ action: 'confirm' }));
    expect(
      names().filter((name) => name === rpcName('exchange_start'))
    ).toHaveLength(1);
    expect(graphCalls()).toEqual(
      step === 'access_token' ? ['oauth/access_token'] : []
    );
    expect(names()).not.toContain(intentRpc);
  }
);

it('requires independent provider proof even when FINISH matches the pins', async () => {
  await responseState(await run({ action: 'launch' }), 'launch_authorized');
  providerDisplay = '+1 555 000 9999';
  await denied(await run(finish()));
  await responseState(await run(), 'held');
  await denied(await run({ action: 'confirm' }));
  expect(graphCalls()).toEqual([
    'oauth/access_token',
    'debug_token',
    '777/phone_numbers',
    '888',
  ]);
  expect(names()).not.toContain(rpcName('verify'));
  expect(names()).not.toContain(intentRpc);
});

it('rejects a launch receipt from a different pinned Login configuration', async () => {
  savedLogin = '555';
  await denied(await run({ action: 'launch' }));
  await denied(await run(finish()));
  expect(graphCalls()).toEqual([]);
});

it('launches once, verifies with Graph, confirms separately, and records only explicit history intent', async () => {
  await denied(await run(finish()));
  await denied(await run({ action: 'confirm' }));
  expect(effects()).toEqual([]);
  await responseState(await run({ action: 'launch' }), 'launch_authorized');
  await responseState(await run(), 'pending');
  await denied(await run({ action: 'launch' }));
  await denied(await run({ action: 'confirm' }));
  expect(names()).toEqual([rpcName('launch')]);
  await responseState(await run(finish()), 'verified');
  await responseState(await run(), 'verified');
  user.live = false;
  await denied(await run({ action: 'confirm' }));
  user.live = true;
  expect(decrypt(ciphertext)).toBe(token);
  expect(graphCalls()).toEqual([
    'oauth/access_token',
    'debug_token',
    '777/phone_numbers',
    '888',
  ]);
  await denied(await run(finish()));
  await denied(await run({ action: 'intent' }));
  const verifyPhase = names();
  expect(verifyPhase.filter((name) => !name.includes('/'))).toEqual(
    ['launch', 'exchange_start', 'store_token', 'verify'].map(rpcName)
  );
  expect(
    effects().find(({ path }) => path.endsWith(`/${rpcName('exchange_start')}`))
      ?.body
  ).toEqual({ ...bound, p_code_hash: hash(code) });
  await responseState(await run({ action: 'confirm' }), 'confirmed');
  await responseState(await run(), 'confirmed');
  expect(names()).toEqual([...verifyPhase, rpcName('confirm')]);
  await denied(await run({ action: 'intent', contacts: true }));
  await responseState(await run({ action: 'intent' }), 'intent_recorded');
  await responseState(await run(), 'confirmed');
  expect(names()).toEqual([...verifyPhase, rpcName('confirm'), intentRpc]);
  expect(effects().at(-1)?.body).toEqual({
    ...identity,
    p_attempt_id: invite.attemptId,
    p_request_id: invite.intentId,
    p_expected_revision: invite.revision,
    p_expected_config_id: null,
    p_expected_generation: null,
    p_app_id: invite.appId,
    p_waba_id: invite.wabaId,
    p_phone_number_id: invite.phoneId,
    p_consent_version: 'history-only-v1',
    p_history: true,
    p_contacts: false,
  });
});

it('keeps the public signup route’s handler gate disabled with the same invited owner and flags', async () => {
  const path = '/api/whatsapp/coexistence/signup';
  const inspection = request(undefined, { path });
  expect(
    await (await signupStatus(inspection, db(inspection))).json()
  ).toMatchObject({
    enabled: true,
    launch_available: false,
    reason: signupLaunchUnavailable,
  });

  const req = request(
    { action: 'launch', nonce: invite.nonce },
    { path: `${path}/${invite.attemptId}` }
  );

  const response = await signupPost(req, db(req), invite.attemptId);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: signupLaunchUnavailable });
  expect(effects()).toEqual([]);
});
