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
import { listenForFetch } from '@/test/http-server';
import { deadlineFetch } from '@/lib/request-deadline';
import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { operatorInventory, operatorRetry } from './operator';
import { z } from 'zod';
import { jsonSchema, type JsonValue } from './payload';

const accountId = '20000000-0000-4000-8000-000000000001';
const userId = '30000000-0000-4000-8000-000000000001';
const jobId = '40000000-0000-4000-8000-000000000001';
const requestId = '50000000-0000-4000-8000-000000000001';
const stamp = '2026-11-17T12:01:02.123456+00:00';
let origin: string;
let role: string;
let authenticated: boolean;
let profileAccount: string;
let dbStatus: number;
let inventory: JsonValue;
let inspection: JsonValue;
let settlement: JsonValue;
let hangPath: string;
let changeOnInspect: () => void;
let calls: { path: string; body: Record<string, JsonValue> }[];

const item = () => ({
  id: jobId,
  state: 'quarantined',
  reason: 'commit_failed',
  created_at: stamp,
  lease_until: null,
  available_at: stamp,
  attempts: 5,
  stage: null,
  retention_until: stamp,
  payload_present: true,
  current_binding: true,
  overdue: false,
  retry_eligible: true,
  operator_requested_at: null,
  access_token: 'secret-token',
  payload: { private: true },
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url!, origin);
  let raw = '';

  for await (const chunk of req) raw += chunk;

  const body = raw
    ? z.record(z.string(), jsonSchema).parse(JSON.parse(raw))
    : {};

  calls.push({ path: url.pathname, body });
  res.setHeader('Content-Type', 'application/json');

  if (url.pathname === hangPath) return;
  let result: JsonValue;

  if (url.pathname === '/auth/v1/user') {
    res.statusCode = authenticated ? 200 : 401;
    result = authenticated
      ? { id: userId, aud: 'authenticated', role: 'authenticated' }
      : { message: 'private-auth' };
  } else if (dbStatus !== 200) {
    res.statusCode = dbStatus;
    result = { message: 'secret-database-error' };
  } else if (url.pathname === '/rest/v1/profiles')
    result = { account_id: profileAccount, account_role: role };
  else if (url.pathname === '/rest/v1/accounts')
    result = { id: profileAccount, name: 'Fixture' };
  else if (url.pathname.startsWith('/rest/v1/rpc/')) {
    expect(req.headers.authorization).toBe('Bearer service-fixture');
    expect(body.p_account_id).toBe(profileAccount);
    expect(body.p_actor_id).toBe(userId);

    if (url.pathname.endsWith('_inventory')) result = inventory;
    else if (url.pathname.endsWith('_inspect')) {
      result = inspection;
      changeOnInspect();
    } else if (url.pathname.endsWith('_requeue')) result = settlement;
    else throw new Error('Unexpected RPC');
  } else throw new Error(`Unexpected HTTP ${url.pathname}`);
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
  role = 'admin';
  authenticated = true;
  profileAccount = accountId;
  dbStatus = 200;
  calls = [];
  inventory = {
    connection: {
      managed: true,
      connected: true,
      verified: true,
      access_token: 'secret-token',
    },
    observed_at: stamp,
    items: [item()],
    next_cursor: { created_at: stamp, id: jobId },
    count: 1,
    count_capped: false,
    payload: 'private',
  };
  inspection = { status: 'ineligible' };
  settlement = { status: 'queued', requested_at: stamp, payload: 'private' };
  hangPath = '';
  changeOnInspect = () => {};

  const fetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));

    if (url.origin !== origin) throw new Error('External network forbidden');

    return fetch(input, init);
  });
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', origin);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-fixture');
  vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'false');
  vi.stubEnv('WHATSAPP_COEXISTENCE_APP_ID', '123');
  vi.stubEnv('WHATSAPP_COEXISTENCE_APP_SECRET', 'fixture');
  vi.stubEnv('WHATSAPP_COEXISTENCE_PARTNER_BUSINESS_ID', '456');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function db() {
  const session = {
    access_token: 'user-fixture',
    refresh_token: 'refresh-fixture',
    expires_at: 4102444800,
    token_type: 'bearer',
    user: { id: userId },
  };

  return createServerClient(origin, 'anon-fixture', {
    global: { fetch: deadlineFetch },
    cookies: {
      getAll: () => [
        {
          name: 'sb-127-auth-token',
          value: `base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}`,
        },
      ],
      setAll: () => {},
    },
  });
}

function get(query = '') {
  return operatorInventory(
    new Request(`${origin}/api/whatsapp/coexistence/operator${query}`),
    db()
  );
}

