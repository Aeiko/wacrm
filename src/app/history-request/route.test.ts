import 'next/dist/server/node-environment-baseline';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequestStoreForAPI } from 'next/dist/server/async-storage/request-store';
import { createWorkStore } from 'next/dist/server/async-storage/work-store';
import { workAsyncStorage } from 'next/dist/server/app-render/work-async-storage.external';
import { workUnitAsyncStorage } from 'next/dist/server/app-render/work-unit-async-storage.external';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { z } from 'zod';
import { listenForFetch } from '@/test/http-server';
import type { CoexistenceFetch } from '@/lib/whatsapp/coexistence-meta';
import { historyRequestHandlers } from '@/lib/whatsapp/coexistence/history-request-handler';
import * as permit from '@/lib/whatsapp/coexistence/history-permit-client';
import { encrypt } from '@/lib/whatsapp/encryption';
import {
  GET as readPermissions,
  POST as writePermissions,
} from '@/app/history-permissions/route';

const origin = 'https://crm.example';
const path = '/history-request';

const work = createWorkStore({
  page: `${path}/route`,
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

const phone = '987654321';
const context = 'a'.repeat(64);
const graphToken = 'fixture-graph-credential';
const ownerPath = '/rest/v1/rpc/coexistence_owner_history';
const finishPath = '/rest/v1/rpc/coexistence_history_request_finish';
const accessKey = 'fixture-anon-key';
const serviceKey = 'fixture-service-key';

function fixtureToken(actor: string, session: string) {
  const jwt = [
    { alg: 'HS256', typ: 'JWT' },
    {
      sub: actor,
      session_id: session,
      exp: Math.floor(Date.now() / 1000) + 600,
    },
  ]
    .map((obj) => Buffer.from(JSON.stringify(obj)).toString('base64url'))
    .join('.');

  return `${jwt}.${createHmac('sha256', 'fixture-secret').update(jwt).digest('base64url')}`;
}

const rpcArgsSchema = z.record(
  z.string(),
  z.union([z.string(), z.boolean(), z.null()])
);

type FixtureJson = Record<
  string,
  string | boolean | null | Record<string, string>
>;

interface RpcFixture {
  status: FixtureJson;
  start: FixtureJson;
  failStart?: number;
  failFinish?: boolean;
  loseStartAck?: boolean;
  rejectAuth?: boolean;
  dropGraph?: boolean;
}

let cleanup: () => Promise<void>;

async function fixture() {
  const actor = randomUUID();
  const session = randomUUID();
  const decisionId = randomUUID();
  const requestId = randomUUID();
  const deadline = new Date(Date.now() + 60_000).toISOString();
  const jwt = fixtureToken(actor, session);
  const user = { id: actor, aud: 'authenticated', role: 'authenticated' };
  const cookie = `sb-127-auth-token=base64-${Buffer.from(JSON.stringify({ access_token: jwt, refresh_token: 'fixture-refresh', expires_at: Math.floor(Date.now() / 1000) + 600, user })).toString('base64url')}`;

  const ready = {
    state: 'ready',
    review: {
      context,
      decision_id: decisionId,
      request_id: requestId,
      phone_id_suffix: '4321',
      deadline_at: deadline,
    },
  };

  const start = {
    dispatch: true,
    request_id: requestId,
    phone_number_id: phone,
    deadline_at: deadline,
    encrypted_token: encrypt(graphToken),
  };

  const wire: { path?: string; payload: unknown }[] = [];

  const state: RpcFixture = { status: ready, start };

  const server = createServer(async (req, res) => {
    const chunks = [];

    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    const payload = text ? rpcArgsSchema.parse(JSON.parse(text)) : undefined;
    wire.push({ path: req.url, payload });

    const json = (data: FixtureJson | boolean, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    if (
      req.url === '/auth/v1/user' &&
      req.method === 'GET' &&
      req.headers.apikey === accessKey &&
      req.headers.authorization === `Bearer ${jwt}` &&
      !state.rejectAuth
    )
      return json(user);

    if (
      req.method !== 'POST' ||
      req.headers.apikey !== serviceKey ||
      req.headers.authorization !== `Bearer ${serviceKey}`
    )
      return json({ message: 'fixture-auth-denied' }, 401);

    if (req.url === ownerPath && payload?.p_action === 'permissions')
      return json({ status: 'ok', connection: null });

    if (req.url === ownerPath && payload?.p_action === 'consent') {
      const id = z.uuid().parse(payload.p_request_id);

      return json({
        status: 'recorded',
        request_id: id,
        contacts: false,
        history: payload.p_history === true,
        expires_at: deadline,
        dispatch_authorized: false,
      });
    }

    if (req.url === ownerPath && payload?.p_action === 'inspect')
      return json(state.status);

    if (req.url === ownerPath && payload?.p_action === 'start') {
      if (state.failStart === 307) {
        res.writeHead(307, { Location: ownerPath });
        res.end();

        return;
      }

      if (state.failStart)
        return json({ message: graphToken }, state.failStart);
      const receipt = state.start;
      state.start = { dispatch: false };

      if (receipt.dispatch === true) state.status = { state: 'started' };

      if (state.loseStartAck) return req.socket.destroy();

      return json(receipt);
    }

    if (req.url === finishPath) {
      if (state.failFinish) return json(false);

      state.status = { state: z.string().parse(payload?.p_outcome) };

      return json(true);
    }

    return json({ message: 'unexpected fixture route' }, 500);
  });

  const local = await listenForFetch(server);
  cleanup = () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  const nativeFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const target = new URL(input instanceof Request ? input.url : input);

    if (target.origin !== local) throw new Error('Unexpected egress');

    return nativeFetch(input, init);
  });
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', local);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', accessKey);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', serviceKey);

  let available = false;

  const consume = vi
    .spyOn(permit, 'consumeDispatchPermit')
    .mockImplementation(async (candidatePhone, candidateRequest) => {
      if (
        !available ||
        candidatePhone !== phone ||
        candidateRequest !== requestId
      )
        return false;

      available = false;

      return true;
    });

  onTestFinished(() => {
    consume.mockRestore();
  });

  function addPermit() {
    available = true;
  }

  const graph = vi.fn<CoexistenceFetch>(async () => {
    if (state.dropGraph) throw new Error(graphToken);

    return Response.json({
      messaging_product: 'whatsapp',
      request_id: 'provider-private-id',
    });
  });

  const handlers = historyRequestHandlers(graph);

  const form = new URLSearchParams({
    context,
    decision_id: decisionId,
    request_id: requestId,
    confirmation: 'history-now-v1',
  }).toString();

  function request(
    method: 'GET' | 'POST',
    options: {
      body?: string | ReadableStream;
      headers?: HeadersInit;
      search?: string;
      permissions?: boolean;
      signal?: AbortSignal;
    } = {}
  ) {
    const headers = new Headers({ cookie, 'x-real-ip': actor });

    if (method === 'POST') {
      headers.set('Origin', origin);
      headers.set('Content-Type', 'application/x-www-form-urlencoded');
    }

    for (const [name, value] of new Headers(options.headers))
      headers.set(name, value);

    const req = new NextRequest(
      `http://localhost:3000${options.permissions ? '/history-permissions' : path}${options.search ?? ''}`,
      {
        method,
        headers,
        duplex: 'half',
        signal: options.signal,
        body: method === 'POST' ? (options.body ?? form) : undefined,
      }
    );

    const store = createRequestStoreForAPI(
      req,
      req.nextUrl,
      { tags: [], expirationsByCacheKind: new Map() },
      undefined,
      undefined,
      undefined
    );

    return workAsyncStorage.run(work, () =>
      workUnitAsyncStorage.run(store, () => {
        if (!options.permissions) return handlers[method](req);

        return method === 'GET' ? readPermissions(req) : writePermissions(req);
      })
    );
  }

  return {
    request,
    state,
    wire,
    graph,
    addPermit,
    form,
    start,
    ready,
    actor,
    session,
    decisionId,
    requestId,
  };
}

