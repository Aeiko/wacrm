import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { buffer } from 'node:stream/consumers';
import { listenForFetch, isFetchPort } from '@/test/http-server';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';

const signatureHeader = 'x-hub-signature-256';
const webhookPath = '/api/whatsapp/webhook';
const relayPath = '/api/whatsapp/coexistence/relay';
const receiverPath = '/webhooks/whatsapp';
const stopPath = '/api/whatsapp/coexistence/receiver-stop';

const factRow = z.strictObject({
  app_id: z.string(),
  waba_id: z.string(),
  kind: z.enum([
    'ACCOUNT_OFFBOARDED',
    'PARTNER_REMOVED',
    'PARTNER_APP_UNINSTALLED',
  ]),
  partner_id: z.string().nullable(),
  source_sha256: z.string(),
  entry_index: z.number().int(),
  change_index: z.number().int(),
});

const kcRows = z.array(
  z.union([factRow, z.strictObject({ confirmed: z.boolean() })])
);

type VetoFact = z.infer<typeof factRow>;

type ObserveVeto = (fact: VetoFact) => Promise<void>;

type ObservePretarget = (facts: readonly VetoFact[]) => Promise<void>;

type Quarantine = {
  admit: (bytes: Buffer, signature: string, appId: string) => Promise<void>;
  pending: (bytes: Buffer) => Promise<boolean>;
};

const servers: Server[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        })
    )
  );
}, 5_000);

async function serve(
  path: string,
  handle: (request: IncomingMessage) => Promise<Response | null>
): Promise<string> {
  const server = createServer((request, reply) => {
    if (request.method !== 'POST' || request.url !== path) {
      reply.writeHead(404).end();

      return;
    }

    void (async () => {
      const response = await handle(request);

      if (!response) {
        // Simulate losing the downstream response after the route committed.
        reply.destroy();

        return;
      }

      const body = Buffer.from(await response.arrayBuffer());
      reply
        .writeHead(response.status, {
          'Content-Type':
            response.headers.get('content-type') ?? 'application/octet-stream',
        })
        .end(body);
    })().catch(() => reply.destroy());
  });

  servers.push(server);

  return (await listenForFetch(server)) + path;
}

async function startKcReceiver(
  path: string,
  secret: string,
  relayFetch: typeof fetch,
  oldSink: Buffer[],
  hold?: {
    key: string;
    quarantine: Quarantine;
    observe?: ObserveVeto;
    pretarget?: ObservePretarget;
  }
): Promise<string> {
  type KcConfig = { readonly appSecret: string };

  // Load only the immutable source exported by the Python launcher; never run KC's runtime.
  const {
    createWebhookServer,
    webhookConfig,
  }: {
    webhookConfig: (env: Record<string, string>) => KcConfig;
    createWebhookServer: (
      config: KcConfig,
      sink: {
        save: (bytes: Buffer) => Promise<void>;
        ready: () => Promise<void>;
      },
      relayFetch: typeof fetch,
      quarantine?: Quarantine,
      observe?: ObserveVeto,
      pretarget?: ObservePretarget
    ) => Server;
  } = createRequire(import.meta.url)(path);

  const server = createWebhookServer(
    webhookConfig({
      META_APP_SECRET: secret,
      WHATSAPP_WEBHOOK_VERIFY_TOKEN: randomBytes(16).toString('hex'),
      WHATSAPP_WABA_ID: '880011',
      WHATSAPP_PHONE_NUMBER_ID: '880012',
      WHATSAPP_TEST_SENDER: '12025550101',
      KC_WHATSAPP_WEBHOOK_MODE: 'owner-test-only',
      KC_WHATSAPP_PILOT_PARTNER_BUSINESS_ID: '880006',
      ...(hold?.pretarget
        ? { KC_WHATSAPP_PRETARGET_STOPS: '1' }
        : {
            KC_WHATSAPP_PILOT_RELAY: 'verified-disjoint',
            KC_WHATSAPP_PILOT_WABA_ID: '880007',
            KC_WHATSAPP_PILOT_PHONE_NUMBER_ID: '880008',
            KC_WHATSAPP_PILOT_APP_ID: '880005',
            ...(hold && { KC_WHATSAPP_PILOT_STOP_KEY: hold.key }),
          }),
      ...(hold && {
        KC_WHATSAPP_PRIVATE_HOLD: 'on',
        KC_WHATSAPP_PRIVATE_HOLD_APP_ID: '880005',
      }),
    }),
    {
      save: async (bytes) => {
        oldSink.push(bytes);
      },
      ready: async () => {},
    },
    relayFetch,
    hold?.quarantine,
    hold?.observe,
    hold?.pretarget
  );

  servers.push(server);

  return (await listenForFetch(server)) + receiverPath;
}

