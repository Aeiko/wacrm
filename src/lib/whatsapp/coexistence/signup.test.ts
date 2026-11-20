import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { isDeepStrictEqual } from 'node:util';
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
import { listenForFetch } from '@/test/http-server';
import { deadlineFetch } from '@/lib/request-deadline';
import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { decrypt } from '../encryption';
import { signupStatus, signupPost, signupProtocol } from './signup';
import { signupActionSchema, signupFinishSchema } from './signup-contract';

const actor = '10000000-0000-4000-8000-000000000001';
const account = '20000000-0000-4000-8000-000000000001';
const sessionId = '30000000-0000-4000-8000-000000000001';
const attemptId = '40000000-0000-4000-8000-000000000001';
const nonce = '50000000-0000-4000-8000-000000000001';
let origin: string;

type JsonValue = z.infer<ReturnType<typeof z.json>>;

let calls: { path: string; body: Record<string, JsonValue> }[];
let role: string;
let ownerId: string;
let claimSession: string;
let claimSub: string;
let authCalls: number;
let rejectClaims: boolean;
let conflict: boolean;
let failStore: boolean;
let attempt: JsonValue;
let savedAppId: string;
let savedLoginId: string;
let businessToken: string;
let omitStartPins: boolean;
let changePinsOnStart: boolean;
let sqlForbidden: boolean;
let duplicate: boolean;
let loseStart: boolean;
let loseStore: boolean;
let stored: string;
let wrongPhone: boolean;
let grantWaba: string | undefined;
let debugAppId: string;
let revokeAfterDebug: boolean;
let hang: boolean;
let received = Promise.withResolvers<void>();
let closed = Promise.withResolvers<void>();
const json = z.record(z.string(), z.json());

const server = createServer(async (req, res) => {
  const path = new URL(req.url!, origin).pathname;
  let raw = '';

  for await (const chunk of req) raw += chunk;
  const body = raw ? json.parse(JSON.parse(raw)) : {};
  calls.push({ path, body });
  res.setHeader('Content-Type', 'application/json');
  let result: JsonValue;

  if (path === '/auth/v1/user') {
    authCalls++;

    if (rejectClaims && authCalls > 1) {
      res.statusCode = 401;
      result = { message: 'private-auth-error' };
    } else result = { id: actor, aud: 'authenticated', role: 'authenticated' };
  } else if (path === '/rest/v1/profiles')
    result = { account_id: account, account_role: role };
  else if (path === '/rest/v1/accounts')
    result = {
      id: account,
      name: 'Fixture',
      owner_user_id: ownerId,
      connection_revision: account,
    };
  else if (path === '/rest/v1/whatsapp_config') result = null;
  else if (path.startsWith('/rest/v1/rpc/')) {
    expect(req.headers.authorization).toBe('Bearer service-fixture');
    expect(body.p_actor_id).toBe(actor);
    expect(body.p_account_id).toBe(account);

    if (
      sqlForbidden ||
      body.p_session_id !== sessionId ||
      (body.p_attempt_id !== undefined &&
        (body.p_attempt_id !== attemptId ||
          body.p_nonce_hash !== fingerprint(nonce)))
    )
      result = { status: 'forbidden' };
    else if (path.endsWith('_status'))
      result = { status: 'ok', attempt, access_token: 'private' };
    else if (path.endsWith('_prepare'))
      result = {
        status: 'prepared',
        attempt_id: attemptId,
        lease_until: '2099-01-01T00:00:00Z',
      };
    else if (path.endsWith('_exchange_start') || path.endsWith('_launch')) {
      if (loseStart) {
        req.socket.destroy();

        return;
      }

      if (duplicate) result = { status: 'duplicate', dispatch: false };
      else if (omitStartPins) result = { status: 'started', dispatch: true };
      else
        result = {
          status: 'started',
          dispatch: true,
          app_id: savedAppId,
          login_config_id: savedLoginId,
        };

      if (changePinsOnStart) vi.stubEnv('WHATSAPP_COEXISTENCE_APP_ID', '999');
      duplicate = true;
    } else if (path.endsWith('_store_token')) {
      if (failStore) {
        res.statusCode = 503;
        res.end(JSON.stringify({ message: 'private-error' }));

        return;
      }

      const value = z.string().parse(body.p_access_token);

      if (stored) expect(value).toBe(stored);
      stored = value;

      if (loseStore) {
        loseStore = false;
        req.socket.destroy();

        return;
      }

      result = { status: 'recorded' };
    } else if (path.endsWith('_token'))
      result = {
        status: 'token',
        access_token: stored,
        intended_phone: '+15550001234',
        app_id: '123',
        login_config_id: '456',
      };
    else if (path.endsWith('_verify'))
      result = { status: conflict ? 'conflict' : 'verified' };
    else if (path.endsWith('_confirm')) result = { status: 'confirmed' };
    else result = { status: 'recorded' };
  } else if (path.endsWith('/oauth/access_token')) {
    received.resolve();
    res.on('close', () => closed.resolve());

    if (hang) return;
    result = { access_token: businessToken, token_type: 'bearer' };
  } else if (path.endsWith('/debug_token')) {
    const data = {
      app_id: debugAppId,
      is_valid: true,
      expires_at: 4102444800,
      scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
    };

    result = grantWaba
      ? {
          data: {
            ...data,
            granular_scopes: [
              {
                scope: 'whatsapp_business_management',
                target_ids: [grantWaba],
              },
            ],
          },
        }
      : { data };

    if (revokeAfterDebug) sqlForbidden = true;
  } else if (path.endsWith('/777/phone_numbers'))
    result = {
      data: [
        { id: '999', display_phone_number: '+1 555 111 1234' },
        {
          id: '888',
          display_phone_number: wrongPhone
            ? '+1 555 222 1234'
            : '+1 555 000 1234',
        },
        { id: '111', display_phone_number: '+1 555 333 1234' },
      ],
    };
  else if (path.endsWith('/888'))
    result = {
      id: '888',
      display_phone_number: wrongPhone ? '+1 555 111 1234' : '+1 555 000 1234',
      is_on_biz_app: true,
      platform_type: 'CLOUD_API',
    };
  else throw new Error(`Unexpected HTTP ${path}`);
  res.end(JSON.stringify(result));
});