beforeEach(() => {
  vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
  vi.stubEnv('WHATSAPP_COEXISTENCE_HISTORY_REQUEST_ENABLED', 'true');
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', origin);
  vi.stubEnv('WHATSAPP_COEXISTENCE_RELAY_PHONE_ID', '999999');
  cleanup = async () => {};
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await cleanup();
});

it.each([
  ['WHATSAPP_COEXISTENCE_HISTORY_REQUEST_ENABLED', 'false'],
  ['WHATSAPP_COEXISTENCE_ENABLED', 'TRUE'],
])(
  'returns no-store 404 before auth/RPC with invalid %s=%s',
  async (key, value) => {
    const { request, graph, wire } = await fixture();
    vi.stubEnv(key, value);

    for (const method of ['GET', 'POST'] as const) {
      const response = await request(method);
      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
    }

    expect(wire).toEqual([]);
    expect(graph).not.toHaveBeenCalled();
  }
);

it('records owner history-only consent without granting review or dispatch', async () => {
  const { request, actor, session, requestId, graph, wire, state } =
    await fixture();

  state.status = { state: 'unavailable' };

  const command = {
    context,
    request_id: requestId,
    previous_request_id: null,
    version: 'projection-v1',
    history: true,
    contacts: false,
  };

  const post = (
    body: typeof command & { phone_number_id?: string },
    cookie?: string
  ) =>
    request('POST', {
      permissions: true,
      body: JSON.stringify(body),
      headers: {
        'content-type': 'application/json',
        ...(cookie !== undefined && { cookie }),
      },
    });

  expect((await post(command, '')).status).toBe(401);
  expect((await post({ ...command, contacts: true })).status).toBe(400);
  expect((await post({ ...command, phone_number_id: phone })).status).toBe(400);
  expect(wire.filter(({ path }) => path === ownerPath)).toEqual([]);
  const recorded = await post(command);
  expect(recorded.status).toBe(200);
  expect(await recorded.json()).toMatchObject({
    history: true,
    contacts: false,
    dispatch_authorized: false,
  });
  expect(wire.filter(({ path }) => path === ownerPath)).toEqual([
    {
      path: ownerPath,
      payload: {
        p_action: 'consent',
        p_actor_id: actor,
        p_session_id: session,
        p_context: context,
        p_request_id: requestId,
        p_decision_id: null,
        p_history: true,
      },
    },
  ]);
  expect(await (await request('GET')).json()).toEqual({ state: 'unavailable' });
  expect(graph).not.toHaveBeenCalled();
});

