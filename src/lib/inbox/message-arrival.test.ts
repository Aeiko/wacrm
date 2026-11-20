import { describe, expect, it } from 'vitest';
import type { Conversation, Message } from '@/types';
import {
  applyConversationMessageInsert,
  isLiveCustomerMessage,
  shouldScrollForMessages,
} from './message-arrival';

const conversation: Conversation = {
  id: 'c1',
  user_id: 'u1',
  contact_id: 'contact1',
  status: 'open',
  unread_count: 3,
  created_at: '2026-05-18T10:00:00Z',
  updated_at: '2026-05-18T10:00:00Z',
  last_message_at: '2026-05-18T10:00:00Z',
  last_message_text: 'newer',
};

const live: Message = {
  id: 'live',
  conversation_id: 'c1',
  sender_type: 'customer',
  content_type: 'text',
  content_text: 'hello',
  status: 'delivered',
  created_at: '2026-05-18T11:00:00Z',
};

describe('isLiveCustomerMessage', () => {
  it('excludes history and echoes from the live customer window', () => {
    expect(isLiveCustomerMessage(live)).toBe(true);
    expect(
      isLiveCustomerMessage({ ...live, message_source: 'cloud_api' })
    ).toBe(true);
    expect(isLiveCustomerMessage({ ...live, message_source: 'history' })).toBe(
      false
    );
    expect(
      isLiveCustomerMessage({ ...live, message_source: 'phone_app' })
    ).toBe(false);
    expect(isLiveCustomerMessage({ ...live, sender_type: 'agent' })).toBe(
      false
    );
  });
});

describe('applyConversationMessageInsert', () => {
  it('keeps true live inbound unread and previews, including legacy rows', () => {
    expect(
      applyConversationMessageInsert(conversation, live, false)
    ).toMatchObject({
      unread_count: 4,
      last_message_text: 'hello',
      last_message_at: live.created_at,
    });
    expect(
      applyConversationMessageInsert(conversation, live, true).unread_count
    ).toBe(0);
  });

  it('never increments unread for imports or outgoing messages', () => {
    for (const row of [
      { ...live, message_source: 'history' as const },
      {
        ...live,
        sender_type: 'agent' as const,
        message_source: 'phone_app' as const,
      },
      { ...live, sender_type: 'agent' as const },
      { ...live, sender_type: 'bot' as const },
    ]) {
      expect(
        applyConversationMessageInsert(conversation, row, false).unread_count
      ).toBe(3);
    }
  });

  it('refreshes the preview for a later PostgreSQL microsecond', () => {
    const current = {
      ...conversation,
      last_message_at: '2026-05-18T11:00:00.123100Z',
    };

    const message = { ...live, created_at: '2026-05-18T11:00:00.123900Z' };

    expect(
      applyConversationMessageInsert(current, message, false).last_message_text
    ).toBe('hello');
  });

  it('does not let older history overwrite a newer preview', () => {
    const row: Message = {
      ...live,
      message_source: 'history',
      created_at: '2020-01-01T00:00:00Z',
    };

    expect(applyConversationMessageInsert(conversation, row, false)).toEqual(
      conversation
    );
  });

  it('can populate a newer history preview without unread or touching another conversation', () => {
    expect(
      applyConversationMessageInsert(
        conversation,
        { ...live, message_source: 'history' },
        false
      )
    ).toMatchObject({ unread_count: 3, last_message_text: 'hello' });
    expect(
      applyConversationMessageInsert(
        conversation,
        { ...live, conversation_id: 'other' },
        false
      )
    ).toBe(conversation);
  });
});

describe('shouldScrollForMessages', () => {
  it('scrolls initial loads and fresh live messages, not imported arrivals or updates', () => {
    const history: Message = {
      ...live,
      id: 'history',
      message_source: 'history',
    };

    expect(shouldScrollForMessages([], [history])).toBe(true);
    expect(shouldScrollForMessages([live], [history, live])).toBe(false);
    expect(shouldScrollForMessages([live], [live, history])).toBe(false);
    expect(shouldScrollForMessages([history], [history, live])).toBe(true);
    expect(
      shouldScrollForMessages(
        [history],
        [{ ...history, message_source: 'cloud_api' }]
      )
    ).toBe(false);
    expect(shouldScrollForMessages([live], [{ ...live, status: 'read' }])).toBe(
      false
    );
  });
});