beforeAll(async () => {
  origin = await listenForFetch(server);
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  __resetRateLimitForTests();
  calls = [];
  role = 'owner';
  ownerId = actor;
  claimSession = sessionId;
  savedAppId = '123';
  savedLoginId = '456';
  businessToken = 'private-business-token';
  omitStartPins = false;
  changePinsOnStart = false;
  claimSub = actor;
  authCalls = 0;
  rejectClaims = false;
  conflict = false;
  failStore = false;
  attempt = null;
  sqlForbidden = false;
  duplicate = false;
  loseStart = false;
  loseStore = false;
  stored = '';
  wrongPhone = false;
  grantWaba = '777';
  debugAppId = '123';
  revokeAfterDebug = false;
  hang = false;
  received = Promise.withResolvers<void>();
  closed = Promise.withResolvers<void>();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', origin);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-fixture');
  vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
  vi.stubEnv('WHATSAPP_COEXISTENCE_APP_ID', '123');
  vi.stubEnv('WHATSAPP_COEXISTENCE_APP_SECRET', 'fixture-secret');
  vi.stubEnv('WHATSAPP_COEXISTENCE_LOGIN_CONFIG_ID', '456');
  vi.stubEnv('WHATSAPP_COEXISTENCE_PARTNER_BUSINESS_ID', '789');
  vi.stubEnv('ENCRYPTION_KEY', 'a'.repeat(64));
  const nativeFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));

    if (url.origin !== origin) throw new Error('External network forbidden');

    return nativeFetch(input, init);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function db() {
  const encoded = (value: JsonValue) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');

  const token = `${encoded({ alg: 'HS256', typ: 'JWT' })}.${encoded({ sub: claimSub, session_id: claimSession, exp: 4102444800 })}.fixture`;

  const session = {
    access_token: token,
    refresh_token: 'fixture',
    expires_at: 4102444800,
    token_type: 'bearer',
    user: { id: actor },
  };

  return createServerClient(origin, 'anon-fixture', {
    global: { fetch: deadlineFetch },
    cookies: {
      getAll: () => [
        { name: 'sb-127-auth-token', value: `base64-${encoded(session)}` },
      ],
      setAll: () => {},
    },
  });
}

