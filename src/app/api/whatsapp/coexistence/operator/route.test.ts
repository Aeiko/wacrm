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
import type { JsonValue } from '@/lib/whatsapp/coexistence/payload';

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
const { GET } = await import('./route');
const { POST } = await import('./jobs/[jobId]/retry/route');
const { GET: configGET } = await import('../../config/route');

const userId = '30000000-0000-4000-8000-000000000001';
const accountId = '20000000-0000-4000-8000-000000000001';
const jobId = '40000000-0000-4000-8000-000000000001';
const requestId = '50000000-0000-4000-8000-000000000001';
const stamp = '2026-11-17T12:01:02.123456+00:00';
let origin: string;
let role: string;
let managed: string | null;
let calls: string[];

const server = createServer(async (req, res) => {
  const url = new URL(req.url!, origin);
  calls.push(url.pathname);
  res.setHeader('Content-Type', 'application/json');
  let value: JsonValue;

  if (url.pathname === '/auth/v1/user')
    value = { id: userId, aud: 'authenticated', role: 'authenticated' };
  else if (url.pathname === '/rest/v1/profiles')
    value = { account_id: accountId, account_role: role };
  else if (url.pathname === '/rest/v1/accounts')
    value = { id: accountId, name: 'Fixture' };
  else if (url.pathname === '/rest/v1/whatsapp_config') {
    expect(url.searchParams.get('account_id')).toBe(`eq.${accountId}`);
    expect(url.searchParams.get('select')).toBe('coexistence_app_id');
    value = { coexistence_app_id: managed };
  } else if (
    url.pathname === '/rest/v1/rpc/connection_operation_account_status'
  ) {
    expect(req.headers.authorization).toBe('Bearer service-fixture');
    let raw = '';

    for await (const chunk of req) raw += chunk;
    expect(JSON.parse(raw)).toEqual({
      p_actor_id: userId,
      p_account_id: accountId,
    });
    value = { status: 'idle' };
  } else if (url.pathname === '/rest/v1/rpc/coexistence_operator_inventory') {
    expect(req.headers.authorization).toBe('Bearer service-fixture');
    value = {
      connection: { managed: true, connected: true, verified: true },
      observed_at: stamp,
      items: [],
      next_cursor: null,
      count: 0,
      count_capped: false,
    };
  } else if (url.pathname === '/rest/v1/rpc/coexistence_operator_inspect') {
    let raw = '';

    for await (const chunk of req) raw += chunk;
    expect(JSON.parse(raw)).toEqual({
      p_actor_id: userId,
      p_account_id: accountId,
      p_job_id: jobId,
      p_app_id: '123',
      p_request_id: requestId,
    });
    value = { status: 'queued', requested_at: stamp, payload: 'secret' };
  } else throw new Error(`Unexpected request ${url.pathname}`);
  res.end(JSON.stringify(value));
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
  role = 'admin';
  managed = '123';
  calls = [];
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', origin);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-fixture');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-fixture');
  vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'false');
  vi.stubEnv('WHATSAPP_COEXISTENCE_APP_ID', '123');
  vi.stubEnv('WHATSAPP_COEXISTENCE_APP_SECRET', 'fixture');
  vi.stubEnv('WHATSAPP_COEXISTENCE_PARTNER_BUSINESS_ID', '456');
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
  path: string,
  handler: (request: Request) => Promise<Response>,
  init: RequestInit = {},
  cookie = true
) {
  const session = Buffer.from(
    JSON.stringify({
      access_token: 'user-fixture',
      refresh_token: 'refresh-fixture',
      expires_at: 4102444800,
      token_type: 'bearer',
      user: { id: userId },
    })
  ).toString('base64url');

  const headers = new Headers(init.headers);

  if (cookie) headers.set('cookie', `sb-127-auth-token=base64-${session}`);

  const request = new NextRequest(`http://localhost${path}`, {
    ...init,
    signal: init.signal ?? undefined,
    headers,
  });

  const work = createWorkStore({
    page: `${path.split('?')[0]}/route`,
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

it('reads disabled inventory using the actual Next cookie session', async () => {
  const response = await run('/api/whatsapp/coexistence/operator', GET);
  expect(response.status).toBe(200);
  expect((await response.json()).enabled).toBe(false);
});

it.each(['viewer', 'agent'])(
  'denies the cookie-authenticated %s',
  async (value) => {
    role = value;
    expect((await run('/api/whatsapp/coexistence/operator', GET)).status).toBe(
      403
    );
  }
);

it('does not accept an API key or authorization header instead of a cookie session', async () => {
  const response = await run(
    '/api/whatsapp/coexistence/operator',
    GET,
    {
      headers: {
        Authorization: 'Bearer service-fixture',
        'X-API-Key': 'service-fixture',
      },
    },
    false
  );

  expect(response.status).toBe(401);
  expect(calls).toEqual([]);
});

it('passes async job params to the retry boundary and returns only queued acknowledgement', async () => {
  vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');

  const response = await run(
    `/api/whatsapp/coexistence/operator/jobs/${jobId}/retry`,
    (request) => POST(request, { params: Promise.resolve({ jobId }) }),
    {
      method: 'POST',
      headers: {
        Origin: 'http://localhost',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ request_id: requestId }),
    }
  );

  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({
    status: 'queued',
    requested_at: stamp,
  });
});

it.each(['viewer', 'agent', 'admin'])(
  'local mode is a session-account-only read for %s, before any token or health access',
  async (value) => {
    role = value;
    const response = await run('/api/whatsapp/config?mode=local', configGET);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      managed: true,
      operation_state: 'idle',
    });
    expect(calls.filter((path) => path.includes('/rpc/'))).toEqual([
      '/rest/v1/rpc/connection_operation_account_status',
    ]);
  }
);

it('local mode requires a cookie session and never falls through to health on errors', async () => {
  const response = await run(
    '/api/whatsapp/config?mode=local',
    configGET,
    {},
    false
  );

  expect(response.status).toBe(401);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(calls).toEqual([]);
});
