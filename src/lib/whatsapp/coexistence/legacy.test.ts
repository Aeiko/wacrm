import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { listenForFetch } from '@/test/http-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const rowSchema = z.record(z.string(), z.json());

type Row = z.infer<typeof rowSchema>;

const accountId = '00000000-0000-4000-8000-000000000001';
const configId = '00000000-0000-4000-8000-000000000002';
let server: Server;
let origin: string;
let config: Row;
let posts: Row[];
let logs: Row[];
let onboardOnContactLookup: boolean;
let legacy: typeof import('./legacy');
let intake: typeof import('./intake');

type PrivateMediaResponse = boolean | null | { private?: boolean };

let privateMedia: PrivateMediaResponse;
let mediaLookups: number;
let mediaDownloads: number;
let uploads: string[];
let uploadMetadata: Row[];
let beforeStorageUpload: () => void;
let savedMessages: Row[];
let afterMediaDownload: () => void;
let afterMediaLookup: () => void;
let ledgerFails: boolean;
let signupMediaAllowed: boolean | null | { allowed: boolean };
let signupRpcFails: boolean;
let managedSibling: boolean;
let ownerAccount: string | null;
let downloadError: Error | null;

function onboard() {
  Object.assign(config, {
    coexistence_app_id: '9999',
    coexistence_generation: '00000000-0000-4000-8000-000000000004',
    coexistence_verified_at: new Date().toISOString(),
  });
}

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('ENCRYPTION_KEY', 'ab'.repeat(32));
  vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
  vi.stubEnv('WHATSAPP_COEXISTENCE_APP_ID', '9999');
  vi.stubEnv('WHATSAPP_COEXISTENCE_APP_SECRET', 'coexistence-test-secret');
  vi.stubEnv('WHATSAPP_COEXISTENCE_PARTNER_BUSINESS_ID', '8888');
  vi.stubEnv('META_APP_SECRET', 'legacy-test-secret');
  posts = [];
  logs = [];
  onboardOnContactLookup = false;
  privateMedia = false;
  signupMediaAllowed = true;
  signupRpcFails = false;
  mediaLookups = mediaDownloads = 0;
  uploads = [];
  uploadMetadata = [];
  beforeStorageUpload = () => {};

  savedMessages = [];
  afterMediaDownload = () => {};

  afterMediaLookup = () => {};

  ledgerFails = managedSibling = false;
  ownerAccount = accountId;
  downloadError = null;
  const { encrypt } = await import('../encryption');
  config = {
    id: configId,
    account_id: accountId,
    user_id: 'user-1',
    phone_number_id: '1234',
    waba_id: '5678',
    access_token: encrypt('token-1'),
    status: 'connected',
    coexistence_app_id: null,
    coexistence_generation: '00000000-0000-4000-8000-000000000003',
    coexistence_verified_at: null,
  };

  const contact = {
    id: 'contact-1',
    account_id: accountId,
    phone: '15551234567',
    name: 'Ada',
  };

  const conversation = {
    id: 'conversation-1',
    account_id: accountId,
    contact_id: contact.id,
    status: 'open',
    first_inbound_at: '2026-01-01T00:00:00Z',
  };

  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, origin);
      let raw = '';

      for await (const chunk of request) raw += chunk;

      if (url.pathname.startsWith('/storage/v1/object/chat-media/')) {
        beforeStorageUpload();

        const metadata = z
          .string()
          .optional()
          .parse(request.headers['x-metadata']);

        uploadMetadata.push(
          rowSchema.parse(
            metadata
              ? JSON.parse(Buffer.from(metadata, 'base64').toString('utf8'))
              : {}
          )
        );
        uploads.push(url.pathname);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ Key: 'chat-media/mirrored.jpg' }));

        return;
      }

      if (url.pathname === '/rest/v1/rpc/coexistence_ingress') {
        expect(JSON.parse(raw)).toEqual({
          p_app_id: '9999',
          p_partner_business_id: '8888',
          p_enabled: true,
          p_authorized: false,
          p_changes: [
            {
              entry_id: '5678',
              field: 'messages',
              value: envelope.entry[0].changes[0].value,
              dedupe_key: expect.stringMatching(/^[a-f0-9]{64}:0:0$/),
            },
          ],
        });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            status: 200,
            legacy_indices: [0],
            captured: 0,
            staged: 0,
          })
        );

        return;
      }

      if (url.pathname === '/rest/v1/rpc/coexistence_signup_media_allowed') {
        expect(JSON.parse(raw)).toEqual({
          p_account_id: accountId,
          p_config_id: configId,
          p_generation: '00000000-0000-4000-8000-000000000003',
        });
        response.writeHead(signupRpcFails ? 500 : 200, {
          'Content-Type': 'application/json',
        });
        response.end(JSON.stringify(signupMediaAllowed));

        return;
      }

      if (url.pathname === '/rest/v1/rpc/coexistence_is_private_media') {
        response.writeHead(ledgerFails ? 500 : 200, {
          'Content-Type': 'application/json',
        });
        response.end(JSON.stringify(privateMedia));

        return;
      }

      if (url.pathname === '/meta/media') {
        mediaLookups++;
        afterMediaLookup();
        expect(url.searchParams.get('phone_number_id')).toBe('1234');
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            url: `${origin}/meta/bytes`,
            mime_type: 'image/jpeg',
            file_size: 3,
          })
        );

        return;
      }

      if (url.pathname === '/meta/bytes') {
        mediaDownloads++;
        afterMediaDownload();
        response.writeHead(200, { 'Content-Type': 'image/jpeg' });
        response.end('abc');

        return;
      }

      const body = raw ? rowSchema.parse(JSON.parse(raw)) : {};
      let rows: Row[] = [];

      if (url.pathname === '/meta/messages') {
        posts.push(body);
        rows = [{ messages: [{ id: `wamid.out-${posts.length}` }] }];
      } else if (url.pathname === '/rest/v1/whatsapp_config') {
        rows = url.searchParams.has('coexistence_app_id')
          ? managedSibling
            ? [{ ...config, coexistence_app_id: '9999' }]
            : []
          : [config];
      } else if (url.pathname === '/rest/v1/profiles') {
        rows = ownerAccount ? [{ account_id: ownerAccount }] : [];
      } else if (url.pathname === '/rest/v1/contacts') {
        if (onboardOnContactLookup) onboard();
        rows = [contact];
      } else if (url.pathname === '/rest/v1/conversations') {
        rows = [conversation];
      } else if (url.pathname === '/rest/v1/rpc/persist_outbound_message') {
        const message = rowSchema.parse(body.p_message);
        rows = [
          {
            id: '00000000-0000-4000-8000-000000000005',
            message_id: message.message_id ?? null,
            status: 'sent',
          },
        ];
      } else if (url.pathname === '/rest/v1/messages') {
        if (request.method === 'POST') savedMessages.push(body);
        rows = [{ id: 'message-1', ...body }];
      } else if (url.pathname === '/rest/v1/automations') {
        if (url.searchParams.get('trigger_type') === 'eq.new_message_received')
          rows = [
            {
              id: 'automation-1',
              account_id: accountId,
              user_id: 'user-1',
              trigger_type: 'new_message_received',
              trigger_config: {},
              is_active: true,
            },
          ];
      } else if (url.pathname === '/rest/v1/automation_steps') {
        rows = [
          {
            id: 'step-1',
            automation_id: 'automation-1',
            step_type: 'send_message',
            position: 0,
            parent_step_id: null,
            branch: null,
            step_config: { text: 'Automatic reply' },
          },
        ];
      } else if (url.pathname === '/rest/v1/automation_logs') {
        if (request.method === 'POST') logs.push({ id: 'log-1', ...body });
        rows = logs;
      }

      const result =
        url.pathname === '/meta/messages' ||
        url.pathname === '/rest/v1/rpc/persist_outbound_message' ||
        request.headers.accept?.includes('vnd.pgrst.object')
          ? (rows[0] ?? null)
          : rows;

      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ message: String(error) }));
    }
  });
  origin = await listenForFetch(server);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', origin);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-key');
  const fetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));

    if (url.hostname === 'graph.facebook.com')
      return fetch(
        `${origin}/meta/${init?.method === 'POST' ? 'messages' : 'media'}${url.search}`,
        init
      );

    if (url.pathname === '/meta/bytes' && downloadError)
      return Promise.reject(downloadError);

    if (url.origin !== origin) throw new Error('Unexpected external request');

    return fetch(input, init);
  });

  // Module loading belongs to fixture setup, not the HTTP behavior timeout.
  legacy = await import('./legacy');
  intake = await import('./intake');
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});

