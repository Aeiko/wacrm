import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { buffer } from 'node:stream/consumers';
import { listenForFetch } from '@/test/http-server';
import { expect, it, vi } from 'vitest';
import type { z } from 'zod';
import type { historySchema, stateSchema } from './payload';

const webhookPath = '/api/whatsapp/webhook';
const signatureHeader = 'x-hub-signature-256';

const tenantA = {
  waba: '880007',
  phoneId: '880008',
  businessPhone: '12025550100',
};

const tenantB = {
  waba: '880017',
  phoneId: '880018',
  businessPhone: '12025550101',
};

const tenantC = {
  waba: '880027',
  phoneId: '880028',
  businessPhone: '12025550105',
};

function delivery(
  tenant: typeof tenantA,
  field: 'history' | 'smb_app_state_sync',
  content:
    | Omit<z.input<typeof historySchema>, 'metadata'>
    | Omit<z.input<typeof stateSchema>, 'metadata'>
) {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: tenant.waba,
        changes: [
          {
            field,
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                phone_number_id: tenant.phoneId,
                display_phone_number: tenant.businessPhone,
              },
              ...content,
            },
          },
        ],
      },
    ],
  });
}

function historyChunk(
  chunkOrder: number,
  progress: number,
  participant: string,
  from: string,
  id: string,
  timestamp: string,
  body: string
) {
  return {
    history: [
      {
        metadata: { phase: 0, chunk_order: chunkOrder, progress },
        threads: [
          {
            id: participant,
            messages: [{ from, id, timestamp, type: 'text', text: { body } }],
          },
        ],
      },
    ],
  };
}

