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
const requestId = '40000000-0000-4000-8000-000000000001';
const context = '0123456789abcdef'.repeat(4);
const statusRpc = '/rest/v1/rpc/coexistence_import_settings_status';
const recordRpc = '/rest/v1/rpc/coexistence_import_settings_record';

const body = {
  context,
  request_id: requestId,
  previous_request_id: null,
  history: true,
  contacts: false,
  version: 'projection-v1',
};

const connection = {
  context,
  phone_id_suffix: '4321',
  can_grant: true,
  can_withdraw: false,
  state: 'none',
  history: false,
  contacts: false,
  previous_request_id: null,
  expires_at: null,
};

const receipt = {
  status: 'recorded',
  request_id: requestId,
  history: true,
  contacts: false,
  expires_at: '2100-01-02T03:04:05.012345+00:00',
  dispatch_authorized: false,
};

let origin: string;
let role: string;
let owner: string;
let calls: string[];
let externalCalls: string[];
let rpc: { args: unknown; authorization: string | undefined }[];
let authStatus: number;
let profileStatus: number;
let rpcStatus: number;
let result: string;
let dropAcknowledgement: boolean;

const server = createServer(async (req, res) => {
  const path = new URL(req.url!, origin).pathname;
  calls.push(path);
  res.setHeader('Content-Type', 'application/json');

  if (path === '/auth/v1/user') {
    res.statusCode = authStatus;
    res.end(
      JSON.stringify(
        authStatus === 200
          ? { id: actor, aud: 'authenticated', role: 'authenticated' }
          : { message: 'fixture error', code: 'bad_jwt' }
      )
    );
  } else if (path === '/rest/v1/profiles') {
    res.statusCode = profileStatus;
    res.end(
      JSON.stringify(
        profileStatus === 200
          ? { account_id: account, account_role: role }
          : { message: 'profile-sensitive-error' }
      )
    );
  } else if (path === '/rest/v1/accounts') {
    res.end(JSON.stringify({ id: account, owner_user_id: owner }));
  } else if (path === statusRpc || path === recordRpc) {
    let raw = '';

    for await (const chunk of req) raw += chunk;
    rpc.push({
      args: JSON.parse(raw),
      authorization: req.headers.authorization,
    });

    if (dropAcknowledgement) {
      res.destroy();

      return;
    }

    res.statusCode = rpcStatus;
    res.end(result);
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
  owner = actor;
  calls = [];
  rpc = [];
  externalCalls = [];
  authStatus = 200;
  profileStatus = 200;
  rpcStatus = 200;
  dropAcknowledgement = false;
  result = JSON.stringify({ status: 'ok', connection });
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', origin);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-fixture');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-fixture');
  vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
  vi.stubEnv('WHATSAPP_COEXISTENCE_IMPORT_SETTINGS_ENABLED', 'true');
  vi.stubEnv('WHATSAPP_COEXISTENCE_APP_ID', '1234');
  vi.stubEnv('WHATSAPP_COEXISTENCE_RELAY_WABA_ID', '2468');
  vi.stubEnv('WHATSAPP_COEXISTENCE_RELAY_PHONE_ID', '98764321');

  const nativeFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));

    if (url.origin !== origin) {
      externalCalls.push(url.origin);
      throw new Error('External network forbidden');
    }

    return nativeFetch(input, init);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  expect(externalCalls).toEqual([]);
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
  vi.stubGlobal('AsyncLocalStorage', AsyncLocalStorage);

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
    `http://localhost/api/whatsapp/coexistence/import-permissions${query}`,
    { ...init, signal: init.signal ?? undefined, headers }
  );

  const work = createWorkStore({
    page: '/api/whatsapp/coexistence/import-permissions/route',
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
  payload: BodyInit = JSON.stringify(body),
  overrides?: HeadersInit
) {
  const headers = new Headers({
    Origin: 'http://localhost',
    'Sec-Fetch-Site': 'same-origin',
    'Content-Type': 'application/json',
  });

  new Headers(overrides).forEach((value, key) => headers.set(key, value));

  return run(POST, { method: 'POST', headers, body: payload });
}

const scopedPins = {
  p_actor_id: actor,
  p_account_id: account,
  p_session_id: sessionId,
  p_allowed_app_id: '1234',
  p_allowed_waba_id: '2468',
  p_allowed_phone_id: '98764321',
};

it('reads the owner’s current import status without fetching provider state or account credentials', async () => {
  const response = await run(GET);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual({ status: 'ok', connection });
  expect(calls.filter((path) => path.startsWith('/rest/v1/'))).toEqual([
    '/rest/v1/profiles',
    '/rest/v1/accounts',
    statusRpc,
  ]);
  expect(rpc).toEqual([
    { args: scopedPins, authorization: 'Bearer service-fixture' },
  ]);
});

it('forwards the reviewed context and previous choice, and preserves the saved expiry on explicit replay', async () => {
  const previousId = '50000000-0000-4000-8000-000000000001';
  const payload = JSON.stringify({ ...body, previous_request_id: previousId });
  result = JSON.stringify(receipt);

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await post(payload);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(receipt);
  }

  expect(calls.filter((path) => path.includes('/rpc/'))).toEqual([
    recordRpc,
    recordRpc,
  ]);
  expect(rpc).toEqual(
    Array.from({ length: 2 }, () => ({
      args: {
        ...scopedPins,
        p_context: context,
        p_request_id: requestId,
        p_previous_request_id: previousId,
        p_history: true,
        p_contacts: false,
        p_version: 'projection-v1',
      },
      authorization: 'Bearer service-fixture',
    }))
  );
});

