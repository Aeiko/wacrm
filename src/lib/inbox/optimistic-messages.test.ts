import { describe, expect, it } from 'vitest';
import type { Message } from '@/types';
import {
  applyMessageUpdate,
  applyRealtimeInsert,
  confirmedSendUpdate,
  compareMessageOrder,
  olderMessagesFilter,
  isTempMessage,
  mergeFetchedPage,
  newTempMessageId,
  prependOlderMessages,
} from './optimistic-messages';

function msg(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    conversation_id: 'conv-1',
    sender_type: 'agent',
    content_type: 'text',
    content_text: id,
    status: 'sent',
    created_at: '2026-05-18T10:00:00.000Z',
    ...overrides,
  };
}

const ids = (list: Message[]) => list.map((m) => m.id);

describe('message cursor', () => {
  it('preserves PostgreSQL microseconds before using ids to break ties', () => {
    const earlier = msg('z', { created_at: '2026-05-18T10:00:00.123100Z' });
    const later = msg('a', { created_at: '2026-05-18T10:00:00.123900Z' });

    expect(compareMessageOrder(earlier, later)).toBeLessThan(0);
    expect(ids(applyRealtimeInsert([later], earlier))).toEqual(['z', 'a']);
    expect(ids(prependOlderMessages([earlier], [later]))).toEqual(['z', 'a']);
  });

  it('compares equivalent offsets and fractional precision as the same timestamp', () => {
    expect(
      compareMessageOrder(
        msg('z', { created_at: '2026-05-18T18:00:00.123100+08:00' }),
        msg('a', { created_at: '2026-05-18T10:00:00.123900Z' })
      )
    ).toBeLessThan(0);
    expect(
      compareMessageOrder(
        msg('same', { created_at: '2026-05-18T10:00:00.1Z' }),
        msg('same', { created_at: '2026-05-18T10:00:00.100000+00:00' })
      )
    ).toBe(0);
  });

  it('advances through more than a page of messages sharing a history timestamp', () => {
    const rows = Array.from({ length: 450 }, (_, index) =>
      msg(String(index).padStart(4, '0'))
    );

    const descending = [...rows].sort((a, b) => compareMessageOrder(b, a));
    const first = descending.slice(0, 200);

    const second = descending
      .filter((row) => compareMessageOrder(row, first[first.length - 1]) < 0)
      .slice(0, 200);

    const third = descending
      .filter((row) => compareMessageOrder(row, second[second.length - 1]) < 0)
      .slice(0, 200);

    expect(
      new Set([...first, ...second, ...third].map((row) => row.id)).size
    ).toBe(450);
    expect(third).toHaveLength(50);
  });

  it('requests strictly earlier timestamps or lower ids at the same timestamp', () => {
    expect(olderMessagesFilter(msg('b'))).toBe(
      'created_at.lt."2026-05-18T10:00:00.000Z",and(created_at.eq."2026-05-18T10:00:00.000Z",id.lt."b")'
    );
    expect(compareMessageOrder(msg('a'), msg('b'))).toBeLessThan(0);
    expect(compareMessageOrder(msg('b'), msg('b'))).toBe(0);
    expect(compareMessageOrder(msg('c'), msg('b'))).toBeGreaterThan(0);
    expect(
      compareMessageOrder(
        msg('z', { created_at: '2020-01-01T00:00:00Z' }),
        msg('b')
      )
    ).toBeLessThan(0);
  });
});

describe('newTempMessageId', () => {
  it('is unique within the same millisecond and recognised as temp', () => {
    const a = newTempMessageId(1);
    const b = newTempMessageId(1);
    expect(a).not.toBe(b);
    expect(isTempMessage({ id: a })).toBe(true);
    expect(isTempMessage({ id: 'real-1' })).toBe(false);
  });
});