it('inspects only via the verified cookie identity and server-resolved scope', async () => {
  const { request, graph, wire, ready, actor, session } = await fixture();
  const response = await request('GET');
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(ready);
  expect(wire.filter(({ path }) => path?.startsWith('/rest/'))).toEqual([
    {
      path: ownerPath,
      payload: {
        p_actor_id: actor,
        p_session_id: session,
        p_action: 'inspect',
      },
    },
  ]);
  expect(graph).not.toHaveBeenCalled();
});

it('rejects overrides, foreign origins, non-native forms, malformed fields and oversized streaming bodies before RPC', async () => {
  const { form, wire, request, graph, state } = await fixture();
  expect(
    (
      await request('POST', {
        headers: {
          Origin: 'https://foreign.example',
          'X-Forwarded-Host': 'foreign.example',
        },
      })
    ).status
  ).toBe(403);
  expect(
    (await request('POST', { headers: { 'Sec-Fetch-Site': 'same-site' } }))
      .status
  ).toBe(403);
  expect(
    (await request('POST', { headers: { 'Content-Type': 'application/json' } }))
      .status
  ).toBe(400);

  for (const body of [
    `${form}&confirmation=history-now-v1`,
    `${form}&token=private`,
    form.replace('history-now-v1', '%C0%AF'),
    form.replace('history-now-v1', 'other'),
  ]) {
    expect((await request('POST', { body })).status).toBe(400);
  }

  expect(
    (
      await request('POST', {
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(1025));
            controller.close();
          },
        }),
      })
    ).status
  ).toBe(413);
  expect((await request('GET', { search: '?actor_id=another' })).status).toBe(
    400
  );
  expect(
    (await request('POST', { headers: { Authorization: 'Bearer override' } }))
      .status
  ).toBe(401);
  expect(wire).toEqual([]);
  state.rejectAuth = true;
  expect((await request('POST')).status).toBe(401);
  expect(wire.map(({ path }) => path)).toEqual(['/auth/v1/user']);
  expect(graph).not.toHaveBeenCalled();
});

it('submits history once from the committed receipt and redirects to sanitized status', async () => {
  const {
    request,
    graph,
    wire,
    addPermit,
    decisionId,
    requestId,
    actor,
    session,
  } = await fixture();

  addPermit();
  const result = await request('POST');
  expect(result.status).toBe(303);
  expect(result.headers.get('location')).toBe(path);
  expect(result.headers.get('cache-control')).toBe('private, no-store');
  expect(await result.text()).toBe('');
  expect(graph).toHaveBeenCalledTimes(1);
  const [[url, setup]] = graph.mock.calls;
  expect(url.href).toMatch(
    new RegExp(
      `^https://graph\\.facebook\\.com/v[0-9.]+/${phone}/smb_app_data$`
    )
  );
  expect(setup.method).toBe('POST');
  expect(new Headers(setup.headers).get('authorization')).toBe(
    `Bearer ${graphToken}`
  );
  expect(setup.body).toBe(
    '{"messaging_product":"whatsapp","sync_type":"history"}'
  );
  expect(wire.filter(({ path }) => path?.startsWith('/rest/'))).toEqual([
    {
      path: ownerPath,
      payload: {
        p_actor_id: actor,
        p_session_id: session,
        p_action: 'start',
        p_context: context,
        p_decision_id: decisionId,
        p_request_id: requestId,
      },
    },
    {
      path: finishPath,
      payload: { p_request_id: requestId, p_outcome: 'accepted' },
    },
  ]);
  const inspection = await request('GET');
  expect(await inspection.json()).toEqual({ state: 'accepted' });
  expect((await request('POST')).status).toBe(409);
  expect(graph).toHaveBeenCalledTimes(1);
});