// The launcher opts in only after provisioning fixture bindings on disposable PostgreSQL.
it.runIf(process.env.WACRM_HISTORY_IMPORT_REHEARSAL === '1')(
  'settles signed history and contacts independently by projection choice at capture and commit',
  async () => {
    const origin = process.env.WACRM_REHEARSAL_RPC_ORIGIN;
    const serviceKey = process.env.WACRM_REHEARSAL_SERVICE_KEY;

    const before079 = process.env.WACRM_REHEARSAL_BEFORE_079 === '1';

    if (
      !origin ||
      !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(origin) ||
      !serviceKey
    )
      throw new Error('Expected a disposable loopback bridge and fixture key');

    const rpcUrls = new Set(
      ['ingress', 'claim', 'commit', 'fail'].map(
        (rpc) => `${origin}/rest/v1/rpc/coexistence_${rpc}`
      )
    );

    const allowed = new Set(rpcUrls);
    const secret = randomBytes(32).toString('hex');
    const nativeFetch = globalThis.fetch;
    let deniedRequests = 0;
    let rpcRequests = 0;

    const guardedFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);

      if (
        /\/(?:smb_app_data|messages)(?:\/|$)/.test(url.pathname) ||
        request.method !== 'POST' ||
        !allowed.has(request.url)
      ) {
        deniedRequests++;
        throw new Error('Unexpected history rehearsal HTTP request');
      }

      if (rpcUrls.has(request.url)) rpcRequests++;

      return nativeFetch(request, {
        redirect: 'error',
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
      });
    };

    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', origin);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', serviceKey);
    vi.stubEnv('ENCRYPTION_KEY', randomBytes(32).toString('hex'));
    vi.stubEnv('META_APP_SECRET', randomBytes(32).toString('hex'));
    vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
    vi.stubEnv('WHATSAPP_COEXISTENCE_APP_ID', '880005');
    vi.stubEnv('WHATSAPP_COEXISTENCE_PARTNER_BUSINESS_ID', '880006');
    vi.stubEnv('WHATSAPP_COEXISTENCE_APP_SECRET', secret);
    vi.stubGlobal('fetch', guardedFetch);
    vi.resetModules();

    const server = createServer();

    try {
      const [{ POST }, { drainCoexistenceJobs }, { createClient }] =
        await Promise.all([
          import('@/app/api/whatsapp/webhook/route'),
          import('./worker'),
          import('@supabase/supabase-js'),
        ]);

      const db = createClient(origin, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      const webhookUrl = (await listenForFetch(server)) + webhookPath;

      server.on('request', (incoming, reply) => {
        if (incoming.method !== 'POST' || incoming.url !== webhookPath) {
          reply.writeHead(404).end();

          return;
        }

        void (async () => {
          const headers = new Headers();
          const signatures = incoming.headersDistinct[signatureHeader];

          if (signatures?.length === 1)
            headers.set(signatureHeader, signatures[0]);

          const response = await POST(
            new Request(webhookUrl, {
              method: 'POST',
              headers,
              body: await buffer(incoming),
            })
          );

          reply.writeHead(
            response.status,
            Object.fromEntries(response.headers)
          );
          reply.end(Buffer.from(await response.arrayBuffer()));
        })().catch(() => reply.writeHead(500).end());
      });
      allowed.add(webhookUrl);

      const post = (body: string, signingKey = secret) =>
        fetch(webhookUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [signatureHeader]: `sha256=${createHmac('sha256', signingKey).update(body).digest('hex')}`,
          },
          body,
        });

      const drained = { completed: 1, retried: 0, quarantined: 0, stale: 0 };
      const replay = { ...drained, completed: 0 };
      const denied = before079 ? drained : { ...replay, quarantined: 1 };

      const receiveAndDrain = async (
        body: string,
        settlement: typeof drained
      ) => {
        const response = await post(body);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ status: 'received' });
        expect(await drainCoexistenceJobs(db)).toEqual(settlement);
      };

      const deniedHistory = (tenant: typeof tenantA) => {
        const id = `wamid.rehearsal.unapproved.${tenant.phoneId}`;

        return delivery(tenant, 'history', {
          history: [
            {
              metadata: { phase: 0, chunk_order: 99, progress: 100 },
              threads: [
                {
                  id: '12025550103',
                  messages: [
                    {
                      from: '12025550103',
                      id,
                      timestamp: '1700000120',
                      type: 'image',
                      image: { id: `fixture-initial-${tenant.phoneId}` },
                    },
                  ],
                },
              ],
            },
          ],
          messages: [
            {
              id,
              timestamp: '1700000180',
              type: 'image',
              image: {
                id: `fixture-hydration-${tenant.phoneId}`,
                mime_type: 'image/jpeg',
              },
            },
          ],
        });
      };

      const outgoing = delivery(
        tenantA,
        'history',
        historyChunk(
          2,
          100,
          '12025550102',
          tenantA.businessPhone,
          'wamid.rehearsal.history.out',
          '1700000060',
          'Synthetic outgoing history'
        )
      );

      const incoming = delivery(
        tenantA,
        'history',
        historyChunk(
          1,
          50,
          '12025550102',
          '12025550102',
          'wamid.rehearsal.history.in',
          '1700000000',
          'Synthetic incoming history'
        )
      );

      expect(
        (await post(outgoing, randomBytes(32).toString('hex'))).status
      ).toBe(401);
      expect(rpcRequests).toBe(0);

      // The launcher grants only after this unseen history job is committed to PG.
      const preGrant = deniedHistory(tenantA);
      await receiveAndDrain(preGrant, denied);
      await receiveAndDrain(preGrant, replay);
      await receiveAndDrain(outgoing, drained);
      await receiveAndDrain(incoming, drained);
      await receiveAndDrain(incoming, replay);

      await receiveAndDrain(deniedHistory(tenantB), denied);
      await receiveAndDrain(deniedHistory(tenantC), denied);

      for (const tenant of [tenantA, tenantB, tenantC]) {
        await receiveAndDrain(
          delivery(tenant, 'smb_app_state_sync', {
            state_sync: [
              {
                type: 'contact',
                action: 'add',
                contact: {
                  phone_number: '12025550104',
                  full_name: 'Synthetic address-book only',
                },
                metadata: { timestamp: '1700000180' },
              },
            ],
          }),
          tenant === tenantC ? drained : denied
        );
      }
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      expect(deniedRequests).toBe(0);
    }
  },
  60_000
);
