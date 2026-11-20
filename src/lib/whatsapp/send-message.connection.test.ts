import { createClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from './encryption';
import { sendMessageToConversation } from './send-message';
import { withStoredSendConnection } from './coexistence/send-guard';

const accountId = 'account-1';

const params = {
  conversationId: 'conversation-1',
  messageType: 'text',
  contentText: 'hello',
};

const db = () =>
  createClient('http://127.0.0.1:54321', 'fixture-key', {
    auth: { persistSession: false, autoRefreshToken: false },
  });

let posts = 0;
let credentialReads = 0;
let rotate = false;
let configWrites = 0;

beforeEach(() => {
  posts = 0;
  credentialReads = 0;
  configWrites = 0;
  rotate = false;
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'fixture-service-key');
  vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
  vi.stubEnv('WHATSAPP_COEXISTENCE_APP_ID', 'app-1');
  vi.stubEnv('WHATSAPP_COEXISTENCE_APP_SECRET', 'fixture-app-secret');
  vi.stubEnv('WHATSAPP_COEXISTENCE_PARTNER_BUSINESS_ID', '123456789');
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));

      if (url.hostname === 'graph.facebook.com') {
        posts++;

        return Response.json({ messages: [{ id: 'wamid.fixture' }] });
      }

      const table = url.pathname.split('/').pop();

      const single = new Headers(init?.headers)
        .get('accept')
        ?.includes('vnd.pgrst.object');

      if (table === 'whatsapp_config') {
        if (init?.method === 'PATCH') configWrites++;
        const isCredentials = url.searchParams.get('select') === '*';

        if (isCredentials) credentialReads++;

        const row = {
          id: 'config-1',
          account_id: accountId,
          phone_number_id: 'phone-1',
          coexistence_app_id: 'app-1',
          coexistence_generation:
            rotate && url.searchParams.has('phone_number_id')
              ? 'epoch-2'
              : 'epoch-1',
          coexistence_verified_at: '2026-01-01T00:00:00Z',
          status: 'connected',
          access_token: encrypt('fixture-token'),
        };

        return Response.json(single ? row : [row]);
      }

      if (table === 'conversations' && init?.method !== 'PATCH') {
        return Response.json({
          id: params.conversationId,
          account_id: accountId,
          contact: { id: 'contact-1', phone: '+15551234567' },
        });
      }

      if (table === 'persist_outbound_message' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));

        return Response.json({
          id: '11111111-1111-4111-8111-111111111111',
          message_id: body.p_message.message_id,
          status: 'sent',
        });
      }

      if (table === 'pending_message_statuses') return Response.json([]);

      if (init?.method === 'PATCH') return new Response(null, { status: 204 });
      throw new Error(`Unexpected fixture request: ${url.pathname}`);
    }
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('manual/public send connection at the real Meta HTTP boundary', () => {
  it('scopes managed sends before credentials and never rewrites the token', async () => {
    await expect(
      sendMessageToConversation(db(), accountId, params)
    ).resolves.toEqual({
      messageId: '11111111-1111-4111-8111-111111111111',
      whatsappMessageId: 'wamid.fixture',
    });
    expect(credentialReads).toBe(1);
    expect(posts).toBe(1);
    expect(configWrites).toBe(0);
  });

  it('blocks rotation between snapshot and POST without recipient fallback', async () => {
    rotate = true;
    await expect(
      sendMessageToConversation(db(), accountId, params)
    ).rejects.toThrow('Outbound send denied');
    expect(posts).toBe(0);
    expect(configWrites).toBe(0);
  });

  it('does not upgrade inherited legacy NULL work to a managed connection', async () => {
    await expect(
      withStoredSendConnection(accountId, {}, () =>
        sendMessageToConversation(db(), accountId, params)
      )
    ).rejects.toThrow('Outbound send denied');
    expect(posts).toBe(0);
  });
});