function post(
  body: JsonValue = { request_id: requestId },
  headers: Record<string, string> = {},
  id = jobId
) {
  return operatorRetry(
    new Request(
      `${origin}/api/whatsapp/coexistence/operator/jobs/${id}/retry`,
      {
        method: 'POST',
        headers: {
          Origin: origin,
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(body),
      }
    ),
    id,
    db()
  );
}

it('shows sanitized backlog to admins while disabled, without enabling retries', async () => {
  const response = await get();
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.enabled).toBe(false);
  expect(result.items[0].retry_eligible).toBe(false);
  expect(result.next_cursor).toEqual({ created_at: stamp, id: jobId });
  expect(JSON.stringify(result)).not.toMatch(
    /secret|private|access_token|payload"/
  );
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
});

const validDelivery = () => ({
  waba_id: '123',
  field: 'messages',
  value: {
    messaging_product: 'whatsapp',
    metadata: { phone_number_id: '777', display_phone_number: '15550001234' },
    messages: [
      {
        id: 'wamid.live',
        from: '15550005678',
        timestamp: '1700000000',
        type: 'text',
        text: { body: 'private-text' },
      },
    ],
  },
});

const validInspection = () => ({
  status: 'inspect',
  fingerprint: 'a'.repeat(64),
  payload: { deliveries: [validDelivery()], legacy: { entry: [] } },
});

it('only acknowledges queuing after private worker validation and fingerprint CAS', async () => {
  vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
  inspection = validInspection();
  const response = await post();
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({
    status: 'queued',
    requested_at: stamp,
  });
  expect(
    calls.filter((call) => call.path.includes('/rpc/')).map((call) => call.path)
  ).toEqual([
    '/rest/v1/rpc/coexistence_operator_inspect',
    '/rest/v1/rpc/coexistence_operator_requeue',
  ]);
  expect(calls.at(-1)?.body).toEqual({
    p_actor_id: userId,
    p_account_id: accountId,
    p_app_id: '123',
    p_job_id: jobId,
    p_request_id: requestId,
    p_fingerprint: 'a'.repeat(64),
  });
});

it.each(['viewer', 'agent'])(
  'denies %s inventory and retry without privileged reads',
  async (value) => {
    role = value;
    expect((await get()).status).toBe(403);
    expect((await post()).status).toBe(403);
    expect(calls.some((call) => call.path.includes('/rpc/'))).toBe(false);
  }
);

it('requires a session and accepts owner role', async () => {
  authenticated = false;
  expect((await get()).status).toBe(401);
  authenticated = true;
  role = 'owner';
  expect((await get()).status).toBe(200);
});

it('derives all privileged account scope from the session', async () => {
  profileAccount = '20000000-0000-4000-8000-000000000002';
  inventory = {
    connection: { managed: false, connected: false, verified: false },
    observed_at: stamp,
    items: [],
    next_cursor: null,
    count: 0,
    count_capped: false,
  };
  expect((await get()).status).toBe(200);
  expect((await get(`?account_id=${accountId}`)).status).toBe(400);
});

it.each([
  '?kind=all',
  '?limit=51',
  '?limit=0',
  '?limit=01',
  '?limit=1&limit=2',
  '?before_id=' + jobId,
  '?before_created_at=' + encodeURIComponent(stamp),
  '?before_created_at=Infinity&before_id=' + jobId,
])('rejects invalid inventory query %s', async (query) => {
  expect((await get(query)).status).toBe(400);
  expect(calls).toHaveLength(0);
});

it('preserves microsecond cursors and bounds the RPC page', async () => {
  expect(
    (
      await get(
        `?kind=jobs&limit=50&before_id=${jobId}&before_created_at=${encodeURIComponent(stamp)}`
      )
    ).status
  ).toBe(200);
  expect(calls.at(-1)?.body).toMatchObject({
    p_before_created_at: stamp,
    p_before_id: jobId,
    p_limit: 50,
    p_kind: 'jobs',
  });
});

it('explains a denied import without offering retry', async () => {
  inventory = {
    connection: { managed: true, connected: true, verified: true },
    observed_at: stamp,
    items: [
      { ...item(), reason: 'import_consent_required', retry_eligible: false },
    ],
    next_cursor: null,
    count: 1,
    count_capped: false,
  };
  const result = await (await get()).json();
  expect(result.items[0]).toMatchObject({
    reason: 'import_consent_required',
    retry_eligible: false,
  });
});

it('replaces unknown reason text and never exposes secret extras', async () => {
  inventory = {
    connection: { managed: true, connected: true, verified: true },
    observed_at: stamp,
    items: [{ ...item(), reason: 'private-token-in-error' }],
    next_cursor: null,
    count: 1,
    count_capped: false,
  };
  const result = await (await get()).json();
  expect(result.items[0].reason).toBe('unknown');
  expect(JSON.stringify(result)).not.toContain('private-token');
});

