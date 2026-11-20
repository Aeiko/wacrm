import { z } from 'zod';

export const jsonSchema = z.json();

export type JsonValue = z.infer<typeof jsonSchema>;

export const coexistenceFields = new Set([
  'history',
  'smb_app_state_sync',
  'smb_message_echoes',
  'account_update',
]);

export const changeSchema = z.object({ field: z.string(), value: jsonSchema });

export const envelopeSchema = z.object({
  object: z.literal('whatsapp_business_account').optional(),
  entry: z
    .array(
      z.object({
        id: z.string().min(1),
        changes: z.array(changeSchema).max(1000),
      })
    )
    .max(1000)
    .default([]),
});

const phoneSchema = z
  .string()
  .regex(/^\+?[\d ()-]{6,30}$/)
  .refine((value) => /^\d{6,15}$/.test(value.replace(/\D/g, '')));

export const metadataSchema = z.object({
  phone_number_id: z.string().regex(/^\d+$/),
  display_phone_number: phoneSchema,
});

export const deliverySchema = z.object({
  waba_id: z.string().regex(/^\d+$/),
  field: z.string(),
  value: jsonSchema,
});

export type CoexistenceDelivery = z.infer<typeof deliverySchema>;

const bsuidSchema = z
  .string()
  .regex(/^[A-Za-z]{2}\.(?:ENT\.)?[A-Za-z0-9]{4,}$/);

const labelSchema = z.string().max(1024);

const identityFields = {
  wa_id: phoneSchema.optional(),
  user_id: bsuidSchema.optional(),
  parent_user_id: bsuidSchema.optional(),
  username: labelSchema.optional(),
};

export const contextSchema = z.object(identityFields);

export const contactSchema = z.object({
  ...identityFields,
  profile: z
    .object({ name: labelSchema.optional(), username: labelSchema.optional() })
    .optional(),
});

export const timestampSchema = z
  .string()
  .regex(/^\d{1,12}$/)
  .refine((value) => {
    const millis = Number(value) * 1000;

    return Number.isSafeInteger(millis) && millis <= 8640000000000000;
  });

const mediaSchema = z.object({
  id: z.string().min(1).max(512),
  mime_type: z.string().max(255).optional(),
  caption: z.string().max(65536).optional(),
  filename: labelSchema.optional(),
});

export const messageSchema = z.object({
  id: z.string().min(1).max(512),
  from: phoneSchema.optional(),
  from_user_id: bsuidSchema.optional(),
  from_parent_user_id: bsuidSchema.optional(),
  to: phoneSchema.optional(),
  to_user_id: bsuidSchema.optional(),
  to_parent_user_id: bsuidSchema.optional(),
  timestamp: timestampSchema,
  type: z.string(),
  text: z.object({ body: z.string().max(65536) }).optional(),
  image: mediaSchema.optional(),
  video: mediaSchema.optional(),
  document: mediaSchema.optional(),
  audio: mediaSchema.optional(),
  sticker: mediaSchema.optional(),
  location: z
    .object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      name: labelSchema.optional(),
      address: labelSchema.optional(),
    })
    .optional(),
  context: z.object({ id: z.string().min(1).max(512) }).optional(),
  history_context: z.object({ status: z.string() }).optional(),
});

const liveMessageSchema = messageSchema.extend({
  reaction: z
    .object({
      message_id: z.string().min(1).max(512),
      emoji: z.string().max(64).optional(),
    })
    .optional(),
  interactive: z
    .object({
      type: z.string(),
      button_reply: z
        .object({ id: labelSchema.min(1), title: labelSchema })
        .optional(),
      list_reply: z
        .object({
          id: labelSchema.min(1),
          title: labelSchema,
          description: labelSchema.optional(),
        })
        .optional(),
    })
    .optional(),
  button: z
    .object({ text: labelSchema.optional(), payload: labelSchema.optional() })
    .refine((button) => Boolean(button.text || button.payload))
    .optional(),
});

// Meta: /documentation/business-messaging/whatsapp/webhooks/reference/messages/status.md
const liveStatusSchema = z.object({
  id: z.string().min(1).max(512),
  status: z.enum(['sent', 'delivered', 'read', 'played', 'failed']),
  timestamp: timestampSchema,
  recipient_id: phoneSchema.optional(),
  recipient_user_id: bsuidSchema.optional(),
  recipient_parent_user_id: bsuidSchema.optional(),
  // Group statuses must not be attributed to a 1:1 customer.
  recipient_type: z.never().optional(),
  recipient_participant_id: z.never().optional(),
  errors: z
    .array(
      z.object({
        code: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        title: labelSchema.optional(),
        error_data: z
          .object({ details: z.string().max(65536).optional() })
          .optional(),
      })
    )
    .min(1)
    .max(100)
    .optional(),
});

