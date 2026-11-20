import type { SupabaseClient } from '@supabase/supabase-js';

import {
  runAutomationsForTrigger,
  type AutomationContext,
  type AutomationOutcome,
} from '@/lib/automations/engine';
import { addContactTagIfAbsent } from './tag-write';
import { MAX_TAG_CHAIN_DEPTH, getTagChainDepth } from './tag-chain';

export { MAX_TAG_CHAIN_DEPTH, getTagChainDepth } from './tag-chain';

interface AddContactTagAndDispatchInput {
  db: SupabaseClient;
  accountId: string;
  contactId: string;
  tagId: string;
  context?: AutomationContext;
}

export interface AddContactTagResult {
  added: boolean;
  dispatched: boolean;
  /** Nested dispatch finished or skipped; ambiguous attempts must not be retried. */
  status: AutomationOutcome;
  reason?: 'duplicate' | 'max_depth';
}

/**
 * Central server-side tag writer. It dispatches tag_added only for a
 * newly-created join and caps chained tag automations to avoid loops.
 */
export async function addContactTagAndDispatch(
  input: AddContactTagAndDispatchInput
): Promise<AddContactTagResult> {
  const added = await addContactTagIfAbsent(input.db, {
    accountId: input.accountId,
    contactId: input.contactId,
    tagId: input.tagId,
  });

  if (!added) {
    return {
      added: false,
      dispatched: false,
      status: 'completed',
      reason: 'duplicate',
    };
  }

  const depth = getTagChainDepth(input.context);

  if (depth >= MAX_TAG_CHAIN_DEPTH) {
    console.warn('[automations] tag_added chain depth limit reached', {
      accountId: input.accountId,
      contactId: input.contactId,
      tagId: input.tagId,
      depth,
    });

    return {
      added: true,
      dispatched: false,
      status: 'completed',
      reason: 'max_depth',
    };
  }

  const status = await runAutomationsForTrigger({
    accountId: input.accountId,
    triggerType: 'tag_added',
    contactId: input.contactId,
    context: {
      ...input.context,
      tag_id: input.tagId,
      vars: {
        ...input.context?.vars,
        _tag_chain_depth: depth + 1,
      },
    },
  });

  return { added: true, dispatched: true, status };
}