function request(body?: JsonValue, signal?: AbortSignal) {
  return new Request(
    `${origin}/api/whatsapp/coexistence/signup`,
    body === undefined
      ? undefined
      : {
          method: 'POST',
          headers: { Origin: origin, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        }
  );
}

const transport = (url: URL, init: RequestInit) => {
  expect(url.origin).toBe('https://graph.facebook.com');

  return deadlineFetch(`${origin}${url.pathname}${url.search}`, init);
};

const exchange = () => ({ action: 'exchange', nonce, code: 'private-code' });

function finish() {
  return {
    type: 'WA_EMBEDDED_SIGNUP',
    event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
    data: {
      phone_number_id: '888',
      is_on_biz_app: true,
      messaging_account_ids: ['777'],
      primary_waac_ids: [],
      page_ids: [],
      catalog_ids: [],
      dataset_ids: [],
      business_id: '12345',
      instagram_account_ids: [],
    },
  };
}

const verify = () => ({ action: 'verify', nonce, finish: finish() });

function core(
  body: JsonValue,
  signal?: AbortSignal,
  deadline?: number,
  id = attemptId
) {
  return signupProtocol(
    request(body, signal),
    db(),
    body,
    transport,
    id,
    deadline
  );
}

const fingerprint = (value: string) =>
  createHash('sha256').update(value).digest('hex');

// Test-only model: per-attempt closure, no browser listener or expected WindowProxy.
function callbackRehearsal(id = attemptId, localNonce = nonce) {
  let accepting = true;
  let disagreement = false;
  let codeHash: string | undefined;
  let exchangeResult: Promise<Response> | undefined;
  let finishHint: z.infer<typeof signupFinishSchema> | undefined;

  return {
    code(response: JsonValue) {
      if (!accepting || disagreement) return;

      const result = z
        .object({ authResponse: z.object({ code: z.string() }) })
        .safeParse(response);

      if (!result.success) return;

      const command = {
        action: 'exchange',
        nonce: localNonce,
        code: result.data.authResponse.code,
      };

      if (!signupActionSchema.safeParse(command).success) return;
      const next = fingerprint(command.code);

      if (codeHash !== undefined) {
        disagreement = codeHash !== next;

        return;
      }

      codeHash = next;
      exchangeResult = core(command, undefined, undefined, id);

      return exchangeResult;
    },
    finish(origin: string, data: JsonValue) {
      // Exact Meta example origins; research §12 does not certify an exhaustive list.
      // The model starts with decoded JSON, not a browser MessageEvent.
      if (
        !accepting ||
        (origin !== 'https://www.facebook.com' &&
          origin !== 'https://web.facebook.com')
      )
        return false;
      const parsed = signupFinishSchema.safeParse(data);

      if (!parsed.success) return false;

      if (finishHint && !isDeepStrictEqual(finishHint, parsed.data))
        disagreement = true;
      else finishHint = parsed.data;

      return true;
    },
    async stop() {
      if (!accepting) return;
      accepting = false;
      const exchanged = await exchangeResult;

      if (exchanged && !exchanged.ok) return exchanged;

      // Never infer a pairing from valid-looking hints, matching assets, or timing.
      return core(
        {
          action: 'review',
          nonce: localNonce,
          reason: disagreement ? 'selection_conflict' : 'callback_invalid',
        },
        undefined,
        undefined,
        id
      );
    },
  };
}

const sdkCode = () => ({ authResponse: { code: 'synthetic-code' } });
const metaOrigin = 'https://www.facebook.com';

const providerPaths = () =>
  calls.map((call) => call.path).filter((path) => path.startsWith('/v27.0/'));

it.each([
  ['code first', 'https://www.facebook.com'],
  ['FINISH first', 'https://web.facebook.com'],
])('exchanges promptly and only once with %s (%s)', async (order, sender) => {
  const callbacks = callbackRehearsal();

  if (order === 'FINISH first') {
    expect(callbacks.finish(sender, finish())).toBe(true);
    expect(calls).toHaveLength(0);
  }

  const exchange = callbacks.code(sdkCode());
  expect(callbacks.code(sdkCode())).toBeUndefined();
  expect(await exchange).toMatchObject({ status: 200 });
  expect(providerPaths()).toEqual(['/v27.0/oauth/access_token']);

  // In the code-first case the exchange has already completed before any FINISH.
  expect(callbacks.finish(sender, finish())).toBe(true);
  expect(callbacks.finish(sender, finish())).toBe(true);
  expect(await callbacks.stop()).toMatchObject({ status: 200 });
  expect(calls.at(-1)?.body.p_reason).toBe('callback_invalid');
  expect(providerPaths()).toEqual(['/v27.0/oauth/access_token']);
  expect(
    calls.filter(({ path }) => path.endsWith('_exchange_start'))
  ).toHaveLength(1);
  expect(calls.some(({ path }) => /_(verify|confirm)$/.test(path))).toBe(false);
});

it('rejects wrong origins, malformed shapes and a valid UUID with the wrong nonce', async () => {
  const callbacks = callbackRehearsal();

  for (const sender of [
    'https://notfacebook.com',
    'http://www.facebook.com',
    'https://www.facebook.com:444',
    'https://m.facebook.com',
    'null',
  ])
    expect(callbacks.finish(sender, finish())).toBe(false);

  expect(callbacks.finish(metaOrigin, { ...finish(), event: 'FINISH' })).toBe(
    false
  );
  expect(callbacks.code({ code: 'synthetic-code' })).toBeUndefined();
  expect(callbacks.code({ authResponse: { code: ' ' } })).toBeUndefined();
  expect(calls).toHaveLength(0);

  expect((await core({ ...exchange(), nonce: account })).status).toBe(403);
  expect(providerPaths()).toEqual([]);
});

it('never retargets a foreign or closed code callback to the attempt that last received FINISH', async () => {
  const old = callbackRehearsal(account, sessionId);
  const next = callbackRehearsal();
  expect(next.finish(metaOrigin, finish())).toBe(true);
  expect(await old.code(sdkCode())).toMatchObject({ status: 403 });
  expect(calls.at(-1)?.body.p_attempt_id).toBe(account);
  expect(await old.stop()).toMatchObject({ status: 403 });
  const beforeLate = calls.length;

  expect(old.code(sdkCode())).toBeUndefined();
  expect(old.finish(metaOrigin, finish())).toBe(false);
  expect(calls).toHaveLength(beforeLate);
  expect(await next.stop()).toMatchObject({ status: 200 });
  expect(providerPaths()).toEqual([]);
});

it.each([
  'FINISH before code',
  'FINISH during exchange',
  'code during exchange',
])(
  'records disagreement without verification or a new exchange: %s',
  async (conflict) => {
    const callbacks = callbackRehearsal();
    const first = finish();

    const different = {
      ...first,
      data: { ...first.data, phone_number_id: '999' },
    };

    expect(callbacks.finish(metaOrigin, first)).toBe(true);

    if (conflict === 'FINISH before code')
      expect(callbacks.finish(metaOrigin, different)).toBe(true);

    const pending = callbacks.code(sdkCode());

    if (conflict === 'FINISH during exchange')
      expect(callbacks.finish(metaOrigin, different)).toBe(true);

    if (conflict === 'code during exchange')
      expect(
        callbacks.code({ authResponse: { code: 'other-synthetic-code' } })
      ).toBeUndefined();

    expect(await callbacks.stop()).toMatchObject({ status: 200 });
    expect(calls.at(-1)?.body.p_reason).toBe('selection_conflict');
    expect(providerPaths()).toEqual(
      conflict === 'FINISH before code' ? [] : ['/v27.0/oauth/access_token']
    );
    expect((await pending)?.status).toBe(
      conflict === 'FINISH before code' ? undefined : 200
    );
    expect(calls.some(({ path }) => /_(verify|confirm)$/.test(path))).toBe(
      false
    );
  }
);

it('CRM verification can succeed on a mixed code/FINISH pair without attesting their association', async () => {
  const codeFromPopupA = sdkCode();
  const finishFromPopupB = finish(); // Different popup, same Meta origin and selected assets.
  const callbacks = callbackRehearsal();

  expect(await callbacks.code(codeFromPopupA)).toMatchObject({ status: 200 });
  expect(callbacks.finish(metaOrigin, finishFromPopupB)).toBe(true);

  // No observable field distinguishes this from a single-popup pair. Bypass the
  // rehearsal's fail-closed stop to see what CRM verification actually proves.
  const response = await core({
    action: 'verify',
    nonce,
    finish: finishFromPopupB,
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'verified' });
  expect(providerPaths()).toEqual([
    '/v27.0/oauth/access_token',
    '/v27.0/debug_token',
    '/v27.0/777/phone_numbers',
    '/v27.0/888',
  ]);
});

it.each(['bad sub', 'missing session', 'rejected validated claims'])(
  'denies %s rather than trusting decoded session data',
  async (scenario) => {
    if (scenario === 'bad sub') claimSub = account;

    if (scenario === 'missing session') claimSession = '';

    if (scenario === 'rejected validated claims') rejectClaims = true;
    expect((await core(exchange())).status).toBe(401);
    expect(calls.some((call) => call.path.includes('/rpc/'))).toBe(false);
  }
);

it('denies foreign attempt IDs with no remote requests', async () => {
  expect(
    (
      await signupProtocol(
        request(exchange()),
        db(),
        exchange(),
        transport,
        account
      )
    ).status
  ).toBe(403);
  expect(calls.some((call) => call.path.startsWith('/v27.0/'))).toBe(false);
});

it('bounds failed token settlement to one DB repeat without re-exchange', async () => {
  failStore = true;
  expect((await core(exchange())).status).toBe(409);
  expect(
    calls.filter((call) => call.path.endsWith('_store_token'))
  ).toHaveLength(2);
  expect(
    calls.filter((call) => call.path.endsWith('/oauth/access_token'))
  ).toHaveLength(1);
  expect(calls.at(-1)?.body.p_reason).toBe('exchange_unknown');
});

it('keeps foreign resource conflicts generic and never activates a preview', async () => {
  await core(exchange());
  conflict = true;

  const response = await core(verify());

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: 'signup_unavailable' });
  expect(
    calls.every(
      (call) =>
        !/register|subscribe|sync|connection_operation_finish/.test(call.path)
    )
  ).toBe(true);
});

