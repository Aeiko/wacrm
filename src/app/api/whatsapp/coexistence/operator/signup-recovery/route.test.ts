import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from 'vitest';
import { listenForFetch } from '@/test/http-server';

vi.stubGlobal('AsyncLocalStorage', AsyncLocalStorage);

const { createWorkStore } =
  await import('next/dist/server/async-storage/work-store');

const { createRequestStoreForAPI } =
  await import('next/dist/server/async-storage/request-store');

const { workAsyncStorage } =
  await import('next/dist/server/app-render/work-async-storage.external');

const { workUnitAsyncStorage } =
  await import('next/dist/server/app-render/work-unit-async-storage.external');

const { NextRequest } = await import('next/server');
const { __resetRateLimitForTests } = await import('@/lib/rate-limit');
const { GET, POST, DELETE } = await import('./route');
const actor = '10000000-0000-4000-8000-000000000001';
const account = '20000000-0000-4000-8000-000000000001';
const sessionId = '30000000-0000-4000-8000-000000000001';
const attemptId = '40000000-0000-4000-8000-000000000001';
const requestId = '50000000-0000-4000-8000-000000000001';

const body = {
  attempt_id: attemptId,
  request_id: requestId,
  action: 'record_hold',
};

const receipt = {
  status: 'recorded',
  attempt_id: attemptId,
  request_id: requestId,
  disposition: 'held_uncertain',
  reviewed_at: '2026-11-18T05:11:30.010001+00:00',
};

let origin: string;
let role: string;
let accountOwner: string;
let calls: string[];

type FixtureJson = {
  [key: string]: FixtureJson | string | number | boolean | null;
};

let statusResult: string;
let recordResult: string;
let authHttpStatus: number;
let rpcHttpStatus: number;
let rpcAction: string;
let onRpc: (() => void) | undefined;

const server = createServer(async (req, res) => {
  const path = new URL(req.url!, origin).pathname;
  calls.push(path);
  res.setHeader('Content-Type', 'application/json');

  if (path === '/auth/v1/user') {
    res.statusCode = authHttpStatus;
    res.end(
      JSON.stringify(
        authHttpStatus === 200
          ? { id: actor, aud: 'authenticated', role: 'authenticated' }
          : { message: 'invalid signature', code: 'bad_jwt' }
      )
    );
  } else if (path === '/rest/v1/profiles')
    res.end(JSON.stringify({ account_id: account, account_role: role }));
  else if (path === '/rest/v1/accounts')
    res.end(
      JSON.stringify({
        id: account,
        name: 'Fixture',
        owner_user_id: accountOwner,
      })
    );
  else if (
    path === '/rest/v1/rpc/coexistence_signup_recovery_status' ||
    path === '/rest/v1/rpc/coexistence_signup_recovery_record'
  ) {
    const record = path.endsWith('_record');
    let raw = '';

    for await (const chunk of req) raw += chunk;
    expect(JSON.parse(raw)).toEqual({
      p_actor_id: actor,
      p_account_id: account,
      p_session_id: sessionId,
      ...(record && {
        p_attempt_id: attemptId,
        p_request_id: requestId,
        p_action: rpcAction,
      }),
    });
    expect(req.headers.authorization).toBe('Bearer service-fixture');
    res.statusCode = rpcHttpStatus;
    onRpc?.();
    res.end(record ? recordResult : statusResult);
  } else {
    res.statusCode = 404;
    res.end('{}');
  }
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
  role = 'owner';
  accountOwner = actor;
  calls = [];
  statusResult = JSON.stringify({ status: 'ok', attempt: null });
  recordResult = JSON.stringify(receipt);
  authHttpStatus = 200;
  rpcHttpStatus = 200;
  rpcAction = 'record_hold';
  onRpc = undefined;
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', origin);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-fixture');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-fixture');
  vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'false');
  const nativeFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));

    if (url.origin !== origin) throw new Error('External network forbidden');

    return nativeFetch(input, init);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function run(
  handler: (request: Request) => Promise<Response>,
  init: RequestInit = {},
  {
    cookie = true,
    claims = { sub: actor, session_id: sessionId },
    query = '',
  }: { cookie?: boolean; claims?: object; query?: string } = {}
) {
  const payload = Buffer.from(
    JSON.stringify({ ...claims, exp: 4102444800 })
  ).toString('base64url');

  const jwt = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${payload}.fixture`;

  const session = Buffer.from(
    JSON.stringify({
      access_token: jwt,
      refresh_token: 'fixture',
      expires_at: 4102444800,
      token_type: 'bearer',
      user: { id: actor },
    })
  ).toString('base64url');

  const headers = new Headers(init.headers);

  if (cookie) headers.set('cookie', `sb-127-auth-token=base64-${session}`);

  const request = new NextRequest(
    `http://localhost/api/whatsapp/coexistence/operator/signup-recovery${query}`,
    { ...init, signal: init.signal ?? undefined, headers }
  );

  const work = createWorkStore({
    page: '/api/whatsapp/coexistence/operator/signup-recovery/route',
    buildId: 'test',
    deploymentId: '',
    previouslyRevalidatedTags: [],
    renderOpts: {
      cacheLifeProfiles: {
        default: { stale: 300, revalidate: 900, expire: 3600 },
      },
      staticPageGenerationTimeout: 60,
      cacheComponents: false,
      validationLevel: 'warning',
      experimental: {
        authInterrupts: false,
        useCacheTimeout: 5000,
        durableUseCacheEntries: false,
      },
      isBuildTimePrerendering: false,
      waitUntil: undefined,
      onClose: () => {},
      onAfterTaskError: undefined,
    },
  });

  const store = createRequestStoreForAPI(
    request,
    request.nextUrl,
    { tags: [], expirationsByCacheKind: new Map() },
    undefined,
    undefined,
    undefined
  );

  return workAsyncStorage.run(work, () =>
    workUnitAsyncStorage.run(store, () => handler(request))
  );
}

