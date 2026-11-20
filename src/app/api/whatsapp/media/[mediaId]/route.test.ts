import { createServer, type Server } from 'node:http';
import { listenForFetch } from '@/test/http-server';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ origin: '', user: true, rateLimitOk: true }));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    const { createClient } = await import('@supabase/supabase-js');
    const db = createClient(h.origin, 'fixture-user-key');

    return {
      auth: {
        getUser: async () => ({
          data: { user: h.user ? { id: 'user-1' } : null },
          error: null,
        }),
      },
      from: db.from.bind(db),
    };
  },
}));

vi.mock('@/lib/rate-limit', () => ({
  RATE_LIMITS: { whatsappMedia: { limit: 240, windowMs: 60_000 } },
  checkRateLimit: () => ({ success: h.rateLimitOk }),
  rateLimitResponse: () =>
    Response.json(
      { error: 'Rate limit exceeded' },
      {
        status: 429,
        headers: { 'Retry-After': '60', 'X-RateLimit-Remaining': '0' },
      }
    ),
}));

type Config = {
  id: string;
  account_id: string;
  user_id: string;
  phone_number_id: string;
  access_token: string;
  status: string;
  coexistence_app_id: string | null;
  coexistence_generation: string;
};

let server: Server;
let config: Config;
let otherManaged: boolean;

type HttpBody = z.infer<ReturnType<typeof z.json>>;

let privateMedia: HttpBody;
let ledgerFails: boolean;
let signupMediaAllowed: boolean | null | { allowed: boolean };
let signupRpcFails: boolean;
let profileAccount: string | null;
let ownerAccount: string | null;
let afterDownload: () => void;
let graphRequests: URL[];
let downloads: number;
let contentType: string;
let GET: typeof import('./route').GET;

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('ENCRYPTION_KEY', 'ab'.repeat(32));
  const { encrypt } = await import('@/lib/whatsapp/encryption');
  config = {
    id: 'config-1',
    account_id: 'acc-1',
    user_id: 'owner-1',
    phone_number_id: '1234',
    access_token: encrypt('test-token'),
    status: 'connected',
    coexistence_app_id: null,
    coexistence_generation: 'epoch-1',
  };
  otherManaged = false;
  privateMedia = false;
  signupMediaAllowed = true;
  signupRpcFails = false;
  ledgerFails = false;
  profileAccount = ownerAccount = 'acc-1';
  afterDownload = () => {};

  graphRequests = [];
  downloads = 0;
  contentType = 'image/jpeg';
  h.user = h.rateLimitOk = true;
  server = createServer(async (request, response) => {
    const url = new URL(request.url!, h.origin);
    let result: HttpBody = null;

    if (url.pathname === '/rest/v1/whatsapp_config') {
      const managedOnly = url.searchParams.has('coexistence_app_id');
      result = managedOnly
        ? otherManaged
          ? [{ ...config, id: 'other', coexistence_app_id: '999' }]
          : []
        : [config];

      if (request.headers.accept?.includes('vnd.pgrst.object')) result = config;
    } else if (url.pathname === '/rest/v1/profiles') {
      const account =
        url.searchParams.get('user_id') === 'eq.owner-1'
          ? ownerAccount
          : profileAccount;

      result = account ? { account_id: account } : null;
    } else if (
      url.pathname === '/rest/v1/rpc/coexistence_signup_media_allowed'
    ) {
      let raw = '';

      for await (const chunk of request) raw += chunk;
      expect(JSON.parse(raw)).toEqual({
        p_account_id: config.account_id,
        p_config_id: config.id,
        p_generation: config.coexistence_generation,
      });
      result = signupMediaAllowed;

      if (signupRpcFails) {
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ message: 'gate unavailable' }));

        return;
      }
    } else if (url.pathname === '/rest/v1/rpc/coexistence_is_private_media') {
      result = privateMedia;

      if (ledgerFails) {
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ message: 'ledger unavailable' }));

        return;
      }
    } else if (url.pathname === '/meta') {
      graphRequests.push(url);
      result = {
        id: '1234567890',
        url: `${h.origin}/bytes`,
        mime_type: contentType,
        file_size: '3',
      };
    } else if (url.pathname === '/bytes') {
      downloads++;
      afterDownload();
      response.writeHead(200, { 'Content-Type': contentType });
      response.end('abc');

      return;
    }

    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(result));
  });
  h.origin = await listenForFetch(server);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', h.origin);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'fixture-service-key');
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));

    if (url.hostname === 'graph.facebook.com')
      return realFetch(`${h.origin}/meta${url.search}`, init);

    if (url.origin !== h.origin) throw new Error('Unexpected external request');

    return realFetch(input, init);
  });
  ({ GET } = await import('./route'));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});

function call(mediaId = '1234567890') {
  return GET(new Request(`http://localhost/api/whatsapp/media/${mediaId}`), {
    params: Promise.resolve({ mediaId }),
  });
}

