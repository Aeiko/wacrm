import { z } from 'zod';

export const signupLaunchUnavailable = 'launch_prerequisites_incomplete';
const metaId = z.string().regex(/^[1-9]\d{0,31}$/);
export const signupPhoneSchema = z.string().regex(/^\+[1-9]\d{7,14}$/);

export const signupReviewReasonSchema = z.enum([
  'exchange_unknown',
  'verification_failed',
  'selection_conflict',
  'provider_cancelled',
  'callback_invalid',
]);

const nonce = z.uuid();

export const signupPrepareSchema = z.strictObject({
  request_id: z.uuid(),
  nonce,
  intended_phone: signupPhoneSchema,
  supervised: z.literal(true),
});

// Browser hints only: shape validation cannot attest that the submitted event is complete.
export const signupFinishSchema = z.strictObject({
  type: z.literal('WA_EMBEDDED_SIGNUP'),
  event: z.literal('FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'),
  data: z.strictObject({
    phone_number_id: metaId,
    is_on_biz_app: z.literal(true),
    messaging_account_ids: z.tuple([metaId]),
    primary_waac_ids: z.tuple([]),
    page_ids: z.tuple([]),
    catalog_ids: z.tuple([]),
    dataset_ids: z.tuple([]),
    business_id: metaId.optional(),
    instagram_account_ids: z.tuple([]),
  }),
});

export const signupCodeSchema = z
  .string()
  .min(1)
  .max(32768)
  .refine((value) => Boolean(value.trim()) && !/[\r\n]/.test(value));

export const signupActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('launch'), nonce }),
  z.strictObject({
    action: z.literal('exchange'),
    nonce,
    code: signupCodeSchema,
  }),
  z.strictObject({
    action: z.literal('verify'),
    nonce,
    finish: signupFinishSchema,
  }),
  z.strictObject({ action: z.literal('confirm'), nonce }),
  z.strictObject({
    action: z.literal('review'),
    nonce,
    reason: signupReviewReasonSchema,
  }),
]);

export const signupAttemptSchema = z.object({
  id: z.uuid(),
  state: z.enum([
    'prepared',
    'launch_possible',
    'exchanging',
    'token_received',
    'verified',
    'confirmed',
    'review_required',
    'cancelled',
  ]),
  intended_phone: signupPhoneSchema,
  reason: signupReviewReasonSchema.nullable(),
  preview: z
    .object({
      phone_number_id: metaId,
      waba_id: metaId,
      display_phone_number: z
        .string()
        .max(128)
        .regex(/^\+?[\d\s().-]+$/),
      normalized_phone_number: signupPhoneSchema,
    })
    .nullable(),
  created_at: z.iso.datetime({ offset: true }),
  lease_until: z.iso.datetime({ offset: true }),
});

export const signupStatusSchema = z.object({
  enabled: z.boolean(),
  launch_available: z.literal(false),
  reason: z.literal(signupLaunchUnavailable),
  attempt: signupAttemptSchema.nullable(),
});

export type SignupStatus = z.infer<typeof signupStatusSchema>;
