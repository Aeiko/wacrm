import { z } from 'zod';

const context = z.string().regex(/^[0-9a-f]{64}$/);
const timestamp = z.iso.datetime({ offset: true });
const choices = { history: z.boolean(), contacts: z.boolean() };

const connectionSchema = z
  .strictObject({
    context,
    phone_id_suffix: z.string().regex(/^[0-9]{1,4}$/),
    can_grant: z.boolean(),
    can_withdraw: z.boolean(),
    state: z.enum(['none', 'effective', 'inactive', 'withdrawn']),
    ...choices,
    previous_request_id: z.uuid().nullable(),
    expires_at: timestamp.nullable(),
  })
  .refine((connection) => {
    const savedGrant = connection.history || connection.contacts;

    if (connection.state === 'none')
      return (
        !savedGrant &&
        !connection.can_withdraw &&
        connection.previous_request_id === null &&
        connection.expires_at === null
      );

    return (
      connection.previous_request_id !== null &&
      connection.expires_at !== null &&
      (connection.state === 'withdrawn'
        ? !savedGrant && !connection.can_withdraw
        : savedGrant && connection.can_withdraw)
    );
  });

export const importSettingsStatusSchema = z.strictObject({
  status: z.literal('ok'),
  connection: connectionSchema.nullable(),
});

export const importSettingsRequestSchema = z.strictObject({
  context,
  request_id: z.uuid(),
  previous_request_id: z.uuid().nullable(),
  ...choices,
  version: z.literal('projection-v1'),
});

export const importSettingsReceiptSchema = z.strictObject({
  status: z.literal('recorded'),
  request_id: z.uuid(),
  ...choices,
  expires_at: timestamp,
  dispatch_authorized: z.literal(false),
});

export type ImportSettingsStatus = z.infer<typeof importSettingsStatusSchema>;

export type ImportSettingsRequest = z.infer<typeof importSettingsRequestSchema>;

export type ImportSettingsReceipt = z.infer<typeof importSettingsReceiptSchema>;
