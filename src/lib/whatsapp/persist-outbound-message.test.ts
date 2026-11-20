import { createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withStoredSendConnection } from './coexistence/send-guard';
import { persistOutboundMessage } from './persist-outbound-message';

const id = '11111111-1111-4111-8111-111111111111';

const args = {
  accountId: 'account-1',
  contactId: 'contact-1',
  recipient: { phone: '15551234567', wa_user_id: 'US.known' },
  message: {
    conversation_id: 'conversation-1',
    message_id: 'wamid.accepted',
    sender_type: 'bot' as const,
    content_type: 'text' as const,
    content_text: 'Hello',
    ai_generated: true,
  },
  preview: 'Hello',
};

const db = () =>
  createClient('http://127.0.0.1:54321', 'fixture-key', {
    auth: { persistSession: false, autoRefreshToken: false },
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('accepted outbound persistence at the RPC boundary', () => {
  it.each([
    null,
    [],
    { id: 'not-a-uuid', message_id: 'wamid.accepted', status: 'sent' },
    { id, message_id: 'wamid.other', status: 'sent' },
    { id, message_id: 'wamid.accepted', status: 'unknown' },
  ])(
    'treats an invalid canonical response as ambiguous without retry: %j',
    async (response) => {
      const fetch = vi.fn(async () => Response.json(response));
      vi.stubGlobal('fetch', fetch);
      await expect(
        withStoredSendConnection('account-1', {}, () =>
          persistOutboundMessage(db(), args)
        )
      ).rejects.toThrow('Message accepted by Meta but failed to persist');
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  );

  it('does not retry a rejected persistence request', async () => {
    const fetch = vi.fn(async () =>
      Response.json({ message: 'conflict' }, { status: 409 })
    );

    vi.stubGlobal('fetch', fetch);
    await expect(
      withStoredSendConnection('account-1', {}, () =>
        persistOutboundMessage(db(), args)
      )
    ).rejects.toThrow('Do not resend');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry a lost persistence response', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('Connection closed');
    });

    vi.stubGlobal('fetch', fetch);
    await expect(
      withStoredSendConnection('account-1', {}, () =>
        persistOutboundMessage(db(), args)
      )
    ).rejects.toThrow('Do not resend');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a different account even when the inherited origin is legacy', async () => {
    const fetch = vi.fn(async () =>
      Response.json({ id, message_id: 'wamid.accepted', status: 'sent' })
    );

    vi.stubGlobal('fetch', fetch);
    await expect(
      withStoredSendConnection('another-account', {}, () =>
        persistOutboundMessage(db(), args)
      )
    ).rejects.toThrow('delivery is ambiguous');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never reloads a missing send scope after acceptance', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('Unexpected request');
    });

    vi.stubGlobal('fetch', fetch);
    await expect(persistOutboundMessage(db(), args)).rejects.toThrow(
      'delivery is ambiguous'
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses the immutable connection and returns the canonical row without sending to Meta', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T11:00:00Z'));

    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(
          'http://127.0.0.1:54321/rest/v1/rpc/persist_outbound_message'
        );
        expect(JSON.parse(String(init?.body))).toEqual({
          p_account_id: 'account-1',
          p_contact_id: 'contact-1',
          p_config_id: 'config-old',
          p_generation: 'generation-old',
          p_recipient: { phone: '15551234567', wa_user_id: 'US.known' },
          p_message: {
            ...args.message,
            created_at: '2026-11-17T11:00:00.000Z',
            sender_id: null,
            media_url: null,
            template_name: null,
            interactive_payload: null,
            reply_to_message_id: null,
          },
          p_preview: 'Hello',
        });

        return Response.json({
          id,
          message_id: 'wamid.accepted',
          status: 'read',
        });
      }
    );

    vi.stubGlobal('fetch', fetch);

    const result = await withStoredSendConnection(
      'account-1',
      {
        send_config_id: 'config-old',
        send_generation: 'generation-old',
      },
      () => persistOutboundMessage(db(), args)
    );

    expect(result).toEqual({
      id,
      message_id: 'wamid.accepted',
      status: 'read',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