describe('applyRealtimeInsert', () => {
  it.each(['history', 'phone_app'] as const)(
    'does not reconcile a %s row by CRM text',
    (message_source) => {
      const pending = msg('temp-1', { content_text: 'hi', status: 'sending' });
      const row = msg('real-1', { content_text: 'hi', message_source });

      expect(applyRealtimeInsert([pending], row)).toContainEqual(pending);
      expect(mergeFetchedPage([pending], [row], 'conv-1')).toContainEqual(
        pending
      );
    }
  );

  it('inserts history chronologically with a deterministic timestamp tie', () => {
    const prev = [
      msg('b', { created_at: '2026-05-18T09:00:00.000Z' }),
      msg('live'),
    ];

    const row = msg('a', {
      created_at: '2026-05-18T09:00:00.000Z',
      message_source: 'history',
    });

    expect(ids(applyRealtimeInsert(prev, row))).toEqual(['a', 'b', 'live']);
  });

  it('replaces only the pending temp that matches the inserted row', () => {
    const prev = [
      msg('temp-1', { content_text: 'hello', status: 'sending' }),
      msg('temp-2', { content_text: 'other', status: 'sending' }),
    ];

    const next = applyRealtimeInsert(
      prev,
      msg('real-1', { content_text: 'hello' })
    );

    expect(ids(next)).toEqual(['temp-2', 'real-1']);
  });

  it('keeps failed temp bubbles even when content matches', () => {
    const prev = [msg('temp-1', { content_text: 'hello', status: 'failed' })];

    const next = applyRealtimeInsert(
      prev,
      msg('real-1', { content_text: 'hello' })
    );

    expect(ids(next)).toEqual(['temp-1', 'real-1']);
  });

  it('keeps temps when a customer message arrives', () => {
    const prev = [msg('temp-1', { content_text: 'hello', status: 'sending' })];

    const next = applyRealtimeInsert(
      prev,
      msg('in-1', { sender_type: 'customer', content_text: 'hello' })
    );

    expect(ids(next)).toEqual(['temp-1', 'in-1']);
  });

  it('does not match a temp of a different content type', () => {
    const prev = [
      msg('temp-1', {
        content_type: 'image',
        content_text: 'x',
        status: 'sending',
      }),
    ];

    const next = applyRealtimeInsert(
      prev,
      msg('real-1', { content_text: 'x' })
    );

    expect(ids(next)).toEqual(['temp-1', 'real-1']);
  });

  it('ignores duplicate inserts', () => {
    const prev = [msg('real-1')];
    expect(applyRealtimeInsert(prev, msg('real-1'))).toBe(prev);
  });
});

describe('confirmedSendUpdate', () => {
  it('carries the persisted row id from the send response', () => {
    expect(
      confirmedSendUpdate({ success: true, message_id: 'real-1' })
    ).toEqual({
      status: 'sent',
      id: 'real-1',
    });
  });

  it('only flips the status when the response has no id', () => {
    expect(confirmedSendUpdate({})).toEqual({ status: 'sent' });
    expect(confirmedSendUpdate(null)).toEqual({ status: 'sent' });
  });
});

