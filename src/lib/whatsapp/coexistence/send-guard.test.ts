import { createClient } from '@supabase/supabase-js';
import { encrypt } from '../encryption';
import {
  sendTextMessage,
  sendMediaMessage,
  sendTemplateMessage,
  sendReactionMessage,
  sendTypingIndicator,
  sendInteractiveButtons,
  sendInteractiveList,
} from '../meta-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withRequestDeadline } from '@/lib/request-deadline';
import {
  withAccountSendConnection,
  sendConnectionColumns,
  withSendConnection,
  withStoredSendConnection,
} from './send-guard';

const connection = {
  accountId: 'account-1',
  configId: 'config-1',
  generation: 'epoch-1',
};

beforeEach(() => {
  vi.stubEnv('WHATSAPP_COEXISTENCE_APP_SECRET', 'fixture-app-secret');
  vi.stubEnv('WHATSAPP_COEXISTENCE_PARTNER_BUSINESS_ID', '7777');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('last-mile outbound guard', () => {
  it('denies a bound phone without scope, and permits its exact current identity', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'fixture-service-key');
    vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
    vi.stubEnv('WHATSAPP_COEXISTENCE_APP_ID', 'app-1');
    let posts = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input));

      if (url.pathname === '/rest/v1/whatsapp_config') {
        expect(url.searchParams.get('limit')).toBe('2');
        expect(url.searchParams.get('phone_number_id')).toBe('eq.phone-1');
        expect(url.toString()).not.toContain('outgoing-secret');

        return Response.json([
          {
            id: 'config-1',
            account_id: 'account-1',
            coexistence_app_id: 'app-1',
            coexistence_generation: 'epoch-1',
            coexistence_verified_at: '2026-01-01T00:00:00Z',
            status: 'connected',
            access_token: encrypt('outgoing-secret'),
          },
        ]);
      }

      if (url.hostname !== 'graph.facebook.com')
        throw new Error('Unexpected HTTP fixture request');
      posts++;

      return Response.json({ messages: [{ id: 'wamid.fixture' }] });
    });

    const send = () =>
      sendTextMessage({
        phoneNumberId: 'phone-1',
        accessToken: 'outgoing-secret',
        to: '15551230000',
        text: 'hi',
      });

    await expect(send()).rejects.toThrow();
    expect(posts).toBe(0);
    await expect(withSendConnection(connection, send)).resolves.toEqual({
      messageId: 'wamid.fixture',
    });
    expect(posts).toBe(1);
  });
});

