import { z } from 'zod';
import { normalizeDelivery } from './normalize';
import { deliverySchema, envelopeSchema, jsonSchema } from './payload';

const payloadSchema = z.object({
  deliveries: z.array(deliverySchema).max(5000),
  legacy: envelopeSchema,
});

/** Pure worker preparation, also used before authorizing a manual queue request. */
export const preparedCoexistenceJobSchema = payloadSchema.transform(
  (payload) => {
    // Old captured envelopes use the same fenced path, never legacy side effects.
    const deliveries = [
      ...payload.deliveries,
      ...payload.legacy.entry.flatMap((entry) =>
        entry.changes.map((change) =>
          deliverySchema.parse({ waba_id: entry.id, ...change })
        )
      ),
    ];

    const operations = deliveries.flatMap(normalizeDelivery);

    if (
      !operations.length ||
      operations.length > 5000 ||
      operations.some((operation) => operation.kind === 'quarantine')
    )
      return null;

    return jsonSchema.parse(operations);
  }
);
