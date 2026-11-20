import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import {
  ForbiddenError,
  UnauthorizedError,
  requireRole,
} from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { withRequestDeadline } from '@/lib/request-deadline';
import {
  operatorInventorySchema,
  operatorKindSchema,
  operatorTimestampSchema,
  operatorQueuedSchema,
  operatorRetryRequestSchema,
} from './operator-contract';
import { preparedCoexistenceJobSchema } from './prepare-job';

const headers = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
};

export function operatorError(status: number, code = 'operator_unavailable') {
  return Response.json({ error: code }, { status, headers });
}

function enabled() {
  return (
    process.env.WHATSAPP_COEXISTENCE_ENABLED === 'true' &&
    /^\d+$/.test(process.env.WHATSAPP_COEXISTENCE_APP_ID ?? '') &&
    Boolean(process.env.WHATSAPP_COEXISTENCE_APP_SECRET?.trim()) &&
    /^\d+$/.test(process.env.WHATSAPP_COEXISTENCE_PARTNER_BUSINESS_ID ?? '')
  );
}

const querySchema = z
  .strictObject({
    kind: operatorKindSchema.default('jobs'),
    limit: z
      .string()
      .regex(/^(?:[1-9]|[1-4]\d|50)$/)
      .transform(Number)
      .default(25),
    before_created_at: operatorTimestampSchema.optional(),
    before_id: z.uuid().optional(),
  })
  .refine(
    (query) => Boolean(query.before_created_at) === Boolean(query.before_id)
  );

const states = {
  jobs: new Set(['pending', 'processing', 'completed', 'quarantined']),
  effects: new Set([
    'pending',
    'leased',
    'running',
    'completed',
    'ambiguous',
    'stale',
  ]),
  status_events: new Set([
    'pending',
    'running',
    'completed',
    'ambiguous',
    'stale',
  ]),
  updates: new Set(['pending', 'applied', 'quarantined', 'stale', 'expired']),
};

async function handle(
  request: Request,
  db: SupabaseClient,
  action: (
    owner: Awaited<ReturnType<typeof requireRole>>,
    signal: AbortSignal
  ) => Promise<Response>,
  deadline: number
) {
  const remaining = deadline - Date.now();

  if (remaining <= 0) return operatorError(504);

  const signal = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(remaining),
  ]);

  try {
    return await withRequestDeadline(
      deadline,
      async () => {
        signal.throwIfAborted();
        const owner = await requireRole('admin', db);
        signal.throwIfAborted();

        for (const key of [
          `whatsapp-operator:user:${owner.userId}`,
          `whatsapp-operator:account:${owner.accountId}`,
        ]) {
          const rate = checkRateLimit(key, RATE_LIMITS.whatsappAdmin);

          if (!rate.success) {
            const response = operatorError(429);
            response.headers.set(
              'Retry-After',
              String(Math.max(1, Math.ceil((rate.reset - Date.now()) / 1000)))
            );

            return response;
          }
        }

        return await action(owner, signal);
      },
      signal
    );
  } catch (error) {
    if (signal.aborted || Date.now() >= deadline)
      return operatorError(request.signal.aborted ? 499 : 504);

    if (error instanceof Response) return error;

    if (error instanceof UnauthorizedError || error instanceof ForbiddenError)
      return operatorError(error.status);

    return operatorError(503);
  }
}

export async function operatorInventory(
  request: Request,
  db: SupabaseClient,
  deadline = Date.now() + 15_000
) {
  if (request.method !== 'GET') return operatorError(405);
  const params = new URL(request.url).searchParams;

  if ([...params.keys()].some((key) => params.getAll(key).length !== 1))
    return operatorError(400, 'invalid_query');
  const query = querySchema.safeParse(Object.fromEntries(params));

  if (!query.success) return operatorError(400, 'invalid_query');

  return handle(
    request,
    db,
    async (owner, signal) => {
      const { kind, limit, before_created_at, before_id } = query.data;

      const { data, error } = await supabaseAdmin()
        .rpc('coexistence_operator_inventory', {
          p_actor_id: owner.userId,
          p_account_id: owner.accountId,
          p_app_id: process.env.WHATSAPP_COEXISTENCE_APP_ID ?? '',
          p_kind: kind,
          p_before_created_at: before_created_at ?? null,
          p_before_id: before_id ?? null,
          p_limit: limit,
        })
        .abortSignal(signal);

      signal.throwIfAborted();

      if (error) throw operatorError(503);

      const parsed = operatorInventorySchema.safeParse({
        ...z.record(z.string(), z.unknown()).parse(data),
        enabled: enabled(),
      });

      if (
        !parsed.success ||
        parsed.data.items.length > limit ||
        parsed.data.items.some((item) => !states[kind].has(item.state))
      )
        throw operatorError(503);
      const result = parsed.data;
      result.items = result.items.map((item) => ({
        ...item,
        retry_eligible:
          result.enabled && kind === 'jobs' && item.retry_eligible,
      }));

      return Response.json(result, { headers });
    },
    deadline
  );
}

const inspectionSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('inspect'),
    payload: z.unknown(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  operatorQueuedSchema,
  z.object({ status: z.enum(['ineligible', 'conflict']) }),
]);

const settlementSchema = z.union([
  operatorQueuedSchema,
  z.object({ status: z.enum(['ineligible', 'conflict']) }),
]);

async function retryBody(request: Request, signal: AbortSignal) {
  const reader = request.body?.getReader();

  if (!reader) throw operatorError(400, 'invalid_request');

  let cancellation: Promise<void> | undefined;

  const cancel = () => {
    cancellation ??= reader.cancel().catch(() => {});
  };

  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    signal.throwIfAborted();

    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();

      if (done) break;
      size += value.byteLength;

      if (size > 4096) {
        cancel();
        throw operatorError(413, 'invalid_request');
      }

      chunks.push(value);
    }

    const bytes = new Uint8Array(size);
    let offset = 0;

    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    try {
      return operatorRetryRequestSchema.parse(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      );
    } catch {
      throw operatorError(400, 'invalid_request');
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    await cancellation;
    reader.releaseLock();
  }
}

export async function operatorRetry(
  request: Request,
  jobId: string,
  db: SupabaseClient,
  deadline = Date.now() + 15_000
) {
  if (request.method !== 'POST') return operatorError(405);

  if (!z.uuid().safeParse(jobId).success)
    return operatorError(400, 'invalid_request');
  const url = new URL(request.url);

  if (
    request.headers.get('origin') !== url.origin ||
    request.headers.get('sec-fetch-site') === 'cross-site'
  )
    return operatorError(403);

  if (
    url.search ||
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
      'application/json'
  )
    return operatorError(400, 'invalid_request');

  return handle(
    request,
    db,
    async (owner, signal) => {
      if (!enabled()) throw operatorError(409, 'operator_disabled');
      const body = await retryBody(request, signal);

      const args = {
        p_actor_id: owner.userId,
        p_account_id: owner.accountId,
        p_job_id: jobId,
        p_app_id: process.env.WHATSAPP_COEXISTENCE_APP_ID!,
        p_request_id: body.request_id,
      };

      const inspected = await supabaseAdmin()
        .rpc('coexistence_operator_inspect', args)
        .abortSignal(signal);

      signal.throwIfAborted();

      if (inspected.error) throw operatorError(503);
      const parsed = inspectionSchema.safeParse(inspected.data);

      if (!parsed.success) throw operatorError(503);

      if (parsed.data.status === 'queued')
        return Response.json(operatorQueuedSchema.parse(parsed.data), {
          status: 202,
          headers,
        });

      if (parsed.data.status !== 'inspect')
        throw operatorError(409, 'retry_unavailable');

      try {
        if (!preparedCoexistenceJobSchema.parse(parsed.data.payload))
          throw new Error('Unsupported');
      } catch {
        throw operatorError(409, 'retry_unavailable');
      }

      signal.throwIfAborted();

      if (
        !enabled() ||
        process.env.WHATSAPP_COEXISTENCE_APP_ID !== args.p_app_id
      )
        throw operatorError(409, 'operator_disabled');

      const queued = await supabaseAdmin()
        .rpc('coexistence_operator_requeue', {
          ...args,
          p_fingerprint: parsed.data.fingerprint,
        })
        .abortSignal(signal);

      signal.throwIfAborted();

      if (queued.error) throw operatorError(503);
      const result = settlementSchema.safeParse(queued.data);

      if (!result.success) throw operatorError(503);

      if (result.data.status !== 'queued')
        throw operatorError(409, 'retry_unavailable');

      return Response.json(operatorQueuedSchema.parse(result.data), {
        status: 202,
        headers,
      });
    },
    deadline
  );
}
