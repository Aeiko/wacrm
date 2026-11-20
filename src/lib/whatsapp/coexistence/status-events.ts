import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { withRequestDeadline } from '@/lib/request-deadline';
import { dispatchWebhookEventWithOutcome } from '@/lib/webhooks/deliver';

const claimSchema = z.object({ id: z.uuid(), lease_token: z.uuid() });

const contextSchema = claimSchema.extend({
  account_id: z.uuid(),
  conversation_id: z.uuid(),
  whatsapp_message_id: z.string().min(1).regex(/\S/),
  status: z.enum(['sent', 'delivered', 'read', 'failed']),
  occurred_at: z.iso.datetime({ offset: true }),
});

const settlementSchema = z.enum(['completed', 'ambiguous', 'stale']);

/** Claim is the dispatch fence: even a crash before HTTP requires manual reconciliation. */
export async function drainCoexistenceStatusEvents(
  db: SupabaseClient,
  appId: string,
  deadline = Date.now() + 40_000
) {
  z.string().regex(/^\d+$/).max(30).parse(appId);

  const result = { completed: 0, ambiguous: 0, stale: 0 };

  for (let count = 0; count < 5 && Date.now() < deadline; count++) {
    const claimed = await db.rpc('coexistence_status_event_claim', {
      p_app_id: appId,
      p_limit: 1,
    });

    if (claimed.error) throw new Error('Coexistence status event claim failed');

    const claims = z
      .array(claimSchema.passthrough())
      .max(1)
      .safeParse(claimed.data);

    if (!claims.success)
      throw new Error('Invalid coexistence status event claim');

    if (!claims.data.length) break;

    const job = claims.data[0];
    let outcome: 'completed' | 'ambiguous' = 'ambiguous';

    try {
      const context = contextSchema.parse(job);

      if (Date.now() < deadline)
        // Keep the caller's settlement reserve outside the shorter HTTP action budget.
        outcome = await withRequestDeadline(deadline, () =>
          dispatchWebhookEventWithOutcome(
            db,
            context.account_id,
            'message.status_updated',
            {
              whatsapp_message_id: context.whatsapp_message_id,
              conversation_id: context.conversation_id,
              status: context.status,
            },
            { id: context.id, occurredAt: context.occurred_at }
          )
        );
    } catch {
      // A malformed context or failed reply cannot safely authorize another attempt.
    }

    const settled = await db.rpc('coexistence_status_event_settle', {
      p_event_id: job.id,
      p_lease_token: job.lease_token,
      p_status: outcome,
    });

    if (settled.error)
      throw new Error('Coexistence status event settlement failed');

    const status = settlementSchema.safeParse(settled.data);

    if (!status.success)
      throw new Error('Invalid coexistence status event settlement');
    result[status.data]++;
  }

  return result;
}
