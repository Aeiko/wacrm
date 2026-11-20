import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { verifyTokenMatches } from '@/lib/whatsapp/webhook-signature';
import {
  drainCoexistenceJobs,
  drainCoexistenceUpdates,
} from '@/lib/whatsapp/coexistence/worker';
import { drainCoexistenceEffects } from '@/lib/whatsapp/coexistence/effects';
import { drainCoexistenceStatusEvents } from '@/lib/whatsapp/coexistence/status-events';
import { deadlineFetch, withRequestDeadline } from '@/lib/request-deadline';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(request: Request) {
  const appId = process.env.WHATSAPP_COEXISTENCE_APP_ID;
  const deadline = Date.now() + 50_000;

  const secret = process.env.AUTOMATION_CRON_SECRET;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!secret || !url || !key)
    return Response.json(
      { error: 'Coexistence worker not configured' },
      { status: 503 }
    );

  if (!verifyTokenMatches(secret, request.headers.get('x-cron-secret') ?? '')) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    return await withRequestDeadline(
      deadline,
      async () => {
        const db = createClient(url, key, {
          auth: { persistSession: false, autoRefreshToken: false },
          global: { fetch: deadlineFetch },
        });

        const { data, error } = await db
          .rpc('coexistence_staged_maintenance', { p_limit: 100 })
          .retry(false)
          .abortSignal(request.signal);

        const maintenance = z
          .object({
            scrubbed: z.number().int().min(0).max(100),
            deleted: z.number().int().min(0).max(100),
            signup_tokens_scrubbed: z.number().int().min(0).max(100),
          })
          .parse(data);

        if (error) throw new Error('Maintenance unavailable');

        if (process.env.WHATSAPP_COEXISTENCE_ENABLED !== 'true' || !appId) {
          return Response.json({ status: 'disabled', maintenance });
        }

        const result = await drainCoexistenceJobs(db);
        const updates = await drainCoexistenceUpdates(db);

        // Reserve most of the action budget for inbound responders, plus time to settle.
        const statusEvents = await drainCoexistenceStatusEvents(
          db,
          appId,
          Math.min(deadline - 5000, Date.now() + 10_000)
        );

        const effects = await drainCoexistenceEffects(
          db,
          appId,
          deadline - 5000
        );

        const [pending, ambiguous, pendingStatus, ambiguousStatus] =
          await Promise.all([
            db
              .from('coexistence_live_effects')
              .select('message_id', { head: true, count: 'exact' })
              .in('state', ['pending', 'leased', 'running']),
            db
              .from('coexistence_live_effects')
              .select('message_id', { head: true, count: 'exact' })
              .eq('state', 'ambiguous'),
            db
              .from('coexistence_status_events')
              .select('id', { head: true, count: 'exact' })
              .in('state', ['pending', 'running']),
            db
              .from('coexistence_status_events')
              .select('id', { head: true, count: 'exact' })
              .eq('state', 'ambiguous'),
          ]);

        if (
          pending.error ||
          ambiguous.error ||
          pendingStatus.error ||
          ambiguousStatus.error ||
          pending.count === null ||
          ambiguous.count === null ||
          pendingStatus.count === null ||
          ambiguousStatus.count === null
        )
          throw new Error('Effect counts unavailable');

        // Ingestion and follow-up outcomes are separate; ambiguity requires review, never automatic replay.
        return Response.json({
          ...result,
          maintenance,
          updates,
          statusEvents,
          pendingStatusEvents: pendingStatus.count,
          ambiguousStatusEvents: ambiguousStatus.count,
          effects,
          pendingEffects: pending.count,
          ambiguousEffects: ambiguous.count,
        });
      },
      request.signal
    );
  } catch {
    return Response.json(
      { error: 'Coexistence worker failed' },
      { status: 503 }
    );
  }
}