it.each([503, 307, 421])(
  'never retries or dispatches when the start ACK is HTTP %s',
  async (httpStatus) => {
    const { request, wire, graph, addPermit, state } = await fixture();
    addPermit();
    state.failStart = httpStatus;
    const result = await request('POST');
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ state: 'unavailable' });
    expect(
      wire
        .filter(({ path }) => path?.startsWith('/rest/'))
        .map(({ path }) => path)
    ).toEqual([ownerPath]);
    expect(graph).not.toHaveBeenCalled();
  }
);

it.each(['invalid phone', 'wrong request', 'extra field'] as const)(
  'does not dispatch or settle a start receipt with %s',
  async (variant) => {
    const { request, state, start, graph, addPermit, wire } = await fixture();
    addPermit();
    state.start =
      variant === 'invalid phone'
        ? { ...start, phone_number_id: '01111' }
        : variant === 'wrong request'
          ? { ...start, request_id: randomUUID() }
          : { ...start, account_id: randomUUID() };
    expect((await request('POST')).status).toBe(503);
    expect(graph).not.toHaveBeenCalled();
    expect(
      wire
        .filter(({ path }) => path?.startsWith('/rest/'))
        .map(({ path }) => path)
    ).toEqual([ownerPath]);
    expect(await (await request('GET')).json()).toEqual({ state: 'started' });
  }
);

it.each(['expired', 'no permit', 'invalid ciphertext'] as const)(
  'settles a matched but unsendable %s start as not_sent',
  async (variant) => {
    const { request, state, start, graph, addPermit, requestId, wire } =
      await fixture();

    if (variant !== 'no permit') addPermit();

    if (variant === 'expired')
      state.start = { ...start, deadline_at: '2020-01-01T00:00:00Z' };

    if (variant === 'invalid ciphertext')
      state.start = { ...start, encrypted_token: graphToken };
    expect((await request('POST')).status).toBe(303);
    expect(graph).not.toHaveBeenCalled();
    expect(wire.filter(({ path }) => path === finishPath)).toEqual([
      {
        path: finishPath,
        payload: { p_request_id: requestId, p_outcome: 'not_sent' },
      },
    ]);
    expect(await (await request('GET')).json()).toEqual({ state: 'not_sent' });
  }
);

it.each([false, true])(
  'holds an ambiguous send when finish ack is absent: %s',
  async (failFinish) => {
    const { request, state, graph, addPermit, wire, requestId } =
      await fixture();

    addPermit();
    state.dropGraph = true;
    state.failFinish = failFinish;
    const result = await request('POST');
    expect(result.status).toBe(303);
    expect(result.headers.get('location')).toBe(path);
    expect(await result.text()).toBe('');
    expect(await (await request('GET')).json()).toEqual({
      state: failFinish ? 'started' : 'ambiguous',
    });
    expect(wire.filter(({ path }) => path === finishPath)).toEqual([
      {
        path: finishPath,
        payload: { p_request_id: requestId, p_outcome: 'ambiguous' },
      },
    ]);
    expect(graph).toHaveBeenCalledTimes(1);
  }
);

it('does not dispatch when SQL committed a start but its ACK was lost', async () => {
  const { request, state, wire, graph, addPermit } = await fixture();
  addPermit();
  state.loseStartAck = true;
  expect((await request('POST')).status).toBe(503);
  expect(await (await request('GET')).json()).toEqual({ state: 'started' });
  expect(
    wire.filter(
      ({ path, payload }) =>
        path === ownerPath && rpcArgsSchema.parse(payload).p_action === 'start'
    )
  ).toHaveLength(1);
  expect(wire.some(({ path }) => path === finishPath)).toBe(false);
  expect(graph).not.toHaveBeenCalled();
});

it('rejects a non-sanitized SQL status rather than returning it', async () => {
  const { request, state } = await fixture();
  state.status = { state: 'accepted', access_token: graphToken };
  const result = await request('GET');
  expect(result.status).toBe(503);
  expect(await result.json()).toEqual({ state: 'unavailable' });
});

it('rate limits submission separately from inspect without more start calls', async () => {
  const { request, state, wire, graph } = await fixture();
  state.start = { dispatch: false };

  for (let index = 0; index < 5; index++)
    expect((await request('POST')).status).toBe(409);
  expect((await request('POST')).status).toBe(429);
  expect((await request('GET')).status).toBe(200);
  expect(
    wire.filter(
      ({ path, payload }) =>
        path === ownerPath && rpcArgsSchema.parse(payload).p_action === 'start'
    )
  ).toHaveLength(5);
  expect(graph).not.toHaveBeenCalled();
});