describe('applyMessageUpdate', () => {
  it.each(['phone_app', 'history'] as const)(
    'reconciles one pending temp only when the same %s row is promoted to CRM',
    (message_source) => {
      const pending = msg('temp-1', {
        content_text: 'hello',
        status: 'sending',
      });

      const second = msg('temp-2', {
        content_text: 'hello',
        status: 'sending',
      });

      const echo = msg('real-1', {
        message_source,
        message_id: 'wamid.1',
        content_text: 'hello',
        status: 'read',
      });

      const echoed = applyRealtimeInsert([pending, second], echo);

      expect(ids(echoed)).toEqual(['temp-1', 'temp-2', 'real-1']);

      const promoted = applyMessageUpdate(echoed, echo.id, {
        message_source: 'cloud_api',
        sender_type: 'agent',
        content_text: 'hello',
      });

      expect(promoted).toEqual([
        second,
        { ...echo, message_source: 'cloud_api' },
      ]);
      expect(applyMessageUpdate(promoted, echo.id, { status: 'read' })).toEqual(
        promoted
      );
    }
  );

  it.each([
    { status: 'read' },
    { message_source: 'cloud_api' },
    { message_source: 'cloud_api', sender_type: 'bot' },
    {
      message_source: 'cloud_api',
      sender_type: 'agent',
      content_text: 'other',
    },
    {
      message_source: 'cloud_api',
      sender_type: 'agent',
      content_type: 'image',
    },
    {
      message_source: 'cloud_api',
      sender_type: 'agent',
      conversation_id: 'conv-2',
    },
  ] satisfies Partial<Message>[])(
    'keeps an agent temp without a matching authoritative promotion: %j',
    (updates) => {
      const pending = msg('temp-1', {
        content_text: 'hello',
        status: 'sending',
      });

      const echo = msg('real-1', {
        message_source: 'phone_app',
        content_text: 'hello',
      });

      expect(applyMessageUpdate([pending, echo], echo.id, updates)).toEqual([
        pending,
        { ...echo, ...updates },
      ]);
    }
  );

  it('does not consume a temp on an ordinary cloud status update', () => {
    const pending = msg('temp-1', { content_text: 'hello', status: 'sending' });

    const row = msg('real-1', {
      message_source: 'cloud_api',
      content_text: 'hello',
    });

    expect(
      applyMessageUpdate([pending, row], row.id, { ...row, status: 'read' })
    ).toEqual([pending, { ...row, status: 'read' }]);
  });

  it('uses promoted CRM content but keeps failed temps and distinct WAMIDs', () => {
    const failed = msg('temp-failed', {
      content_text: 'hello',
      status: 'failed',
    });

    const pending = msg('temp-1', { content_text: 'hello', status: 'sending' });

    const other = msg('real-other', {
      message_source: 'cloud_api',
      message_id: 'wamid.other',
      content_text: 'hello',
      status: 'read',
    });

    const echo = msg('real-1', {
      message_source: 'phone_app',
      message_id: 'wamid.1',
      content_text: 'echo content',
      status: 'delivered',
    });

    const updates: Partial<Message> = {
      message_source: 'cloud_api',
      sender_type: 'agent',
      content_text: 'hello',
    };

    const next = applyMessageUpdate(
      [failed, pending, other, echo],
      echo.id,
      updates
    );

    expect(next).toEqual([failed, other, { ...echo, ...updates }]);
    expect(applyMessageUpdate(next, pending.id, { status: 'failed' })).toEqual(
      next
    );
    expect(applyMessageUpdate(next, echo.id, { ...echo, ...updates })).toEqual(
      next
    );
  });

  it.each(['response-first', 'promotion-first'])(
    'keeps one read bubble when echo arrives first and confirmation is %s',
    (order) => {
      const pending = msg('temp-1', {
        content_text: 'hello',
        status: 'sending',
      });

      const echo = msg('real-1', {
        message_source: 'phone_app',
        message_id: 'wamid.1',
        content_text: 'hello',
        status: 'read',
      });

      const promoted: Message = { ...echo, message_source: 'cloud_api' };

      const response = confirmedSendUpdate({
        success: true,
        message_id: echo.id,
      });

      let messages = applyRealtimeInsert([pending], echo);

      if (order === 'response-first') {
        messages = applyMessageUpdate(messages, pending.id, response);
      }

      messages = applyMessageUpdate(messages, promoted.id, promoted);
      messages = applyRealtimeInsert(messages, promoted);

      if (order === 'promotion-first') {
        messages = applyMessageUpdate(messages, pending.id, response);
      }

      expect(messages).toEqual([promoted]);
    }
  );

  it('leaves a missing-row UPDATE to HTTP confirmation rather than inserting it', () => {
    const pending = msg('temp-1', { content_text: 'hello', status: 'sending' });

    const promoted = msg('real-1', {
      message_source: 'cloud_api',
      content_text: 'hello',
      status: 'read',
    });

    const messages = applyMessageUpdate([pending], promoted.id, promoted);

    expect(messages).toEqual([pending]);
    expect(
      applyMessageUpdate(
        messages,
        pending.id,
        confirmedSendUpdate({ message_id: promoted.id })
      )
    ).toEqual([{ ...pending, id: promoted.id, status: 'sent' }]);
  });

  it('swaps a temp id for the confirmed row id', () => {
    const prev = [msg('temp-1', { status: 'sending' })];

    const next = applyMessageUpdate(prev, 'temp-1', {
      id: 'real-1',
      status: 'sent',
    });

    expect(next).toEqual([
      msg('real-1', { content_text: 'temp-1', status: 'sent' }),
    ]);
  });

  it('drops the temp when realtime already delivered the confirmed row', () => {
    const prev = [msg('real-1'), msg('temp-1', { status: 'sending' })];

    const next = applyMessageUpdate(prev, 'temp-1', {
      id: 'real-1',
      status: 'sent',
    });

    expect(ids(next)).toEqual(['real-1']);
  });

  it('patches status without an id change', () => {
    const prev = [msg('temp-1', { status: 'sending' })];
    expect(
      applyMessageUpdate(prev, 'temp-1', { status: 'failed' })[0].status
    ).toBe('failed');
  });
});