it('waits for an aborting transport to settle before reviewing and returning', async () => {
  hang = true;
  const release = Promise.withResolvers<void>();
  const controller = new AbortController();
  let finished = false;

  const heldTransport = async (url: URL, init: RequestInit) => {
    try {
      return await transport(url, init);
    } catch (error) {
      await release.promise;
      throw error;
    }
  };

  const pending = signupProtocol(
    request(exchange(), controller.signal),
    db(),
    exchange(),
    heldTransport,
    attemptId
  ).finally(() => {
    finished = true;
  });

  try {
    await received.promise;
    controller.abort();
    await closed.promise;
    expect(finished).toBe(false);
    expect(calls.some((call) => call.path.endsWith('_review'))).toBe(false);
  } finally {
    release.resolve();
    await pending;
  }

  expect((await pending).status).toBe(499);
  expect(calls.at(-1)?.body.p_reason).toBe('exchange_unknown');
});

it('returns only the sanitized immutable owner preview, never private attempt fields', async () => {
  attempt = {
    id: attemptId,
    state: 'verified',
    intended_phone: '+15550001234',
    reason: null,
    preview: {
      phone_number_id: '888',
      waba_id: '777',
      display_phone_number: '+1 555 000 1234',
      normalized_phone_number: '+15550001234',
      access_token: 'private-preview',
    },
    created_at: '2026-11-17T12:00:00Z',
    lease_until: '2026-11-17T12:02:00Z',
    nonce_hash: 'private-nonce',
    access_token: 'private-token',
    code: 'private-code',
  };
  vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'false');
  const response = await signupStatus(request(), db());
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.attempt.state).toBe('verified');
  expect(JSON.stringify(result)).not.toMatch(
    /private|access_token|nonce_hash|code/
  );
});