const envelope = {
  entry: [
    {
      id: '5678',
      changes: [
        {
          field: 'messages',
          value: {
            metadata: { phone_number_id: '1234' },
            contacts: [{ wa_id: '15551234567', profile: { name: 'Ada' } }],
            messages: [
              {
                id: 'wamid.in-1',
                from: '15551234567',
                timestamp: '1700000000',
                type: 'text',
                text: { body: 'Hello' },
              },
            ],
          },
        },
      ],
    },
  ],
};

async function acceptLegacyDelivery() {
  const { createClient } = await import('@supabase/supabase-js');
  const body = JSON.stringify(envelope);
  const signature = `sha256=${createHmac('sha256', 'legacy-test-secret').update(body).digest('hex')}`;

  expect(
    await intake.captureCoexistenceWebhook(
      body,
      signature,
      createClient(origin, 'test-service-key')
    )
  ).toBeNull();
}

async function processAcceptedDelivery() {
  await legacy.processLegacyWebhook(legacy.legacyWebhookSchema.parse(envelope));
}

async function processMediaDelivery() {
  const value = envelope.entry[0].changes[0].value;
  await legacy.processLegacyWebhook(
    legacy.legacyWebhookSchema.parse({
      entry: [
        {
          id: '5678',
          changes: [
            {
              field: 'messages',
              value: {
                ...value,
                messages: [
                  {
                    id: 'wamid.image-1',
                    from: '15551234567',
                    timestamp: '1700000000',
                    type: 'image',
                    image: { id: '9876', mime_type: 'image/jpeg' },
                  },
                ],
              },
            },
          ],
        },
      ],
    })
  );
}