describe('legacy raw media access through controlled HTTP', () => {
  it.each([
    'active attempt',
    'RPC error',
    'null response',
    'malformed response',
  ])(
    'denies signup %s before lookup and after bytes, regardless of flags',
    async (scenario) => {
      vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'false');

      const block = () => {
        if (scenario === 'active attempt') signupMediaAllowed = false;

        if (scenario === 'RPC error') signupRpcFails = true;

        if (scenario === 'null response') signupMediaAllowed = null;

        if (scenario === 'malformed response')
          signupMediaAllowed = { allowed: true };
      };

      afterDownload = block;
      const response = await call();
      expect(response.status).toBe(404);
      expect(await response.text()).not.toBe('abc');
      expect(downloads).toBe(1);

      graphRequests = [];
      downloads = 0;
      expect((await call()).status).toBe(404);
      expect(graphRequests).toEqual([]);
      expect(downloads).toBe(0);
    }
  );

  it.each([
    { scenario: 'private', status: 404 },
    { scenario: 'managed', status: 404 },
    { scenario: 'unauthenticated', status: 401 },
    { scenario: 'unlinked', status: 403 },
    { scenario: 'rate limited', status: 429 },
    { scenario: 'invalid media ID', status: 400 },
    { scenario: 'invalid credential', status: 500 },
  ])(
    'hardens $scenario errors without changing their response contract',
    async ({ scenario, status }) => {
      if (scenario === 'private') privateMedia = true;

      if (scenario === 'managed') config.coexistence_app_id = '999';

      if (scenario === 'unauthenticated') h.user = false;

      if (scenario === 'unlinked') profileAccount = null;

      if (scenario === 'rate limited') h.rateLimitOk = false;

      if (scenario === 'invalid credential') config.access_token = 'invalid';

      const res = await call(
        scenario === 'invalid media ID' ? 'invalid' : '1234567890'
      );

      expect(res.status).toBe(status);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-security-policy')).toBe(
        "default-src 'none'; sandbox"
      );
      expect(res.headers.get('content-type')).toContain('application/json');
      await expect(res.json()).resolves.toHaveProperty('error');

      if (status === 429) {
        expect(res.headers.get('retry-after')).toBe('60');
        expect(res.headers.get('x-ratelimit-remaining')).toBe('0');
      }
    }
  );
  it.each([
    'private',
    'rpc failure',
    'malformed rpc',
    'managed sibling',
    'owner moved',
    'disconnected',
    'missing phone',
  ])('denies %s before any Meta request', async (scenario) => {
    if (scenario === 'private') privateMedia = true;

    if (scenario === 'rpc failure') ledgerFails = true;

    if (scenario === 'malformed rpc') privateMedia = { private: false };

    if (scenario === 'managed sibling') otherManaged = true;

    if (scenario === 'owner moved') ownerAccount = 'other';

    if (scenario === 'disconnected') config.status = 'disconnected';

    if (scenario === 'missing phone') config.phone_number_id = '';
    expect((await call()).status).toBe(404);
    expect(graphRequests).toEqual([]);
    expect(downloads).toBe(0);
  });

  it.each([
    'private',
    'rpc failure',
    'malformed rpc',
    'managed sibling',
    'owner moved',
    'caller moved',
    'disconnected',
    'token changed',
    'generation changed',
    'phone changed',
    'managed',
  ])('withholds downloaded bytes after %s', async (scenario) => {
    afterDownload = () => {
      if (scenario === 'private') privateMedia = true;

      if (scenario === 'rpc failure') ledgerFails = true;

      if (scenario === 'malformed rpc') privateMedia = null;

      if (scenario === 'managed sibling') otherManaged = true;

      if (scenario === 'owner moved') ownerAccount = 'other';

      if (scenario === 'caller moved') profileAccount = 'other';

      if (scenario === 'disconnected') config.status = 'disconnected';

      if (scenario === 'token changed') config.access_token = 'changed';

      if (scenario === 'generation changed')
        config.coexistence_generation = 'epoch-2';

      if (scenario === 'phone changed') config.phone_number_id = '5678';

      if (scenario === 'managed') config.coexistence_app_id = '999';
    };

    const res = await call();
    expect(res.status).toBe(404);
    expect(await res.text()).not.toBe('abc');
    expect(downloads).toBe(1);
  });

  it.each(['text/html; charset=utf-8', 'image/svg+xml', 'application/pdf'])(
    'keeps legacy %s downloads as attachments',
    async (mime) => {
      contentType = mime;
      const res = await call();
      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toMatch(/^attachment/);
    }
  );

  it('rejects unauthenticated requests without Meta access', async () => {
    h.user = false;
    expect((await call()).status).toBe(401);
    expect(graphRequests).toEqual([]);
  });

  it('preserves rate limiting', async () => {
    h.rateLimitOk = false;
    expect((await call()).status).toBe(429);
    expect(graphRequests).toEqual([]);
  });

  it('rejects an unlinked caller without Meta access', async () => {
    profileAccount = null;
    expect((await call()).status).toBe(403);
    expect(graphRequests).toEqual([]);
  });

  it('rejects graph-path injection without Meta access', async () => {
    expect((await call('123?fields=access_token')).status).toBe(400);
    expect(graphRequests).toEqual([]);
  });
  it('denies managed configurations even with Coexistence disabled', async () => {
    config.coexistence_app_id = '999';
    vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'false');
    expect((await call()).status).toBe(404);
    expect(graphRequests).toEqual([]);
    expect(downloads).toBe(0);
  });

  it.each(['ordinary account', 'unrelated account with an active signup'])(
    'preserves phone-owned delivery when the scoped RPC allows an %s',
    async () => {
      signupMediaAllowed = true;
      const res = await call();
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('abc');
      expect(graphRequests[0]?.searchParams.get('phone_number_id')).toBe(
        '1234'
      );
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(res.headers.get('content-type')).toBe('image/jpeg');
      expect(res.headers.get('content-disposition')).toBe('inline');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-security-policy')).toBe(
        "default-src 'none'; sandbox"
      );
    }
  );
});