it('fails closed and does not log malformed private status data', async () => {
  attempt = { state: 'private-unknown-state', access_token: 'private-token' };
  const log = vi.spyOn(console, 'error');

  try {
    const response = await signupStatus(request(), db());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'signup_unavailable' });
    expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});

it.each(['launch', 'exchange'])(
  'refuses %s on saved App or Login pin drift before any provider permission',
  async (action) => {
    for (const key of ['app', 'login']) {
      duplicate = false;
      savedAppId = key === 'app' ? '999' : '123';
      savedLoginId = key === 'login' ? '999' : '456';

      const response = await core(
        action === 'launch' ? { action, nonce } : exchange()
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'signup_unavailable' });
      expect(calls.at(-1)?.path).toMatch(/_review$/);
      expect(calls.some((call) => call.path.startsWith('/v27.0/'))).toBe(false);
    }
  }
);

it.each(['launch', 'exchange'])(
  'requires private receipt pins for %s and rechecks current config after acknowledgement',
  async (action) => {
    omitStartPins = true;
    expect(
      (await core(action === 'launch' ? { action, nonce } : exchange())).status
    ).toBe(503);
    duplicate = false;
    omitStartPins = false;
    changePinsOnStart = true;
    expect(
      (await core(action === 'launch' ? { action, nonce } : exchange())).status
    ).toBe(409);
    expect(calls.some((call) => call.path.startsWith('/v27.0/'))).toBe(false);
  }
);

