import { z } from 'zod';

const timestamp = z.iso.datetime({ offset: true });
const disposition = z.enum(['closed_unstarted', 'held_uncertain']);

export const recoveryRequestSchema = z.strictObject({
  attempt_id: z.uuid(),
  request_id: z.uuid(),
  action: z.enum(['close_unstarted', 'record_hold']),
});

const recoveryAttemptSchema = z
  .strictObject({
    id: z.uuid(),
    state: z.enum([
      'prepared',
      'expired_unstarted',
      'launch_possible',
      'exchange_started',
      'verified',
      'confirmed',
      'review_required',
      'cancelled',
    ]),
    launched_at: timestamp.nullable(),
    exchange_started: z.boolean(),
    known_claims: z.int().nonnegative(),
    disposition: disposition.nullable(),
    reviewed_at: timestamp.nullable(),
  })
  .refine((attempt) => {
    const launched = attempt.launched_at !== null;

    if (attempt.exchange_started && !launched) return false;

    if ((attempt.disposition === null) !== (attempt.reviewed_at === null))
      return false;

    if (attempt.disposition === 'closed_unstarted')
      return (
        attempt.state === 'cancelled' && !launched && attempt.known_claims === 0
      );

    if (attempt.disposition === 'held_uncertain' && !launched) return false;

    switch (attempt.state) {
      case 'prepared':
      case 'expired_unstarted':
        return !launched;
      case 'launch_possible':
        return launched && !attempt.exchange_started;
      case 'exchange_started':
      case 'verified':
      case 'confirmed':
        return attempt.exchange_started;
      default:
        return true;
    }
  });

export const recoveryStatusSchema = z.strictObject({
  status: z.literal('ok'),
  attempt: recoveryAttemptSchema.nullable(),
});

export const recoveryReceiptSchema = z.strictObject({
  status: z.literal('recorded'),
  attempt_id: z.uuid(),
  request_id: z.uuid(),
  disposition,
  reviewed_at: timestamp,
});