export const liveSchema = z
  .object({
    messaging_product: z.literal('whatsapp').optional(),
    metadata: metadataSchema,
    messages: z.array(liveMessageSchema).min(1).max(5000).optional(),
    statuses: z.array(liveStatusSchema).min(1).max(5000).optional(),
    contacts: z.array(contactSchema).max(5000).optional(),
  })
  .strict()
  .refine((value) => {
    const count = (value.messages?.length ?? 0) + (value.statuses?.length ?? 0);

    return count > 0 && count <= 5000;
  });

export type SourceMessage = z.infer<typeof messageSchema>;

export type SourceContact = z.infer<typeof contactSchema>;

export type ThreadContext = z.infer<typeof contextSchema>;

export const echoSchema = z.object({
  metadata: metadataSchema,
  message_echoes: z.array(messageSchema).min(1),
  contacts: z.array(contactSchema).optional(),
});

export const historyErrorSchema = z.object({
  history: z
    .array(
      z
        .object({
          errors: z.array(z.object({ code: z.number().int() })).min(1),
        })
        .strict()
    )
    .min(1),
});

export const historySchema = z
  .object({
    metadata: metadataSchema.optional(),
    history: z
      .array(
        z.object({
          metadata: z
            .object({
              phase: z.number().int().min(0).max(2),
              chunk_order: z.number().int().min(0),
              progress: z.number().min(0).max(100),
            })
            .optional(),
          errors: z.array(z.object({ code: z.number().int() })).optional(),
          threads: z
            .array(
              z.object({
                id: phoneSchema.optional(),
                context: contextSchema.optional(),
                messages: z.array(messageSchema),
              })
            )
            .optional(),
        })
      )
      .optional(),
    messages: z.array(messageSchema).optional(),
  })
  .refine((value) => Boolean(value.history?.length || value.messages?.length))
  .refine(
    (value) =>
      Boolean(value.metadata) || historyErrorSchema.safeParse(value).success
  );

export const stateSchema = z.object({
  metadata: metadataSchema,
  state_sync: z
    .array(
      z.object({
        type: z.literal('contact'),
        action: z.enum(['add', 'remove']),
        metadata: z.object({ timestamp: timestampSchema }),
        contact: z.object({
          phone_number: phoneSchema.optional(),
          user_id: bsuidSchema.optional(),
          parent_user_id: bsuidSchema.optional(),
          username: labelSchema.optional(),
          full_name: labelSchema.optional(),
          first_name: labelSchema.optional(),
        }),
      })
    )
    .min(1),
});

export interface ContactIdentity {
  phone: string;
  wa_user_id: string | null;
  wa_parent_user_id: string | null;
  wa_username: string | null;
  name: string | null;
}

export interface MessageOperation {
  kind: 'message';
  source: 'history' | 'phone_app';
  wamid: string;
  occurred_at: string;
  sender_type: 'customer' | 'agent';
  identity: ContactIdentity;
  content_type: 'text' | 'image' | 'video' | 'audio' | 'document' | 'location';
  content_text: string | null;
  status: 'sent' | 'delivered' | 'read' | 'failed' | 'pending';
  reply_wamid: string | null;
  media_id: string | null;
  media_type: string | null;
  placeholder: boolean;
}

export interface LiveMessageOperation extends Omit<
  MessageOperation,
  'kind' | 'source' | 'sender_type' | 'status' | 'content_type'
> {
  kind: 'live_message';
  source: 'cloud_api';
  sender_type: 'customer';
  status: 'delivered';
  content_type: MessageOperation['content_type'] | 'interactive';
  interactive_reply_id: string | null;
}

export interface MessageStatusOperation {
  kind: 'message_status';
  wamid: string;
  occurred_at: string;
  identity: ContactIdentity;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  provider_status: 'sent' | 'delivered' | 'read' | 'played' | 'failed';
  error_code: number | null;
  error_title: string | null;
  error_details: string | null;
}

export interface ReactionOperation {
  kind: 'reaction';
  wamid: string;
  target_wamid: string;
  occurred_at: string;
  identity: ContactIdentity;
  emoji: string;
}

export interface HydrationOperation {
  kind: 'hydration';
  wamid: string;
  media_id: string;
  media_type: string | null;
  content_type: MessageOperation['content_type'];
  content_text: string | null;
}

export interface ContactOperation {
  kind: 'contact';
  identity: ContactIdentity;
  action: 'add' | 'remove';
  occurred_at: string;
}

export interface ProgressOperation {
  kind: 'progress';
  phase: number | null;
  chunk_order: number | null;
  progress: number | null;
  error_code: number | null;
}

export interface QuarantineOperation {
  kind: 'quarantine';
  code: string;
}

export type NormalizedOperation =
  | MessageOperation
  | LiveMessageOperation
  | MessageStatusOperation
  | ReactionOperation
  | HydrationOperation
  | ContactOperation
  | ProgressOperation
  | QuarantineOperation;
