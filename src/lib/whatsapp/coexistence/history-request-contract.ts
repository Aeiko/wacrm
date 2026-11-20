import { z } from 'zod';

export const historyRequestReviewSchema = z.strictObject({
  context: z.string().regex(/^[0-9a-f]{64}$/),
  decision_id: z.uuid(),
  request_id: z.uuid(),
  phone_id_suffix: z.string().regex(/^[0-9]{1,4}$/),
  deadline_at: z.iso.datetime({ offset: true }),
});

export const historyRequestStatusSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('ready'),
    review: historyRequestReviewSchema,
  }),
  z.strictObject({
    state: z.enum([
      'unavailable',
      'started',
      'accepted',
      'rejected',
      'ambiguous',
      'not_sent',
    ]),
  }),
]);

export type HistoryRequestReview = z.infer<typeof historyRequestReviewSchema>;

export type HistoryRequestStatus = z.infer<typeof historyRequestStatusSchema>;
