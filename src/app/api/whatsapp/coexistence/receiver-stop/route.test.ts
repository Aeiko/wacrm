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
import { POST } from './route';

const endpoint =
  'https://kc-crm.sqkii.com/api/whatsapp/coexistence/receiver-stop';

const stopKey = 'a'.repeat(64);
const serviceKey = 'fixture-service-key';

const projection = {
  version: 1,
  app_id: '101',
  waba_id: '303',
  phone_number_id: '404',
  kind: 'PARTNER_REMOVED',
  source_sha256: 'b'.repeat(64),
  entry_index: 0,
  change_index: 999,
};

interface RpcReply {
  status: number;
  body: string;
  location?: string;
  type?: string;
  stall?: boolean;
}

let origin: string;
let wire: RpcReply;

const calls: unknown[] = [];

const server = createServer(async (request, response) => {
  request.setEncoding('utf8');
  let body = '';

  for await (const chunk of request) body += chunk;
  calls.push({
    path: request.url,
    method: request.method,
    authorization: request.headers.authorization,
    apiKey: request.headers.apikey,
    schema: request.headers['content-profile'],
    cookie: request.headers.cookie,
    body: JSON.parse(body),
  });
  response.setHeader('Content-Type', wire.type ?? 'application/json');

  if (wire.location) response.setHeader('Location', wire.location);
  response.writeHead(wire.status);

  if (wire.stall) {
    response.write(wire.body);
  } else {
    response.end(wire.body);
  }
});

