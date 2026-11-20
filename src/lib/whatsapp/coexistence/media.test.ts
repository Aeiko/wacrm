import { createServer } from 'node:http';
import { createServerClient } from '@supabase/ssr';
import type { ServerResponse } from 'node:http';
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
import { encrypt } from '../encryption';
import { privateMedia } from './media';
import { deadlineFetch } from '@/lib/request-deadline';

const messageId = '10000000-0000-4000-8000-000000000001';
const accountId = '20000000-0000-4000-8000-000000000001';
const userId = '30000000-0000-4000-8000-000000000001';
let origin: string;
let owned: boolean;
let calls: string[];
let contextRows: unknown[];
let originalContext: ReturnType<typeof context>;
let onDownload: (res: ServerResponse) => boolean | void;
let onAuth: (res: ServerResponse) => boolean | void;
let onRequest: (path: string, res: ServerResponse) => boolean;
let profileAccount: string;
let authStatus: number;
let dbStatus: number;
let providerStatus: number;
let inFlight: number;
let abortedFetches: number;

const context = () => ({
  config_id: '40000000-0000-4000-8000-000000000001',
  generation: '50000000-0000-4000-8000-000000000001',
  phone_number_id: '777',
  access_token: encrypt('provider-fixture'),
  media_id: '888',
  media_type: 'image/png',
  content_type: 'image',
  media_url: `/api/whatsapp/coexistence/media/${messageId}`,
});