function post(
  payload: FixtureJson = body,
  headers: Record<string, string> = {}
) {
  return run(POST, {
    method: 'POST',
    headers: {
      Origin: 'http://localhost',
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(payload),
  });
}

it('records a hold while disabled using the current admin’s own session', async () => {
  role = 'admin';
  accountOwner = attemptId;
  const response = await post();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(receipt);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(calls.filter((path) => path.includes('/rpc/'))).toEqual([
    '/rest/v1/rpc/coexistence_signup_recovery_record',
  ]);
});

it('reads only the current owner’s tenant recovery status while signup is disabled', async () => {
  const response = await run(GET);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'ok', attempt: null });
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
});

function rpcCalls() {
  return calls.filter((path) => path.includes('/rpc/'));
}

it('rejects bearer or API-key substitutes for a cookie session', async () => {
  const response = await run(
    GET,
    {
      headers: {
        Authorization: 'Bearer service-fixture',
        'X-API-Key': 'fixture',
      },
    },
    { cookie: false }
  );

  expect(response.status).toBe(401);
  expect(calls).toEqual([]);
});

it('does not trust the cookie payload when Auth rejects the token', async () => {
  authHttpStatus = 401;
  const response = await run(GET);
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: 'recovery_unavailable' });
  expect(calls).toEqual(['/auth/v1/user']);
});

it('does not disclose GET status when SQL reports the live session or role is gone', async () => {
  statusResult = JSON.stringify({ status: 'forbidden' });
  const response = await run(GET);
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: 'recovery_unavailable' });
});

it.each([
  { sub: actor },
  { sub: attemptId, session_id: sessionId },
  { sub: actor, session_id: 'not-a-uuid' },
])(
  'rejects cookie claims without the verified caller/session pair: %j',
  async (claims) => {
    expect((await run(GET, {}, { claims })).status).toBe(401);
    expect(rpcCalls()).toEqual([]);
  }
);

it.each(['agent', 'viewer', 'owner'])(
  'rejects profile role %s without operator authority',
  async (value) => {
    role = value;
    accountOwner = attemptId;
    expect((await post()).status).toBe(403);
    expect(rpcCalls()).toEqual([]);
  }
);

it('does not send query input or unsupported methods to recovery SQL', async () => {
  expect((await run(GET, {}, { query: '?account_id=foreign' })).status).toBe(
    400
  );
  expect(DELETE().status).toBe(405);
  expect(DELETE().headers.get('allow')).toBe('GET, POST');
  expect(calls).toEqual([]);
});

it.each([
  ['Origin', ''],
  ['Origin', 'https://another.invalid'],
  ['Sec-Fetch-Site', 'cross-site'],
])('rejects a cross-origin POST with %s %s', async (header, value) => {
  expect((await post(body, { [header]: value })).status).toBe(403);
  expect(calls).toEqual([]);
});

