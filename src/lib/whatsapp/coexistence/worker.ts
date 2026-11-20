import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { preparedCoexistenceJobSchema } from './prepare-job';

const jobSchema = z.object({
  id: z.uuid(),
  lease_token: z.uuid(),
  payload: z.unknown(),
});

const settlementSchema = z.enum([
  'completed',
  'pending',
  'quarantined',
  'stale',
]);

const updateRecoverySchema = z.object({
  applied: z.number().int().nonnegative(),
  quarantined: z.number().int().nonnegative(),
  stale: z.number().int().nonnegative(),
  expired: z.number().int().nonnegative(),
});

/** Deferred receipts recover even when no new webhook job arrives. */
export async function drainCoexistenceUpdates(db: SupabaseClient) {
  const { data, error } = await db.rpc('coexistence_recover_updates', {
    p_limit: 100,
  });

  if (error) throw new Error('Coexistence update recovery failed');

  return updateRecoverySchema.parse(data);
}

export interface WorkerResult {
  completed: number;
  retried: number;
  quarantined: number;
  stale: number;
}

/** One bounded lease batch; a later invocation recovers expired claims. */
export async function drainCoexistenceJobs(
  db: SupabaseClient
): Promise<WorkerResult> {
  const { data, error } = await db.rpc('coexistence_claim', { p_limit: 5 });

  if (error) throw new Error('Coexistence claim failed');

  const jobs = z.array(jobSchema).max(5).parse(data);

  const result: WorkerResult = {
    completed: 0,
    retried: 0,
    quarantined: 0,
    stale: 0,
  };

  for (const job of jobs) {
    let failureCode = 'decode_failed';

    try {
      const operations = preparedCoexistenceJobSchema.parse(job.payload);
      failureCode = 'worker_failed';

      if (!operations) {
        const failed = await db.rpc('coexistence_fail', {
          p_job_id: job.id,
          p_lease_token: job.lease_token,
          p_code: 'unsupported_payload',
          p_quarantine: true,
        });

        if (failed.error) throw new Error('Coexistence quarantine failed');

        const status = settlementSchema.parse(failed.data);

        if (status === 'stale') result.stale++;
        else result.quarantined++;
        continue;
      }

      failureCode = 'commit_failed';

      const committed = await db.rpc('coexistence_commit', {
        p_job_id: job.id,
        p_lease_token: job.lease_token,
        p_operations: operations,
      });

      if (committed.error) throw new Error('Coexistence commit failed');

      const status = settlementSchema.parse(committed.data);

      if (status === 'completed') result.completed++;
      else if (status === 'quarantined') result.quarantined++;
      else if (status === 'stale') result.stale++;
      else throw new Error('Unexpected Coexistence commit settlement');
    } catch {
      const failed = await db.rpc('coexistence_fail', {
        p_job_id: job.id,
        p_lease_token: job.lease_token,
        p_code: failureCode,
        p_quarantine: failureCode === 'decode_failed',
      });

      if (failed.error) throw new Error('Coexistence retry persistence failed');

      const status = settlementSchema.parse(failed.data);

      if (status === 'stale') result.stale++;
      else if (status === 'quarantined') result.quarantined++;
      else result.retried++;
    }
  }

  return result;
}
