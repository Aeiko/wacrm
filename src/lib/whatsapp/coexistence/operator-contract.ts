import { z } from 'zod';

export const operatorKindSchema = z.enum([
  'jobs',
  'effects',
  'status_events',
  'updates',
]);

export type OperatorKind = z.infer<typeof operatorKindSchema>;

// Keep database microseconds intact: cursors are strings, never JavaScript Dates.
export const operatorTimestampSchema = z.iso.datetime({ offset: true });

export const operatorCursorSchema = z.object({
  created_at: operatorTimestampSchema,
  id: z.uuid(),
});

const reasonSchema = z.enum([
  'decode_failed',
  'unsupported_payload',
  'worker_failed',
  'commit_failed',
  'processing_failed',
  'hydration_parent_missing',
  'retry_expired',
  'retention_expired',
  'binding_changed',
  'binding_paused',
  'lifecycle_target_unknown',
  'identity_changed',
  'inbound_expired',
  'inbound_future',
  'lease_expired',
  'execution_uncertain',
  'event_expired',
  'identity_missing',
  'identity_conflict',
  'message_identity_conflict',
  'invalid_hydration',
  'invalid_contact_action',
  'invalid_message',
  'invalid_timestamp',
  'direction_conflict',
  'unsupported_operation',
  'invalid_live_message',
  'invalid_update',
  'invalid_update_identity',
  'invalid_message_status',
  'invalid_provider_status',
  'invalid_error_code',
  'invalid_reaction',
  'unsupported_update',
  'update_identity_conflict',
  'message_origin_conflict',
  'import_consent_required',
  'unknown',
]);

export const operatorItemSchema = z.object({
  id: z.uuid(),
  state: z.enum([
    'pending',
    'processing',
    'completed',
    'quarantined',
    'leased',
    'running',
    'ambiguous',
    'stale',
    'applied',
    'expired',
  ]),
  reason: z
    .string()
    .nullable()
    .transform((reason) =>
      reason === null
        ? null
        : (reasonSchema.safeParse(reason).data ?? 'unknown')
    ),
  created_at: operatorTimestampSchema,
  lease_until: operatorTimestampSchema.nullable(),
  available_at: operatorTimestampSchema.nullable(),
  attempts: z.number().int().nonnegative().nullable(),
  stage: z.number().int().nonnegative().nullable(),
  retention_until: operatorTimestampSchema.nullable(),
  payload_present: z.boolean().nullable(),
  current_binding: z.boolean(),
  overdue: z.boolean(),
  retry_eligible: z.boolean(),
  operator_requested_at: operatorTimestampSchema.nullable(),
});

export const operatorInventorySchema = z.object({
  enabled: z.boolean(),
  connection: z.object({
    managed: z.boolean(),
    connected: z.boolean(),
    verified: z.boolean(),
  }),
  observed_at: operatorTimestampSchema,
  items: z.array(operatorItemSchema).max(50),
  next_cursor: operatorCursorSchema.nullable(),
  count: z.number().int().min(0).max(1000),
  count_capped: z.boolean(),
});

export type OperatorInventory = z.infer<typeof operatorInventorySchema>;

export type OperatorItem = z.infer<typeof operatorItemSchema>;

export type OperatorCursor = z.infer<typeof operatorCursorSchema>;

export const operatorRetryRequestSchema = z.strictObject({
  request_id: z.uuid(),
});

export const operatorQueuedSchema = z.object({
  status: z.literal('queued'),
  requested_at: operatorTimestampSchema,
});

export type OperatorQueued = z.infer<typeof operatorQueuedSchema>;
