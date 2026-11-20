import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  BROADCAST_REPLY_WINDOW_MS,
  applyBroadcastRecipientStatus,
  flagBroadcastReply,
  isReplyAttributable,
} from './broadcast-recipient-webhook';

interface FakeRow {
  id: string;
  status: string;
  sent_at: string | null;
  whatsapp_message_id?: string;
  account_id?: string;
}

function makeDb(
  rows: FakeRow[],
  options: { failUpdate?: boolean; failLookup?: boolean } = {}
) {
  const updates: {
    filters: Record<string, unknown>;
    allowed: string[];
    patch: Record<string, unknown>;
  }[] = [];

  const latestQuery: Record<string, unknown> = {};

  const db = {
    from(table: string) {
      expect(table).toBe('broadcast_recipients');

      return {
        select: (columns: string) => {
          latestQuery.columns = columns;

          const chain = Object.assign(
            Promise.resolve().then(() => ({
              data: options.failLookup
                ? null
                : rows.filter(
                    (row) =>
                      row.whatsapp_message_id ===
                        latestQuery.whatsapp_message_id &&
                      (row.account_id ?? 'acc-1') ===
                        latestQuery['broadcasts.account_id']
                  ),
              error: options.failLookup ? { message: 'lookup failed' } : null,
            })),
            {
              eq: (column: string, value: unknown) => {
                latestQuery[column] = value;

                return chain;
              },
              order: (column: string, opts: { ascending: boolean }) => {
                latestQuery.order = [column, opts.ascending];

                return chain;
              },
              limit: (n: number) =>
                Promise.resolve({ data: rows.slice(0, n), error: null }),
            }
          );

          return chain;
        },
        update: (patch: Record<string, string>) => {
          const filters: Record<string, string | string[]> = {};
          let allowed: string[] = [];

          const chain = {
            eq: (column: string, value: string) => {
              filters[column] = value;

              return chain;
            },
            in: (column: string, values: string[]) => {
              if (column === 'status') allowed = values;
              else filters[column] = values;

              return chain;
            },
            select: () => {
              updates.push({ filters, allowed, patch });

              if (options.failUpdate) {
                return Promise.resolve({
                  data: null,
                  error: { message: 'boom' },
                });
              }

              const matched = rows.filter(
                (row) =>
                  Object.entries(filters).every(([column, value]) => {
                    const actual =
                      column === 'id' ? row.id : row.whatsapp_message_id;

                    return Array.isArray(value)
                      ? actual !== undefined && value.includes(actual)
                      : value === actual;
                  }) && allowed.includes(row.status)
              );

              for (const row of matched) row.status = String(patch.status);

              return Promise.resolve({
                data: matched.map((row) => ({ id: row.id })),
                error: null,
              });
            },
          };

          return chain;
        },
      };
    },
  } as unknown as SupabaseClient;

  return { db, updates, latestQuery };
}

const NOW = new Date('2026-10-16T12:00:00.000Z');

const hoursAgo = (h: number) =>
  new Date(NOW.getTime() - h * 3600_000).toISOString();

describe('applyBroadcastRecipientStatus', () => {
  const event = (status: string) => ({
    whatsappMessageId: 'wamid.1',
    status,
    occurredAt: '2026-10-16T11:00:00.000Z',
    failure: null,
  });

  it('leaves the same WAMID in another account unchanged', async () => {
    const rows = [
      {
        id: 'r1',
        account_id: 'acc-1',
        status: 'sent',
        sent_at: null,
        whatsapp_message_id: 'wamid.1',
      },
      {
        id: 'r2',
        account_id: 'acc-2',
        status: 'sent',
        sent_at: null,
        whatsapp_message_id: 'wamid.1',
      },
    ];

    const { db, latestQuery } = makeDb(rows);

    await expect(
      applyBroadcastRecipientStatus(db, 'acc-1', event('read'))
    ).resolves.toBe('updated');
    expect(rows.map((row) => row.status)).toEqual(['read', 'sent']);
    expect(latestQuery).toEqual({
      columns: 'id, broadcasts!inner(account_id)',
      whatsapp_message_id: 'wamid.1',
      'broadcasts.account_id': 'acc-1',
    });
  });

  it('only updates rows whose current status may precede the incoming one', async () => {
    const { db, updates } = makeDb([
      {
        id: 'r1',
        status: 'sent',
        sent_at: null,
        whatsapp_message_id: 'wamid.1',
      },
    ]);

    await expect(
      applyBroadcastRecipientStatus(db, 'acc-1', event('read'))
    ).resolves.toBe('updated');
    expect(updates[0].filters).toEqual({ id: ['r1'] });
    expect(updates[0].allowed).toEqual(['pending', 'sent', 'delivered']);
    expect(updates[0].patch).toEqual({
      status: 'read',
      read_at: '2026-10-16T11:00:00.000Z',
    });
  });

  it('is a no-op when a concurrent webhook already advanced the row', async () => {
    const rows = [
      {
        id: 'r1',
        status: 'sent',
        sent_at: null,
        whatsapp_message_id: 'wamid.1',
      },
    ];

    const { db } = makeDb(rows);
    await applyBroadcastRecipientStatus(db, 'acc-1', event('read'));
    await expect(
      applyBroadcastRecipientStatus(db, 'acc-1', event('delivered'))
    ).resolves.toBe('skipped');
    expect(rows[0].status).toBe('read');
  });

  it('refuses failed once the recipient was delivered', async () => {
    const rows = [
      {
        id: 'r1',
        status: 'delivered',
        sent_at: null,
        whatsapp_message_id: 'wamid.1',
      },
    ];

    const { db, updates } = makeDb(rows);
    await expect(
      applyBroadcastRecipientStatus(db, 'acc-1', {
        ...event('failed'),
        failure: { code: 131049, title: 'Blocked', details: 'ecosystem' },
      })
    ).resolves.toBe('skipped');
    expect(updates[0].allowed).toEqual(['pending', 'sent']);
    expect(updates[0].patch.error_message).toBe('[131049] Blocked: ecosystem');
    expect(rows[0].status).toBe('delivered');
  });

  it('skips unknown statuses without touching the database', async () => {
    const { db, updates } = makeDb([]);

    await expect(
      applyBroadcastRecipientStatus(db, 'acc-1', event('deleted'))
    ).resolves.toBe('skipped');
    expect(updates).toHaveLength(0);
  });

  it('skips a WAMID that belongs only to another account', async () => {
    const rows = [
      {
        id: 'r2',
        account_id: 'acc-2',
        status: 'sent',
        sent_at: null,
        whatsapp_message_id: 'wamid.1',
      },
    ];

    const { db, updates } = makeDb(rows);

    await expect(
      applyBroadcastRecipientStatus(db, 'acc-1', event('read'))
    ).resolves.toBe('skipped');
    expect(updates).toEqual([]);
    expect(rows[0].status).toBe('sent');
  });

  it('reports a lookup error without attempting an update', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { db, updates } = makeDb(
      [
        {
          id: 'r1',
          status: 'sent',
          sent_at: null,
          whatsapp_message_id: 'wamid.1',
        },
      ],
      { failLookup: true }
    );

    try {
      await expect(
        applyBroadcastRecipientStatus(db, 'acc-1', event('read'))
      ).resolves.toBe('error');
      expect(updates).toEqual([]);
    } finally {
      error.mockRestore();
    }
  });

  it('keeps failed terminal within the account', async () => {
    const rows = [
      {
        id: 'r1',
        status: 'failed',
        sent_at: null,
        whatsapp_message_id: 'wamid.1',
      },
    ];

    const { db } = makeDb(rows);

    await expect(
      applyBroadcastRecipientStatus(db, 'acc-1', event('read'))
    ).resolves.toBe('skipped');
    expect(rows[0].status).toBe('failed');
  });

  it('reports a database error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { db } = makeDb(
      [
        {
          id: 'r1',
          status: 'pending',
          sent_at: null,
          whatsapp_message_id: 'wamid.1',
        },
      ],
      { failUpdate: true }
    );

    await expect(
      applyBroadcastRecipientStatus(db, 'acc-1', event('sent'))
    ).resolves.toBe('error');
    error.mockRestore();
  });
});

