import { parentPort, workerData } from 'node:worker_threads';
import { createServerClient, parseCookieHeader } from '@supabase/ssr';
import type { CoexistenceFetch } from '../coexistence-meta';
import type { ScopeReply, ScopeRequest } from './signup-scope-worker.rehearsal';
import { supervisedSignup } from './supervised-signup';

if (!parentPort || (workerData !== 'first' && workerData !== 'second'))
  throw new Error('Expected a signup scope worker');

const port = parentPort;

const { waba, phone, e164, code } =
  workerData === 'first'
    ? {
        waba: '777',
        phone: '888',
        e164: '+12025550124',
        code: 'fixture-owner-code',
      }
    : {
        waba: '333',
        phone: '444',
        e164: '+12025550125',
        code: 'fixture-second-code',
      };

const appId = '123';
const appSecret = 'fixture-app-secret';
const token = `fixture-${workerData}-business-token`;

Object.assign(process.env, {
  WHATSAPP_COEXISTENCE_ENABLED: 'true',
  WHATSAPP_COEXISTENCE_APP_ID: appId,
  WHATSAPP_COEXISTENCE_LOGIN_CONFIG_ID: '456',
  WHATSAPP_COEXISTENCE_PARTNER_BUSINESS_ID: '789',
  WHATSAPP_COEXISTENCE_APP_SECRET: appSecret,
  WHATSAPP_COEXISTENCE_RELAY_WABA_ID: waba,
  WHATSAPP_COEXISTENCE_RELAY_PHONE_ID: phone,
});

const origin = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const nativeFetch = globalThis.fetch;

const read =
  /^\/(auth\/v1\/user|rest\/v1\/(accounts|profiles|whatsapp_config))$/;

const write =
  /^\/rest\/v1\/rpc\/(coexistence_signup_(status|launch|exchange_start|store_token|token|verify|confirm|review)|coexistence_history_intent_record)$/;

globalThis.fetch = async (input, init) => {
  const request = new Request(input, { ...init, redirect: 'error' });
  const url = new URL(request.url);

  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.hash ||
    !(
      (request.method === 'GET' && read.test(url.pathname)) ||
      (request.method === 'POST' && !url.search && write.test(url.pathname))
    )
  )
    throw new Error('Only signup bridge requests are permitted');

  return nativeFetch(request, {
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
  });
};

const providerRoutes = new Map<
  string,
  {
    query: Record<string, string>;
    authorization: string | null;
    reply: () => object;
  }
>([
  [
    '/v27.0/oauth/access_token',
    {
      query: { client_id: appId, client_secret: appSecret, code },
      authorization: null,
      reply: () => ({ access_token: token, token_type: 'bearer' }),
    },
  ],
  [
    '/v27.0/debug_token',
    {
      query: { input_token: token },
      authorization: `Bearer ${appId}|${appSecret}`,
      reply: () => ({
        data: {
          app_id: appId,
          is_valid: true,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          scopes: [
            'whatsapp_business_management',
            'whatsapp_business_messaging',
          ],
          granular_scopes: [
            { scope: 'whatsapp_business_management', target_ids: [waba] },
          ],
        },
      }),
    },
  ],
  [
    `/v27.0/${waba}/phone_numbers`,
    {
      query: { fields: 'id' },
      authorization: `Bearer ${token}`,
      reply: () => ({ data: [{ id: phone }] }),
    },
  ],
  [
    `/v27.0/${phone}`,
    {
      query: {
        fields: 'id,display_phone_number,is_on_biz_app,platform_type',
      },
      authorization: `Bearer ${token}`,
      reply: () => ({
        id: phone,
        display_phone_number: e164,
        is_on_biz_app: true,
        platform_type: 'CLOUD_API',
      }),
    },
  ],
]);

let providerCalls = 0;

const provider: CoexistenceFetch = async (url, init) => {
  providerCalls++;
  init.signal?.throwIfAborted();
  const route = providerRoutes.get(url.pathname);

  if (
    url.origin !== 'https://graph.facebook.com' ||
    url.username ||
    url.password ||
    url.hash ||
    init.method !== 'GET' ||
    init.redirect !== 'error' ||
    !route ||
    new Headers(init.headers).get('authorization') !== route.authorization ||
    url.search !== `?${new URLSearchParams(route.query)}`
  )
    return Response.json(
      { error: 'Unexpected fixture provider request' },
      { status: 400 }
    );

  return Response.json(route.reply());
};

const active = new Map<number, AbortController>();

port.on('message', async (message: ScopeRequest) => {
  const { id } = message;

  if ('cancel' in message) {
    active.get(id)?.abort();

    return;
  }

  const abort = new AbortController();
  active.set(id, abort);
  let reply: ScopeReply = { id };

  try {
    const { url, method, headers, body, invite } = message;

    const request = new Request(url, {
      method,
      headers,
      body,
      signal: abort.signal,
    });

    const db = createServerClient(origin, anon, {
      global: {
        fetch: (input, init) =>
          globalThis.fetch(input, {
            ...init,
            signal: init?.signal
              ? AbortSignal.any([abort.signal, init.signal])
              : abort.signal,
          }),
      },
      cookies: {
        getAll: () => parseCookieHeader(request.headers.get('cookie') ?? ''),
        setAll: () => {},
      },
    });

    const response = await supervisedSignup(request, db, invite, provider);
    const responseBody = response.body === null ? null : await response.text();
    response.headers.set('x-fixture-call-count', String(providerCalls));
    reply = {
      id,
      response: {
        status: response.status,
        headers: [...response.headers],
        body: responseBody,
      },
    };
  } catch {
    // Only the empty failure envelope crosses IPC; never forward exception diagnostics.
  } finally {
    active.delete(id);
  }

  port.postMessage(reply);
});