it('persists the maximum accepted ASCII token once as encrypted bytes', async () => {
  businessToken = 'x'.repeat(32768);
  const response = await core(exchange());
  expect(response.status).toBe(200);
  expect(decrypt(stored)).toBe(businessToken);
  expect(stored.length).toBe(32768 * 2 + 58);
  expect(await response.json()).toEqual({ status: 'recorded' });
  expect(
    calls.filter((call) => call.path.endsWith('_store_token'))
  ).toHaveLength(1);
});

it('rejects an oversized token without persisting or exposing it', async () => {
  businessToken = 'private-' + 'x'.repeat(32769);
  const response = await core(exchange());
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: 'signup_unavailable' });
  expect(stored).toBe('');
  expect(calls.some((call) => call.path.endsWith('_store_token'))).toBe(false);
});

it.each<JsonValue>([
  { messaging_account_ids: ['777', '999'] },
  { messaging_account_ids: [] },
  { is_on_biz_app: false },
  { phone_number_id: '0888' },
  { business_id: 'not-canonical' },
  { primary_waac_ids: ['999'] },
  { page_ids: ['999'] },
  { catalog_ids: ['999'] },
  { dataset_ids: ['999'] },
  { instagram_account_ids: ['999'] },
  { unsupported_product: [] },
])(
  'rejects full multi-asset or unsupported callback data before Graph or candidate acquisition: %j',
  async (override) => {
    const complete = finish();

    const command = {
      action: 'verify',
      nonce,
      finish: {
        ...complete,
        data: { ...complete.data, ...json.parse(override) },
      },
    };

    expect((await core(command)).status).toBe(400);
    expect((await signupPost(request(command), db(), attemptId)).status).toBe(
      400
    );
    expect(
      calls.some(
        (call) =>
          call.path.startsWith('/v27.0/') || call.path.endsWith('_verify')
      )
    ).toBe(false);
  }
);

it.each<JsonValue>([
  { type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', data: finish().data },
  {
    type: 'OTHER',
    event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
    data: finish().data,
  },
  {
    type: 'WA_EMBEDDED_SIGNUP',
    event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
    data: {
      phone_number_id: '888',
      is_on_biz_app: true,
      messaging_account_ids: ['777'],
    },
  },
])('requires the complete supported v5 FINISH shape: %j', async (submitted) => {
  expect(
    (await core({ action: 'verify', nonce, finish: submitted })).status
  ).toBe(400);
  expect(calls).toHaveLength(0);
});

it('accepts absent optional business ID but still independently verifies broad grants and multiple existing WABA phones', async () => {
  await core(exchange());
  const { business_id, ...data } = finish().data;
  expect(business_id).toBe('12345');
  expect(
    (await core({ action: 'verify', nonce, finish: { ...finish(), data } }))
      .status
  ).toBe(200);
});

it('rejects a seven-digit intended phone at admission', async () => {
  const command = {
    request_id: attemptId,
    nonce,
    intended_phone: '+1234567',
    supervised: true,
  };

  expect(
    (await signupProtocol(request(command), db(), command, transport)).status
  ).toBe(400);
  expect(calls).toHaveLength(0);
});

it('shows disabled owner status with no attempt and no secret extras', async () => {
  vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'false');
  const response = await signupStatus(request(), db());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    enabled: false,
    launch_available: false,
    reason: 'launch_prerequisites_incomplete',
    attempt: null,
  });
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
});

it('runs authenticated owner through one controlled exchange, encrypted persistence, independent verification and confirmation', async () => {
  expect((await core(exchange())).status).toBe(200);
  expect(decrypt(stored)).toBe('private-business-token');
  expect(stored).not.toContain('private-business-token');

  const verified = await core(verify());

  expect(verified.status).toBe(200);
  expect(await verified.json()).toEqual({ status: 'verified' });
  expect((await core({ action: 'confirm', nonce })).status).toBe(200);
  const graph = calls.filter((call) => call.path.startsWith('/v27.0/'));
  expect(graph.map((call) => call.path)).toEqual([
    '/v27.0/oauth/access_token',
    '/v27.0/debug_token',
    '/v27.0/777/phone_numbers',
    '/v27.0/888',
  ]);

  for (const path of [
    '/v27.0/debug_token',
    '/v27.0/777/phone_numbers',
    '/v27.0/888',
  ]) {
    expect(calls[calls.findIndex((call) => call.path === path) - 1].path).toBe(
      '/rest/v1/rpc/coexistence_signup_token'
    );
  }

  expect(
    calls.find((call) => call.path.endsWith('_verify'))?.body
  ).toMatchObject({
    p_normalized_phone_number: '+15550001234',
    p_phone_number_id: '888',
    p_waba_id: '777',
  });
});

