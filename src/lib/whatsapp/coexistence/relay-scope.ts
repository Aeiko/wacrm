import { z } from 'zod';
import type { JsonValue } from './payload';

const resourceId = z.string().regex(/^[1-9][0-9]{0,31}$/);

const scopeSchema = z.object({
  app: resourceId,
  partner: resourceId,
  waba: resourceId,
  phone: resourceId,
});

export function readRelayScope(app: string | null, partner: string | null) {
  return scopeSchema.safeParse({
    app,
    partner,
    waba: process.env.WHATSAPP_COEXISTENCE_RELAY_WABA_ID,
    phone: process.env.WHATSAPP_COEXISTENCE_RELAY_PHONE_ID,
  });
}

type Scope = z.infer<typeof scopeSchema>;

const phoneMetadata = z.looseObject({ phone_number_id: resourceId });
const records = z.array(z.looseObject({}));

const phonePayload = z.object({
  metadata: phoneMetadata,
  messaging_product: z.literal('whatsapp').optional(),
});

const historyPayload = phonePayload
  .extend({
    history: records.min(1).optional(),
    messages: records.min(1).optional(),
  })
  .strict()
  .refine((value) => value.history || value.messages);

// Without a phone binding, retain only Meta's documented error shape.
const historyErrorPayload = z.strictObject({
  messaging_product: z.literal('whatsapp').optional(),
  history: z
    .array(
      z.strictObject({
        errors: z
          .array(
            z.strictObject({
              code: z.int(),
              title: z.string().optional(),
              message: z.string().optional(),
              error_data: z.strictObject({ details: z.string() }).optional(),
            })
          )
          .min(1),
      })
    )
    .min(1),
});

const messagesPayload = phonePayload
  .extend({
    messages: records.min(1).optional(),
    statuses: records.min(1).optional(),
    contacts: records.optional(),
  })
  .strict()
  .refine((value) => value.messages || value.statuses);

const echoesPayload = phonePayload
  .extend({ message_echoes: records.min(1), contacts: records.optional() })
  .strict();

const contactsPayload = phonePayload
  .extend({
    state_sync: z.array(z.looseObject({ type: z.literal('contact') })).min(1),
  })
  .strict();

const lifecyclePayload = z.strictObject({
  event: z.string(),
  waba_info: z
    .looseObject({
      waba_id: resourceId.nullish(),
      partner_app_id: resourceId.nullish(),
    })
    .nullish(),
  metadata: z.looseObject({ phone_number_id: resourceId.optional() }).nullish(),
  disconnection_info: z.looseObject({}).nullish(),
});

function isScopedLifecycle(
  entry: string | null,
  value: JsonValue,
  scope: Scope
) {
  const parsed = lifecyclePayload.safeParse(value);

  if (!parsed.success) return false;

  const { event, waba_info: info, metadata } = parsed.data;

  if (metadata?.phone_number_id && metadata.phone_number_id !== scope.phone)
    return false;

  if (info?.partner_app_id && info.partner_app_id !== scope.app) return false;

  // Mirror SQL075's event-specific authority, without its legacy ID normalization.
  switch (event) {
    case 'ACCOUNT_OFFBOARDED':
    case 'ACCOUNT_RECONNECTED':
      return (
        entry === scope.waba &&
        (info?.waba_id == null || info.waba_id === scope.waba)
      );
    case 'PARTNER_REMOVED':
    case 'PARTNER_ADDED':
      return entry === scope.partner && info?.waba_id === scope.waba;
    case 'PARTNER_APP_UNINSTALLED':
    case 'PARTNER_APP_INSTALLED':
      return (
        (entry === null ||
          entry === scope.waba ||
          entry === scope.app ||
          entry === scope.partner) &&
        info?.waba_id === scope.waba &&
        info.partner_app_id === scope.app
      );
    default:
      return false;
  }
}

export function isScopedRelayChange(
  entry: string | null,
  field: string,
  value: JsonValue,
  scope: Scope
): boolean {
  if (field === 'account_update') return isScopedLifecycle(entry, value, scope);

  if (entry !== scope.waba) return false;

  const parsed = (() => {
    switch (field) {
      case 'history':
        return historyPayload.safeParse(value);
      case 'messages':
        return messagesPayload.safeParse(value);
      case 'smb_message_echoes':
        return echoesPayload.safeParse(value);
      case 'smb_app_state_sync':
        return contactsPayload.safeParse(value);
      default:
        return null;
    }
  })();

  if (parsed?.success)
    return parsed.data.metadata.phone_number_id === scope.phone;

  return field === 'history' && historyErrorPayload.safeParse(value).success;
}
