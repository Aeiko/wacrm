import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import {
  echoSchema,
  historySchema,
  liveSchema,
  stateSchema,
  type CoexistenceDelivery,
  type ContactIdentity,
  type MessageOperation,
  type LiveMessageOperation,
  type NormalizedOperation,
  type QuarantineOperation,
  type SourceMessage,
  type SourceContact,
  type ThreadContext,
} from './payload';

function quarantine(code: string): QuarantineOperation {
  return { kind: 'quarantine', code };
}

function identity(
  context: ThreadContext,
  name: string | null = null
): ContactIdentity {
  return {
    phone: normalizePhone(context.wa_id ?? ''),
    wa_user_id: context.user_id ?? null,
    wa_parent_user_id: context.parent_user_id ?? null,
    wa_username: context.username ?? null,
    name,
  };
}

function usableIdentity(contact: ContactIdentity): boolean {
  return Boolean(contact.phone || contact.wa_user_id);
}

type MessageContent = Pick<
  MessageOperation,
  'content_type' | 'content_text' | 'media_id' | 'media_type' | 'placeholder'
>;

function content(message: SourceMessage): MessageContent | null {
  switch (message.type) {
    case 'text':
      return message.text
        ? {
            content_type: 'text',
            content_text: message.text.body,
            media_id: null,
            media_type: null,
            placeholder: false,
          }
        : null;
    case 'media_placeholder':
      return {
        content_type: 'text',
        content_text: '[Media unavailable]',
        media_id: null,
        media_type: null,
        placeholder: true,
      };
    case 'image':
    case 'video':
    case 'document':
    case 'audio':
    case 'sticker': {
      const attachment = message[message.type];

      return attachment
        ? {
            content_type: message.type === 'sticker' ? 'image' : message.type,
            content_text: attachment.caption ?? attachment.filename ?? null,
            media_id: attachment.id,
            media_type: attachment.mime_type ?? null,
            placeholder: false,
          }
        : null;
    }

    case 'location':
      return message.location
        ? {
            content_type: 'location',
            content_text: JSON.stringify(message.location),
            media_id: null,
            media_type: null,
            placeholder: false,
          }
        : null;
    default:
      return null;
  }
}

function historyStatus(
  status: string | undefined
): MessageOperation['status'] | null {
  switch (status) {
    // Meta's history examples use both lowercase and uppercase status values.
    case undefined:
    case 'sent':
    case 'SENT':
      return 'sent';
    case 'delivered':
    case 'DELIVERED':
      return 'delivered';
    case 'played':
    case 'PLAYED':
    case 'read':
    case 'READ':
      return 'read';
    case 'error':
    case 'ERROR':
      return 'failed';
    case 'pending':
    case 'PENDING':
      return 'pending';
    default:
      return null;
  }
}

function messageOperation(
  message: SourceMessage,
  contact: ContactIdentity,
  sender: MessageOperation['sender_type'],
  source: MessageOperation['source']
): NormalizedOperation {
  if (!usableIdentity(contact)) return quarantine('missing_contact_identity');

  const parsed = content(message);
  const status = historyStatus(message.history_context?.status);

  if (!parsed || !status)
    return quarantine('unsupported_message_content_or_status');

  return {
    kind: 'message',
    source,
    wamid: message.id,
    occurred_at: new Date(Number(message.timestamp) * 1000).toISOString(),
    sender_type: sender,
    identity: contact,
    status,
    reply_wamid: message.context?.id ?? null,
    ...parsed,
  };
}

function liveIdentity(
  context: ThreadContext,
  contacts: SourceContact[],
  businessPhone: string
): ContactIdentity | null {
  if (!context.wa_id && !context.user_id) return null;

  const matches = contacts.filter(
    (contact) =>
      (context.wa_id &&
        contact.wa_id &&
        normalizePhone(context.wa_id) === normalizePhone(contact.wa_id)) ||
      (context.user_id && contact.user_id === context.user_id)
  );

  const phones = new Set(
    [context.wa_id, ...matches.map((contact) => contact.wa_id)].flatMap(
      (value) => (value === undefined ? [] : [normalizePhone(value)])
    )
  );

  const users = new Set(
    [context.user_id, ...matches.map((contact) => contact.user_id)].filter(
      (value) => value !== undefined
    )
  );

  const parents = new Set(
    [
      context.parent_user_id,
      ...matches.map((contact) => contact.parent_user_id),
    ].filter((value) => value !== undefined)
  );

  if (
    phones.size > 1 ||
    users.size > 1 ||
    parents.size > 1 ||
    phones.has(businessPhone)
  )
    return null;

  const contact = matches[0];

  return identity(
    {
      wa_id: [...phones][0],
      user_id: [...users][0],
      parent_user_id: [...parents][0],
      username: contact?.profile?.username ?? contact?.username,
    },
    contact?.profile?.name ?? null
  );
}

