import { createServer } from 'node:http';
import { listenForFetch } from '@/test/http-server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

afterEach(() => vi.unstubAllEnvs());

describe('Coexistence worker authorization', () => {
  it.each([
    { countStatus: 200, recoveryStatus: 200, statusClaimStatus: 200 },
    { countStatus: 403, recoveryStatus: 200, statusClaimStatus: 200 },
    { countStatus: 200, recoveryStatus: 403, statusClaimStatus: 200 },
    { countStatus: 200, recoveryStatus: 200, statusClaimStatus: 403 },
  ])(
    'recovers deferred updates without hiding failures: $countStatus/$recoveryStatus/$statusClaimStatus',
    async ({ countStatus, recoveryStatus, statusClaimStatus }) => {
      const requests: string[] = [];

      const server = createServer((request, response) => {
        requests.push(`${request.method} ${request.url}`);
        response.setHeader('Content-Type', 'application/json');

        if (request.url === '/rest/v1/rpc/coexistence_staged_maintenance') {
          response.end(
            JSON.stringify({
              scrubbed: 2,
              deleted: 1,
              signup_tokens_scrubbed: 3,
            })
          );
        } else if (request.url === '/rest/v1/rpc/coexistence_recover_updates') {
          response.statusCode = recoveryStatus;
          response.end(
            JSON.stringify({ applied: 2, quarantined: 1, stale: 0, expired: 0 })
          );
        } else if (
          request.url === '/rest/v1/rpc/coexistence_status_event_claim'
        ) {
          response.statusCode = statusClaimStatus;
          response.end('[]');
        } else if (request.method === 'HEAD') {
          response.statusCode = countStatus;
          response.setHeader('Content-Range', '*/3');
          response.end();
        } else {
          response.end('[]');
        }
      });

      const origin = await listenForFetch(server);
      vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
      vi.stubEnv('WHATSAPP_COEXISTENCE_APP_ID', '9999');
      vi.stubEnv('AUTOMATION_CRON_SECRET', 'scheduler-secret');
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', origin);
      vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-key');

      try {
        const response = await GET(
          new Request('http://localhost/api/whatsapp/coexistence/cron', {
            headers: { 'x-cron-secret': 'scheduler-secret' },
          })
        );

        const succeeded =
          countStatus === 200 &&
          recoveryStatus === 200 &&
          statusClaimStatus === 200;

        expect(response.status).toBe(succeeded ? 200 : 503);
        expect(await response.json()).toEqual(
          succeeded
            ? {
                maintenance: {
                  scrubbed: 2,
                  deleted: 1,
                  signup_tokens_scrubbed: 3,
                },
                completed: 0,
                retried: 0,
                quarantined: 0,
                stale: 0,
                updates: { applied: 2, quarantined: 1, stale: 0, expired: 0 },
                statusEvents: { completed: 0, ambiguous: 0, stale: 0 },
                pendingStatusEvents: 3,
                ambiguousStatusEvents: 3,
                effects: { advanced: 0, completed: 0, ambiguous: 0, stale: 0 },
                pendingEffects: 3,
                ambiguousEffects: 3,
              }
            : { error: 'Coexistence worker failed' }
        );
        expect(requests[0]).toBe(
          'POST /rest/v1/rpc/coexistence_staged_maintenance'
        );
        expect(
          requests.some(
            (request) =>
              request.startsWith('HEAD /rest/v1/coexistence_live_effects?') &&
              request.includes('state=in.%28pending%2Cleased%2Crunning%29')
          )
        ).toBe(recoveryStatus === 200 && statusClaimStatus === 200);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
      }
    }
  );

  it.each([
    { enabled: 'false', appId: '9999' },
    { enabled: 'true', appId: '' },
  ])('cleans without draining: $enabled/$appId', async ({ enabled, appId }) => {
    const requests: string[] = [];

    const maintenance = {
      scrubbed: 100,
      deleted: 0,
      signup_tokens_scrubbed: 1,
    };

    const server = createServer(async (request, response) => {
      requests.push(`${request.method} ${request.url}`);
      let body = '';

      for await (const chunk of request) body += chunk;
      expect(JSON.parse(body)).toEqual({ p_limit: 100 });
      expect(request.headers.authorization).toBe('Bearer test-key');
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(maintenance));
    });

    const origin = await listenForFetch(server);
    vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', enabled);
    vi.stubEnv('WHATSAPP_COEXISTENCE_APP_ID', appId);
    vi.stubEnv('AUTOMATION_CRON_SECRET', 'scheduler-secret');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', origin);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-key');

    try {
      const response = await GET(
        new Request('http://localhost/api/whatsapp/coexistence/cron', {
          headers: { 'x-cron-secret': 'scheduler-secret' },
        })
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        status: 'disabled',
        maintenance,
      });
      expect(requests).toEqual([
        'POST /rest/v1/rpc/coexistence_staged_maintenance',
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it.each([
    { status: 503, body: { message: 'private database failure' } },
    { status: 200, body: null },
    { status: 200, body: [] },
    { status: 200, body: { scrubbed: 0, deleted: 0 } },
    ...[-1, 101, 0.5, '1', null].flatMap((invalid) =>
      ['scrubbed', 'deleted', 'signup_tokens_scrubbed'].map((field) => ({
        status: 200,
        body: {
          scrubbed: 0,
          deleted: 0,
          signup_tokens_scrubbed: 0,
          [field]: invalid,
        },
      }))
    ),
  ])(
    'stops on failed or malformed maintenance: $status/$body',
    async ({ status, body }) => {
      const requests: string[] = [];

      const server = createServer((request, response) => {
        requests.push(`${request.method} ${request.url}`);
        response.statusCode = status;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(body));
      });

      const origin = await listenForFetch(server);
      vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
      vi.stubEnv('WHATSAPP_COEXISTENCE_APP_ID', '9999');
      vi.stubEnv('AUTOMATION_CRON_SECRET', 'scheduler-secret');
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', origin);
      vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-key');

      try {
        const response = await GET(
          new Request('http://localhost/api/whatsapp/coexistence/cron', {
            headers: { 'x-cron-secret': 'scheduler-secret' },
          })
        );

        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({
          error: 'Coexistence worker failed',
        });
        expect(requests).toEqual([
          'POST /rest/v1/rpc/coexistence_staged_maintenance',
        ]);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
      }
    }
  );

  it.each([
    'wrong-secret',
    'AUTOMATION_CRON_SECRET',
    'NEXT_PUBLIC_SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
  ])(
    'never writes with invalid authorization/configuration: %s',
    async (missing) => {
      const requests: string[] = [];

      const server = createServer((request, response) => {
        requests.push(`${request.method} ${request.url}`);
        response.end('{}');
      });

      const origin = await listenForFetch(server);
      vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'false');
      vi.stubEnv('AUTOMATION_CRON_SECRET', 'scheduler-secret');
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', origin);
      vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-key');

      if (missing !== 'wrong-secret') vi.stubEnv(missing, '');

      try {
        const response = await GET(
          new Request('http://localhost/api/whatsapp/coexistence/cron', {
            headers: {
              'x-cron-secret':
                missing === 'wrong-secret' ? 'wrong' : 'scheduler-secret',
            },
          })
        );

        expect(response.status).toBe(missing === 'wrong-secret' ? 401 : 503);
        expect(requests).toEqual([]);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
      }
    }
  );

  it('cancels maintenance without starting follow-up work', async () => {
    const controller = new AbortController();
    const requests: string[] = [];

    const server = createServer((request) => {
      requests.push(`${request.method} ${request.url}`);
      controller.abort();
    });

    const origin = await listenForFetch(server);
    vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
    vi.stubEnv('WHATSAPP_COEXISTENCE_APP_ID', '9999');
    vi.stubEnv('AUTOMATION_CRON_SECRET', 'scheduler-secret');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', origin);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-key');

    try {
      const response = await GET(
        new Request('http://localhost/api/whatsapp/coexistence/cron', {
          headers: { 'x-cron-secret': 'scheduler-secret' },
          signal: controller.signal,
        })
      );

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: 'Coexistence worker failed',
      });
      expect(requests).toEqual([
        'POST /rest/v1/rpc/coexistence_staged_maintenance',
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('rejects an invalid scheduler secret before touching the database', async () => {
    vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
    vi.stubEnv('WHATSAPP_COEXISTENCE_APP_ID', '9999');
    vi.stubEnv('AUTOMATION_CRON_SECRET', 'scheduler-secret');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:1');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-key');

    const response = await GET(
      new Request('http://localhost/api/whatsapp/coexistence/cron', {
        headers: { 'x-cron-secret': 'wrong' },
      })
    );

    expect(response.status).toBe(401);
  });
});
