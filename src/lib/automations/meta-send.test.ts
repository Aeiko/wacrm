import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from '@/lib/whatsapp/encryption';
import { withStoredSendConnection } from '@/lib/whatsapp/coexistence/send-guard';

const state = vi.hoisted(() => ({
  templateRows: [] as unknown[],
  insertedMessage: null as Record<string, unknown> | null,
  rpc: vi.fn(),
}));

vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    rpc: state.rpc,
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        update: () => builder,
        maybeSingle: async () => {
          if (table === 'contacts') {
            return {
              data: { id: 'ct-1', phone: '15551234567', wa_user_id: null },
              error: null,
            };
          }

          if (table === 'conversations')
            return { data: { id: 'cv-1' }, error: null };

          return { data: null, error: null };
        },
        single: async () => {
          if (table === 'whatsapp_config') {
            return {
              data: { phone_number_id: 'pn-1', access_token: encrypt('token') },
              error: null,
            };
          }

          return { data: null, error: null };
        },
        then: (resolve: (r: { data: unknown; error: null }) => unknown) =>
          resolve({
            data: table === 'message_templates' ? state.templateRows : null,
            error: null,
          }),
      };

      return builder;
    },
  }),
}));

import { engineSendTemplate } from './meta-send';

type FetchResult = { ok: boolean; json: () => Promise<unknown> };

const fetchMock = vi.fn<
  (url: string, init?: RequestInit) => Promise<FetchResult>
>(async () => ({
  ok: true,
  json: async () => ({ messages: [{ id: 'wamid.auto' }] }),
}));

function sentTemplate(): Record<string, unknown> {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const init = fetchMock.mock.calls[0][1];

  return JSON.parse(String(init?.body)).template;
}

const BASE_ROW = {
  id: 'tpl-1',
  user_id: 'u-1',
  name: 'order_update',
  category: 'Utility',
  language: 'en_US',
  body_text: 'Your order {{1}} ships on {{2}}',
  created_at: '2026-01-01T00:00:00Z',
};

const SEND_ARGS = {
  accountId: 'acct-1',
  userId: 'u-1',
  conversationId: 'cv-1',
  contactId: 'ct-1',
  templateName: 'order_update',
  language: 'en_US',
  params: ['A123', 'Friday'],
};

const BODY_COMPONENT = {
  type: 'body',
  parameters: [
    { type: 'text', text: 'A123' },
    { type: 'text', text: 'Friday' },
  ],
};

beforeEach(() => {
  state.templateRows = [];
  state.insertedMessage = null;
  state.rpc.mockImplementation(async (name, args) => {
    expect(name).toBe('persist_outbound_message');
    state.insertedMessage = args.p_message;

    return {
      data: {
        id: '00000000-0000-4000-8000-000000000001',
        message_id: args.p_message.message_id,
        status: 'sent',
      },
      error: null,
    };
  });
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'fixture-service-key');
  vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'false');
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));

      if (
        url.origin === 'http://127.0.0.1:54321' &&
        url.pathname === '/rest/v1/whatsapp_config'
      ) {
        expect(url.searchParams.get('phone_number_id')).toBe('eq.pn-1');

        return Response.json([
          {
            id: 'config-1',
            account_id: 'acct-1',
            status: 'connected',
            access_token: encrypt('token'),
            coexistence_app_id: null,
            coexistence_generation: 'epoch-1',
            coexistence_verified_at: null,
          },
        ]);
      }

      if (
        url.hostname !== 'graph.facebook.com' ||
        !url.pathname.endsWith('/messages')
      )
        throw new Error('Unexpected fixture request');

      return fetchMock(String(input), init);
    }
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('engineSendTemplate — header component', () => {
  it.each(['image', 'video', 'document'] as const)(
    'sends the stored %s header as a header parameter',
    async (headerType) => {
      state.templateRows = [
        {
          ...BASE_ROW,
          header_type: headerType,
          header_media_url: `https://cdn.example.com/header.${headerType}`,
        },
      ];

      await withStoredSendConnection(SEND_ARGS.accountId, {}, () =>
        engineSendTemplate(SEND_ARGS)
      );

      expect(sentTemplate()).toEqual({
        name: 'order_update',
        language: { code: 'en_US' },
        components: [
          {
            type: 'header',
            parameters: [
              {
                type: headerType,
                [headerType]: {
                  link: `https://cdn.example.com/header.${headerType}`,
                },
              },
            ],
          },
          BODY_COMPONENT,
        ],
      });
      expect(state.insertedMessage?.media_url).toBe(
        `https://cdn.example.com/header.${headerType}`
      );
    }
  );

  it('fails before calling Meta when a text header variable has no value', async () => {
    state.templateRows = [
      { ...BASE_ROW, header_type: 'text', header_content: 'Hi {{1}}' },
    ];

    await expect(
      withStoredSendConnection(SEND_ARGS.accountId, {}, () =>
        engineSendTemplate(SEND_ARGS)
      )
    ).rejects.toThrow(/Header text variable \{\{1\}\} requires a value/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it('sends no header component for a static text header', async () => {
    state.templateRows = [
      { ...BASE_ROW, header_type: 'text', header_content: 'Order update' },
    ];

    await withStoredSendConnection(SEND_ARGS.accountId, {}, () =>
      engineSendTemplate(SEND_ARGS)
    );

    expect(sentTemplate().components).toEqual([BODY_COMPONENT]);
  });
});

describe('engineSendTemplate — templates without a header keep their payload', () => {
  it('sends only the body component for a header-less template', async () => {
    state.templateRows = [BASE_ROW];

    await expect(
      withStoredSendConnection(SEND_ARGS.accountId, {}, () =>
        engineSendTemplate(SEND_ARGS)
      )
    ).resolves.toEqual({ whatsapp_message_id: 'wamid.auto' });

    expect(state.rpc).toHaveBeenCalledExactlyOnceWith(
      'persist_outbound_message',
      expect.objectContaining({
        p_config_id: null,
        p_generation: null,
        p_message: expect.objectContaining({
          conversation_id: 'cv-1',
          sender_type: 'bot',
          content_type: 'template',
          content_text: 'Your order A123 ships on Friday',
          template_name: 'order_update',
          message_id: 'wamid.auto',
        }),
      })
    );
    expect(sentTemplate()).toEqual({
      name: 'order_update',
      language: { code: 'en_US' },
      components: [BODY_COMPONENT],
    });
  });

  it('rejects a persistence failure after Meta accepts the template without resending', async () => {
    state.templateRows = [BASE_ROW];
    state.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'Fixture persistence failed' },
    });

    await expect(
      withStoredSendConnection(SEND_ARGS.accountId, {}, () =>
        engineSendTemplate(SEND_ARGS)
      )
    ).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.rpc).toHaveBeenCalledTimes(1);
  });

  it('sends no components for a fully static template', async () => {
    state.templateRows = [{ ...BASE_ROW, body_text: 'Thanks for your order' }];

    await withStoredSendConnection(SEND_ARGS.accountId, {}, () =>
      engineSendTemplate({ ...SEND_ARGS, params: [] })
    );

    expect(sentTemplate()).toEqual({
      name: 'order_update',
      language: { code: 'en_US' },
    });
  });

  it('falls back to the body-only payload when the account has no local row', async () => {
    await withStoredSendConnection(SEND_ARGS.accountId, {}, () =>
      engineSendTemplate(SEND_ARGS)
    );

    expect(sentTemplate()).toEqual({
      name: 'order_update',
      language: { code: 'en_US' },
      components: [BODY_COMPONENT],
    });
  });
});
