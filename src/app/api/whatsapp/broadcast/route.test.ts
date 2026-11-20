import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { encrypt } from '@/lib/whatsapp/encryption';
import { listenForFetch } from '@/test/http-server';

vi.stubGlobal('AsyncLocalStorage', AsyncLocalStorage);

const { createWorkStore } =
  await import('next/dist/server/async-storage/work-store');

const { createRequestStoreForAPI } =
  await import('next/dist/server/async-storage/request-store');

const { workAsyncStorage } =
  await import('next/dist/server/app-render/work-async-storage.external');

const { workUnitAsyncStorage } =
  await import('next/dist/server/app-render/work-unit-async-storage.external');

const { NextRequest } = await import('next/server');
const { POST } = await import('./route');

const broadcastId = '11111111-1111-4111-8111-111111111111';
let generation = 'epoch-1';
let appId: string | null = 'app-1';
let configAccount = 'account-1';

let stored: {
  id: string;
  account_id: string;
  send_config_id?: string | null;
  send_generation?: string | null;
} | null;

let graphPosts = 0;
let guardChecks = 0;
let credentialLoads = 0;
let broadcastReads = 0;
let role = 'agent';
let user = 0;
let rotateAfterPost = false;
let rotateOnCredentials = false;
let databaseError = false;
let recipientError = false;
const nativeFetch = globalThis.fetch;

const server = createServer((req, res) => {
  const url = new URL(req.url!, 'http://fixture');
  res.setHeader('Content-Type', 'application/json');

  if (url.pathname === '/auth/v1/user') {
    res.end(JSON.stringify({ id: `user-${user}` }));

    return;
  }

  let data;

  switch (url.pathname) {
    case '/rest/v1/profiles':
      data = { account_id: 'account-1', account_role: role };
      break;
    case '/rest/v1/accounts':
      data = { id: 'account-1', name: 'Fixture' };
      break;
    case '/rest/v1/broadcasts':
      broadcastReads++;
      expect(url.searchParams.get('id')).toBe(`eq.${broadcastId}`);
      expect(url.searchParams.get('account_id')).toBe('eq.account-1');

      if (databaseError) res.statusCode = 403;
      data = databaseError ? { message: 'fixture failure' } : stored;
      break;
    case '/rest/v1/whatsapp_config': {
      const credentials = url.searchParams.get('select') === '*';

      if (credentials) {
        credentialLoads++;

        if (rotateOnCredentials) generation = 'epoch-2';
      } else {
        guardChecks++;
      }

      const row = {
        id: 'config-1',
        account_id: configAccount,
        phone_number_id: 'phone-1',
        access_token: encrypt('secret'),
        status: 'connected',
        coexistence_app_id: appId,
        coexistence_generation: generation,
        coexistence_verified_at: '2026-01-01',
      };

      data = credentials ? row : [row];
      break;
    }

    case '/rest/v1/message_templates':
      data = [];
      break;
    default:
      res.statusCode = 500;
      data = { message: 'Unexpected fixture URL' };
  }

  res.end(JSON.stringify(data));
});

beforeEach(async () => {
  generation = 'epoch-1';
  appId = 'app-1';
  configAccount = 'account-1';
  role = 'agent';
  user++;
  stored = {
    id: broadcastId,
    account_id: 'account-1',
    send_config_id: 'config-1',
    send_generation: 'epoch-1',
  };
  graphPosts = 0;
  guardChecks = 0;
  credentialLoads = 0;
  broadcastReads = 0;
  rotateAfterPost = false;
  rotateOnCredentials = false;
  databaseError = false;
  recipientError = false;
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', await listenForFetch(server));
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'fixture-anon');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'fixture-service');
  vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
  vi.stubEnv('WHATSAPP_COEXISTENCE_APP_ID', 'app-1');
  vi.stubEnv('WHATSAPP_COEXISTENCE_APP_SECRET', 'fixture-app-secret');
  vi.stubEnv('WHATSAPP_COEXISTENCE_PARTNER_BUSINESS_ID', '7777');
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new URL(String(input)).hostname === 'graph.facebook.com') {
        graphPosts++;

        if (rotateAfterPost) generation = 'epoch-2';

        if (recipientError)
          return Response.json(
            {
              error: {
                message: 'Recipient phone number not in allowed list',
                code: 131030,
              },
            },
            { status: 400 }
          );

        return Response.json({ messages: [{ id: `wamid.${graphPosts}` }] });
      }

      return nativeFetch(input, init);
    }
  );
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function broadcast(
  overrides: {
    broadcast_id?: string | number | null;
    recipients?: { phone: string }[];
  } = {}
) {
  const session = Buffer.from(
    JSON.stringify({
      access_token: 'fixture-token',
      refresh_token: 'fixture-refresh',
      expires_at: 4102444800,
      user: { id: `user-${user}` },
    })
  ).toString('base64url');

  const request = new NextRequest('http://localhost/api/whatsapp/broadcast', {
    method: 'POST',
    headers: { cookie: `sb-127-auth-token=base64-${session}` },
    body: JSON.stringify({
      broadcast_id: broadcastId,
      recipients: [
        { phone: '+15551234567', params: [] },
        { phone: '+15551234568', params: [] },
      ],
      template_name: 'hello',
      ...overrides,
    }),
  });

  const work = createWorkStore({
    page: '/api/whatsapp/broadcast/route',
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

  const store = createRequestStoreForAPI(
    request,
    request.nextUrl,
    { tags: [], expirationsByCacheKind: new Map() },
    undefined,
    undefined,
    undefined
  );

  return workAsyncStorage.run(work, () =>
    workUnitAsyncStorage.run(store, () => POST(request))
  );
}

it('sends the whole managed batch under its stored identity', async () => {
  const response = await broadcast();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ sent: 2, failed: 0 });
  expect(broadcastReads).toBe(1);
  expect(graphPosts).toBe(2);
});