it.each([
  ['WHATSAPP_COEXISTENCE_ENABLED', 'false'],
  ['WHATSAPP_COEXISTENCE_IMPORT_SETTINGS_ENABLED', 'TRUE'],
  ['WHATSAPP_COEXISTENCE_APP_ID', ' 1234'],
  ['WHATSAPP_COEXISTENCE_RELAY_WABA_ID', '02468'],
  ['WHATSAPP_COEXISTENCE_RELAY_PHONE_ID', '2468'],
])(
  'does not accept a positive write without both flags and canonical distinct pins: %s=%s',
  async (key, value) => {
    vi.stubEnv(key, value);
    result = JSON.stringify(receipt);
    expect((await post()).status).toBe(409);
    expect(rpc).toEqual([]);
  }
);

it('leaves an existing effective choice and withdrawal available with the grant flag disabled', async () => {
  vi.stubEnv('WHATSAPP_COEXISTENCE_IMPORT_SETTINGS_ENABLED', 'false');

  const effective = {
    ...connection,
    state: 'effective',
    history: true,
    can_withdraw: true,
    previous_request_id: requestId,
    expires_at: receipt.expires_at,
  };

  result = JSON.stringify({ status: 'ok', connection: effective });
  const status = await run(GET);
  expect(status.status).toBe(200);
  expect(await status.json()).toEqual({
    status: 'ok',
    connection: { ...effective, can_grant: false },
  });

  const withdrawalId = '50000000-0000-4000-8000-000000000001';
  result = JSON.stringify({
    ...receipt,
    request_id: withdrawalId,
    history: false,
  });

  const saved = await post(
    JSON.stringify({
      ...body,
      request_id: withdrawalId,
      previous_request_id: requestId,
      history: false,
    })
  );

  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({
    ...receipt,
    request_id: withdrawalId,
    history: false,
  });

  const nullPins = {
    ...scopedPins,
    p_allowed_app_id: null,
    p_allowed_waba_id: null,
    p_allowed_phone_id: null,
  };

  expect(rpc.map((entry) => entry.args)).toEqual([
    nullPins,
    {
      ...nullPins,
      p_context: context,
      p_request_id: withdrawalId,
      p_previous_request_id: requestId,
      p_history: false,
      p_contacts: false,
      p_version: 'projection-v1',
    },
  ]);
});

it.each([
  { request_id: sessionId },
  { history: false },
  { contacts: true },
  { dispatch_authorized: true },
  { expires_at: null },
  { expires_at: 'tomorrow' },
  { access_token: 'sensitive-receipt-field' },
])(
  'does not acknowledge malformed or mismatched saved choices: %j',
  async (override) => {
    result = JSON.stringify({ ...receipt, ...override });
    const response = await post();
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({
      error: 'import_settings_unavailable',
    });
  }
);

it('withholds the entire RPC projection when malformed status includes internal fields', async () => {
  result = JSON.stringify({
    status: 'ok',
    connection: {
      ...connection,
      session_id: sessionId,
      access_token: 'sensitive-status-field',
    },
  });
  const response = await run(GET);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: 'import_settings_unavailable',
  });
});

