import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { ContentType } from '@/types';
import type { InteractiveMessagePayload } from './interactive';
import {
  sendConnectionColumns,
  withSendConnection,
} from './coexistence/send-guard';

interface AcceptedOutboundMessage {
  conversation_id: string;
  message_id: string;
  sender_type: 'agent' | 'bot';
  sender_id?: string | null;
  ai_generated?: boolean;
  content_type: Exclude<ContentType, 'location'>;
  content_text: string | null;
  media_url?: string | null;
  template_name?: string | null;
  interactive_payload?: InteractiveMessagePayload | null;
  reply_to_message_id?: string | null;
}

const persistedMessageSchema = z.object({
  id: z.uuid(),
  message_id: z.string().min(1),
  status: z.enum(['sending', 'sent', 'delivered', 'read', 'failed']),
});

/** Record an already accepted send; failures never mean it is safe to send again. */
export async function persistOutboundMessage(
  db: SupabaseClient,
  args: {
    accountId: string;
    contactId: string;
    recipient: { phone: string | null; wa_user_id: string | null };
    message: AcceptedOutboundMessage;
    preview: string;
  }
): Promise<z.infer<typeof persistedMessageSchema>> {
  try {
    const connection = sendConnectionColumns();
    const message = args.message;

    const { data, error } = await withSendConnection(
      {
        accountId: args.accountId,
        configId: connection.send_config_id,
        generation: connection.send_generation,
      },
      async () =>
        db.rpc('persist_outbound_message', {
          p_account_id: args.accountId,
          p_contact_id: args.contactId,
          p_config_id: connection.send_config_id,
          p_generation: connection.send_generation,
          p_recipient: args.recipient,
          p_message: {
            conversation_id: message.conversation_id,
            message_id: message.message_id,
            created_at: new Date().toISOString(),
            sender_type: message.sender_type,
            sender_id: message.sender_id ?? null,
            ai_generated: message.ai_generated ?? false,
            content_type: message.content_type,
            content_text: message.content_text,
            media_url: message.media_url ?? null,
            template_name: message.template_name ?? null,
            interactive_payload: message.interactive_payload ?? null,
            reply_to_message_id: message.reply_to_message_id ?? null,
          },
          p_preview: args.preview,
        })
    );

    const parsed = persistedMessageSchema.safeParse(data);

    if (
      error ||
      !parsed.success ||
      parsed.data.message_id !== message.message_id
    )
      throw new Error('Invalid outbound persistence response');

    return parsed.data;
  } catch {
    throw new Error(
      'Message accepted by Meta but failed to persist; delivery is ambiguous. Do not resend.'
    );
  }
}