function normalizeLive(delivery: CoexistenceDelivery): NormalizedOperation[] {
  const parsed = liveSchema.safeParse(delivery.value);
  const unsupported = [quarantine('unsupported_payload')];

  if (!parsed.success) return unsupported;

  const businessPhone = normalizePhone(
    parsed.data.metadata.display_phone_number
  );

  const operations: NormalizedOperation[] = [];

  for (const status of parsed.data.statuses ?? []) {
    const recipient = liveIdentity(
      {
        wa_id: status.recipient_id,
        user_id: status.recipient_user_id,
        parent_user_id: status.recipient_parent_user_id,
      },
      parsed.data.contacts ?? [],
      businessPhone
    );

    if (!recipient) return unsupported;

    const error = status.errors?.[0];
    operations.push({
      kind: 'message_status',
      wamid: status.id,
      occurred_at: new Date(Number(status.timestamp) * 1000).toISOString(),
      identity: recipient,
      status: status.status === 'played' ? 'read' : status.status,
      provider_status: status.status,
      error_code: error?.code ?? null,
      error_title: error?.title ?? null,
      error_details: error?.error_data?.details ?? null,
    });
  }

  for (const message of parsed.data.messages ?? []) {
    if (
      (!message.from && !message.from_user_id) ||
      (message.from && normalizePhone(message.from) === businessPhone) ||
      (message.to && normalizePhone(message.to) !== businessPhone) ||
      message.to_user_id ||
      message.to_parent_user_id
    )
      return unsupported;

    const sender = liveIdentity(
      {
        wa_id: message.from,
        user_id: message.from_user_id,
        parent_user_id: message.from_parent_user_id,
      },
      parsed.data.contacts ?? [],
      businessPhone
    );

    if (!sender) return unsupported;

    if (message.type === 'reaction') {
      if (!message.reaction) return unsupported;
      operations.push({
        kind: 'reaction',
        wamid: message.id,
        target_wamid: message.reaction.message_id,
        occurred_at: new Date(Number(message.timestamp) * 1000).toISOString(),
        identity: sender,
        emoji: message.reaction.emoji ?? '',
      });
      continue;
    }

    let body: Pick<
      LiveMessageOperation,
      | 'content_type'
      | 'content_text'
      | 'media_id'
      | 'media_type'
      | 'placeholder'
    > | null;

    let interactiveReplyId: string | null = null;

    if (message.type === 'interactive') {
      const interactive = message.interactive;

      if (!interactive) return unsupported;

      const reply =
        interactive.type === 'button_reply'
          ? interactive.button_reply
          : interactive.type === 'list_reply'
            ? interactive.list_reply
            : null;

      if (!reply && ['button_reply', 'list_reply'].includes(interactive.type))
        return unsupported;

      interactiveReplyId = reply?.id ?? null;
      body = {
        content_type: 'interactive',
        content_text: reply ? reply.title || reply.id : '[Interactive reply]',
        media_id: null,
        media_type: null,
        placeholder: false,
      };
    } else if (message.type === 'button') {
      if (!message.button) return unsupported;
      interactiveReplyId =
        message.button.payload || message.button.text || null;
      body = {
        content_type: 'interactive',
        content_text: message.button.text || message.button.payload || null,
        media_id: null,
        media_type: null,
        placeholder: false,
      };
    } else {
      body = message.type === 'media_placeholder' ? null : content(message);
    }

    if (!body) return unsupported;

    operations.push({
      kind: 'live_message',
      source: 'cloud_api',
      sender_type: 'customer',
      status: 'delivered',
      wamid: message.id,
      occurred_at: new Date(Number(message.timestamp) * 1000).toISOString(),
      identity: sender,
      reply_wamid: message.context?.id ?? null,
      interactive_reply_id: interactiveReplyId,
      ...body,
    });
  }

  return operations;
}

function normalizeEcho(delivery: CoexistenceDelivery): NormalizedOperation[] {
  const parsed = echoSchema.safeParse(delivery.value);

  if (!parsed.success) return [quarantine('malformed_echo')];

  const businessPhone = normalizePhone(
    parsed.data.metadata.display_phone_number
  );

  return parsed.data.message_echoes.map((message) => {
    if (message.from && normalizePhone(message.from) !== businessPhone)
      return quarantine('echo_sender_mismatch');

    const contacts = parsed.data.contacts ?? [];

    const matches = contacts.filter(
      (contact) =>
        (message.to_user_id && contact.user_id === message.to_user_id) ||
        (message.to &&
          contact.wa_id &&
          normalizePhone(message.to) === normalizePhone(contact.wa_id))
    );

    if (
      matches.some(
        (contact) =>
          (message.to_user_id &&
            contact.user_id &&
            message.to_user_id !== contact.user_id) ||
          (message.to &&
            contact.wa_id &&
            normalizePhone(message.to) !== normalizePhone(contact.wa_id))
      )
    )
      return quarantine('conflicting_echo_recipient');

    const contact = matches[0];

    const recipient = identity(
      {
        wa_id: message.to ?? contact?.wa_id,
        user_id: message.to_user_id ?? contact?.user_id,
        parent_user_id: message.to_parent_user_id ?? contact?.parent_user_id,
        username: contact?.profile?.username,
      },
      contact?.profile?.name ?? null
    );

    return messageOperation(message, recipient, 'agent', 'phone_app');
  });
}