describe('accepted legacy webhook continuations through HTTP boundaries', () => {
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

      afterMediaDownload = block;
      await processMediaDelivery();
      expect(uploads).toEqual([]);
      expect(mediaDownloads).toBe(1);
      expect(savedMessages[0]?.media_url).toBeNull();

      mediaLookups = mediaDownloads = 0;
      await processMediaDelivery();
      expect(mediaLookups).toBe(0);
      expect(mediaDownloads).toBe(0);
      expect(uploads).toEqual([]);
      expect(savedMessages.every((message) => message.media_url === null)).toBe(
        true
      );
    }
  );

  it('redacts download transport errors while retaining the legitimate proxy fallback', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      downloadError = new Error('transport leaked secret-token-and-url');
      await processMediaDelivery();
      expect(uploads).toEqual([]);
      expect(savedMessages[0]?.media_url).toBe('/api/whatsapp/media/9876');
      expect(JSON.stringify(warn.mock.calls)).not.toContain(
        'secret-token-and-url'
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('preserves public mirroring of ordinary legacy media', async () => {
    await processMediaDelivery();
    expect(uploads).toHaveLength(1);
    expect(mediaDownloads).toBe(1);
    expect(uploadMetadata).toEqual([
      {
        connection_config_id: configId,
        connection_generation: '00000000-0000-4000-8000-000000000003',
      },
    ]);
    expect(savedMessages[0]?.media_url).toContain(
      '/storage/v1/object/public/chat-media/'
    );
  });

  it('sends the captured origin, not a replacement legacy epoch, at the Storage boundary', async () => {
    beforeStorageUpload = () => {
      config.id = '00000000-0000-4000-8000-000000000005';
      config.coexistence_generation = '00000000-0000-4000-8000-000000000004';
    };

    await processMediaDelivery();

    expect(uploadMetadata).toEqual([
      {
        connection_config_id: configId,
        connection_generation: '00000000-0000-4000-8000-000000000003',
      },
    ]);
  });

  it.each(['after lookup', 'after bytes'])(
    'does not upload or expose a proxy after private classification %s',
    async (timing) => {
      const classifyPrivate = () => {
        privateMedia = true;
      };

      if (timing === 'after lookup') afterMediaLookup = classifyPrivate;
      else afterMediaDownload = classifyPrivate;
      await processMediaDelivery();
      expect(uploads).toEqual([]);
      expect(mediaLookups).toBe(1);
      expect(mediaDownloads).toBe(timing === 'after bytes' ? 1 : 0);
      expect(savedMessages).toHaveLength(1);
      expect(savedMessages[0]?.media_url).toBeNull();
    }
  );

  it.each([
    'managed',
    'generation changed',
    'token changed',
    'owner moved',
    'phone changed',
    'disconnected',
    'ledger failure',
    'malformed ledger',
    'managed sibling',
  ])(
    'suppresses the public upload when %s while bytes are in flight',
    async (scenario) => {
      afterMediaDownload = () => {
        if (scenario === 'managed') onboard();

        if (scenario === 'generation changed')
          config.coexistence_generation = 'new-epoch';

        if (scenario === 'token changed') config.access_token = 'changed';

        if (scenario === 'owner moved') ownerAccount = null;

        if (scenario === 'phone changed') config.phone_number_id = '4321';

        if (scenario === 'disconnected') config.status = 'disconnected';

        if (scenario === 'ledger failure') ledgerFails = true;

        if (scenario === 'malformed ledger') privateMedia = null;

        if (scenario === 'managed sibling') managedSibling = true;
      };

      await processMediaDelivery();
      expect(uploads).toEqual([]);
      expect(mediaDownloads).toBe(1);
      expect(savedMessages).toHaveLength(1);
      expect(savedMessages[0]?.media_url).toBeNull();
    }
  );

  it.each([
    'ledger failure',
    'malformed ledger',
    'missing owner',
    'managed sibling',
    'missing phone',
  ])(
    'keeps message ingestion best-effort but denies media for %s',
    async (scenario) => {
      if (scenario === 'ledger failure') ledgerFails = true;

      if (scenario === 'malformed ledger') privateMedia = {};

      if (scenario === 'missing owner') ownerAccount = null;

      if (scenario === 'managed sibling') managedSibling = true;

      if (scenario === 'missing phone') config.phone_number_id = '';
      await processMediaDelivery();
      expect(uploads).toEqual([]);
      expect(mediaLookups).toBe(0);
      expect(savedMessages).toHaveLength(1);
      expect(savedMessages[0]?.media_url).toBeNull();
    }
  );

  it('does not expose a raw proxy for private media with mirroring disabled', async () => {
    privateMedia = true;
    config.mirror_inbound_media = false;
    await processMediaDelivery();
    expect(uploads).toEqual([]);
    expect(mediaLookups).toBe(0);
    expect(savedMessages[0]?.media_url).toBeNull();
  });

  it('never copies a known private ID into public storage', async () => {
    privateMedia = true;
    await processMediaDelivery();
    expect(uploads).toEqual([]);
    expect(mediaLookups).toBe(0);
    expect(mediaDownloads).toBe(0);
    expect(savedMessages[0]?.media_url).toBeNull();
  });
  it.each(['before processing', 'during contact lookup'])(
    'does not adopt managed credentials after onboarding %s',
    async (timing) => {
      await acceptLegacyDelivery();

      if (timing === 'before processing') onboard();
      else onboardOnContactLookup = true;

      await processAcceptedDelivery();

      expect(posts).toEqual([]);
      expect(logs).toEqual([
        expect.objectContaining({
          send_config_id: null,
          send_generation: null,
        }),
      ]);
    }
  );

  it('still sends the automatic reply while the connection remains legacy', async () => {
    await acceptLegacyDelivery();
    await processAcceptedDelivery();

    expect(posts).toEqual([
      expect.objectContaining({
        type: 'text',
        text: { body: 'Automatic reply' },
      }),
    ]);
  });
});
