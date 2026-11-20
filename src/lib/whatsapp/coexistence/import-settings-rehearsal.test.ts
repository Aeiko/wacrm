import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ImportSettingsRequest } from './import-settings-contract';

const path = '/api/whatsapp/coexistence/import-permissions';
const browserOrigin = 'http://localhost:1';
const gate = 'WHATSAPP_COEXISTENCE_IMPORT_SETTINGS_ENABLED';

const wirePaths = new Set([
  'GET /auth/v1/user',
  'GET /rest/v1/profiles',
  'GET /rest/v1/accounts',
  'POST /rest/v1/rpc/coexistence_import_settings_status',
  'POST /rest/v1/rpc/coexistence_import_settings_record',
]);

// See supabase/ci/rehearse-coexistence-import-settings.py. Real handlers and
// Supabase clients under Next's request stores; only the upstream HTTP seam is simulated.
it.runIf(process.env.WACRM_IMPORT_SETTINGS_REHEARSAL === '1')(
  'records and withdraws an owner choice in disposable SQL080/079 without syncing',
  async () => {
    const origin = z
      .string()
      .regex(/^http:\/\/127\.0\.0\.1:\d{1,5}$/)
      .parse(process.env.NEXT_PUBLIC_SUPABASE_URL);

    const {
      WACRM_FIXTURE_TOKENS,
      WACRM_FIXTURE_ACTOR,
      WACRM_FIXTURE_FOREIGN_ACCOUNT,
    } = process.env;

    const tokens = z
      .object({ owner: z.string(), other: z.string(), stale: z.string() })
      .parse(JSON.parse(z.string().parse(WACRM_FIXTURE_TOKENS)));

    const actor = z.uuid().parse(WACRM_FIXTURE_ACTOR);
    const foreign = z.uuid().parse(WACRM_FIXTURE_FOREIGN_ACCOUNT);
    const nativeFetch = globalThis.fetch;
    let deniedFetches = 0;
    vi.stubGlobal('AsyncLocalStorage', AsyncLocalStorage);
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, { ...init, redirect: 'error' });
      const url = new URL(request.url);

      if (
        url.origin !== origin ||
        url.username ||
        url.password ||
        !wirePaths.has(`${request.method} ${url.pathname}`)
      ) {
        deniedFetches++;
        throw new Error('Only allowed loopback fixture requests may use fetch');
      }

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

      const { GET, POST } =
        await import('@/app/api/whatsapp/coexistence/import-permissions/route');

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

      async function call(
        expected: number,
        body?: ImportSettingsRequest & { account_id?: string },
        session: keyof typeof tokens = 'owner'
      ) {
        const cookie = Buffer.from(
          JSON.stringify({
            access_token: tokens[session],
            refresh_token: 'fixture-only',
            expires_at: 4102444800,
            token_type: 'bearer',
            user: { id: actor },
          })
        ).toString('base64url');

        const request = new NextRequest(`${browserOrigin}${path}`, {
          method: body ? 'POST' : 'GET',
          headers: {
            cookie: `sb-127-auth-token=base64-${cookie}`,
            ...(body && {
              'content-type': 'application/json',
              origin: browserOrigin,
              'sec-fetch-site': 'same-origin',
            }),
          },
          ...(body && { body: JSON.stringify(body) }),
        });

        const store = createRequestStoreForAPI(
          request,
          request.nextUrl,
          { tags: [], expirationsByCacheKind: new Map() },
          undefined,
          undefined,
          undefined
        );

        const response = await workAsyncStorage.run(work, () =>
          workUnitAsyncStorage.run(store, () =>
            body ? POST(request) : GET(request)
          )
        );

        expect(response.status).toBe(expected);
        expect(response.headers.get('cache-control')).toContain('no-store');

        return response.json();
      }

      const initial: unknown = await call(200);
      expect(initial).toEqual({
        status: 'ok',
        connection: {
          context: expect.stringMatching(/^[0-9a-f]{64}$/),
          phone_id_suffix: '0008',
          can_grant: true,
          can_withdraw: false,
          state: 'none',
          history: false,
          contacts: false,
          previous_request_id: null,
          expires_at: null,
        },
      });

      const {
        connection: { context },
      } = z
        .object({ connection: z.object({ context: z.string() }) })
        .parse(initial);

      const grant: ImportSettingsRequest = {
        context,
        request_id: randomUUID(),
        previous_request_id: null,
        history: true,
        contacts: false,
        version: 'projection-v1',
      };

      const granted: unknown = await call(200, grant);
      expect(granted).toEqual({
        status: 'recorded',
        request_id: grant.request_id,
        history: true,
        contacts: false,
        expires_at: expect.any(String),
        dispatch_authorized: false,
      });
      expect(await call(200, grant)).toEqual(granted);

      const { expires_at } = z
        .object({ expires_at: z.iso.datetime({ offset: true }) })
        .parse(granted);

      const effective = {
        context,
        phone_id_suffix: '0008',
        can_grant: true,
        can_withdraw: true,
        state: 'effective',
        history: true,
        contacts: false,
        previous_request_id: grant.request_id,
        expires_at,
      };

      expect(await call(200)).toEqual({ status: 'ok', connection: effective });

      vi.stubEnv(gate, 'false');
      expect(await call(200)).toEqual({
        status: 'ok',
        connection: { ...effective, can_grant: false },
      });

      const withdraw = {
        ...grant,
        request_id: randomUUID(),
        previous_request_id: grant.request_id,
        history: false,
      };

      await call(409, {
        ...withdraw,
        request_id: randomUUID(),
        contacts: true,
      });
      await call(400, { ...withdraw, account_id: foreign });
      await call(403, withdraw, 'stale');
      await call(409, withdraw, 'other');
      await call(409, { ...withdraw, previous_request_id: null });
      const withdrawn: unknown = await call(200, withdraw);
      expect(withdrawn).toEqual({
        status: 'recorded',
        request_id: withdraw.request_id,
        history: false,
        contacts: false,
        expires_at: expect.any(String),
        dispatch_authorized: false,
      });
      expect(await call(200, withdraw)).toEqual(withdrawn);
      expect(await call(200)).toEqual({
        status: 'ok',
        connection: {
          ...effective,
          can_grant: false,
          can_withdraw: false,
          state: 'withdrawn',
          history: false,
          previous_request_id: withdraw.request_id,
          expires_at: z
            .object({ expires_at: z.iso.datetime({ offset: true }) })
            .parse(withdrawn).expires_at,
        },
      });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      expect(deniedFetches).toBe(0);
    }
  },
  60_000
);
