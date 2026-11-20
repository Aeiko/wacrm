import { createHash, createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { buffer } from 'node:stream/consumers';
import { NextRequest } from 'next/server';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from 'vitest';
import { middleware } from '@/middleware';
import { listenForFetch } from '@/test/http-server';
import type { JsonValue } from '@/lib/whatsapp/coexistence/payload';
import { MAX_WEBHOOK_BODY_BYTES } from '@/lib/whatsapp/webhook-body';
import { POST } from './route';

const path = '/api/whatsapp/coexistence/relay';
const rpcUrl = 'https://relay-test.invalid/rest/v1/rpc/coexistence_ingress';
const secret = 'dedicated-test-secret';
const legacy = 'legacy-test-secret';
const waba = '880007';
const phone = '880008';
const app = '880005';
const partner = '880006';

const history = {
  field: 'history',
  value: {
    metadata: { phone_number_id: phone },
    history: [
      {
        threads: [
          {
            id: '15555550123',
            messages: [
              {
                id: 'wamid.h1',
                from: '15555550123',
                timestamp: '1700000000',
                type: 'text',
                text: { body: 'café' },
              },
            ],
          },
        ],
      },
    ],
  },
};

const lifecycle = (value: JsonValue) => ({ field: 'account_update', value });
const stop = lifecycle({ event: 'ACCOUNT_OFFBOARDED' });

const envelope = (changes: JsonValue[] = [history], id: JsonValue = waba) => ({
  object: 'whatsapp_business_account',
  entry: [{ id, changes }],
});

const original = ` \n${JSON.stringify(envelope(), null, 2)}\n`;
const dedup = { status: 200, captured: 0, staged: 0, legacy_indices: [] };
const receipt = { ...dedup, staged: 1 };

const sign = (body: string | Uint8Array, key = secret) =>
  `sha256=${createHmac('sha256', key).update(body).digest('hex')}`;

const rpc = vi.fn<typeof fetch>();
const localFetch = globalThis.fetch;
let server: Server;
let url: string;

const send = (
  body: string | Uint8Array<ArrayBuffer>,
  signature: string | null = sign(body)
) =>
  localFetch(url, {
    method: 'POST',
    headers: signature ? { 'x-hub-signature-256': signature } : {},
    body,
  });

beforeAll(async () => {
  server = createServer((incoming, outgoing) => {
    void (async () => {
      const headers = new Headers();

      for (const [name, values] of Object.entries(incoming.headersDistinct)) {
        for (const value of values ?? []) headers.append(name, value);
      }

      const request = new NextRequest(url, {
        method: incoming.method,
        headers,
        body: new Uint8Array(await buffer(incoming)),
      });

      const gate = await middleware(request);

      const response =
        gate.headers.get('x-middleware-next') === '1'
          ? await POST(request)
          : gate;

      outgoing.writeHead(response.status).end(await response.text());
    })().catch(() => outgoing.destroy());
  });
  url = `${await listenForFetch(server)}${path}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
});

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://relay-test.invalid');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-role-key');
  vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
  vi.stubEnv('WHATSAPP_COEXISTENCE_APP_ID', app);
  vi.stubEnv('WHATSAPP_COEXISTENCE_APP_SECRET', secret);
  vi.stubEnv('WHATSAPP_COEXISTENCE_PARTNER_BUSINESS_ID', partner);
  vi.stubEnv('WHATSAPP_COEXISTENCE_RELAY_WABA_ID', waba);
  vi.stubEnv('WHATSAPP_COEXISTENCE_RELAY_PHONE_ID', phone);
  vi.stubEnv('META_APP_SECRET', legacy);
  rpc.mockReset().mockImplementation(async () => Response.json(receipt));
  vi.stubGlobal('fetch', (...args: Parameters<typeof fetch>) => {
    expect(String(args[0])).toBe(rpcUrl);

    return rpc(...args);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('ACKs the original history bytes without a user cookie, only after receiving a commit receipt', async () => {
  const rpcStarted = Promise.withResolvers<void>();
  const commit = Promise.withResolvers<Response>();
  rpc.mockImplementationOnce(() => {
    rpcStarted.resolve();

    return commit.promise;
  });
  const ack = vi.fn();

  const pending = send(original).then(async (response) => {
    ack();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"status":"captured"}');
  });

  await Promise.race([rpcStarted.promise, pending]);
  expect(ack).not.toHaveBeenCalled();
  commit.resolve(Response.json(receipt));
  await pending;
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(rpc.mock.calls[0][1]?.body))).toEqual({
    p_app_id: app,
    p_partner_business_id: partner,
    p_enabled: true,
    p_authorized: true,
    p_changes: [
      {
        entry_id: waba,
        ...history,
        dedupe_key: `${createHash('sha256').update(original).digest('hex')}:0:0`,
      },
    ],
  });
});

it.each([
  ['messages', { messages: [{ id: 'wamid.live' }] }],
  ['smb_message_echoes', { message_echoes: [{ id: 'wamid.echo' }] }],
  ['smb_app_state_sync', { state_sync: [{ type: 'contact' }] }],
] satisfies [string, JsonValue][])('ACKs scoped %s', async (field, payload) => {
  const body = envelope([
    { field, value: { ...payload, metadata: { phone_number_id: phone } } },
  ]);

  const response = await send(JSON.stringify(body));

  expect(response.status).toBe(200);
  expect(await response.text()).toBe('{"status":"captured"}');
  expect(rpc).toHaveBeenCalledTimes(1);
});

it.each([
  {
    ...envelope(),
    entry: [{ id: waba, time: 1700000000, changes: [history] }],
  },
  envelope([stop]),
  envelope([
    lifecycle({
      event: 'ACCOUNT_RECONNECTED',
      waba_info: { waba_id: null, partner_app_id: null },
    }),
  ]),
  envelope(
    [lifecycle({ event: 'PARTNER_REMOVED', waba_info: { waba_id: waba } })],
    partner
  ),
  envelope(
    [
      lifecycle({
        event: 'PARTNER_APP_UNINSTALLED',
        waba_info: { waba_id: waba, partner_app_id: app },
      }),
    ],
    null
  ),
  ...[app, partner, waba].map((id) =>
    envelope(
      [
        lifecycle({
          event: 'PARTNER_APP_INSTALLED',
          waba_info: { waba_id: waba, partner_app_id: app },
        }),
      ],
      id
    )
  ),
  envelope([
    {
      field: 'history',
      value: {
        messaging_product: 'whatsapp',
        history: [
          {
            errors: [
              {
                code: 2593109,
                title: 'History sharing off',
                message: 'Sharing declined',
                error_data: { details: 'Disabled in WhatsApp' },
              },
            ],
          },
        ],
      },
    },
  ]),
])(
  'ACKs scoped WABA-wide lifecycle or missing-phone history error %#',
  async (body) => {
    expect(await (await send(JSON.stringify(body))).json()).toEqual({
      status: 'captured',
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  }
);

it.each([
  [original, null, 401],
  [original, sign(original, legacy), 401],
  [JSON.stringify(JSON.parse(original)), sign(original), 401],
  ['\uFEFF' + original, sign(original), 401],
  ['\uFEFF' + original, sign('\uFEFF' + original), 400],
  [new Uint8Array([0xc0, 0x80]), sign(new Uint8Array([0xc0, 0x80])), 400],
])(
  'rejects unauthorized, re-encoded or corrupt bytes %# without RPC',
  async (body, signature, status) => {
    expect((await send(body, signature)).status).toBe(status);
    expect(rpc).not.toHaveBeenCalled();
  }
);

it.each([
  envelope([], waba),
  ...[null, '1700000000', 1.5, Number.MAX_SAFE_INTEGER + 1].map((time) => ({
    ...envelope(),
    entry: [{ id: waba, time, changes: [history] }],
  })),
  envelope(
    [
      lifecycle({
        event: 'PARTNER_APP_INSTALLED',
        waba_info: { waba_id: waba, partner_app_id: app },
      }),
    ],
    '990009'
  ),
  ...Array.of<JsonValue>(
    { code: 2593109, contacts: [{ wa_id: '15555550123' }] },
    {
      code: 2593109,
      error_data: { details: 'Disabled', messages: [{ id: 'wamid.private' }] },
    },
    { code: 2593109, message: { text: { body: 'private chat' } } }
  ).map((error) =>
    envelope([{ field: 'history', value: { history: [{ errors: [error] }] } }])
  ),
  envelope([history], `0${waba}`),
  envelope([history], Number(waba)),
  envelope([history], '990007'),
  envelope([
    stop,
    {
      ...history,
      value: { ...history.value, metadata: { phone_number_id: '990008' } },
    },
  ]),
  envelope([
    stop,
    {
      ...history,
      value: { ...history.value, metadata: { phone_number_id: Number(phone) } },
    },
  ]),
  envelope([
    stop,
    {
      ...history,
      value: { ...history.value, statuses: [{ id: 'unexpected' }] },
    },
  ]),
  envelope([stop, { field: 'message_template_status_update', value: {} }]),
  envelope([stop, null]),
  envelope([{ field: 'history', value: { history: history.value.history } }]),
  envelope([
    {
      field: 'history',
      value: { ...history.value, metadata: { display_phone_number: phone } },
    },
  ]),
  envelope([
    lifecycle({
      event: 'ACCOUNT_OFFBOARDED',
      waba_info: { waba_id: '990007' },
    }),
  ]),
  envelope([
    lifecycle({
      event: 'ACCOUNT_OFFBOARDED',
      waba_info: { waba_id: Number(waba) },
    }),
  ]),
  envelope([lifecycle({ event: 'ACCOUNT_OFFBOARDED', waba_info: [] })]),
  envelope([
    lifecycle({
      event: 'ACCOUNT_OFFBOARDED',
      metadata: { phone_number_id: '990008' },
    }),
  ]),
  envelope([
    lifecycle({ event: 'PARTNER_REMOVED', waba_info: { waba_id: waba } }),
  ]),
  envelope(
    [
      lifecycle({
        event: 'PARTNER_APP_UNINSTALLED',
        waba_info: { waba_id: waba, partner_app_id: '990005' },
      }),
    ],
    null
  ),
  envelope([lifecycle({ event: 'UNSUPPORTED' })]),
])(
  'rejects an invalid envelope or any unexpected sibling %# without RPC',
  async (body) => {
    expect((await send(JSON.stringify(body))).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  }
);

it.each([
  ['WHATSAPP_COEXISTENCE_ENABLED', 'false'],
  ['WHATSAPP_COEXISTENCE_RELAY_WABA_ID', undefined],
  ['WHATSAPP_COEXISTENCE_RELAY_PHONE_ID', ` ${phone}`],
  ['WHATSAPP_COEXISTENCE_PARTNER_BUSINESS_ID', '0'],
  ['WHATSAPP_COEXISTENCE_APP_ID', undefined],
  ['WHATSAPP_COEXISTENCE_APP_SECRET', undefined],
  ['META_APP_SECRET', `${legacy},${secret}`],
])('fails closed without RPC when %s is misconfigured', async (key, value) => {
  vi.stubEnv(key, value);
  expect((await send(original)).status).toBe(503);
  expect(rpc).not.toHaveBeenCalled();
});

it('rejects oversized bodies before RPC', async () => {
  expect((await send(' '.repeat(MAX_WEBHOOK_BODY_BYTES + 1))).status).toBe(413);
  expect(rpc).not.toHaveBeenCalled();
});

it.each([
  [{ ...receipt, legacy_indices: [0] }, 200, 503],
  [{ ...receipt, status: 403 }, 200, 403],
  [{ ...receipt, staged: '1' }, 200, 503],
  [receipt, 201, 503],
  [{ message: 'database error with private details' }, 500, 503],
])(
  'does not ACK non-success, legacy or malformed receipts %#',
  async (body, transport, status) => {
    rpc.mockResolvedValueOnce(Response.json(body, { status: transport }));
    const response = await send(original);
    expect(response.status).toBe(status);
    expect(await response.text()).not.toMatch(/captured|private details/);
    expect(rpc).toHaveBeenCalledTimes(1);
  }
);

it('does not ACK when a committed RPC loses its response; original retry can ACK a dedup receipt', async () => {
  rpc.mockRejectedValueOnce(
    new Error('lost commit response with private details')
  );
  const failed = await send(original);
  expect(failed.status).toBe(503);
  expect(await failed.text()).toBe(
    '{"error":"Coexistence ingress unavailable"}'
  );
  expect(rpc).toHaveBeenCalledTimes(1);
  rpc.mockResolvedValueOnce(Response.json(dedup));
  expect(await (await send(original)).json()).toEqual({ status: 'captured' });
  expect(rpc).toHaveBeenCalledTimes(2);
  expect(rpc.mock.calls[1][1]?.body).toBe(rpc.mock.calls[0][1]?.body);
});
