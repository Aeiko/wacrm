import type { Message } from '@/types';

export const TEMP_MESSAGE_PREFIX = 'temp-';
export const RESYNC_MATCH_WINDOW_MS = 2 * 60_000;

let tempCounter = 0;

export function newTempMessageId(now: number = Date.now()): string {
  tempCounter += 1;

  return `${TEMP_MESSAGE_PREFIX}${now}-${tempCounter}`;
}

export function isTempMessage(message: Pick<Message, 'id'>): boolean {
  return message.id.startsWith(TEMP_MESSAGE_PREFIX);
}

function createdAtMs(message: Pick<Message, 'created_at'>): number {
  return new Date(message.created_at).getTime();
}

function microsecondRemainder(timestamp: string): number {
  const fraction = timestamp.match(/\.(\d+)(?:Z|[+-]\d{2}:?\d{2})$/)?.[1] ?? '';

  return Number(fraction.padEnd(6, '0').slice(3, 6));
}

export function compareMessageTimestamps(a: string, b: string): number {
  // JavaScript Date drops the final three fractional digits of PostgreSQL timestamps.
  return (
    new Date(a).getTime() - new Date(b).getTime() ||
    microsecondRemainder(a) - microsecondRemainder(b)
  );
}

export function compareMessageOrder(
  a: Pick<Message, 'created_at' | 'id'>,
  b: Pick<Message, 'created_at' | 'id'>
): number {
  return (
    compareMessageTimestamps(a.created_at, b.created_at) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

export function olderMessagesFilter(
  cursor: Pick<Message, 'created_at' | 'id'>
): string {
  const timestamp = JSON.stringify(cursor.created_at);
  const id = JSON.stringify(cursor.id);

  return `created_at.lt.${timestamp},and(created_at.eq.${timestamp},id.lt.${id})`;
}

function isPendingTemp(message: Message): boolean {
  return isTempMessage(message) && message.status !== 'failed';
}

function sameOutgoingContent(temp: Message, row: Message): boolean {
  return (
    row.sender_type === 'agent' &&
    (row.message_source ?? 'cloud_api') === 'cloud_api' &&
    temp.sender_type === row.sender_type &&
    temp.conversation_id === row.conversation_id &&
    temp.content_type === row.content_type &&
    (temp.content_text ?? '') === (row.content_text ?? '')
  );
}

export function applyRealtimeInsert(prev: Message[], row: Message): Message[] {
  if (prev.some((m) => m.id === row.id)) return prev;

  const tempIndex = prev.findIndex(
    (m) => isPendingTemp(m) && sameOutgoingContent(m, row)
  );

  const withoutMatchedTemp =
    tempIndex >= 0 ? prev.filter((_, i) => i !== tempIndex) : prev;

  const insertionIndex = withoutMatchedTemp.findIndex(
    (message) =>
      !isTempMessage(message) && compareMessageOrder(message, row) > 0
  );

  if (insertionIndex < 0) return [...withoutMatchedTemp, row];

  return [
    ...withoutMatchedTemp.slice(0, insertionIndex),
    row,
    ...withoutMatchedTemp.slice(insertionIndex),
  ];
}

export function confirmedSendUpdate(response: unknown): Partial<Message> {
  const messageId = (response as { message_id?: unknown } | null)?.message_id;

  return typeof messageId === 'string' && messageId
    ? { status: 'sent', id: messageId }
    : { status: 'sent' };
}

export function applyMessageUpdate(
  prev: Message[],
  id: string,
  updates: Partial<Message>
): Message[] {
  const nextId = updates.id;

  if (nextId && nextId !== id && prev.some((m) => m.id === nextId)) {
    return prev.filter((m) => m.id !== id);
  }

  const existing = prev.find((m) => m.id === id);
  let tempIndex = -1;

  if (
    existing &&
    !isTempMessage(existing) &&
    (existing.message_source === 'phone_app' ||
      existing.message_source === 'history') &&
    updates.message_source === 'cloud_api' &&
    updates.sender_type === 'agent'
  ) {
    const promoted = { ...existing, ...updates };

    tempIndex = prev.findIndex(
      (m) => isPendingTemp(m) && sameOutgoingContent(m, promoted)
    );
  }

  return prev.flatMap((m, index) => {
    if (index === tempIndex) return [];

    return [m.id === id ? { ...m, ...updates } : m];
  });
}

function unmatchedTemps(temps: Message[], fetched: Message[]): Message[] {
  const consumed = new Set<string>();

  return temps.filter((temp) => {
    if (temp.status === 'failed') return true;
    const tempAt = createdAtMs(temp);

    const match = fetched.find(
      (row) =>
        !consumed.has(row.id) &&
        sameOutgoingContent(temp, row) &&
        createdAtMs(row) >= tempAt - RESYNC_MATCH_WINDOW_MS
    );

    if (!match) return true;
    consumed.add(match.id);

    return false;
  });
}

export function mergeFetchedPage(
  prev: Message[],
  fetched: Message[],
  conversationId: string
): Message[] {
  const local = prev.filter((m) => m.conversation_id === conversationId);
  const temps = local.filter(isTempMessage);
  const localReal = local.filter((m) => !isTempMessage(m));

  if (fetched.length === 0) {
    return [...localReal, ...unmatchedTemps(temps, fetched)];
  }

  const fetchedIds = new Set(fetched.map((m) => m.id));
  const oldestFetched = fetched[0];
  const newestFetched = fetched[fetched.length - 1];
  const overlapsLocal = localReal.some((m) => fetchedIds.has(m.id));

  const olderKept = overlapsLocal
    ? localReal.filter(
        (m) =>
          !fetchedIds.has(m.id) && compareMessageOrder(m, oldestFetched) < 0
      )
    : [];

  const newerKept = localReal.filter(
    (m) => !fetchedIds.has(m.id) && compareMessageOrder(m, newestFetched) > 0
  );

  return [
    ...olderKept,
    ...fetched,
    ...newerKept,
    ...unmatchedTemps(temps, fetched),
  ];
}

export function prependOlderMessages(
  prev: Message[],
  older: Message[]
): Message[] {
  const known = new Set(prev.map((m) => m.id));
  const fresh = older.filter((m) => !known.has(m.id));

  return fresh.length === 0
    ? prev
    : [...fresh, ...prev].sort(compareMessageOrder);
}