describe('isReplyAttributable', () => {
  it('accepts a sent, delivered or read row inside the reply window', () => {
    for (const status of ['sent', 'delivered', 'read']) {
      expect(
        isReplyAttributable({ id: 'r', status, sent_at: hoursAgo(2) }, NOW)
      ).toBe(true);
    }
  });

  it('rejects a row already replied, failed, or never sent', () => {
    expect(
      isReplyAttributable(
        { id: 'r', status: 'replied', sent_at: hoursAgo(2) },
        NOW
      )
    ).toBe(false);
    expect(
      isReplyAttributable(
        { id: 'r', status: 'failed', sent_at: hoursAgo(2) },
        NOW
      )
    ).toBe(false);
    expect(
      isReplyAttributable({ id: 'r', status: 'pending', sent_at: null }, NOW)
    ).toBe(false);
  });

  it('rejects a row sent before the reply window', () => {
    const justOutside = new Date(
      NOW.getTime() - BROADCAST_REPLY_WINDOW_MS - 1
    ).toISOString();

    expect(
      isReplyAttributable(
        { id: 'r', status: 'read', sent_at: justOutside },
        NOW
      )
    ).toBe(false);
  });
});

describe('flagBroadcastReply', () => {
  it('looks up only the most recent recipient row for the contact in the account', async () => {
    const { db, latestQuery } = makeDb([
      { id: 'r1', status: 'read', sent_at: hoursAgo(1) },
    ]);

    await expect(
      flagBroadcastReply(db, 'acc-1', 'contact-1', NOW)
    ).resolves.toBe('updated');
    expect(latestQuery).toMatchObject({
      contact_id: 'contact-1',
      'broadcasts.account_id': 'acc-1',
      order: ['created_at', false],
    });
  });

  it('does not walk back to an older broadcast on a second inbound message', async () => {
    const rows = [
      { id: 'newest', status: 'read', sent_at: hoursAgo(1) },
      { id: 'older', status: 'read', sent_at: hoursAgo(30) },
    ];

    const { db } = makeDb(rows);
    await flagBroadcastReply(db, 'acc-1', 'contact-1', NOW);
    await expect(
      flagBroadcastReply(db, 'acc-1', 'contact-1', NOW)
    ).resolves.toBe('skipped');
    expect(rows.map((r) => r.status)).toEqual(['replied', 'read']);
  });

  it('ignores a reply to a broadcast sent outside the window', async () => {
    const rows = [{ id: 'r1', status: 'delivered', sent_at: hoursAgo(24 * 8) }];
    const { db, updates } = makeDb(rows);
    await expect(
      flagBroadcastReply(db, 'acc-1', 'contact-1', NOW)
    ).resolves.toBe('skipped');
    expect(updates).toHaveLength(0);
  });

  it('guards the update so a concurrent reply cannot flag it twice', async () => {
    const { db, updates } = makeDb([
      { id: 'r1', status: 'sent', sent_at: hoursAgo(1) },
    ]);

    await flagBroadcastReply(db, 'acc-1', 'contact-1', NOW);
    expect(updates[0].filters).toEqual({ id: 'r1' });
    expect(updates[0].allowed).not.toContain('replied');
    expect(updates[0].patch).toEqual({
      status: 'replied',
      replied_at: NOW.toISOString(),
    });
  });
});