const server = createServer((req, res) => {
  const url = new URL(req.url!, origin);
  calls.push(url.pathname);
  res.setHeader('Content-Type', 'application/json');

  if (onRequest(url.pathname, res)) return;

  if (url.pathname === '/auth/v1/user') {
    expect(req.headers.authorization).toBe('Bearer user-fixture');

    if (onAuth(res)) return;
    res.statusCode = authStatus;
    res.end(
      JSON.stringify(
        authStatus === 200
          ? {
              id: userId,
              aud: 'authenticated',
              role: 'authenticated',
              email: 'fixture@example.test',
            }
          : { message: 'private-auth-cause' }
      )
    );
  } else if (dbStatus !== 200 && url.pathname.startsWith('/rest/')) {
    res.statusCode = dbStatus;
    res.end(JSON.stringify({ message: 'private-db-cause' }));
  } else if (url.pathname === '/rest/v1/profiles')
    res.end(
      JSON.stringify({ account_id: profileAccount, account_role: 'viewer' })
    );
  else if (url.pathname === '/rest/v1/accounts')
    res.end(JSON.stringify({ id: accountId }));
  else if (url.pathname === '/rest/v1/messages') {
    expect(req.headers.authorization).toBe('Bearer user-fixture');
    expect(url.searchParams.get('id')).toBe(`eq.${messageId}`);
    expect(url.searchParams.get('conversations.account_id')).toBe(
      `eq.${accountId}`
    );
    res.end(
      JSON.stringify(
        owned
          ? { id: messageId, conversations: { account_id: accountId } }
          : null
      )
    );
  } else if (url.pathname === '/rest/v1/rpc/coexistence_media_context') {
    expect(req.headers.authorization).toBe('Bearer service-fixture');
    res.end(JSON.stringify(contextRows));
  } else if (url.pathname.startsWith('/graph/')) {
    expect(req.headers.authorization).toBe('Bearer provider-fixture');
    res.statusCode = providerStatus;
    res.end(
      JSON.stringify(
        providerStatus === 200
          ? {
              id: '888',
              url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/fixture',
              mime_type: 'image/png',
              file_size: 3,
            }
          : { error: { message: 'private-provider-cause' } }
      )
    );
  } else if (url.pathname.startsWith('/cdn/')) {
    if (onDownload(res)) return;
    res.setHeader('Content-Type', 'image/png');
    res.end('png');
  } else {
    res.statusCode = 500;
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
  owned = false;
  calls = [];
  originalContext = context();
  contextRows = [originalContext];
  onDownload = () => {};

  onAuth = () => {};

  onRequest = () => false;

  profileAccount = accountId;
  authStatus = 200;
  dbStatus = 200;
  providerStatus = 200;
  inFlight = 0;
  abortedFetches = 0;
  const fetch = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));

      let target = input;

      if (url.hostname === 'graph.facebook.com')
        target = `${origin}/graph${url.pathname}${url.search}`;
      else if (url.hostname === 'lookaside.fbsbx.com')
        target = `${origin}/cdn${url.pathname}${url.search}`;
      else if (url.origin !== origin)
        throw new Error('External network forbidden');

      inFlight++;

      try {
        return await fetch(target, init);
      } finally {
        if (init?.signal?.aborted) abortedFetches++;
        inFlight--;
      }
    }
  );
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', origin);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-fixture');
  vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
  vi.stubEnv('WHATSAPP_COEXISTENCE_APP_ID', '123');
  vi.stubEnv('WHATSAPP_COEXISTENCE_APP_SECRET', 'fixture');
  vi.stubEnv('WHATSAPP_COEXISTENCE_PARTNER_BUSINESS_ID', '456');
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function run(
  method = 'GET',
  id = messageId,
  signal?: AbortSignal,
  deadline?: number
) {
  const session = {
    access_token: 'user-fixture',
    refresh_token: 'refresh-fixture',
    expires_at: 4102444800,
    token_type: 'bearer',
    user: { id: userId },
  };

  const db = createServerClient(origin, 'anon-fixture', {
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

  return privateMedia(
    new Request(`${origin}/api/media/${id}`, {
      method,
      signal,
      headers: { Range: 'bytes=1-1' },
    }),
    id,
    db,
    deadline
  );
}

it('returns the same private 404 for an unreadable message without touching privileged context', async () => {
  const response = await run();
  expect(response.status).toBe(404);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(calls).toEqual([
    '/auth/v1/user',
    '/rest/v1/profiles',
    '/rest/v1/accounts',
    '/rest/v1/messages',
  ]);
  expect(await response.text()).toBe('{"error":"Media unavailable"}');
});

it('delivers the entire private body, ignoring Range, after rechecking membership and source', async () => {
  owned = true;
  const response = await run();
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('png');
  expect(response.headers.get('Content-Length')).toBe('3');
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  expect(response.headers.get('Content-Security-Policy')).toBe(
    "default-src 'none'; sandbox"
  );
  expect(calls.filter((path) => path === '/auth/v1/user')).toHaveLength(2);
});

it.each([
  ['WHATSAPP_COEXISTENCE_ENABLED', 'false'],
  ['WHATSAPP_COEXISTENCE_APP_ID', 'not-numeric'],
  ['WHATSAPP_COEXISTENCE_APP_SECRET', ''],
  ['WHATSAPP_COEXISTENCE_PARTNER_BUSINESS_ID', 'not-numeric'],
])(
  'fails closed with no HTTP calls for invalid feature configuration %s',
  async (key, value) => {
    vi.stubEnv(key, value);
    expect((await run()).status).toBe(404);
    expect(calls).toEqual([]);
  }
);

it.each(['HEAD', 'POST', 'OPTIONS'])(
  'does not authorize or download for %s',
  async (method) => {
    expect((await run(method)).status).toBe(405);
    expect(calls).toEqual([]);
  }
);

it('accepts UUIDs only, not raw provider IDs or caller URLs', async () => {
  for (const id of ['888', 'https://example.test', 'not-a-uuid']) {
    expect((await run('GET', id)).status).toBe(404);
  }

  expect(calls).toEqual([]);
});

it('denies failed auth without looking up private metadata', async () => {
  authStatus = 401;
  const response = await run();
  expect(response.status).toBe(401);
  expect(await response.text()).toBe('{"error":"Media unavailable"}');
  expect(calls).toEqual(['/auth/v1/user']);
});

it('sanitizes database errors and fails before privileged context', async () => {
  dbStatus = 403;
  const response = await run();
  expect(response.status).toBe(503);
  expect(await response.text()).toBe('{"error":"Media unavailable"}');
  expect(calls.some((path) => path.includes('/rpc/'))).toBe(false);
});

it.each([
  { rows: [], status: 404 },
  { rows: [{ unexpected: 'private-shape' }], status: 503 },
])(
  'does not download missing or malformed private metadata ($status)',
  async ({ rows, status }) => {
    owned = true;
    contextRows = rows;
    const response = await run();
    expect(response.status).toBe(status);
    expect(calls.some((path) => path.startsWith('/graph/'))).toBe(false);
  }
);

it.each([
  [
    'config',
    () => {
      contextRows = [
        {
          ...originalContext,
          config_id: '40000000-0000-4000-8000-000000000002',
        },
      ];
    },
  ],
  [
    'generation',
    () => {
      contextRows = [
        {
          ...originalContext,
          generation: '50000000-0000-4000-8000-000000000002',
        },
      ];
    },
  ],
  [
    'token',
    () => {
      contextRows = [
        { ...originalContext, access_token: encrypt('rotated-fixture') },
      ];
    },
  ],
  [
    'source asset',
    () => {
      contextRows = [{ ...originalContext, media_id: '999' }];
    },
  ],
  [
    'projection revision',
    () => {
      contextRows = [
        {
          ...originalContext,
          media_url: `${originalContext.media_url}?v=60000000-0000-4000-8000-000000000001`,
        },
      ];
    },
  ],
  [
    'binding',
    () => {
      contextRows = [];
    },
  ],
  [
    'membership',
    () => {
      profileAccount = '20000000-0000-4000-8000-000000000002';
    },
  ],
  [
    'owned row',
    () => {
      owned = false;
    },
  ],
  [
    'feature gate',
    () => {
      vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'false');
    },
  ],
])(
  'withholds every byte when %s changes during download',
  async (_label, change) => {
    owned = true;
    onDownload = change;
    const response = await run();
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.text()).toBe('{"error":"Media unavailable"}');
    expect(calls.filter((path) => path.startsWith('/graph/'))).toHaveLength(1);
  }
);