it.each(['effects', 'status_events', 'updates'])(
  'never authorizes replay from %s inventory',
  async (kind) => {
    vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
    inventory = {
      connection: { managed: true, connected: true, verified: true },
      observed_at: stamp,
      items: [
        { ...item(), state: kind === 'updates' ? 'pending' : 'ambiguous' },
      ],
      next_cursor: null,
      count: 1,
      count_capped: false,
    };
    const response = await get(`?kind=${kind}`);
    expect(response.status).toBe(200);
    expect((await response.json()).items[0].retry_eligible).toBe(false);
  }
);

it('fails closed on unknown inventory state or malformed database result', async () => {
  inventory = { items: [{ ...item(), state: 'private-unknown' }] };
  expect((await get()).status).toBe(503);
});

it('returns generic database errors without logging raw details', async () => {
  const log = vi.spyOn(console, 'error');

  try {
    dbStatus = 400;
    const response = await get();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'operator_unavailable' });
    expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});

it('rejects retry while disabled without inspecting the job', async () => {
  expect((await post()).status).toBe(409);
  expect(calls.some((call) => call.path.includes('/rpc/'))).toBe(false);
});

it.each<Record<string, string>>([
  { Origin: '' },
  { Origin: 'https://foreign.test' },
  { Origin: 'null' },
  { Origin: 'https://forwarded.test', 'X-Forwarded-Host': 'forwarded.test' },
  { 'Sec-Fetch-Site': 'cross-site' },
])(
  'requires same-origin Origin and rejects cross-site metadata: %j',
  async (headers) => {
    vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
    expect((await post(undefined, headers)).status).toBe(403);
    expect(calls).toHaveLength(0);
  }
);

it.each<JsonValue>([
  {},
  { request_id: 'not-a-uuid' },
  { request_id: requestId, account_id: accountId },
  { request_id: requestId, fingerprint: 'private' },
  { request_id: requestId, action: 'replay' },
])('accepts only an opaque strict request UUID: %j', async (body) => {
  vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
  expect((await post(body)).status).toBe(400);
  expect(calls.some((call) => call.path.includes('/rpc/'))).toBe(false);
});

it('requires JSON and a UUID job path', async () => {
  expect((await post(undefined, { 'Content-Type': 'text/plain' })).status).toBe(
    400
  );
  expect((await post(undefined, {}, 'foreign-or-effect')).status).toBe(400);
});

it.each(['ineligible', 'conflict'])(
  'returns the same safe unavailable response for %s',
  async (status) => {
    vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
    inspection = { status, payload: 'private' };
    const response = await post();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'retry_unavailable' });
  }
);

it('returns the prior acceptance for the same UUID without normalizing or requeuing', async () => {
  vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
  inspection = { status: 'queued', requested_at: stamp, payload: 'private' };
  const response = await post();
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({
    status: 'queued',
    requested_at: stamp,
  });
  expect(calls.some((call) => call.path.endsWith('_requeue'))).toBe(false);
});

it.each<JsonValue>([
  null,
  {},
  { deliveries: [], legacy: { entry: [] } },
  {
    deliveries: [{ waba_id: '123', field: 'account_update', value: {} }],
    legacy: { entry: [] },
  },
  {
    deliveries: Array.from({ length: 5001 }, validDelivery),
    legacy: { entry: [] },
  },
])(
  'rejects unsupported private payloads before the final RPC',
  async (payload) => {
    vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
    inspection = { status: 'inspect', fingerprint: 'a'.repeat(64), payload };
    expect((await post()).status).toBe(409);
    expect(calls.some((call) => call.path.endsWith('_requeue'))).toBe(false);
  }
);

it('validates captured legacy envelopes using the worker expansion path', async () => {
  vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
  const delivery = validDelivery();
  inspection = {
    status: 'inspect',
    fingerprint: 'a'.repeat(64),
    payload: {
      deliveries: [],
      legacy: {
        entry: [
          {
            id: delivery.waba_id,
            changes: [{ field: delivery.field, value: delivery.value }],
          },
        ],
      },
    },
  };
  expect((await post()).status).toBe(202);
});

it('does not claim queue acceptance when eligibility changes during preparation', async () => {
  vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
  inspection = validInspection();
  settlement = { status: 'conflict', payload: 'private' };
  const response = await post();
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: 'retry_unavailable' });
});

it('rechecks configured enablement before final acceptance', async () => {
  vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
  inspection = validInspection();
  changeOnInspect = () => {
    vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'false');
  };

  expect((await post()).status).toBe(409);
  expect(calls.some((call) => call.path.endsWith('_requeue'))).toBe(false);
});

it('caps streaming bodies at 4 KiB without trusting Content-Length', async () => {
  vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
  expect(
    (
      await post(
        { request_id: requestId, extra: 'x'.repeat(4096) },
        { 'Content-Length': '1' }
      )
    ).status
  ).toBe(413);
});