describe('fresh configuration at the Meta HTTP boundary', () => {
  const args = {
    phoneNumberId: 'phone-1',
    accessToken: 'outgoing-secret',
    to: '15551230000',
  };

  const textSend = () => sendTextMessage({ ...args, text: 'hi' });

  const current = () => ({
    id: 'config-1',
    account_id: 'account-1',
    coexistence_app_id: 'app-1',
    coexistence_generation: 'epoch-1',
    coexistence_verified_at: '2026-01-01T00:00:00Z',
    status: 'connected',
    access_token: encrypt('outgoing-secret'),
  });

  let row = current();
  let rows: unknown[];
  let posts: number;
  let databaseStatus: number;
  beforeEach(() => {
    row = current();
    rows = [row];
    posts = 0;
    databaseStatus = 200;
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'fixture-service-key');
    vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
    vi.stubEnv('WHATSAPP_COEXISTENCE_APP_ID', 'app-1');
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input));

      if (
        url.origin === 'http://127.0.0.1:54321' &&
        url.pathname === '/rest/v1/whatsapp_config'
      ) {
        return Response.json(
          databaseStatus === 200 ? rows : { message: 'outgoing-secret' },
          { status: databaseStatus }
        );
      }

      if (
        url.hostname !== 'graph.facebook.com' ||
        !url.pathname.endsWith('/messages')
      )
        throw new Error('Unexpected fixture URL');
      posts++;

      return Response.json({
        messages: [{ id: 'wamid.fixture' }],
        success: true,
      });
    });
  });

  it('keeps the history pilot send-disabled even before any receiver veto can reach the CRM', async () => {
    vi.stubEnv('WHATSAPP_COEXISTENCE_RELAY_WABA_ID', '880007');
    vi.stubEnv('WHATSAPP_COEXISTENCE_RELAY_PHONE_ID', '880008');
    vi.stubEnv('WHATSAPP_COEXISTENCE_RECEIVER_STOP_KEY', '');
    rows = [{ ...row, waba_id: '0880007' }];
    await expect(withSendConnection(connection, textSend)).rejects.toThrow(
      'Outbound send denied'
    );
    rows = [{ ...row, waba_id: '880010' }];

    const forPhone = (phoneNumberId: string) =>
      sendTextMessage({ ...args, phoneNumberId, text: 'hi' });

    await expect(
      withSendConnection(connection, () => forPhone('0880008'))
    ).rejects.toThrow('Outbound send denied');
    rows = [
      { ...row, coexistence_app_id: null, coexistence_verified_at: null },
    ];
    await expect(forPhone('880008')).rejects.toThrow('Outbound send denied');
    expect(posts).toBe(0);
    await expect(forPhone('880009')).resolves.toEqual({
      messageId: 'wamid.fixture',
    });
    rows = [{ ...row, waba_id: '880010' }];
    await withSendConnection(connection, textSend);
    expect(posts).toBe(2);
  });

  it.each([
    ['text', textSend],
    [
      'media',
      () =>
        sendMediaMessage({
          ...args,
          kind: 'image',
          link: 'https://cdn.test/image.png',
        }),
    ],
    ['template', () => sendTemplateMessage({ ...args, templateName: 'hello' })],
    [
      'reaction',
      () =>
        sendReactionMessage({
          ...args,
          targetMessageId: 'wamid.inbound',
          emoji: '👍',
        }),
    ],
    [
      'typing/read',
      () => sendTypingIndicator({ ...args, messageId: 'wamid.inbound' }),
    ],
    [
      'buttons',
      () =>
        sendInteractiveButtons({
          ...args,
          bodyText: 'Choose',
          buttons: [{ id: 'a', title: 'A' }],
        }),
    ],
    [
      'list',
      () =>
        sendInteractiveList({
          ...args,
          bodyText: 'Choose',
          buttonLabel: 'Open',
          sections: [{ rows: [{ id: 'a', title: 'A' }] }],
        }),
    ],
  ])('guards %s and rechecks before the next POST', async (_name, send) => {
    await withSendConnection<unknown>(connection, send);
    row.coexistence_generation = 'epoch-2';
    await expect(withSendConnection<unknown>(connection, send)).rejects.toThrow(
      'Outbound send denied'
    );
    expect(posts).toBe(1);
  });

  it.each([
    'disabled',
    'wrong-app',
    'missing-secret',
    'missing-partner',
    'invalid-partner',
    'unverified',
    'disconnected',
    'replaced',
    'unbound',
    'wrong-account',
    'token-rotated',
    'invalid-ciphertext',
    'missing',
    'ambiguous',
    'database-error',
  ])('blocks %s without leaking credentials', async (change) => {
    switch (change) {
      case 'disabled':
        vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'false');
        break;
      case 'wrong-app':
        vi.stubEnv('WHATSAPP_COEXISTENCE_APP_ID', 'another-app');
        break;
      case 'missing-secret':
        vi.stubEnv('WHATSAPP_COEXISTENCE_APP_SECRET', '');
        break;
      case 'missing-partner':
        vi.stubEnv('WHATSAPP_COEXISTENCE_PARTNER_BUSINESS_ID', '');
        break;
      case 'invalid-partner':
        vi.stubEnv('WHATSAPP_COEXISTENCE_PARTNER_BUSINESS_ID', 'not-an-id');
        break;
      case 'unverified':
        rows = [{ ...row, coexistence_verified_at: null }];
        break;
      case 'disconnected':
        row.status = 'disconnected';
        break;
      case 'replaced':
        row.id = 'config-2';
        break;
      case 'unbound':
        rows = [{ ...row, coexistence_app_id: null }];
        break;
      case 'wrong-account':
        row.account_id = 'account-2';
        break;
      case 'token-rotated':
        row.access_token = encrypt('rotated-secret');
        break;
      case 'invalid-ciphertext':
        row.access_token = 'outgoing-secret';
        break;
      case 'missing':
        rows = [];
        break;
      case 'ambiguous':
        rows = [row, row];
        break;
      case 'database-error':
        databaseStatus = 403;
        break;
    }

    await expect(withSendConnection(connection, textSend)).rejects.toThrow(
      /^Outbound send denied: current connection unavailable or changed$/
    );
    expect(posts).toBe(0);
  });

  it('permits unscoped legacy sends with the flag off, but rejects old legacy work after onboarding', async () => {
    vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'false');
    rows = [{ ...row, coexistence_app_id: null }];
    await expect(textSend()).resolves.toBeDefined();
    await withStoredSendConnection('account-1', {}, async () => {
      await expect(textSend()).resolves.toBeDefined();
      rows = [row];
      vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
      await expect(textSend()).rejects.toThrow('Outbound send denied');
    });
    expect(posts).toBe(2);
  });

  it('denies missing managed scope even with the global flag off', async () => {
    vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'false');
    await expect(textSend()).rejects.toThrow('Outbound send denied');
    expect(posts).toBe(0);
  });

  it('rejects legacy context from another account even for an unbound phone', async () => {
    rows = [{ ...row, coexistence_app_id: null }];
    await expect(
      withStoredSendConnection('account-2', {}, textSend)
    ).rejects.toThrow();
    expect(posts).toBe(0);
  });

  it('respects the inherited request deadline during the guard lookup', async () => {
    await expect(
      withRequestDeadline(Date.now() - 1, () =>
        withSendConnection(connection, textSend)
      )
    ).rejects.toThrow('Outbound send denied');
    expect(posts).toBe(0);
  });
});