it('never refreshes a queued generation to current credentials', async () => {
  generation = 'epoch-2';
  const response = await broadcast();
  expect(await response.json()).toMatchObject({ sent: 0, failed: 2 });
  expect(graphPosts).toBe(0);
  expect(guardChecks).toBe(2);
});

it('fences rotation during credential loading', async () => {
  rotateOnCredentials = true;
  const response = await broadcast();
  expect(await response.json()).toMatchObject({ sent: 0, failed: 2 });
  expect(graphPosts).toBe(0);
});

it('rechecks the pinned generation for every recipient', async () => {
  rotateAfterPost = true;
  const response = await broadcast();
  expect(await response.json()).toMatchObject({ sent: 1, failed: 1 });
  expect(graphPosts).toBe(1);
});

it.each(['not-a-uuid', 42, null, ''])(
  'rejects invalid broadcast id %s before credentials',
  async (id) => {
    expect((await broadcast({ broadcast_id: id })).status).toBe(400);
    expect(broadcastReads).toBe(0);
    expect(credentialLoads).toBe(0);
    expect(graphPosts).toBe(0);
  }
);

it('rejects missing broadcasts before credential loading', async () => {
  stored = null;
  expect((await broadcast()).status).toBe(404);
  expect(credentialLoads).toBe(0);
  expect(graphPosts).toBe(0);
});

it('rejects another tenant even if a malformed database response returns its row', async () => {
  stored = {
    id: broadcastId,
    account_id: 'account-2',
    send_config_id: 'config-1',
    send_generation: 'epoch-1',
  };
  expect((await broadcast()).status).toBe(404);
  expect(credentialLoads).toBe(0);
  expect(graphPosts).toBe(0);
});

it('fails closed on broadcast lookup errors', async () => {
  databaseError = true;
  expect((await broadcast()).status).toBe(500);
  expect(credentialLoads).toBe(0);
  expect(graphPosts).toBe(0);
});

it('requires a persisted broadcast for managed config when an old browser omits the id', async () => {
  expect((await broadcast({ broadcast_id: undefined })).status).toBe(409);
  expect(graphPosts).toBe(0);
});

it('permits old browser batches only for unbound legacy config', async () => {
  appId = null;
  vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'false');
  const response = await broadcast({ broadcast_id: undefined });
  expect(await response.json()).toMatchObject({ sent: 2, failed: 0 });
  expect(graphPosts).toBe(2);
});

it('treats absent stored scope fields as legacy, never as permission to onboard', async () => {
  stored = { id: broadcastId, account_id: 'account-1' };
  const response = await broadcast();
  expect(await response.json()).toMatchObject({ sent: 0, failed: 2 });
  expect(graphPosts).toBe(0);
});

it('allows persisted legacy broadcasts on legacy config', async () => {
  stored = {
    id: broadcastId,
    account_id: 'account-1',
    send_config_id: null,
    send_generation: null,
  };
  appId = null;
  expect(await (await broadcast()).json()).toMatchObject({
    sent: 2,
    failed: 0,
  });
});

it('rejects partial stored scope before credentials', async () => {
  stored = {
    id: broadcastId,
    account_id: 'account-1',
    send_config_id: 'config-1',
  };
  expect((await broadcast()).status).toBe(500);
  expect(credentialLoads).toBe(0);
  expect(graphPosts).toBe(0);
});

it('does not use phone variants to bypass a fenced denial', async () => {
  generation = 'epoch-2';

  const response = await broadcast({
    recipients: [{ phone: '+4407911123456' }],
  });

  expect(await response.json()).toMatchObject({ sent: 0, failed: 1 });
  expect(guardChecks).toBe(1);
  expect(graphPosts).toBe(0);
});

it('fences rotation before a phone-variant retry after a real recipient error', async () => {
  recipientError = true;
  rotateAfterPost = true;

  const response = await broadcast({
    recipients: [{ phone: '+4407911123456' }],
  });

  expect(await response.json()).toMatchObject({ sent: 0, failed: 1 });
  expect(graphPosts).toBe(1);
  expect(guardChecks).toBe(2);
});

it('rejects credentials belonging to another account at the last mile', async () => {
  configAccount = 'account-2';

  const response = await broadcast();

  expect(await response.json()).toMatchObject({ sent: 0, failed: 2 });
  expect(graphPosts).toBe(0);
});

it('does not load credentials for viewers', async () => {
  role = 'viewer';
  expect((await broadcast()).status).toBe(403);
  expect(credentialLoads).toBe(0);
  expect(graphPosts).toBe(0);
});