it.each(['overflow', 'client abort'])(
  'waits for %s body cancellation to settle before returning',
  async (scenario) => {
    vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
    const cancelStarted = Promise.withResolvers<void>();
    const cancelFinished = Promise.withResolvers<void>();
    const controller = new AbortController();
    let settled = false;
    let cancellations = 0;

    const stream = new ReadableStream<Uint8Array>(
      {
        pull(streamController) {
          if (scenario === 'overflow')
            streamController.enqueue(new Uint8Array(4097));
          else controller.abort();
        },
        cancel() {
          cancellations++;
          cancelStarted.resolve();

          return cancelFinished.promise;
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

    const pending = operatorRetry(
      new Request(`${origin}/api/retry`, init),
      jobId,
      db()
    ).then((response) => {
      settled = true;

      return response;
    });

    try {
      await cancelStarted.promise;
      await new Promise<void>((resolve) => process.nextTick(resolve));
      expect(settled).toBe(false);
      expect(calls.some((call) => call.path.includes('/rpc/'))).toBe(false);
    } finally {
      cancelFinished.resolve();
      await pending;
    }

    expect((await pending).status).toBe(scenario === 'overflow' ? 413 : 499);
    expect(cancellations).toBe(1);
  }
);

it('cancels a stalled body reader at the request deadline', async () => {
  vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
  let cancelled = false;

  const stream = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });

  const init = {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
    },
    body: stream,
    duplex: 'half',
  };

  const request = new Request(`${origin}/api/retry`, init);
  const response = await operatorRetry(request, jobId, db(), Date.now() + 150);
  expect(response.status).toBe(504);
  expect(cancelled).toBe(true);
});

it('aborts stalled database requests at the deadline', async () => {
  hangPath = '/rest/v1/rpc/coexistence_operator_inventory';

  const response = await operatorInventory(
    new Request(`${origin}/api/operator`),
    db(),
    Date.now() + 150
  );

  expect(response.status).toBe(504);
});

it.each(['false', 'TRUE', ''])(
  'keeps retry disabled for a non-enabled flag %s',
  async (flag) => {
    vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', flag);
    expect((await post()).status).toBe(409);
  }
);

it.each([
  'WHATSAPP_COEXISTENCE_APP_ID',
  'WHATSAPP_COEXISTENCE_PARTNER_BUSINESS_ID',
  'WHATSAPP_COEXISTENCE_APP_SECRET',
])('requires valid configuration for %s', async (key) => {
  vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
  vi.stubEnv(key, key.endsWith('SECRET') ? ' ' : 'invalid');
  expect((await post()).status).toBe(409);
  expect((await (await get()).json()).enabled).toBe(false);
});

it.each(['{', 'null', '[]'])(
  'rejects malformed or non-object JSON %s',
  async (body) => {
    vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');

    const request = new Request(`${origin}/api/retry`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body,
    });

    expect((await operatorRetry(request, jobId, db())).status).toBe(400);
    expect(calls.some((call) => call.path.includes('/rpc/'))).toBe(false);
  }
);

it('rejects missing or malformed inspection fingerprints without exposing private payload', async () => {
  vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
  inspection = {
    ...validInspection(),
    fingerprint: 'secret-invalid-fingerprint',
  };
  const response = await post();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'operator_unavailable' });
  expect(calls.some((call) => call.path.endsWith('_requeue'))).toBe(false);
});

it('rejects more than 5000 normalized operations even when the delivery count fits', async () => {
  vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
  const delivery = validDelivery();
  delivery.value.messages.push({
    ...delivery.value.messages[0],
    id: 'wamid.second',
  });
  inspection = {
    status: 'inspect',
    fingerprint: 'a'.repeat(64),
    payload: {
      deliveries: Array.from({ length: 2501 }, () => delivery),
      legacy: { entry: [] },
    },
  };
  expect((await post()).status).toBe(409);
  expect(calls.some((call) => call.path.endsWith('_requeue'))).toBe(false);
});

it('does not distinguish foreign from unknown jobs', async () => {
  vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');

  const response = await post(
    undefined,
    {},
    '40000000-0000-4000-8000-000000000002'
  );

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: 'retry_unavailable' });
});

it('cooperatively cancels a stalled upload when the caller disconnects', async () => {
  vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
  let cancelled = false;

  const init = {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(150),
    body: new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
    duplex: 'half',
  };

  const response = await operatorRetry(
    new Request(`${origin}/api/retry`, init),
    jobId,
    db()
  );

  expect(response.status).toBe(499);
  expect(cancelled).toBe(true);
});

it('enforces per-user and per-account admission', async () => {
  for (let i = 0; i < 30; i++) expect((await get()).status).toBe(200);
  const response = await get();
  expect(response.status).toBe(429);
  expect(response.headers.get('Retry-After')).toBeTruthy();
});