it.each(['owner mismatch', 'member', 'wrong session', 'revoked'])(
  'denies %s without provider authority',
  async (scenario) => {
    if (scenario === 'owner mismatch') ownerId = account;

    if (scenario === 'member') role = 'admin';

    if (scenario === 'wrong session') claimSession = attemptId;

    if (scenario === 'revoked') sqlForbidden = true;
    expect((await core(exchange())).status).toBe(403);
    expect(calls.some((call) => call.path.startsWith('/v27.0/'))).toBe(false);
  }
);

it('never resends a callback code after the first acknowledged dispatch', async () => {
  expect((await core(exchange())).status).toBe(200);
  expect((await core(exchange())).status).toBe(409);
  expect(
    calls.filter((call) => call.path.endsWith('/oauth/access_token'))
  ).toHaveLength(1);
});

it('does not dispatch or retry on a lost start acknowledgement', async () => {
  loseStart = true;
  expect((await core(exchange())).status).toBe(503);
  expect(
    calls.filter((call) => call.path.endsWith('_exchange_start'))
  ).toHaveLength(1);
  expect(calls.some((call) => call.path.startsWith('/v27.0/'))).toBe(false);
});

it('repeats only DB settlement with the original encrypted bytes after a lost token ACK', async () => {
  loseStore = true;
  expect((await core(exchange())).status).toBe(200);
  expect(
    calls.filter((call) => call.path.endsWith('_store_token'))
  ).toHaveLength(2);
  expect(
    calls.filter((call) => call.path.endsWith('/oauth/access_token'))
  ).toHaveLength(1);
});

it('holds verification without claiming assets when only the phone suffix matches', async () => {
  await core(exchange());
  wrongPhone = true;
  expect((await core(verify())).status).toBe(409);
  expect(calls.some((call) => call.path.endsWith('_verify'))).toBe(false);
  expect(calls.at(-1)?.body.p_reason).toBe('verification_failed');
});

it.each([undefined, '999'])(
  'holds before any phone read when the FINISH WABA is not a management grant target (%s)',
  async (target) => {
    await core(exchange());
    grantWaba = target;
    expect((await core(verify())).status).toBe(409);
    expect(calls.some(({ path }) => path.endsWith('/phone_numbers'))).toBe(
      false
    );
    expect(calls.some(({ path }) => path.endsWith('_verify'))).toBe(false);
    expect(calls.at(-1)?.body.p_reason).toBe('verification_failed');
  }
);

it.each(['wrong app', 'wrong full number'])(
  'holds grant-only discovery without claiming assets: %s',
  async (scenario) => {
    await core(exchange());
    debugAppId = scenario === 'wrong app' ? '999' : '123';
    wrongPhone = scenario === 'wrong full number';
    const command = { action: 'discover', nonce };

    const response = await signupProtocol(
      request(command),
      db(),
      command,
      transport,
      attemptId,
      undefined,
      {
        owner: {
          p_actor_id: actor,
          p_account_id: account,
          p_session_id: sessionId,
        },
        discovery: true,
        assertPins: () => {},
        check: async () => {},
      }
    );

    expect(response.status).toBe(409);
    expect(calls.some(({ path }) => path.endsWith('/phone_numbers'))).toBe(
      wrongPhone
    );
    expect(
      calls.some(
        ({ path }) => path.endsWith('/888') || path.endsWith('_verify')
      )
    ).toBe(false);
    expect(calls.at(-1)?.body.p_reason).toBe('verification_failed');
  }
);

it('rechecks SQL authority between debug-token and phone lookup', async () => {
  await core(exchange());
  revokeAfterDebug = true;
  expect((await core(verify())).status).toBe(403);
  expect(calls.some((call) => call.path.endsWith('/phone_numbers'))).toBe(
    false
  );
});

it.each<JsonValue>([
  {
    request_id: attemptId,
    nonce,
    intended_phone: '+15550001234',
    supervised: true,
  },
  { action: 'launch', nonce },
  exchange(),
  verify(),
  { action: 'confirm', nonce },
  { action: 'review', nonce, reason: 'provider_cancelled' },
])('keeps every public mutation unavailable: %j', async (command) => {
  const response = await signupPost(
    request(command),
    db(),
    json.parse(command).action ? attemptId : undefined
  );

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: 'launch_prerequisites_incomplete',
  });
  expect(
    calls
      .filter((call) => call.path.includes('/rpc/'))
      .every((call) => call.path.endsWith('_status'))
  ).toBe(true);
});