const heldStop = process.env.WACRM_REHEARSAL_HELD_STOP === '1';
const vetoWorker = process.env.WACRM_REHEARSAL_KC_VETO_WORKER;
const pretarget = process.env.WACRM_REHEARSAL_PRETARGET === '1';

function vetoRedrive(
  worker: string,
  handler: string,
  origin: string,
  serviceKey: string,
  stopKey: string,
  transport: typeof fetch,
  allowed: Set<string>
) {
  type SqlTag = (
    parts: TemplateStringsArray,
    ...values: (string | number | null)[]
  ) => Promise<z.infer<typeof kcRows>>;

  type Store = {
    observe: ObserveVeto;
    pending: () => Promise<VetoFact | undefined>;
  };

  const pins = {
    appId: '880005',
    wabaId: '880007',
    phoneId: '880008',
    partnerId: '880006',
  };

  const load = createRequire(import.meta.url);

  const {
    postgresReceiverVeto,
    postgresPretargetStops,
    createReceiverVetoTick,
  }: {
    postgresReceiverVeto: (sql: SqlTag, scope: typeof pins) => Store;
    postgresPretargetStops: (
      sql: SqlTag,
      appId: string,
      partnerId: string
    ) => {
      observe: ObservePretarget;
      bind: (scope: typeof pins) => Promise<void>;
    };
    createReceiverVetoTick: (
      store: Store,
      send: (fact: VetoFact) => Promise<'blocked'>
    ) => () => Promise<void>;
  } = load(worker);

  const {
    sendReceiverStop,
  }: {
    sendReceiverStop: (
      fact: VetoFact,
      scope: typeof pins,
      key: string,
      fetch: typeof globalThis.fetch
    ) => Promise<'blocked'>;
  } = load(handler);

  const endpoints = new Map([
    [
      'SELECT kc_receiver_veto.admit(?, ?, ?, ?, ?, ?, ?, ?, ?)',
      `${origin}/kc003/admit`,
    ],
    [
      'SELECT * FROM kc_receiver_veto.pending(?, ?, ?, ?)',
      `${origin}/kc003/pending`,
    ],
    [
      'SELECT kc_receiver_veto.ack(?, ?, ?, ?, ?, ?, ?, ?) AS confirmed',
      `${origin}/kc003/ack`,
    ],
  ]);

  if (pretarget) {
    endpoints.set(
      'SELECT kc_receiver_veto.remember(?, ?, ?::text::jsonb)',
      `${origin}/kc004/remember`
    );
    endpoints.set(
      'SELECT kc_receiver_veto.bind(?, ?, ?, ?)',
      `${origin}/kc004/bind`
    );
  }

  for (const url of endpoints.values()) allowed.add(url);

  const sql: SqlTag = async (parts, ...values) => {
    const url = endpoints.get(parts.join('?'));

    if (!url) throw new Error('Unexpected KC veto SQL template');

    const response = await fetch(url, {
      method: 'POST',
      headers: { apikey: serviceKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) throw new Error('KC veto operation unavailable');

    return kcRows.parse(await response.json());
  };

  const newStore = () => postgresReceiverVeto(sql, pins);
  const store = newStore();

  const newTick = (scope = pins) => {
    const tick = createReceiverVetoTick(
      postgresReceiverVeto(sql, scope),
      (fact) => sendReceiverStop(fact, scope, stopKey, transport)
    );

    if (!pretarget) return tick;

    const binder = postgresPretargetStops(sql, scope.appId, scope.partnerId);

    return async () => {
      await binder.bind(scope);
      await tick();
    };
  };

  return {
    store,
    newTick,
    observePretarget: pretarget
      ? postgresPretargetStops(sql, '880005', '880006').observe
      : undefined,
    verifyUnrelatedPins: async () => {
      for (const mismatch of [
        { wabaId: '880098', phoneId: '880099' },
        { appId: '880015' },
        { partnerId: '880016' },
      ]) {
        await newTick({ ...pins, ...mismatch })();
      }
    },
  };
}

async function rehearseHeldStop(
  kcHandler: string,
  secret: string,
  sign: (body: Uint8Array) => string,
  post: (
    url: string,
    body: Uint8Array<ArrayBuffer>,
    signed: string,
    timeoutMs: number
  ) => Promise<Response>,
  allowed: Set<string>,
  origin: string,
  serviceKey: string
) {
  const legacy = new Uint8Array(
    readFileSync('supabase/ci/fixtures/receiver-legacy-owner-test.json')
  );

  const oldEnvelope = JSON.parse(new TextDecoder().decode(legacy));

  const stopEntry = {
    id: '880007',
    changes: [
      {
        field: 'account_update',
        value: {
          event: 'ACCOUNT_OFFBOARDED',
          metadata: { phone_number_id: '880099' },
        },
      },
    ],
  };

  const mixed = new TextEncoder().encode(
    JSON.stringify({
      ...oldEnvelope,
      entry: pretarget
        ? [
            {
              id: '880097',
              changes: [
                {
                  field: 'account_update',
                  value: { event: 'ACCOUNT_OFFBOARDED' },
                },
              ],
            },
            stopEntry,
            ...oldEnvelope.entry,
          ]
        : [...oldEnvelope.entry, stopEntry],
    })
  );

  const signature = sign(mixed);
  const sourceHash = createHash('sha256').update(mixed).digest('hex');
  const stopKey = randomBytes(32).toString('hex');
  vi.stubEnv('WHATSAPP_COEXISTENCE_RECEIVER_STOP_KEY', stopKey);

  const { POST } =
    await import('@/app/api/whatsapp/coexistence/receiver-stop/route');

  const deliveries: {
    url: unknown;
    headers: Headers;
    body: unknown;
    redirect: unknown;
    credentials: unknown;
  }[] = [];

  const acks: { status: number; body: unknown }[] = [];
  const oldSink: Buffer[] = [];
  const admits: { app: string; bytes: Buffer; signature: string }[] = [];
  const pending = new Set<string>();
  let mode: 'unavailable' | 'lose-ack' | 'ready' = 'unavailable';

  const stopUrl = await serve(stopPath, async (request) => {
    if (mode === 'unavailable') return new Response(null, { status: 503 });

    const headers = new Headers();

    for (const [name, values] of Object.entries(request.headersDistinct)) {
      for (const value of values ?? []) headers.append(name, value);
    }

    const response = await POST(
      new Request(stopUrl, {
        method: 'POST',
        headers,
        body: new Uint8Array(await buffer(request)),
      })
    );

    acks.push({ status: response.status, body: await response.clone().json() });

    return mode === 'lose-ack' && response.ok ? null : response;
  });

  allowed.add(stopUrl);

  const transport: typeof fetch = async (url, init) => {
    deliveries.push({
      url,
      headers: new Headers(init?.headers),
      body: init?.body,
      redirect: init?.redirect,
      credentials: init?.credentials,
    });

    // No Internet requests, including on a regression into the whole-envelope relay.
    if (
      url !== `https://kc-crm.sqkii.com${stopPath}` ||
      init?.method !== 'POST'
    )
      throw new Error('Unexpected KC destination');

    return fetch(stopUrl, init);
  };

  const redrive =
    vetoWorker &&
    vetoRedrive(
      vetoWorker,
      kcHandler,
      origin,
      serviceKey,
      stopKey,
      transport,
      allowed
    );

  const receiverUrl = await startKcReceiver(
    kcHandler,
    secret,
    transport,
    oldSink,
    {
      key: stopKey,
      observe: redrive && !pretarget ? redrive.store.observe : undefined,
      pretarget: redrive ? redrive.observePretarget : undefined,
      quarantine: {
        admit: async (bytes, signature, app) => {
          admits.push({ app, bytes: Buffer.from(bytes), signature });
          pending.add(createHash('sha256').update(bytes).digest('hex'));
        },
        pending: async (bytes) =>
          pending.has(createHash('sha256').update(bytes).digest('hex')),
      },
    }
  );

  allowed.add(receiverUrl);

  const send = (body: Uint8Array<ArrayBuffer>, signed = sign(body)) =>
    post(receiverUrl, body, signed, 15_000);

  if (!redrive) expect((await send(mixed, sign(legacy))).status).toBe(403);
  expect(admits).toEqual([]);
  expect(deliveries).toEqual([]);

  if (redrive) {
    if (!pretarget) expect(await redrive.store.pending()).toBeUndefined();
    expect((await send(mixed, signature)).status).toBe(503);
    expect(admits).toHaveLength(1);
    expect(deliveries).toEqual([]);

    if (pretarget) {
      expect(oldSink).toEqual([]);
      const owner = await send(legacy);
      expect(owner.status).toBe(200);
      expect(await owner.text()).toBe('EVENT_RECEIVED');
      expect(oldSink).toEqual([Buffer.from(legacy)]);
      expect(admits).toHaveLength(1);
      await redrive.verifyUnrelatedPins();
      expect(deliveries).toEqual([]);
      expect(await redrive.store.pending()).toBeUndefined();
    } else {
      expect(await redrive.store.pending()).toEqual({
        app_id: '880005',
        waba_id: '880007',
        kind: 'ACCOUNT_OFFBOARDED',
        partner_id: null,
        source_sha256: sourceHash,
        entry_index: 1,
        change_index: 0,
      });
    }
  }

  let tick = redrive ? redrive.newTick() : undefined;

  for (const [index, stage] of (
    ['unavailable', 'lose-ack', 'ready'] as const
  ).entries()) {
    mode = stage;

    if (tick && redrive) {
      if (stage === 'ready') {
        tick = redrive.newTick();
        await tick();
        expect(await redrive.store.pending()).toBeUndefined();
        await redrive.newTick()();
      } else {
        await expect(tick()).rejects.toThrow();
        expect(await redrive.store.pending()).toMatchObject({
          source_sha256: sourceHash,
        });
      }
    } else {
      expect((await send(mixed, signature)).status).toBe(503);
    }

    expect(deliveries).toHaveLength(index + 1);
    expect(acks).toHaveLength(index);
    expect(pending).toEqual(new Set([sourceHash]));
    expect(oldSink).toEqual(pretarget ? [Buffer.from(legacy)] : []);
  }

  if (redrive) expect(admits).toHaveLength(1);
  else expect(admits.length).toBeGreaterThan(0);

  for (const admit of admits)
    expect(admit).toEqual({
      app: '880005',
      bytes: Buffer.from(mixed),
      signature,
    });
  expect(acks).toEqual(
    Array.from({ length: 2 }, () => ({
      status: 200,
      body: { status: 'blocked' },
    }))
  );

  for (const delivery of deliveries) {
    expect(delivery.url).toBe(`https://kc-crm.sqkii.com${stopPath}`);
    expect([...delivery.headers]).toEqual([
      ['authorization', `Bearer ${stopKey}`],
      ['content-type', 'application/json'],
    ]);
    expect(delivery.redirect).toBe('error');
    expect(delivery.credentials).toBe('omit');
    expect(delivery.body).toEqual(expect.any(String));
    expect(JSON.parse(String(delivery.body))).toEqual({
      version: 1,
      app_id: '880005',
      waba_id: '880007',
      phone_number_id: '880008',
      kind: 'ACCOUNT_OFFBOARDED',
      source_sha256: sourceHash,
      entry_index: 1,
      change_index: 0,
    });
  }

  if (!pretarget) {
    const owner = await send(legacy);
    expect(owner.status).toBe(200);
    expect(await owner.text()).toBe('EVENT_RECEIVED');
  }

  expect(oldSink).toEqual([Buffer.from(legacy)]);
  expect(deliveries).toHaveLength(3);

  return sourceHash;
}

it.skipIf(process.env.WACRM_RECEIVER_REHEARSAL !== '1')(
  heldStop
    ? vetoWorker
      ? pretarget
        ? 'remembers pre-pin stops and redrives only the separately bound target'
        : 'redrives one authenticated held stop from durable KC003 across worker restart'
      : 'keeps mixed envelopes held through outage, commit and exact retry'
    : 'preserves the signed delivery and only ACKs after durable Coexistence intake',
  async () => {
    const origin = process.env.WACRM_REHEARSAL_RPC_ORIGIN;
    const serviceKey = process.env.WACRM_REHEARSAL_SERVICE_KEY;

    const port = Number(
      /^http:\/\/127\.0\.0\.1:([1-9]\d{3,4})$/.exec(origin ?? '')?.[1]
    );

    if (
      !origin ||
      origin !== `http://127.0.0.1:${port}` ||
      !isFetchPort(port) ||
      port > 65535 ||
      !serviceKey ||
      !/^receiver-test-[0-9a-f]{64}$/.test(serviceKey)
    ) {
      throw new Error(
        'Rehearsal requires a loopback HTTP RPC origin and a synthetic service key'
      );
    }

    const kcHandler = process.env.WACRM_REHEARSAL_KC_HANDLER;
    const rpcUrl = `${origin}/rest/v1/rpc/${heldStop ? 'coexistence_receiver_stop' : 'coexistence_ingress'}`;
    const secret = randomBytes(16).toString('hex');

    const sign = (body: Uint8Array) =>
      `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

    const original = new Uint8Array(
      readFileSync(
        `supabase/ci/fixtures/${kcHandler ? 'receiver-history-rehearsal' : 'receiver-rehearsal'}.json`
      )
    );

    const fixture = new TextDecoder().decode(original);
    const signature = sign(original);
    const digest = createHash('sha256').update(original).digest('hex');

    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', origin);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', serviceKey);
    vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
    vi.stubEnv('WHATSAPP_COEXISTENCE_APP_ID', '880005');
    vi.stubEnv('WHATSAPP_COEXISTENCE_PARTNER_BUSINESS_ID', '880006');
    vi.stubEnv('WHATSAPP_COEXISTENCE_APP_SECRET', secret);
    vi.stubEnv('WHATSAPP_COEXISTENCE_RELAY_WABA_ID', '880007');
    vi.stubEnv('WHATSAPP_COEXISTENCE_RELAY_PHONE_ID', '880008');
    vi.stubEnv('META_APP_SECRET', randomBytes(32).toString('hex'));
    vi.resetModules();

    const nativeFetch = globalThis.fetch;
    const allowed = new Set([rpcUrl]);
    let unexpectedRequests = 0;
    const rpcCalls: unknown[] = [];
    const rpcResults: unknown[] = [];

    const guardedFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);

      if (request.method !== 'POST' || !allowed.has(request.url)) {
        unexpectedRequests++;
        throw new Error('Unexpected rehearsal HTTP request');
      }

      if (request.url !== rpcUrl)
        return nativeFetch(request, { redirect: 'error' });

      rpcCalls.push(await request.clone().json());

      const response = await nativeFetch(request, {
        redirect: 'error',
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
      });

      rpcResults.push(await response.clone().json());

      return response;
    };

    vi.stubGlobal('fetch', guardedFetch);

    const post = (
      url: string,
      body: Uint8Array<ArrayBuffer>,
      signed: string,
      timeoutMs: number
    ) =>
      fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [signatureHeader]: signed,
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });

    if (heldStop) {
      if (!kcHandler)
        throw new Error('Held-stop rehearsal requires pinned KC source');

      const sourceHash = await rehearseHeldStop(
        kcHandler,
        secret,
        sign,
        post,
        allowed,
        origin,
        serviceKey
      );

      expect(unexpectedRequests).toBe(0);
      expect(rpcCalls).toEqual(
        Array.from({ length: 2 }, () => ({
          p_app_id: '880005',
          p_waba_id: '880007',
          p_phone_number_id: '880008',
          p_kind: 'ACCOUNT_OFFBOARDED',
          p_source_sha256: sourceHash,
          p_entry_index: 1,
          p_change_index: 0,
        }))
      );
      expect(rpcResults).toEqual([
        { status: 'blocked' },
        { status: 'blocked' },
      ]);

      return;
    }

    const { POST } = kcHandler
      ? await import('@/app/api/whatsapp/coexistence/relay/route')
      : await import('@/app/api/whatsapp/webhook/route');

    let downstreamMode: 'lose-ack' | 'ready' | 'unavailable' = 'lose-ack';
    let rewriteInTransit = false;
    let crmDeliveries = 0;
    const crmStatuses: number[] = [];
    const crmAcks: unknown[] = [];

    const crmUrl = await serve(
      kcHandler ? relayPath : webhookPath,
      async (request) => {
        crmDeliveries++;

        if (downstreamMode === 'unavailable')
          return Response.json({ error: 'CRM unavailable' }, { status: 503 });

        const bytes = await buffer(request);
        const signed = request.headers[signatureHeader];

        if (!signed || Array.isArray(signed))
          return new Response(null, { status: 400 });

        const result = await POST(
          new Request(crmUrl, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              [signatureHeader]: signed,
            },
            body: new Uint8Array(bytes),
          })
        );

        crmStatuses.push(result.status);

        if (kcHandler && result.ok) crmAcks.push(await result.clone().json());

        return downstreamMode === 'lose-ack' && result.ok ? null : result;
      }
    );

    allowed.add(crmUrl);

    const oldSink: Buffer[] = [];

    const relayFetch: typeof fetch = async (input, init) => {
      if (
        input !== 'https://kc-crm.sqkii.com/api/whatsapp/coexistence/relay' ||
        init?.method !== 'POST'
      ) {
        unexpectedRequests++;
        throw new Error('Unexpected KC relay destination');
      }

      return guardedFetch(crmUrl, init);
    };

    const receiverUrl = kcHandler
      ? await startKcReceiver(kcHandler, secret, relayFetch, oldSink)
      : await serve(receiverPath, async (request) => {
          const bytes = await buffer(request);
          const signed = request.headers[signatureHeader];

          if (
            !signed ||
            Array.isArray(signed) ||
            !/^sha256=[a-f0-9]{64}$/.test(signed) ||
            !timingSafeEqual(Buffer.from(signed), Buffer.from(sign(bytes)))
          ) {
            return new Response(null, { status: 401 });
          }

          try {
            const forward = rewriteInTransit
              ? new TextEncoder().encode(JSON.stringify(JSON.parse(fixture)))
              : new Uint8Array(bytes);

            return await post(crmUrl, forward, signed, 12_000);
          } catch {
            return new Response(null, { status: 503 });
          }
        });

    allowed.add(receiverUrl);

    const send = (bytes = original, signed = signature) =>
      post(receiverUrl, bytes, signed, 15_000);

    expect((await send()).status).toBe(503);
    expect(crmStatuses).toEqual([200]);

    downstreamMode = 'ready';
    const retry = await send();
    expect(retry.status).toBe(200);

    if (kcHandler) {
      expect(await retry.text()).toBe('EVENT_RECEIVED');
      expect(crmAcks).toEqual([{ status: 'captured' }, { status: 'captured' }]);
    } else {
      expect(await retry.json()).toEqual({ status: 'received' });
    }

    expect(crmStatuses).toEqual([200, 200]);

    const reserialized = new TextEncoder().encode(
      JSON.stringify(JSON.parse(fixture))
    );

    const tampered = new TextEncoder().encode(
      fixture.replace('880009', '880010')
    );

    const alteredSignature =
      signature.slice(0, -1) + (signature.endsWith('0') ? '1' : '0');

    const denied = kcHandler ? 403 : 401;
    expect((await send(reserialized)).status).toBe(denied);
    expect((await send(tampered)).status).toBe(denied);
    expect((await send(original, alteredSignature)).status).toBe(denied);
    expect(crmDeliveries).toBe(2);

    if (kcHandler) {
      const legacyBytes = new Uint8Array(
        readFileSync('supabase/ci/fixtures/receiver-legacy-owner-test.json')
      );

      const legacy = JSON.parse(new TextDecoder().decode(legacyBytes));
      const pilot = JSON.parse(fixture);
      const encoder = new TextEncoder();

      const mixed = encoder.encode(
        JSON.stringify({
          ...pilot,
          entry: [...legacy.entry, ...pilot.entry],
        })
      );

      const unsupported = encoder.encode(
        fixture.replace('"field": "history"', '"field": "unsupported"')
      );

      expect((await send(mixed, sign(mixed))).status).toBe(400);
      expect((await send(unsupported, sign(unsupported))).status).toBe(400);
      expect(oldSink).toEqual([]);

      expect((await send(legacyBytes, sign(legacyBytes))).status).toBe(200);
      expect(oldSink).toEqual([Buffer.from(legacyBytes)]);
      expect(crmDeliveries).toBe(2);

      // The CRM protects the relay even when the KC receiver is bypassed.
      expect(
        (await post(crmUrl, original, alteredSignature, 12_000)).status
      ).toBe(401);
      expect((await post(crmUrl, mixed, sign(mixed), 12_000)).status).toBe(400);
    } else {
      // A relay can authenticate correctly and still invalidate the original signature.
      rewriteInTransit = true;
      expect((await send()).status).toBe(401);
      expect(crmStatuses).toEqual([200, 200, 401]);
      rewriteInTransit = false;

      downstreamMode = 'unavailable';
      const unavailable = await send();
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toEqual({ error: 'CRM unavailable' });
      expect(crmDeliveries).toBe(4);
    }

    expect(unexpectedRequests).toBe(0);
    expect(rpcCalls).toHaveLength(2);

    for (const call of rpcCalls) {
      expect(call).toMatchObject({
        p_app_id: '880005',
        p_partner_business_id: '880006',
        p_enabled: true,
        p_authorized: true,
        p_changes: [
          {
            entry_id: '880007',
            field: kcHandler ? 'history' : 'messages',
            dedupe_key: `${digest}:0:0`,
          },
          {
            entry_id: '880007',
            field: 'account_update',
            dedupe_key: `${digest}:0:1`,
          },
        ],
      });
    }

    expect(rpcResults).toEqual([
      { status: 200, legacy_indices: [], captured: 0, staged: 2 },
      { status: 200, legacy_indices: [], captured: 0, staged: 0 },
    ]);
  },
  90_000
);
