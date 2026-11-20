import { z } from 'zod';
import {
  ForbiddenError,
  UnauthorizedError,
  requireRole,
} from '@/lib/auth/account';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { withRequestDeadline } from '@/lib/request-deadline';
import { createClient } from '@/lib/supabase/server';
import {
  ConnectionGateError,
  connectionBody,
  connectionHeaders,
  connectionServiceClient,
} from '@/lib/whatsapp/connection-operation';
import {
  recoveryReceiptSchema,
  recoveryRequestSchema,
  recoveryStatusSchema,
} from '@/lib/whatsapp/coexistence/signup-recovery-contract';

const identitySchema = z.object({ sub: z.uuid(), session_id: z.uuid() });

const failureSchema = z.strictObject({
  status: z.enum(['forbidden', 'busy', 'conflict', 'not_found', 'invalid']),
});

const failureStatus = {
  forbidden: 403,
  busy: 409,
  conflict: 409,
  not_found: 404,
  invalid: 400,
};

function failure(status: number, code = 'recovery_unavailable') {
  return Response.json({ error: code }, { status, headers: connectionHeaders });
}

async function recover(request: Request, record: boolean) {
  const url = new URL(request.url);

  if (url.search) return failure(400, 'invalid_request');

  if (
    record &&
    (request.headers.get('origin') !== url.origin ||
      request.headers.get('sec-fetch-site') === 'cross-site')
  )
    return failure(403);

  const deadline = Date.now() + 15_000;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]);

  try {
    return await withRequestDeadline(
      deadline,
      async () => {
        signal.throwIfAborted();
        const db = await createClient();
        const operator = await requireRole('admin', db);
        const claims = await db.auth.getClaims();
        signal.throwIfAborted();
        const identity = identitySchema.safeParse(claims.data?.claims);

        if (
          claims.error ||
          !identity.success ||
          identity.data.sub !== operator.userId
        )
          return failure(401);

        if (
          !z.uuid().safeParse(operator.accountId).success ||
          operator.account.id !== operator.accountId
        )
          return failure(403);

        if (operator.role === 'owner') {
          const actual = await db
            .from('accounts')
            .select('owner_user_id')
            .eq('id', operator.accountId)
            .abortSignal(signal)
            .maybeSingle();

          signal.throwIfAborted();

          if (actual.error) return failure(503);

          if (actual.data?.owner_user_id !== operator.userId)
            return failure(403);
        }

        for (const key of [
          `signup-recovery:user:${operator.userId}`,
          `signup-recovery:account:${operator.accountId}`,
        ]) {
          const rate = checkRateLimit(key, RATE_LIMITS.whatsappAdmin);

          if (!rate.success) {
            const response = failure(429);
            response.headers.set(
              'Retry-After',
              String(Math.max(1, Math.ceil((rate.reset - Date.now()) / 1000)))
            );

            return response;
          }
        }

        const command = record
          ? await connectionBody(request, signal, recoveryRequestSchema)
          : null;

        const args = {
          p_actor_id: operator.userId,
          p_account_id: operator.accountId,
          p_session_id: identity.data.session_id,
        };

        const service = connectionServiceClient();

        // Each RPC independently checks live session and current tenant role.
        signal.throwIfAborted();

        const { data, error } = await (
          command
            ? service.rpc('coexistence_signup_recovery_record', {
                ...args,
                p_attempt_id: command.attempt_id,
                p_request_id: command.request_id,
                p_action: command.action,
              })
            : service.rpc('coexistence_signup_recovery_status', args)
        )
          .retry(false)
          .abortSignal(signal);

        signal.throwIfAborted();

        if (error) return failure(503);
        const rejected = failureSchema.safeParse(data);

        if (rejected.success)
          return failure(failureStatus[rejected.data.status]);

        if (command) {
          const receipt = recoveryReceiptSchema.safeParse(data);

          const expected =
            command.action === 'close_unstarted'
              ? 'closed_unstarted'
              : 'held_uncertain';

          if (
            !receipt.success ||
            receipt.data.attempt_id.toLowerCase() !==
              command.attempt_id.toLowerCase() ||
            receipt.data.request_id.toLowerCase() !==
              command.request_id.toLowerCase() ||
            receipt.data.disposition !== expected
          )
            return failure(503);

          return Response.json(receipt.data, { headers: connectionHeaders });
        }

        const parsed = recoveryStatusSchema.safeParse(data);

        return parsed.success
          ? Response.json(parsed.data, { headers: connectionHeaders })
          : failure(503);
      },
      signal
    );
  } catch (error) {
    if (signal.aborted || Date.now() >= deadline)
      return failure(request.signal.aborted ? 499 : 504);

    if (error instanceof UnauthorizedError || error instanceof ForbiddenError)
      return failure(error.status);

    if (error instanceof ConnectionGateError)
      return failure(error.status, error.code);

    return failure(503);
  }
}

export function GET(request: Request) {
  return recover(request, false);
}

export function POST(request: Request) {
  return recover(request, true);
}

function unsupported() {
  const response = failure(405);
  response.headers.set('Allow', 'GET, POST');

  return response;
}

export {
  unsupported as PUT,
  unsupported as PATCH,
  unsupported as DELETE,
  unsupported as HEAD,
  unsupported as OPTIONS,
};