describe('pinned outbound connection scopes', () => {
  it('loads an account snapshot once and never refreshes an inherited epoch', async () => {
    const transport = vi.fn(async () =>
      Response.json([
        {
          id: 'config-1',
          account_id: 'account-1',
          coexistence_app_id: 'app-1',
          coexistence_generation: 'epoch-1',
        },
      ])
    );

    const db = createClient('http://127.0.0.1:54321', 'fixture-service-key', {
      global: { fetch: transport },
      auth: { persistSession: false },
    });

    await withAccountSendConnection(db, 'account-1', async () => {
      expect(sendConnectionColumns()).toEqual({
        send_config_id: 'config-1',
        send_generation: 'epoch-1',
      });
      transport.mockImplementation(async () => {
        throw new Error('must not reload');
      });
      await withAccountSendConnection(db, 'account-1', async () => {
        expect(sendConnectionColumns().send_generation).toBe('epoch-1');
      });
      await expect(
        withAccountSendConnection(db, 'account-2', async () => {})
      ).rejects.toThrow();
    });
    transport.mockImplementation(async () => Response.json([]));
    await withAccountSendConnection(db, 'account-1', async () => {
      expect(sendConnectionColumns()).toEqual({
        send_config_id: null,
        send_generation: null,
      });
    });
  });
  it('requires queue entry scope and preserves the pinned identity across awaits', async () => {
    expect(() => sendConnectionColumns()).toThrow();
    await withSendConnection(connection, async () => {
      await Promise.resolve();
      expect(sendConnectionColumns()).toEqual({
        send_config_id: 'config-1',
        send_generation: 'epoch-1',
      });
      await withSendConnection({ ...connection }, async () => {
        expect(sendConnectionColumns().send_generation).toBe('epoch-1');
      });
      await expect(
        withSendConnection(
          { ...connection, generation: 'epoch-2' },
          async () => {}
        )
      ).rejects.toThrow();
      await expect(
        withSendConnection(
          { ...connection, accountId: 'account-2' },
          async () => {}
        )
      ).rejects.toThrow();
    });
    expect(() => sendConnectionColumns()).toThrow();
  });

  it('treats absent stored columns as legacy but rejects partial identities', async () => {
    await withStoredSendConnection('account-1', {}, async () => {
      expect(sendConnectionColumns()).toEqual({
        send_config_id: null,
        send_generation: null,
      });
      await expect(
        withSendConnection(connection, async () => {})
      ).rejects.toThrow();
    });
    await expect(
      withStoredSendConnection(
        'account-1',
        { send_config_id: 'config-1' },
        async () => {}
      )
    ).rejects.toThrow();
    await expect(
      withStoredSendConnection(
        'account-1',
        { send_generation: 'epoch-1' },
        async () => {}
      )
    ).rejects.toThrow();
  });
});
