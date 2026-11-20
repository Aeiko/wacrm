import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { encrypt } from '@/lib/whatsapp/encryption';
import { withStoredSendConnection } from '@/lib/whatsapp/coexistence/send-guard';
import {
  engineSendText,
  engineSendMedia,
  engineSendInteractiveButtons,
  engineSendInteractiveList,
} from './meta-send';

const base = {
  accountId: 'account-1',
  userId: 'user-1',
  contactId: 'contact-1',
  conversationId: 'conversation-1',
};

const id = '11111111-1111-4111-8111-111111111111';

let rpcBody: z.infer<ReturnType<typeof z.json>> | undefined;
let metaPosts = 0;
let persistenceFails = false;
let bsuid = false;
let rejectOriginal = false;

beforeEach(() => {
  rpcBody = undefined;
  metaPosts = 0;
  persistenceFails = false;
  bsuid = false;
  rejectOriginal = false;
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'fixture-key');
  vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'false');
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));

      if (url.hostname === 'graph.facebook.com') {
        metaPosts++;

        if (rejectOriginal && metaPosts === 1)
          return Response.json(
            {
              error: { message: 'Recipient not in allowed list', code: 131030 },
            },
            { status: 400 }
          );

        return Response.json({ messages: [{ id: 'wamid.flow' }] });
      }

      if (url.origin !== 'http://127.0.0.1:54321')
        throw new Error('External traffic forbidden');
      const table = url.pathname.split('/').pop();

      if (table === 'contacts' && init?.method === 'PATCH')
        return new Response(null, { status: 204 });

      if (table === 'contacts')
        return Response.json({
          id: base.contactId,
          phone: bsuid ? null : '15551234567',
          wa_user_id: 'US.12345678',
        });

      if (table === 'conversations' && init?.method !== 'PATCH')
        return Response.json({ id: base.conversationId });

      if (table === 'whatsapp_config') {
        const row = {
          id: 'config-1',
          account_id: base.accountId,
          phone_number_id: 'phone-1',
          access_token: encrypt('fixture-token'),
          status: 'connected',
          coexistence_app_id: null,
          coexistence_generation: 'generation-1',
          coexistence_verified_at: null,
        };

        return Response.json(
          url.searchParams.has('phone_number_id') ? [row] : row
        );
      }

      if (table === 'persist_outbound_message') {
        rpcBody = z.json().parse(JSON.parse(String(init?.body)));

        return persistenceFails
          ? Response.json({ message: 'persistence conflict' }, { status: 409 })
          : Response.json({ id, message_id: 'wamid.flow', status: 'read' });
      }

      throw new Error(`Unexpected fixture request: ${url.pathname}`);
    }
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const scoped = <T>(action: () => Promise<T>): Promise<T> =>
  withStoredSendConnection(base.accountId, {}, action);

describe('Flow accepted sends at the HTTP/RPC boundary', () => {
  it('persists AI authorship and keeps a BSUID-only recipient phone null', async () => {
    bsuid = true;
    await expect(
      scoped(() =>
        engineSendText({ ...base, text: 'Hello', aiGenerated: true })
      )
    ).resolves.toEqual({ whatsapp_message_id: 'wamid.flow' });
    expect(rpcBody).toMatchObject({
      p_config_id: null,
      p_generation: null,
      p_recipient: { phone: null, wa_user_id: 'US.12345678' },
      p_message: {
        conversation_id: base.conversationId,
        sender_type: 'bot',
        sender_id: null,
        content_type: 'text',
        content_text: 'Hello',
        ai_generated: true,
      },
      p_preview: 'Hello',
    });
  });

  it('records the successful phone variant rather than the originally attempted phone', async () => {
    rejectOriginal = true;
    await scoped(() => engineSendText({ ...base, text: 'Hello' }));
    expect(rpcBody).toMatchObject({
      p_recipient: { phone: '105551234567', wa_user_id: 'US.12345678' },
    });
    expect(metaPosts).toBe(2);
  });

  it('persists the actual media URL and atomically supplies the fallback preview', async () => {
    await scoped(() =>
      engineSendMedia({
        ...base,
        kind: 'image',
        link: 'https://cdn.example.com/image.jpg',
      })
    );
    expect(rpcBody).toMatchObject({
      p_account_id: base.accountId,
      p_contact_id: base.contactId,
      p_recipient: { phone: '15551234567', wa_user_id: 'US.12345678' },
      p_message: {
        message_id: 'wamid.flow',
        content_type: 'image',
        content_text: null,
        media_url: 'https://cdn.example.com/image.jpg',
        ai_generated: false,
      },
      p_preview: '[image]',
    });
    expect(metaPosts).toBe(1);
  });

  it.each(['buttons', 'list'] as const)(
    'persists the full %s prompt',
    async (kind) => {
      const buttons = [{ id: 'yes', title: 'Yes' }];

      const sections = [
        { title: 'Options', rows: [{ id: 'yes', title: 'Yes' }] },
      ];

      await scoped(() =>
        kind === 'buttons'
          ? engineSendInteractiveButtons({
              ...base,
              bodyText: 'Choose',
              buttons,
            })
          : engineSendInteractiveList({
              ...base,
              bodyText: 'Choose',
              buttonLabel: 'Options',
              sections,
            })
      );
      expect(rpcBody).toMatchObject({
        p_message: {
          sender_type: 'bot',
          content_type: 'interactive',
          content_text: 'Choose',
          interactive_payload:
            kind === 'buttons'
              ? { kind: 'buttons', body: 'Choose', buttons }
              : {
                  kind: 'list',
                  body: 'Choose',
                  button_label: 'Options',
                  sections,
                },
        },
        p_preview: 'Choose',
      });
    }
  );

  it('reports post-acceptance persistence ambiguity without resending', async () => {
    persistenceFails = true;
    await expect(
      scoped(() => engineSendText({ ...base, text: 'Hello' }))
    ).rejects.toThrow('Message accepted by Meta but failed to persist');
    expect(metaPosts).toBe(1);
  });
});