function historySender(
  message: SourceMessage,
  contact: ContactIdentity,
  businessPhone: string
): MessageOperation['sender_type'] | null {
  const senderPhone = normalizePhone(message.from ?? '');

  const phoneInbound = Boolean(
    senderPhone && contact.phone && senderPhone === contact.phone
  );

  const phoneOutbound = Boolean(senderPhone && senderPhone === businessPhone);

  const bsuidInbound = Boolean(
    message.from_user_id && message.from_user_id === contact.wa_user_id
  );

  if (message.from_user_id && !bsuidInbound) return null;

  if (bsuidInbound && phoneOutbound) return null;

  if (senderPhone && !phoneInbound && !phoneOutbound) return null;

  if (phoneInbound || bsuidInbound) return 'customer';

  return phoneOutbound ? 'agent' : null;
}

function normalizeHistory(
  delivery: CoexistenceDelivery
): NormalizedOperation[] {
  const parsed = historySchema.safeParse(delivery.value);

  if (!parsed.success) return [quarantine('malformed_history')];

  const operations: NormalizedOperation[] = [];

  const businessPhone = normalizePhone(
    parsed.data.metadata?.display_phone_number ?? ''
  );

  for (const batch of parsed.data.history ?? []) {
    for (const thread of batch.threads ?? []) {
      const contact = identity({
        ...thread.context,
        wa_id: thread.context?.wa_id ?? thread.id,
      });

      if (
        thread.id &&
        thread.context?.wa_id &&
        normalizePhone(thread.id) !== normalizePhone(thread.context.wa_id)
      ) {
        operations.push(quarantine('conflicting_thread_identity'));
        continue;
      }

      for (const message of thread.messages) {
        const sender = historySender(message, contact, businessPhone);

        operations.push(
          sender
            ? messageOperation(message, contact, sender, 'history')
            : quarantine('ambiguous_history_direction')
        );
      }
    }

    if (batch.metadata) {
      operations.push({
        kind: 'progress',
        ...batch.metadata,
        error_code: null,
      });
    }

    for (const error of batch.errors ?? []) {
      operations.push({
        kind: 'progress',
        phase: null,
        chunk_order: null,
        progress: null,
        error_code: error.code,
      });
    }

    if (!batch.metadata && !batch.threads?.length && !batch.errors?.length)
      operations.push(quarantine('empty_history_batch'));
  }

  for (const message of parsed.data.messages ?? []) {
    const parsedContent = content(message);

    if (!parsedContent?.media_id) {
      operations.push(quarantine('malformed_history_hydration'));
      continue;
    }

    operations.push({
      kind: 'hydration',
      wamid: message.id,
      media_id: parsedContent.media_id,
      media_type: parsedContent.media_type,
      content_type: parsedContent.content_type,
      content_text: parsedContent.content_text,
    });
  }

  return operations;
}

function normalizeContacts(
  delivery: CoexistenceDelivery
): NormalizedOperation[] {
  const parsed = stateSchema.safeParse(delivery.value);

  if (!parsed.success) return [quarantine('malformed_contact_state')];

  return parsed.data.state_sync.map((state) => {
    const contact = identity(
      {
        wa_id: state.contact.phone_number,
        user_id: state.contact.user_id,
        parent_user_id: state.contact.parent_user_id,
        username: state.contact.username,
      },
      state.contact.full_name ?? state.contact.first_name ?? null
    );

    return usableIdentity(contact)
      ? {
          kind: 'contact',
          identity: contact,
          action: state.action,
          occurred_at: new Date(
            Number(state.metadata.timestamp) * 1000
          ).toISOString(),
        }
      : quarantine('missing_contact_identity');
  });
}

export function normalizeDelivery(
  delivery: CoexistenceDelivery
): NormalizedOperation[] {
  let operations: NormalizedOperation[];

  switch (delivery.field) {
    case 'messages':
      operations = normalizeLive(delivery);
      break;
    case 'smb_message_echoes':
      operations = normalizeEcho(delivery);
      break;
    case 'history':
      operations = normalizeHistory(delivery);
      break;
    case 'smb_app_state_sync':
      operations = normalizeContacts(delivery);
      break;
    default:
      operations = [quarantine('unsupported_lifecycle_event')];
  }

  return operations.length > 5000
    ? [quarantine('operation_limit_exceeded')]
    : operations;
}
