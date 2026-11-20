import { deadlineFetch as fetch } from '@/lib/request-deadline';
// ============================================================
// Outbound webhook delivery.
//
// `dispatchWebhookEvent` finds the account's active endpoints
// subscribed to an event, signs one JSON payload, and POSTs it to
// each in parallel. It is best-effort and never throws — callers fire
// it from the inbound webhook's `after()` block, where a failed
// delivery must not affect the 200 OK returned to Meta.
//
// Delivery semantics (documented in docs/public-api.md):
//   - At-most-once per event, single attempt with a short timeout.
//   - Each consecutive failure bumps `failure_count`; once it crosses
//     MAX_CONSECUTIVE_FAILURES the endpoint is auto-disabled
//     (`is_active = false`) so a dead sink stops being hit. A success
//     resets the counter and stamps `last_delivery_at`.
//   - Durable retry-with-backoff would need a queue/worker (a
//     follow-up); in-process retries inside `after()` would burn the
//     route's duration budget without a real durability guarantee.
// ============================================================

import { randomUUID } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { core } from 'zod';

import { decrypt } from '@/lib/whatsapp/encryption';
import { buildSignatureHeader } from '@/lib/webhooks/sign';
import { isDeliverableUrl } from '@/lib/webhooks/ssrf';
import type { WebhookEvent } from '@/lib/webhooks/events';

/** Per-endpoint HTTP timeout. Kept short — this runs in `after()`. */
export const DELIVERY_TIMEOUT_MS = 5000;

/** Auto-disable an endpoint after this many consecutive failures. */
export const MAX_CONSECUTIVE_FAILURES = 15;

interface EndpointRow {
  id: string;
  url: string;
  secret: string;
}

/**
 * Deliver `event` (+ `data`) to every active endpoint of `accountId`
 * subscribed to it. Never throws.
 */
export async function dispatchWebhookEvent(
  db: SupabaseClient,
  accountId: string,
  event: WebhookEvent,
  data: Record<string, core.util.JSONType>
): Promise<void> {
  await dispatch(db, accountId, event, data);
}

/**
 * Single-attempt durable-caller boundary. Only complete after every endpoint's
 * HTTP success and DB outcome; failures (including partial fanout) are ambiguous.
 * The caller must begin its durable stage before calling and checkpoint after;
 * a lost reply or ambiguous outcome must not automatically replay this fanout.
 */
export async function dispatchWebhookEventWithOutcome(
  db: SupabaseClient,
  accountId: string,
  event: WebhookEvent,
  data: Record<string, core.util.JSONType>,
  identity: { id: string; occurredAt: string }
): Promise<'completed' | 'ambiguous'> {
  return dispatch(db, accountId, event, data, identity);
}

async function dispatch(
  db: SupabaseClient,
  accountId: string,
  event: WebhookEvent,
  data: Record<string, core.util.JSONType>,
  identity?: { id: string; occurredAt: string }
): Promise<'completed' | 'ambiguous'> {
  try {
    const { data: rows, error } = await db
      .from('webhook_endpoints')
      .select('id, url, secret')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .contains('events', [event]);

    if (error || !rows) return 'ambiguous';

    if (rows.length === 0) return 'completed';

    // Sign the exact bytes sent; durable callers supply a stable event identity.
    const payload = JSON.stringify({
      id: identity?.id ?? randomUUID(),
      event,
      occurred_at: identity?.occurredAt ?? new Date().toISOString(),
      account_id: accountId,
      data,
    });

    const tsSeconds = Math.floor(Date.now() / 1000);

    const outcomes = await Promise.allSettled(
      (rows as EndpointRow[]).map((row) =>
        deliverOne(db, row, event, payload, tsSeconds)
      )
    );

    return outcomes.every(
      (outcome) =>
        outcome.status === 'fulfilled' && outcome.value === 'completed'
    )
      ? 'completed'
      : 'ambiguous';
  } catch {
    // Do not log raw errors: transport/provider errors can contain credentials.
    console.error('[webhooks] dispatch failed');

    return 'ambiguous';
  }
}

async function deliverOne(
  db: SupabaseClient,
  row: EndpointRow,
  event: WebhookEvent,
  payload: string,
  tsSeconds: number
): Promise<'completed' | 'ambiguous'> {
  // SSRF guard: refuse to POST to a host that resolves to a private /
  // loopback / link-local address. Counts as a failure so a
  // misconfigured internal URL surfaces and eventually auto-disables.
  if (!(await isDeliverableUrl(row.url))) {
    console.warn('[webhooks] refusing non-public delivery target for', row.id);
    await recordFailure(db, row);

    return 'ambiguous';
  }

  let secret: string;

  try {
    secret = decrypt(row.secret);
  } catch {
    // A row whose secret can't be decrypted can never produce a valid
    // signature — count it as a failure so it eventually auto-disables.
    console.error('[webhooks] secret decrypt failed for', row.id);
    await recordFailure(db, row);

    return 'ambiguous';
  }

  try {
    const res = await fetch(row.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Wacrm-Event': event,
        'X-Wacrm-Webhook-Id': row.id,
        'X-Wacrm-Signature': buildSignatureHeader(payload, secret, tsSeconds),
      },
      body: payload,
      // Do NOT follow redirects — a public URL could 3xx-bounce to an
      // internal address, bypassing the SSRF check above. A 3xx is a
      // misconfiguration; treat it as a failure.
      redirect: 'manual',
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });

    if (!res.ok) throw new Error(`endpoint responded ${res.status}`);

    // Success: clear the failure streak.
    const { error } = await db
      .from('webhook_endpoints')
      .update({ failure_count: 0, last_delivery_at: new Date().toISOString() })
      .eq('id', row.id);

    return error ? 'ambiguous' : 'completed';
  } catch {
    console.warn('[webhooks] delivery failed for', row.id);
    await recordFailure(db, row);

    return 'ambiguous';
  }
}

async function recordFailure(
  db: SupabaseClient,
  row: EndpointRow
): Promise<void> {
  // Atomic increment (+ auto-disable at the threshold) via a SQL
  // function — a read-modify-write here would lose increments when two
  // deliveries to the same endpoint run concurrently (e.g.
  // conversation.created + message.received for one inbound message),
  // so a dead endpoint might never reach the disable threshold.
  const { error } = await db.rpc('record_webhook_failure', {
    endpoint_id: row.id,
    max_failures: MAX_CONSECUTIVE_FAILURES,
  });

  if (error) {
    console.error('[webhooks] record_webhook_failure failed for', row.id);
  }
}
