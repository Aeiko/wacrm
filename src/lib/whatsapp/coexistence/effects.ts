import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { dispatchWebhookEventWithOutcome } from '@/lib/webhooks/deliver';
import { dispatchInboundToFlows } from '@/lib/flows/engine';
import {
  resumeAwaitingReplyWithOutcome,
  runAutomationsForTrigger,
} from '@/lib/automations/engine';
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply';
import { withRequestDeadline } from '@/lib/request-deadline';
import { withSendConnection } from '@/lib/whatsapp/coexistence/send-guard';

const claimSchema = z.object({ message_id: z.uuid(), lease_token: z.uuid() });

const beginSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('running'), stage: z.int().min(0).max(9) }),
  z.object({ status: z.enum(['completed', 'ambiguous', 'stale']) }),
]);

const contextSchema = z.object({
  stage: z.int().min(0).max(9),
  action_id: z.uuid(),
  content_consumed: z.boolean(),
  account_id: z.uuid(),
  config_id: z.uuid(),
  generation: z.uuid(),
  config_owner_user_id: z.uuid(),
  conversation_id: z.uuid(),
  contact_id: z.uuid(),
  whatsapp_message_id: z.string().min(1),
  content_type: z.string(),
  content_text: z.string().nullable(),
  interactive_reply_id: z.string().nullable(),
  was_new_contact: z.boolean(),
  was_new_conversation: z.boolean(),
  was_first_inbound: z.boolean(),
  occurred_at: z.iso.datetime({ offset: true }),
});

const settlementSchema = z.enum(['pending', 'completed', 'ambiguous', 'stale']);

type EffectContext = z.infer<typeof contextSchema>;

interface ActionOutcome {
  status: 'completed' | 'ambiguous';
  consumed: boolean;
}

async function executeAction(
  db: SupabaseClient,
  context: EffectContext
): Promise<ActionOutcome> {
  if (context.stage === 0 || context.stage === 9) {
    if (context.stage === 0 && !context.was_new_conversation)
      return { status: 'completed', consumed: false };

    const status = await dispatchWebhookEventWithOutcome(
      db,
      context.account_id,
      context.stage === 0 ? 'conversation.created' : 'message.received',
      {
        conversation_id: context.conversation_id,
        contact_id: context.contact_id,
        ...(context.stage === 9 && {
          whatsapp_message_id: context.whatsapp_message_id,
          content_type: context.content_type,
          text: context.content_text,
        }),
      },
      { id: context.action_id, occurredAt: context.occurred_at }
    );

    return { status, consumed: false };
  }

  if (
    (context.content_consumed && [2, 5, 6, 7, 8].includes(context.stage)) ||
    (context.stage === 3 && !context.was_first_inbound) ||
    (context.stage === 4 && !context.was_new_contact) ||
    (context.stage === 7 && !context.interactive_reply_id) ||
    (context.stage === 8 &&
      (context.interactive_reply_id || !context.content_text?.trim()))
  )
    return { status: 'completed', consumed: false };

  if (context.stage === 1) {
    const flow = await dispatchInboundToFlows({
      accountId: context.account_id,
      userId: context.config_owner_user_id,
      conversationId: context.conversation_id,
      contactId: context.contact_id,
      isFirstInboundMessage: context.was_first_inbound,
      message: context.interactive_reply_id
        ? {
            kind: 'interactive_reply',
            reply_id: context.interactive_reply_id,
            reply_title: context.content_text ?? '',
            meta_message_id: context.whatsapp_message_id,
          }
        : {
            kind: 'text',
            text: context.content_text ?? '',
            meta_message_id: context.whatsapp_message_id,
          },
    });

    return {
      status:
        !flow.outcome || flow.outcome === 'run_error'
          ? 'ambiguous'
          : 'completed',
      consumed: flow.consumed,
    };
  }

  const input = {
    accountId: context.account_id,
    contactId: context.contact_id,
    context: {
      message_text: context.content_text ?? '',
      conversation_id: context.conversation_id,
      interactive_reply_id: context.interactive_reply_id ?? undefined,
    },
  };

  if (context.stage === 2) return resumeAwaitingReplyWithOutcome(input);

  if (context.stage === 8) {
    const status = await dispatchInboundToAiReply({
      accountId: context.account_id,
      contactId: context.contact_id,
      conversationId: context.conversation_id,
      configOwnerUserId: context.config_owner_user_id,
      inboundMessageId: context.whatsapp_message_id,
    });

    return { status, consumed: false };
  }

  const triggerType = (
    [
      'first_inbound_message',
      'new_contact_created',
      'new_message_received',
      'keyword_match',
      'interactive_reply',
    ] as const
  )[context.stage - 3];

  if (!triggerType) throw new Error('Unsupported effect stage');

  return {
    status: await runAutomationsForTrigger({ ...input, triggerType }),
    consumed: false,
  };
}

/** Checkpoint each stage; an interrupted started stage must never be retried automatically. */
export async function drainCoexistenceEffects(
  db: SupabaseClient,
  appId: string,
  deadline = Date.now() + 40_000
) {
  z.string().regex(/^\d+$/).max(30).parse(appId);
  const result = { advanced: 0, completed: 0, ambiguous: 0, stale: 0 };

  for (let count = 0; count < 10 && Date.now() < deadline; count++) {
    const claimed = await db.rpc('coexistence_effect_claim', {
      p_app_id: appId,
      p_limit: 1,
    });

    if (claimed.error) throw new Error('Coexistence effect claim failed');

    const claims = z.array(claimSchema).max(1).parse(claimed.data);

    if (!claims.length) break;

    const job = claims[0];

    const begun = await db.rpc('coexistence_effect_begin', {
      p_message_id: job.message_id,
      p_lease_token: job.lease_token,
      p_app_id: appId,
    });

    if (begun.error) throw new Error('Coexistence effect begin failed');

    const begin = beginSchema.parse(begun.data);

    if (begin.status !== 'running') {
      result[begin.status]++;
      continue;
    }

    let outcome: ActionOutcome = { status: 'ambiguous', consumed: false };

    try {
      const context = contextSchema.parse(begun.data);
      outcome = await withRequestDeadline(deadline, () =>
        withSendConnection(
          {
            accountId: context.account_id,
            configId: context.config_id,
            generation: context.generation,
          },
          () => executeAction(db, context)
        )
      );
    } catch {
      // A failed response does not prove that a non-idempotent action never happened.
    }

    const settled = await db.rpc('coexistence_effect_settle', {
      p_message_id: job.message_id,
      p_lease_token: job.lease_token,
      p_stage: begin.stage,
      p_status: outcome.status,
      p_consumed: outcome.consumed,
    });

    if (settled.error) throw new Error('Coexistence effect settlement failed');

    const status = settlementSchema.parse(settled.data);

    if (status === 'pending') result.advanced++;
    else result[status]++;
  }

  return result;
}
