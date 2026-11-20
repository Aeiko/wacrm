import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { encrypt } from '@/lib/whatsapp/encryption';
import { listenForFetch } from '@/test/http-server';
import { withSendConnection } from '@/lib/whatsapp/coexistence/send-guard';

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

const messageId = '11111111-1111-4111-8111-111111111111';
let generation = 'epoch-1';
let appId: string | null = 'app-1';
let account = 'account-1';
let role = 'agent';
let graphPosts = 0;
let mirrors = 0;
let credentialLoads = 0;
let rotateOnCredentials = false;
const nativeFetch = globalThis.fetch;

const server = createServer((req, res) => {
  const url = new URL(req.url!, 'http://fixture');
  res.setHeader('Content-Type', 'application/json');

  if (url.pathname === '/auth/v1/user') {
    res.end(JSON.stringify({ id: 'user-1' }));

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
    case '/rest/v1/messages':
      data = {
        id: messageId,
        message_id: 'wamid.inbound',
        conversation_id: 'conversation-1',
      };
      break;
    case '/rest/v1/conversations':
      data =
        account === 'account-1'
          ? {
              id: 'conversation-1',
              account_id: account,
              contact: { phone: '+15551234567', wa_user_id: null },
            }
          : null;
      break;
    case '/rest/v1/whatsapp_config': {
      const credentials =
        url.searchParams.get('select') === 'phone_number_id,access_token';

      if (credentials) {
        credentialLoads++;

        if (rotateOnCredentials) generation = 'epoch-2';
      }

      const row = {
        id: 'config-1',
        account_id: account,
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

    case '/rest/v1/message_reactions':
      mirrors++;
      data = null;
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
  account = 'account-1';
  role = 'agent';
  graphPosts = 0;
  mirrors = 0;
  credentialLoads = 0;
  rotateOnCredentials = false;
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

        return Response.json({
          success: true,
          messages: [{ id: 'wamid.reaction' }],
        });
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

function react(message_id: string | number | null = messageId, emoji = '👍') {
  const session = Buffer.from(
    JSON.stringify({
      access_token: 'fixture-token',
      refresh_token: 'fixture-refresh',
      expires_at: 4102444800,
      user: { id: 'user-1' },
    })
  ).toString('base64url');

  const request = new NextRequest('http://localhost/api/whatsapp/react', {
    method: 'POST',
    headers: { cookie: `sb-127-auth-token=base64-${session}` },
    body: JSON.stringify({ message_id, emoji }),
  });

  const work = createWorkStore({
    page: '/api/whatsapp/react/route',
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

it('sends a managed reaction and mirrors only after Meta accepts it', async () => {
  expect((await react()).status).toBe(200);
  expect(graphPosts).toBe(1);
  expect(mirrors).toBe(2);
});

it('captures scope before credential loading and fences a rotated generation', async () => {
  rotateOnCredentials = true;
  expect((await react()).status).toBe(502);
  expect(credentialLoads).toBe(1);
  expect(graphPosts).toBe(0);
  expect(mirrors).toBe(0);
});

it('preserves an inherited generation rather than upgrading it', async () => {
  generation = 'epoch-2';

  const response = await withSendConnection(
    { accountId: 'account-1', configId: 'config-1', generation: 'epoch-1' },
    () => react()
  );

  expect(response.status).toBe(502);
  expect(graphPosts).toBe(0);
  expect(mirrors).toBe(0);
});

it('still removes legacy reactions with coexistence disabled', async () => {
  appId = null;
  vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'false');
  expect((await react(messageId, '')).status).toBe(200);
  expect(graphPosts).toBe(1);
  expect(mirrors).toBe(1);
});

it.each(['not-a-uuid', 42, null])(
  'rejects invalid message id %s before credential loading',
  async (id) => {
    expect((await react(id)).status).toBe(400);
    expect(credentialLoads).toBe(0);
    expect(graphPosts).toBe(0);
  }
);

it('rejects another tenant conversation', async () => {
  account = 'account-2';
  expect((await react()).status).toBe(404);
  expect(credentialLoads).toBe(0);
  expect(graphPosts).toBe(0);
});

it('rejects a viewer before sending', async () => {
  role = 'viewer';
  expect((await react()).status).toBe(403);
  expect(graphPosts).toBe(0);
});