it.each(['GET', 'POST'])(
  'denies %s if SQL no longer recognizes the owner’s live session',
  async (method) => {
    result = JSON.stringify({ status: 'forbidden' });
    const response = await (method === 'GET' ? run(GET) : post());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'import_settings_unavailable',
    });
  }
);

it.each(['conflict', 'busy', 'blocked', 'superseded', 'expired'])(
  'requires re-review after SQL returns %s',
  async (status) => {
    result = JSON.stringify({ status });
    expect((await post()).status).toBe(409);
    expect(rpc).toHaveLength(1);
  }
);

it('treats an HTTP 202 receipt as unconfirmed', async () => {
  rpcStatus = 202;
  result = JSON.stringify(receipt);
  expect((await post()).status).toBe(503);
  expect(rpc).toHaveLength(1);
});

it('does not repeat a write after the acknowledgement is lost', async () => {
  dropAcknowledgement = true;
  const response = await post();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: 'import_settings_unavailable',
  });
  expect(rpc).toHaveLength(1);
});

it('does not expose upstream database errors or retry a failed RPC', async () => {
  rpcStatus = 503;
  result = JSON.stringify({ message: 'record-sensitive-error' });
  const response = await post();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: 'import_settings_unavailable',
  });
  expect(rpc).toHaveLength(1);
});

it('does not invoke SQL after Auth rejects the cookie or when the cookie is missing', async () => {
  expect((await run(GET, {}, { cookie: false })).status).toBe(401);
  authStatus = 401;
  expect((await post()).status).toBe(401);
  expect(rpc).toEqual([]);
});

it('does not accept bearer auth even alongside a valid owner cookie', async () => {
  const response = await post(JSON.stringify(body), {
    Authorization: 'Bearer fixture',
  });

  expect(response.status).toBe(401);
  expect(calls).toEqual([]);
});

it('rejects a cookie without the caller’s authenticated session claim', async () => {
  expect((await run(GET, {}, { claims: { sub: actor } })).status).toBe(401);
  expect(rpc).toEqual([]);
});

it.each([
  ['admin', actor],
  ['owner', sessionId],
])(
  'rejects a profile role %s with actual owner %s unless both owner checks agree',
  async (profileRole, actualOwner) => {
    role = profileRole;
    owner = actualOwner;
    expect((await post()).status).toBe(403);
    expect(rpc).toEqual([]);
  }
);

it('fails closed before the service RPC when loading account scope fails', async () => {
  profileStatus = 503;
  const response = await run(GET);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: 'import_settings_unavailable',
  });
  expect(rpc).toEqual([]);
});

it.each([
  ['Origin', ''],
  ['Origin', 'null'],
  ['Origin', 'https://foreign.invalid'],
  ['Sec-Fetch-Site', 'cross-site'],
  ['Sec-Fetch-Site', 'same-site'],
])(
  'rejects inconsistent or foreign POST origin metadata: %s=%s',
  async (key, value) => {
    expect((await post(JSON.stringify(body), { [key]: value })).status).toBe(
      403
    );
    expect(calls).toEqual([]);
  }
);

it.each([
  { account_id: account },
  { previous_request_id: undefined },
  { request_id: 'not-a-uuid' },
  { history: 'false' },
  { context: context.toUpperCase() },
  { version: 'projection-v2' },
])('rejects non-contract JSON fields: %j', async (override) => {
  expect((await post(JSON.stringify({ ...body, ...override }))).status).toBe(
    400
  );
  expect(calls).toEqual([]);
});

it('rejects duplicate JSON fields, non-UTF-8 bytes and non-JSON content', async () => {
  expect(
    (await post(`{"history":false,${JSON.stringify(body).slice(1)}`)).status
  ).toBe(400);
  expect((await post(Uint8Array.of(0xc0, 0xaf))).status).toBe(400);
  expect(
    (await post(JSON.stringify(body), { 'Content-Type': 'text/plain' })).status
  ).toBe(400);
  expect(calls).toEqual([]);
});

it('bounds the bytes received independently of the declared length', async () => {
  const response = await post(JSON.stringify(body) + ' '.repeat(1024), {
    'Content-Length': '123',
  });

  expect(response.status).toBe(413);
  expect(calls).toEqual([]);
});

it('rejects query overrides and unsupported methods with no storage reads', async () => {
  expect((await run(GET, {}, { query: '?account_id=foreign' })).status).toBe(
    400
  );
  const response = DELETE();
  expect(response.status).toBe(405);
  expect(response.headers.get('allow')).toBe('GET, POST');
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(calls).toEqual([]);
});