it.each([
  { ...body, p_actor_id: actor },
  { ...body, reason: 'caller evidence' },
  { ...body, action: 'launch' },
  { ...body, action: 'reset' },
  { ...body, attempt_id: 'malformed' },
])('refuses non-recovery input without touching SQL: %j', async (invalid) => {
  expect((await post(invalid)).status).toBe(400);
  expect(rpcCalls()).toEqual([]);
});

it('requires JSON rather than accepting a simple cross-origin form content type', async () => {
  const response = await post(body, { 'Content-Type': 'text/plain' });
  expect(response.status).toBe(400);
  expect(rpcCalls()).toEqual([]);
});

it('bounds POST bytes even if a Content-Length is missing or misleading', async () => {
  const response = await run(POST, {
    method: 'POST',
    headers: {
      Origin: 'http://localhost',
      'Content-Type': 'application/json',
      'Content-Length': '120',
    },
    body: JSON.stringify(body) + ' '.repeat(64 * 1024),
  });

  expect(response.status).toBe(413);
  expect(rpcCalls()).toEqual([]);
});

const launched = {
  id: attemptId,
  state: 'launch_possible',
  launched_at: '2026-11-17T05:11:30+00:00',
  exchange_started: false,
  known_claims: 1,
  disposition: null,
  reviewed_at: null,
};

it('returns the complete safe status shape without converting database timestamps', async () => {
  const result = {
    status: 'ok',
    attempt: {
      ...launched,
      disposition: 'held_uncertain',
      reviewed_at: receipt.reviewed_at,
    },
  };

  statusResult = JSON.stringify(result);
  const response = await run(GET);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(result);
});

it.each([
  { ...launched, state: 'expired_unstarted' },
  { ...launched, exchange_started: true },
  { ...launched, known_claims: -1 },
  { ...launched, disposition: 'held_uncertain' },
  { ...launched, reviewed_at: receipt.reviewed_at },
  { ...launched, access_token: 'secret' },
  {
    ...launched,
    launched_at: null,
    exchange_started: true,
    state: 'review_required',
  },
])(
  'fails closed on impossible or sensitive status metadata: %j',
  async (attempt) => {
    statusResult = JSON.stringify({ status: 'ok', attempt });
    const response = await run(GET);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'recovery_unavailable' });
  }
);

it.each([
  { ...receipt, attempt_id: account },
  { ...receipt, request_id: account },
  { ...receipt, disposition: 'closed_unstarted' },
  { ...receipt, reviewed_at: 'not a timestamp' },
  { ...receipt, nonce: 'secret' },
  { status: 'not_found', detail: 'sensitive data' },
])(
  'fails closed rather than publishing an invalid receipt: %j',
  async (result) => {
    recordResult = JSON.stringify(result);
    const response = await post();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'recovery_unavailable' });
  }
);

it.each([
  ['forbidden', 403],
  ['not_found', 404],
  ['conflict', 409],
  ['busy', 409],
  ['invalid', 400],
])(
  'uses a generic error when fresh SQL authorization or state rejects with %s',
  async (status, code) => {
    recordResult = JSON.stringify({ status });
    const response = await post();
    expect(response.status).toBe(code);
    expect(await response.json()).toEqual({ error: 'recovery_unavailable' });
  }
);

it('never retries an ambiguous POST automatically; an identical explicit repeat returns the DB receipt', async () => {
  const closed = { ...receipt, disposition: 'closed_unstarted' };
  const command = { ...body, action: 'close_unstarted' };
  rpcAction = 'close_unstarted';
  rpcHttpStatus = 503;
  recordResult = JSON.stringify({
    message: 'lost acknowledgement',
    details: 'secret',
  });
  const lost = await post(command);
  expect(lost.status).toBe(503);
  expect(await lost.json()).toEqual({ error: 'recovery_unavailable' });
  expect(rpcCalls()).toHaveLength(1);

  rpcHttpStatus = 200;
  recordResult = JSON.stringify(closed);
  const retry = await post(command);
  expect(retry.status).toBe(200);
  expect(await retry.json()).toEqual(closed);
  expect(rpcCalls()).toHaveLength(2);
});

it('cancels a pending lookup if the caller disconnects', async () => {
  const abort = new AbortController();
  onRpc = () => abort.abort();
  const response = await run(GET, { signal: abort.signal });
  expect(response.status).toBe(499);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
});

it('throttles recovery calls without sending additional SQL requests', async () => {
  for (let count = 0; count < 30; count++)
    expect((await run(GET)).status).toBe(200);
  const response = await post();
  expect(response.status).toBe(429);
  expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
  expect(rpcCalls()).toHaveLength(30);
});
