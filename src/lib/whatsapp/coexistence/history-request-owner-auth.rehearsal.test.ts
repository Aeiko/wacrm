import { AsyncLocalStorage } from 'node:async_hooks';
import { writeFile } from 'node:fs/promises';
import { createBrowserClient } from '@supabase/ssr';
import { Client } from 'undici';
import { expect, it, vi } from 'vitest';

const wirePaths = new Set([
  'POST /auth/v1/token',
  'GET /auth/v1/user',
  'GET /auth/v1/.well-known/jwks.json',
]);

function requiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) throw new Error(`Missing ${name} for owner auth rehearsal`);

  return value;
}

async function login(origin: string, key: string) {
  const jar = new Map<string, string>();

  const { auth } = createBrowserClient(origin, key, {
    cookies: {
      getAll: () => Array.from(jar, ([name, value]) => ({ name, value })),
      setAll(cookies) {
        for (const { name, value, options } of cookies) {
          if (options.maxAge === 0) jar.delete(name);
          else jar.set(name, value);
        }
      },
    },
  });

  const { data, error } = await auth.signInWithPassword({
    email: requiredEnv('WACRM_AUTH_EMAIL'),
    password: requiredEnv('WACRM_AUTH_PASSWORD'),
  });

  if (error || !data.session || !jar.size) {
    throw new Error('Fixture login did not produce a session cookie');
  }

  return Array.from(
    jar,
    ([name, value]) => `${name}=${encodeURIComponent(value)}`
  ).join('; ');
}

async function verify(cookie: string) {
  const { createWorkStore } =
    await import('next/dist/server/async-storage/work-store');

  const { createRequestStoreForAPI } =
    await import('next/dist/server/async-storage/request-store');

  const { workAsyncStorage } =
    await import('next/dist/server/app-render/work-async-storage.external');

  const { workUnitAsyncStorage } =
    await import('next/dist/server/app-render/work-unit-async-storage.external');

  const { NextRequest } = await import('next/server');
  const { readHistoryRequestOwner } = await import('./history-request-owner');

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

  async function call(headers: HeadersInit, query = '') {
    const request = new NextRequest(`http://127.0.0.1:1${path}${query}`, {
      headers,
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
      workUnitAsyncStorage.run(store, () => readHistoryRequestOwner(request))
    );
  }

  expect(
    await call(
      {
        cookie: 'unrelated=only',
        authorization: 'Bearer not-a-cookie',
        apikey: 'not-a-cookie',
      },
      '?access_token=not-a-cookie'
    )
  ).toBeNull();

  return call({ cookie });
}

// The parent opts in with WACRM_AUTH_OP and runs this in a scrubbed child
// with a temporary Vite config (envDir: false), never with the CRM's env files.
it.runIf(process.env.WACRM_HISTORY_OWNER_AUTH_REHEARSAL === '1')(
  'exchanges a fixture login for SSR cookies or verifies the cookie identity',
  async () => {
    const op = requiredEnv('WACRM_AUTH_OP');

    if (op !== 'login' && op !== 'verify')
      throw new Error('Invalid owner auth operation');

    const output = requiredEnv('WACRM_AUTH_OUTPUT');
    const origin = requiredEnv('NEXT_PUBLIC_SUPABASE_URL');
    const key = requiredEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY');

    if (
      !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(origin) ||
      new URL(origin).origin !== origin
    ) {
      throw new Error(
        'Owner auth rehearsal requires an explicit loopback origin'
      );
    }

    const dispatcher = new Client(origin);
    const nativeFetch = globalThis.fetch;
    let denied = false;

    vi.stubGlobal('AsyncLocalStorage', AsyncLocalStorage);
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, { ...init, redirect: 'error' });
      const url = new URL(request.url);

      if (
        url.origin !== origin ||
        !wirePaths.has(`${request.method} ${url.pathname}`)
      ) {
        denied = true;
        throw new Error('Only loopback fixture Auth requests are permitted');
      }

      const options = {
        dispatcher,
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(5_000)]),
      };

      return nativeFetch(request, options);
    });

    try {
      const value =
        op === 'login'
          ? await login(origin, key)
          : JSON.stringify(await verify(process.env.WACRM_AUTH_COOKIE ?? ''));

      expect(denied, 'Unexpected fixture Auth request').toBe(false);
      await writeFile(output, value, { mode: 0o600 });
    } finally {
      vi.unstubAllGlobals();
      await dispatcher.destroy();
    }
  },
  20_000
);