beforeAll(async () => {
  origin = await listenForFetch(server);
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', origin);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', serviceKey);
  vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
  vi.stubEnv('WHATSAPP_COEXISTENCE_RECEIVER_STOP_KEY', stopKey);
  vi.stubEnv('WHATSAPP_COEXISTENCE_APP_ID', '101');
  vi.stubEnv('WHATSAPP_COEXISTENCE_PARTNER_BUSINESS_ID', '202');
  vi.stubEnv('WHATSAPP_COEXISTENCE_RELAY_WABA_ID', '303');
  vi.stubEnv('WHATSAPP_COEXISTENCE_RELAY_PHONE_ID', '404');
  vi.stubEnv('WHATSAPP_COEXISTENCE_APP_SECRET', 'fixture-meta-secret');
  vi.stubEnv('AUTOMATION_CRON_SECRET', 'fixture-cron-secret');
  vi.stubEnv('META_APP_SECRET', 'fixture-legacy-secret');
  vi.stubEnv('META_APP_ID', '909');
  const realFetch = globalThis.fetch;

  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(String(input)).origin !== origin || init?.redirect !== 'error')
      throw new Error(
        'Only non-redirecting loopback HTTP is allowed in this fixture'
      );

    return realFetch(input, init);
  });
  wire = { status: 200, body: '{"status": "blocked"}' };
  calls.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function request(
  body: BodyInit = JSON.stringify(projection),
  headers: Record<string, string> = {},
  signal?: AbortSignal
) {
  const init = {
    method: 'POST',
    body,
    signal,
    duplex: 'half',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${stopKey}`,
      ...headers,
    },
  };

  return POST(new Request(endpoint, init));
}

it('returns only the durable veto receipt even when template uploads share the app ID', async () => {
  vi.stubEnv('META_APP_ID', projection.app_id);
  const result = await request();

  expect(result.status).toBe(200);
  expect(result.headers.get('cache-control')).toBe('no-store');
  expect(await result.text()).toBe('{"status":"blocked"}');
  expect(calls).toEqual([
    {
      path: '/rest/v1/rpc/coexistence_receiver_stop',
      method: 'POST',
      authorization: `Bearer ${serviceKey}`,
      apiKey: serviceKey,
      schema: 'public',
      cookie: undefined,
      body: {
        p_app_id: '101',
        p_waba_id: '303',
        p_phone_number_id: '404',
        p_kind: 'PARTNER_REMOVED',
        p_source_sha256: 'b'.repeat(64),
        p_entry_index: 0,
        p_change_index: 999,
      },
    },
  ]);
});

it.each([
  [503, JSON.stringify({ message: `db failure ${stopKey}` })],
  [201, '{"status":"blocked"}'],
  [200, `${' '.repeat(64 * 1024)}{"status":"blocked"}`],
  [404, '[{"status":"blocked"}]'],
  [200, '{"status":"blocked","extra":true}'],
  [200, '{"status":"other","status":"blocked"}'],
  [200, '{"status":"pending"}'],
  [200, '[{"status":"blocked"}]'],
  [200, '{"status":'],
])('fails closed on unconfirmed RPC response %#', async (status, body) => {
  wire = { status, body };
  const result = await request();

  expect(result.status).toBe(503);
  expect(result.headers.get('cache-control')).toBe('no-store');
  expect(await result.json()).toEqual({ error: 'Receiver stop unavailable' });
  expect(calls).toHaveLength(1);
});

it.each(['same', 'cross'])(
  'never follows a %s-origin DB redirect',
  async (destination) => {
    wire = {
      status: 307,
      body: '',
      location: `${destination === 'same' ? origin : 'http://127.0.0.1:1'}/forbidden`,
    };

    expect((await request()).status).toBe(503);
    expect(calls).toHaveLength(1);
  }
);

it('rejects a success-shaped response with the wrong media type', async () => {
  wire.type = 'text/plain';
  expect((await request()).status).toBe(503);
  expect(calls).toHaveLength(1);
});

it('times out while awaiting the database response body, without retry', async () => {
  wire.stall = true;
  wire.body = '{"status":';

  expect((await request()).status).toBe(503);
  expect(calls).toHaveLength(1);
});

it.each(['client disconnect', 'route deadline'])(
  'cancels a stalled upload on %s before calling the RPC',
  async (cause) => {
    const controller = new AbortController();
    const cancel = vi.fn();

    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode('{"version":'));
      },
      cancel,
    });

    const result = request(body, {}, controller.signal);

    if (cause === 'client disconnect') controller.abort();

    expect((await result).status).toBe(503);
    expect(cancel).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(0);
  }
);

it.each([
  ['WHATSAPP_COEXISTENCE_ENABLED', 'false'],
  ['WHATSAPP_COEXISTENCE_RECEIVER_STOP_KEY', ''],
  ['WHATSAPP_COEXISTENCE_RECEIVER_STOP_KEY', ` ${stopKey}`],
  ['WHATSAPP_COEXISTENCE_RECEIVER_STOP_KEY', stopKey.toUpperCase()],
  ['WHATSAPP_COEXISTENCE_APP_SECRET', stopKey],
  ['META_APP_SECRET', `another, ${stopKey} ,third`],
  ['AUTOMATION_CRON_SECRET', stopKey],
  ['SUPABASE_SERVICE_ROLE_KEY', stopKey],
  ['WHATSAPP_COEXISTENCE_PARTNER_BUSINESS_ID', ''],
  ['WHATSAPP_COEXISTENCE_PARTNER_BUSINESS_ID', '303'],
  ['WHATSAPP_COEXISTENCE_RELAY_PHONE_ID', '0303'],
])('fails closed on misconfigured %s (%#)', async (name, value) => {
  vi.stubEnv(name, value);
  expect((await request()).status).toBe(503);
  expect(calls).toHaveLength(0);
});

it.each([
  ['Authorization', ''],
  ['Authorization', 'Bearer fixture-meta-secret'],
  ['Authorization', `Bearer ${stopKey}, Bearer ${stopKey}`],
  ['Cookie', ''],
  ['Origin', 'https://kc-crm.sqkii.com'],
  ['Origin', 'https://different.invalid'],
  ['X-Hub-Signature-256', ''],
  ['X-Hub-Signature', 'sha1=fixture'],
  ['X-Cron-Secret', 'fixture'],
  ['Content-Type', ''],
  ['Content-Type', 'text/plain'],
])('rejects an invalid or mixed %s header (%#)', async (name, value) => {
  expect(
    (await request(undefined, { [name]: value })).status
  ).toBeGreaterThanOrEqual(400);
  expect(calls).toHaveLength(0);
});

it.each([
  '',
  'not JSON',
  'null',
  JSON.stringify([projection]),
  JSON.stringify({ ...projection, version: '1' }),
  JSON.stringify({ ...projection, partner_business_id: '202' }),
  JSON.stringify({ ...projection, app_id: '0101' }),
  JSON.stringify({ ...projection, app_id: 101 }),
  JSON.stringify({ ...projection, app_id: '999' }),
  JSON.stringify({ ...projection, waba_id: '999' }),
  JSON.stringify({ ...projection, phone_number_id: '999' }),
  JSON.stringify({ ...projection, kind: 'ACCOUNT_RECONNECTED' }),
  JSON.stringify({ ...projection, source_sha256: 'B'.repeat(64) }),
  JSON.stringify({ ...projection, entry_index: -1 }),
  JSON.stringify({ ...projection, change_index: 1000 }),
  JSON.stringify({ ...projection, change_index: 0.5 }),
  JSON.stringify({ ...projection, entry_index: undefined }),
  JSON.stringify(projection).replace('"version":1', '"version":2,"version":1'),
  `${' '.repeat(1500)}${JSON.stringify(projection)}`,
])('rejects invalid, out-of-scope or oversized JSON %#', async (body) => {
  expect((await request(body)).status).toBeGreaterThanOrEqual(400);
  expect(calls).toHaveLength(0);
});
