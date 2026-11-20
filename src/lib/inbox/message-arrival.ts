import type { Conversation, Message } from '@/types';
import { compareMessageTimestamps } from './optimistic-messages';

export function isLiveCustomerMessage(
  message: Pick<Message, 'sender_type' | 'message_source'>
): boolean {
  return (
    message.sender_type === 'customer' &&
    (message.message_source ?? 'cloud_api') === 'cloud_api'
  );
}

export function applyConversationMessageInsert(
  conversation: Conversation,
  message: Message,
  active: boolean
): Conversation {
  if (conversation.id !== message.conversation_id) return conversation;

  const inbound = isLiveCustomerMessage(message);

  const newer =
    !conversation.last_message_at ||
    compareMessageTimestamps(message.created_at, conversation.last_message_at) >
      0;

  const next = { ...conversation };

  if (newer) {
    next.last_message_text = message.content_text ?? '';
    next.last_message_at = message.created_at;
  }

  if (inbound) next.unread_count = active ? 0 : conversation.unread_count + 1;

  return next;
}

export function shouldScrollForMessages(
  previous: Message[],
  next: Message[]
): boolean {
  if (previous.length === 0) return next.length > 0;

  const known = new Set(previous.map((message) => message.id));

  return next.some(
    (message) => !known.has(message.id) && message.message_source !== 'history'
  );
}