describe('mergeFetchedPage', () => {
  const at = (minute: number) =>
    `2026-05-18T10:${String(minute).padStart(2, '0')}:00.000Z`;

  it('keeps failed and still-pending temps after a resync', () => {
    const prev = [
      msg('real-1', { created_at: at(1) }),
      msg('temp-failed', {
        content_text: 'lost',
        status: 'failed',
        created_at: at(2),
      }),
      msg('temp-pending', {
        content_text: 'wait',
        status: 'sending',
        created_at: at(3),
      }),
    ];

    const fetched = [msg('real-1', { created_at: at(1) })];
    expect(ids(mergeFetchedPage(prev, fetched, 'conv-1'))).toEqual([
      'real-1',
      'temp-failed',
      'temp-pending',
    ]);
  });

  it('drops a pending temp once the fetched page contains its row', () => {
    const prev = [
      msg('temp-1', { content_text: 'hi', status: 'sent', created_at: at(5) }),
    ];

    const fetched = [msg('real-9', { content_text: 'hi', created_at: at(5) })];
    expect(ids(mergeFetchedPage(prev, fetched, 'conv-1'))).toEqual(['real-9']);
  });

  it('does not let an old identical message consume a new pending temp', () => {
    const prev = [
      msg('temp-1', {
        content_text: 'ok',
        status: 'sending',
        created_at: at(30),
      }),
    ];

    const fetched = [
      msg('real-old', { content_text: 'ok', created_at: at(1) }),
    ];

    expect(ids(mergeFetchedPage(prev, fetched, 'conv-1'))).toEqual([
      'real-old',
      'temp-1',
    ]);
  });

  it('keeps older loaded pages when the newest page overlaps them', () => {
    const prev = [
      msg('old-1', { created_at: at(1) }),
      msg('old-2', { created_at: at(2) }),
      msg('mid-3', { created_at: at(3) }),
    ];

    const fetched = [
      msg('mid-3', { created_at: at(3) }),
      msg('new-4', { created_at: at(4) }),
    ];

    expect(ids(mergeFetchedPage(prev, fetched, 'conv-1'))).toEqual([
      'old-1',
      'old-2',
      'mid-3',
      'new-4',
    ]);
  });

  it('drops older pages when the newest page does not connect to them', () => {
    const prev = [msg('old-1', { created_at: at(1) })];

    const fetched = [
      msg('new-8', { created_at: at(8) }),
      msg('new-9', { created_at: at(9) }),
    ];

    expect(ids(mergeFetchedPage(prev, fetched, 'conv-1'))).toEqual([
      'new-8',
      'new-9',
    ]);
  });

  it('keeps a realtime row that landed after the fetch ran', () => {
    const prev = [
      msg('a', { created_at: at(1) }),
      msg('late', { created_at: at(9) }),
    ];

    const fetched = [msg('a', { created_at: at(1) })];
    expect(ids(mergeFetchedPage(prev, fetched, 'conv-1'))).toEqual([
      'a',
      'late',
    ]);
  });

  it('retains loaded rows across timestamp ties on overlapping resync', () => {
    const prev = [msg('a'), msg('b'), msg('d')];

    expect(ids(mergeFetchedPage(prev, [msg('b'), msg('c')], 'conv-1'))).toEqual(
      ['a', 'b', 'c', 'd']
    );
  });

  it('ignores local messages from another conversation', () => {
    const prev = [
      msg('temp-x', { conversation_id: 'conv-2', status: 'failed' }),
    ];

    expect(ids(mergeFetchedPage(prev, [msg('a')], 'conv-1'))).toEqual(['a']);
  });
});

describe('prependOlderMessages', () => {
  it('keeps an earlier realtime history row before the loaded page', () => {
    const prev = [
      msg('history', {
        message_source: 'history',
        created_at: '2020-01-01T00:00:00Z',
      }),
      msg('new'),
    ];

    const older = [msg('middle', { created_at: '2025-01-01T00:00:00Z' })];

    expect(ids(prependOlderMessages(prev, older))).toEqual([
      'history',
      'middle',
      'new',
    ]);
  });

  it('prepends unseen older rows and skips boundary duplicates', () => {
    const prev = [msg('b'), msg('c')];
    expect(ids(prependOlderMessages(prev, [msg('a'), msg('b')]))).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('returns the same list when nothing is new', () => {
    const prev = [msg('a')];
    expect(prependOlderMessages(prev, [msg('a')])).toBe(prev);
  });
});