it('accepts only the stored private projection, including an opaque UUID revision', async () => {
  owned = true;
  contextRows = [
    {
      ...originalContext,
      media_url: `${originalContext.media_url}?v=60000000-0000-4000-8000-000000000001`,
    },
  ];
  expect((await run()).status).toBe(200);
  calls = [];
  contextRows = [
    { ...originalContext, media_url: 'https://private.example.test/asset' },
  ];
  expect((await run()).status).toBe(404);
  expect(calls.some((path) => path.startsWith('/graph/'))).toBe(false);
});

it('withholds bytes on a failed post-download database check', async () => {
  owned = true;
  onDownload = () => {
    dbStatus = 403;
  };

  const response = await run();
  expect(response.status).toBe(503);
  expect(await response.text()).toBe('{"error":"Media unavailable"}');
});

it('fails closed on an undecryptable stored credential without provider HTTP', async () => {
  owned = true;
  contextRows = [{ ...originalContext, access_token: 'private-invalid-token' }];
  const response = await run();
  expect(response.status).toBe(503);
  expect(await response.text()).toBe('{"error":"Media unavailable"}');
  expect(calls.some((path) => path.startsWith('/graph/'))).toBe(false);
});

it('maps expired provider media to a sanitized, private response', async () => {
  owned = true;
  providerStatus = 404;
  const response = await run();
  expect(response.status).toBe(410);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(await response.text()).toBe('{"error":"Media unavailable"}');
});

it('respects an already cancelled request without HTTP calls', async () => {
  const controller = new AbortController();
  controller.abort();
  expect((await run('GET', messageId, controller.signal)).status).toBe(499);
  expect(calls).toEqual([]);
});

it('aborts and awaits stalled authentication HTTP before returning the outer deadline error', async () => {
  const held = Promise.withResolvers<ServerResponse>();
  onAuth = (response) => {
    held.resolve(response);

    return true;
  };

  const pending = run('GET', messageId, undefined, Date.now() + 250);
  const authResponse = await held.promise;
  const response = await pending;
  expect(response.status).toBe(504);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');

  try {
    expect(inFlight).toBe(0);
    expect(abortedFetches).toBe(1);
    expect(calls).toEqual(['/auth/v1/user']);
  } finally {
    authResponse.destroy();
  }
});

it.each([
  '/auth/v1/user',
  '/rest/v1/profiles',
  '/rest/v1/accounts',
  '/rest/v1/messages',
  '/rest/v1/rpc/coexistence_media_context',
  '/graph/',
  '/cdn/',
])('awaits cancelled %s HTTP with no subsequent requests', async (path) => {
  owned = true;
  const controller = new AbortController();
  const held = Promise.withResolvers<void>();
  onRequest = (requestPath) => {
    if (!requestPath.startsWith(path)) return false;
    held.resolve();

    return true;
  };

  const pending = run('GET', messageId, controller.signal);
  await held.promise;
  const beforeCancel = [...calls];
  controller.abort(new Error('Private cancellation reason'));
  const response = await pending;
  expect(response.status).toBe(499);
  expect(inFlight).toBe(0);
  expect(abortedFetches).toBe(1);
  expect(calls).toEqual(beforeCancel);
  expect(await response.text()).toBe('{"error":"Media unavailable"}');
});

it('awaits cancellation of post-download authentication before releasing its admission', async () => {
  owned = true;
  const controller = new AbortController();
  const held = Promise.withResolvers<void>();
  let authCalls = 0;
  onAuth = () => {
    authCalls++;

    if (authCalls !== 2) return false;
    held.resolve();

    return true;
  };

  const pending = run('GET', messageId, controller.signal);
  await held.promise;
  const beforeCancel = [...calls];
  controller.abort();
  const response = await pending;
  expect(response.status).toBe(499);
  expect(inFlight).toBe(0);
  expect(abortedFetches).toBe(1);
  expect(calls).toEqual(beforeCancel);
  expect(await response.text()).toBe('{"error":"Media unavailable"}');
});

it('withholds the downloaded body if the caller cancels during provider HTTP', async () => {
  owned = true;
  const controller = new AbortController();
  onDownload = () => {
    controller.abort();
  };

  const response = await run('GET', messageId, controller.signal);
  expect(response.status).toBe(499);
  expect(await response.text()).toBe('{"error":"Media unavailable"}');
});

it('admits at most eight downloads and releases admission when bodies finish', async () => {
  owned = true;
  const held: ServerResponse[] = [];
  const admitted = Promise.withResolvers<void>();
  onDownload = (response) => {
    held.push(response);

    if (held.length === 8) admitted.resolve();

    return true;
  };

  const pending = Array.from({ length: 8 }, () => run());
  await admitted.promise;
  const ninth = await run();
  expect(ninth.status).toBe(429);
  expect(ninth.headers.get('Retry-After')).toBe('1');
  expect(ninth.headers.get('Cache-Control')).toBe('private, no-store');
  onDownload = () => {};

  for (const response of held) {
    response.setHeader('Content-Type', 'image/png');
    response.end('png');
  }

  expect(
    (await Promise.all(pending)).map((response) => response.status)
  ).toEqual(Array(8).fill(200));
  expect((await run()).status).toBe(200);
});
