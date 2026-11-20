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
const { POST: attemptPOST } = await import('./[attemptId]/route');
const actor = '10000000-0000-4000-8000-000000000001';
const account = '20000000-0000-4000-8000-000000000001';
const sessionId = '30000000-0000-4000-8000-000000000001';
const attemptId = '40000000-0000-4000-8000-000000000001';
let origin: string;
let role: string;
let calls: string[];

const server = createServer(async (req, res) => {
  const path = new URL(req.url!, origin).pathname;
  calls.push(path);
  res.setHeader('Content-Type', 'application/json');

  if (path === '/auth/v1/user')
    res.end(
      JSON.stringify({ id: actor, aud: 'authenticated', role: 'authenticated' })
    );
  else if (path === '/rest/v1/profiles')
    res.end(JSON.stringify({ account_id: account, account_role: role }));
  else if (path === '/rest/v1/accounts')
    res.end(
      JSON.stringify({ id: account, name: 'Fixture', owner_user_id: actor })
    );
  else if (path === '/rest/v1/rpc/coexistence_signup_status') {
    let raw = '';

    for await (const chunk of req) raw += chunk;
    expect(JSON.parse(raw)).toEqual({
      p_actor_id: actor,
      p_account_id: account,
      p_session_id: sessionId,
    });
    expect(req.headers.authorization).toBe('Bearer service-fixture');
    res.end(JSON.stringify({ status: 'ok', attempt: null }));
  } else throw new Error(`Unexpected HTTP ${path}`);
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
  calls = [];
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
  cookie = true
) {
  const payload = Buffer.from(
    JSON.stringify({ sub: actor, session_id: sessionId, exp: 4102444800 })
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
    'http://localhost/api/whatsapp/coexistence/signup',
    { ...init, signal: init.signal ?? undefined, headers }
  );

  const work = createWorkStore({
    page: '/api/whatsapp/coexistence/signup/route',
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

it('reads owner status through real Next cookie auth and validated claims while disabled', async () => {
  const response = await run(GET);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    enabled: false,
    launch_available: false,
    reason: 'launch_prerequisites_incomplete',
    attempt: null,
  });
  expect(response.headers.get('cache-control')).toBe('private, no-store');
});

it('does not substitute a bearer or API key for a cookie session', async () => {
  expect(
    (
      await run(
        GET,
        {
          headers: {
            Authorization: 'Bearer service-fixture',
            'X-API-Key': 'fixture',
          },
        },
        false
      )
    ).status
  ).toBe(401);
  expect(calls).toEqual([]);
});

it.each(['admin', 'viewer', 'agent'])(
  'rejects %s before privileged SQL',
  async (value) => {
    role = value;
    expect((await run(GET)).status).toBe(403);
    expect(calls.some((path) => path.includes('/rpc/'))).toBe(false);
  }
);

it('fails closed for prepare and async attempt launch routes without mutation or provider HTTP', async () => {
  for (const handler of [
    POST,
    (request: Request) =>
      attemptPOST(request, { params: Promise.resolve({ attemptId }) }),
  ]) {
    const body =
      handler === POST
        ? {
            request_id: attemptId,
            nonce: attemptId,
            intended_phone: '+15550001234',
            supervised: true,
          }
        : { action: 'launch', nonce: attemptId };

    const response = await run(handler, {
      method: 'POST',
      headers: {
        Origin: 'http://localhost',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'launch_prerequisites_incomplete',
    });
  }

  expect(
    calls
      .filter((path) => path.includes('/rpc/'))
      .every((path) => path.endsWith('_status'))
  ).toBe(true);
});

it('returns safe headers and method allowance on unsupported verbs', () => {
  const response = DELETE();
  expect(response.status).toBe(405);
  expect(response.headers.get('allow')).toBe('GET, POST');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
});