it.each<JsonValue>([
  { ...exchange(), account_id: account },
  { ...exchange(), actor_id: actor },
  { ...exchange(), code: 'x'.repeat(32769) },
  { action: 'verify', nonce, waba_id: ['777', '999'], phone_number_id: '888' },
  { action: 'verify', nonce, waba_id: '777', phone_number_id: ['888', '999'] },
  { action: 'exchange', nonce: 'invalid', code: 'code' },
])(
  'rejects extra scope, malformed secrets or ambiguous multi-asset callbacks',
  async (command) => {
    expect((await signupPost(request(command), db(), attemptId)).status).toBe(
      400
    );
    expect((await core(command)).status).toBe(400);
  }
);

it('requires same-origin JSON before doing any authenticated or SQL work', async () => {
  const response = await signupPost(
    new Request(`${origin}/api/signup`, {
      method: 'POST',
      headers: {
        Origin: 'https://foreign.test',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(exchange()),
    }),
    db(),
    attemptId
  );

  expect(response.status).toBe(403);
  expect(calls).toHaveLength(0);
});

it.each(['overflow', 'abort'])(
  'awaits public body cancellation on %s',
  async (scenario) => {
    const cancelStarted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    let finished = false;

    const stream = new ReadableStream<Uint8Array>(
      {
        pull(streamController) {
          if (scenario === 'overflow')
            streamController.enqueue(new Uint8Array(40 * 1024 + 1));
          else controller.abort();
        },
        cancel() {
          cancelStarted.resolve();

          return release.promise;
        },
      },
      { highWaterMark: 0 }
    );

    const init = {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: stream,
      signal: controller.signal,
      duplex: 'half',
    };

    const pending = signupPost(
      new Request(`${origin}/api/signup`, init),
      db(),
      attemptId
    ).finally(() => {
      finished = true;
    });

    try {
      await cancelStarted.promise;
      await new Promise<void>((resolve) => process.nextTick(resolve));
      expect(finished).toBe(false);
    } finally {
      release.resolve();
      await pending;
    }

    expect((await pending).status).toBe(scenario === 'overflow' ? 413 : 499);
  }
);

it('reserves settlement time after the remote phase deadline', async () => {
  hang = true;
  const pending = core(exchange(), undefined, Date.now() + 5400);
  await received.promise;
  expect((await pending).status).toBe(409);
  await closed.promise;
  expect(calls.at(-1)?.body.p_reason).toBe('exchange_unknown');
  expect(
    calls.filter((call) => call.path.endsWith('/oauth/access_token'))
  ).toHaveLength(1);
});

it('enforces bounded owner admission with retry-after', async () => {
  for (let i = 0; i < 30; i++)
    expect((await signupStatus(request(), db())).status).toBe(200);
  const response = await signupStatus(request(), db());
  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBeTruthy();
});

it('caps public bodies without trusting Content-Length', async () => {
  expect(
    (
      await signupPost(
        request({ ...exchange(), padding: 'x'.repeat(40 * 1024) }),
        db(),
        attemptId
      )
    ).status
  ).toBe(413);
});

it('aborts and awaits the controlled provider before recording uncertainty, never resending', async () => {
  hang = true;
  const controller = new AbortController();
  const pending = core(exchange(), controller.signal);
  await received.promise;
  controller.abort();
  const response = await pending;
  await closed.promise;
  expect(response.status).toBe(499);
  expect(
    calls.filter((call) => call.path.endsWith('/oauth/access_token'))
  ).toHaveLength(1);
  expect(calls.at(-1)?.body.p_reason).toBe('exchange_unknown');
});

it('prepares with server-derived snapshot and launches once without invoking SDK or Meta', async () => {
  const command = {
    request_id: attemptId,
    nonce,
    intended_phone: '+15550001234',
    supervised: true,
  };

  const prepared = await signupProtocol(
    request(command),
    db(),
    command,
    transport
  );

  expect(prepared.status).toBe(200);
  expect(calls.at(-1)?.body).toMatchObject({
    p_expected_revision: account,
    p_expected_config_id: null,
    p_expected_generation: null,
    p_app_id: '123',
    p_login_config_id: '456',
  });
  expect((await core({ action: 'launch', nonce })).status).toBe(200);
  expect((await core({ action: 'launch', nonce })).status).toBe(409);
  expect(calls.some((call) => call.path.startsWith('/v27.0/'))).toBe(false);
});
