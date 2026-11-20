import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from '@/i18n/intl-provider';
import { HistoryRequestForm } from '@/components/settings/coexistence-history-request-form';
import { listenForFetch } from '@/test/http-server';
import messages from '../../../../messages/en.json';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { historyRequestStatusSchema } from './history-request-contract';

const path = '/history-request';
const browserOrigin = 'http://localhost:1';
const gate = 'WHATSAPP_COEXISTENCE_HISTORY_REQUEST_ENABLED';
const rpcPath = '/rest/v1/rpc/coexistence_history_request_';

const allowed = new Set([
  'GET /auth/v1/user',
  ...['status', 'start', 'finish'].map((rpc) => `POST ${rpcPath}${rpc}`),
]);

const fixture = z.object({
  phone: z.string().regex(/^8800[012]8$/),
  waba: z.string().regex(/^8800[012]7$/),
  context: z.string().regex(/^[0-9a-f]{64}$/),
  decision: z.uuid(),
  request: z.uuid(),
});

// Only run under the isolated Python runner: no dotenv, local database and fresh permits.
it.runIf(process.env.WACRM_OWNER_HISTORY_ROUTE_REHEARSAL === '1')(
  'proves real GET/POST owner history handlers against SQL081 on owned PG',
  async () => {
    const origin = z
      .string()
      .regex(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/)
      .parse(process.env.NEXT_PUBLIC_SUPABASE_URL);

    const cookies = z
      .object({
        owner: z.string().min(1),
        other: z.string().min(1),
        foreign: z.string().min(1),
        lost: z.string().min(1),
      })
      .parse(JSON.parse(process.env.WACRM_FIXTURE_COOKIES ?? '{}'));

    const [owner, foreign, lost] = z
      .tuple([fixture, fixture, fixture])
      .parse(JSON.parse(process.env.WACRM_FIXTURE_REVIEWS ?? '[]'));

    const nativeFetch = globalThis.fetch;
    const calls: string[] = [];
    let deniedFetches = 0;
    vi.stubGlobal('AsyncLocalStorage', AsyncLocalStorage);
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, { ...init, redirect: 'error' });
      const url = new URL(request.url);
      const key = `${request.method} ${url.pathname}`;

      if (
        url.origin !== origin ||
        url.username ||
        url.password ||
        url.search ||
        !allowed.has(key)
      ) {
        deniedFetches++;
        throw new Error('Only allowed loopback requests may use fetch');
      }

      calls.push(key);

      return nativeFetch(request);
    });

    try {
      const { createWorkStore } =
        await import('next/dist/server/async-storage/work-store');

      const { createRequestStoreForAPI } =
        await import('next/dist/server/async-storage/request-store');

      const { workAsyncStorage } =
        await import('next/dist/server/app-render/work-async-storage.external');

      const { workUnitAsyncStorage } =
        await import('next/dist/server/app-render/work-unit-async-storage.external');

      const { NextRequest } = await import('next/server');

      // Fail closed if the disposable config does not bind the route to loopback.
      const bound =
        await import('@/lib/whatsapp/coexistence/history-request-transport');

      const local = await import('./owner-history-route-rehearsal-transport');
      expect(
        bound.historyRequestTransport === local.historyRequestTransport
      ).toBe(true);

      const { GET, POST } = await import('@/app/history-request/route');

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

      function select({ phone, waba }: z.infer<typeof fixture>) {
        vi.stubEnv('WHATSAPP_COEXISTENCE_RELAY_PHONE_ID', phone);
        vi.stubEnv('WHATSAPP_COEXISTENCE_RELAY_WABA_ID', waba);
      }

      function form(review: z.infer<typeof fixture>) {
        return new URLSearchParams({
          context: review.context,
          decision_id: review.decision,
          request_id: review.request,
          confirmation: 'history-now-v1',
        });
      }

      function invoke(request: InstanceType<typeof NextRequest>) {
        const store = createRequestStoreForAPI(
          request,
          request.nextUrl,
          { tags: [], expirationsByCacheKind: new Map() },
          undefined,
          undefined,
          undefined
        );

        return workAsyncStorage.run(work, () =>
          workUnitAsyncStorage.run(store, () =>
            (request.method === 'POST' ? POST : GET)(request)
          )
        );
      }

      async function call(
        expected: number,
        who: keyof typeof cookies,
        body?: URLSearchParams
      ) {
        const request = new NextRequest(`${browserOrigin}${path}`, {
          method: body ? 'POST' : 'GET',
          headers: {
            cookie: cookies[who],
            ...(body && {
              origin: browserOrigin,
              'sec-fetch-site': 'same-origin',
            }),
          },
          body,
        });

        const response = await invoke(request);

        expect(response.status, `${request.method} as ${who}`).toBe(expected);
        expect(response.headers.get('cache-control')).toContain('no-store');

        if (expected === 303) {
          expect(response.headers.get('location')).toBe(path);
          expect(await response.text()).toBe('');

          return;
        }

        const result: unknown = await response.json();
        const parsed = historyRequestStatusSchema.safeParse(result);
        expect(parsed.success, 'Expected only sanitized status fields').toBe(
          true
        );

        return parsed.data;
      }

      vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
      vi.stubEnv('WHATSAPP_COEXISTENCE_APP_ID', '880005');
      select(owner);
      vi.stubEnv(gate, 'false');
      await call(404, 'owner');
      await call(404, 'owner', form(owner));
      expect(calls).toHaveLength(0);

      vi.stubEnv(gate, 'true');
      select(foreign);
      expect(await call(200, 'foreign')).toEqual({ state: 'unavailable' });
      await call(409, 'foreign', form(foreign));

      select(owner);

      for (const who of ['foreign', 'other'] as const) {
        expect(await call(200, who)).toEqual({ state: 'unavailable' });
        await call(409, who, form(owner));
      }

      const ready = await call(200, 'owner');
      expect(ready).toEqual({
        state: 'ready',
        review: {
          context: owner.context,
          decision_id: owner.decision,
          request_id: owner.request,
          phone_id_suffix: '0008',
          deadline_at: expect.any(String),
        },
      });

      if (ready?.state !== 'ready')
        throw new Error('Missing reviewed form fields');

      const submit = form({
        ...owner,
        context: ready.review.context,
        decision: ready.review.decision_id,
        request: ready.review.request_id,
      });

      // This is a handler HTTP harness, not a running Next app or middleware.
      let browserAddress: string;
      let harnessFailed = false;
      const traffic: string[] = [];

      // NextRequest otherwise rewrites the literal loopback host to localhost.
      vi.stubEnv('__NEXT_NO_MIDDLEWARE_URL_NORMALIZE', '1');

      const server = createServer(async (incoming, outgoing) => {
        try {
          const isReview =
            incoming.method === 'GET' && incoming.url === '/review';

          const isPost = incoming.method === 'POST';
          const length = Number(incoming.headers['content-length'] ?? 0);

          if (
            incoming.headers.host !== new URL(browserAddress).host ||
            (!isReview && incoming.url !== path) ||
            (!isPost && incoming.method !== 'GET') ||
            incoming.headers['transfer-encoding'] ||
            length > 1024 ||
            incoming.headers.authorization ||
            incoming.headers.apikey
          ) {
            outgoing.writeHead(400).end();

            return;
          }

          const headers = new Headers();

          for (const name of [
            'cookie',
            'origin',
            'sec-fetch-site',
            'content-type',
          ]) {
            const value = z.string().optional().parse(incoming.headers[name]);

            if (value !== undefined) headers.set(name, value);
          }

          let body = '';

          if (isPost) {
            incoming.setEncoding('utf8');

            for await (const chunk of incoming) body += chunk;
          }

          const request = new NextRequest(`${browserAddress}${path}`, {
            method: incoming.method,
            headers,
            body: isPost ? body : undefined,
          });

          const reply = await invoke(request);
          traffic.push(`${incoming.method} ${incoming.url} ${reply.status}`);
          let content = await reply.text();
          const responseHeaders = Object.fromEntries(reply.headers);

          if (isReview) {
            const status = historyRequestStatusSchema.parse(
              JSON.parse(content)
            );

            if (status.state !== 'ready')
              throw new Error('No reviewed browser form');
            content =
              '<!doctype html>' +
              renderToStaticMarkup(
                <IntlProvider
                  locale="en"
                  timeZone="UTC"
                  messages={messages}
                >
                  <HistoryRequestForm role="owner" review={status.review} />
                </IntlProvider>
              );
            responseHeaders['content-type'] = 'text/html; charset=utf-8';
            responseHeaders['referrer-policy'] =
              'strict-origin-when-cross-origin';
            responseHeaders['content-security-policy'] =
              "default-src 'none'; form-action 'self'; base-uri 'none'";
          }

          outgoing.writeHead(reply.status, responseHeaders).end(content);
        } catch {
          harnessFailed = true;
          outgoing.writeHead(500).end();
        }
      });

      try {
        browserAddress = await listenForFetch(server);

        const result = await promisify(execFile)(
          process.execPath,
          ['supabase/ci/drive-history-request-browser.mjs'],
          {
            env: {
              ...Object.fromEntries(
                Object.entries(process.env).filter(([k]) =>
                  /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP)$/i.test(k)
                )
              ),
              NODE_ENV: 'test',
              WACRM_OWNER_ORIGIN: browserAddress,
              WACRM_OWNER_COOKIE: cookies.owner,
              WACRM_OWNER_EXPECT: 'accepted',
              WACRM_OWNER_JSON_RESULT: '1',
            },
            timeout: 90_000,
          }
        ).catch((error: Error) => {
          const details = z.object({ stderr: z.string() }).safeParse(error);

          const stage = details.data?.stderr.match(
            /^FAIL: owner browser rehearsal could not ([a-zA-Z0-9 /_-]+)\r?\n$/
          )?.[1];

          throw new Error(
            `Isolated Chromium failed to ${stage ?? 'complete'} (${traffic.join(', ')})`
          );
        });

        expect(result.stdout).toContain('exactly one POST');
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }

      expect(harnessFailed).toBe(false);
      expect(traffic).toEqual([
        'GET /history-request 200',
        'GET /review 200',
        'GET /review 200',
        'POST /history-request 303',
        'GET /history-request 200',
        'GET /history-request 200',
      ]);
      expect(await call(200, 'owner')).toEqual({ state: 'accepted' });
      await call(409, 'owner', submit);
      expect(await call(200, 'other')).toEqual({ state: 'unavailable' });

      select(lost);
      expect((await call(200, 'lost'))?.state).toBe('ready');
      await call(503, 'lost', form(lost));
      expect(await call(200, 'lost')).toEqual({ state: 'started' });
      await call(409, 'lost', form(lost));
      expect(await call(200, 'lost')).toEqual({ state: 'started' });
      expect(deniedFetches).toBe(0);
      expect(
        calls.filter((key) => key === `POST ${rpcPath}start`)
      ).toHaveLength(7);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  },
  110_000
);
