import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { withRequestDeadline } from '@/lib/request-deadline';
import { connectionHeaders } from '@/lib/whatsapp/connection-operation';
import { readCappedBytes } from '@/lib/whatsapp/webhook-body';
import { readHistoryRequestOwner } from '@/lib/whatsapp/coexistence/history-request-owner';
import {
  isOwnerHistoryOrigin,
  ownerHistoryClient,
} from '@/lib/whatsapp/coexistence/owner-history-client';
import {
  importSettingsReceiptSchema,
  importSettingsRequestSchema,
  importSettingsStatusSchema,
} from '@/lib/whatsapp/coexistence/import-settings-contract';

function failure(status: number) {
  return Response.json(
    { error: 'import_settings_unavailable' },
    { status, headers: connectionHeaders }
  );
}

async function recordBody(request: Request, signal: AbortSignal) {
  if (
    !/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/i.test(
      request.headers.get('content-type') ?? ''
    )
  )
    return failure(415);

  try {
    const bytes = await readCappedBytes(request, 1024, signal);

    if (!bytes) return failure(413);

    const text = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);

    const command = importSettingsRequestSchema.parse(JSON.parse(text));

    // Each member of this flat command contributes one colon outside quotes.
    if (
      command.contacts ||
      text.replace(/"(?:[^"\\]|\\.)*"/g, '').split(':').length !==
        Object.keys(command).length + 1
    )
      return failure(400);

    return command;
  } catch {
    signal.throwIfAborted();

    return failure(400);
  }
}

async function handle(request: Request) {
  if (
    process.env.WHATSAPP_COEXISTENCE_ENABLED !== 'true' ||
    process.env.WHATSAPP_COEXISTENCE_HISTORY_REQUEST_ENABLED !== 'true'
  )
    return failure(404);

  if (new URL(request.url).search) return failure(400);
  const record = request.method === 'POST';

  if (record && !isOwnerHistoryOrigin(request)) return failure(403);

  const deadline = Date.now() + 15_000;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]);

  try {
    return await withRequestDeadline(
      deadline,
      async () => {
        const owner = await readHistoryRequestOwner(request);
        signal.throwIfAborted();

        if (!owner) return failure(401);

        if (
          !checkRateLimit(
            `owner-history:permissions:${owner.actor}`,
            RATE_LIMITS.whatsappAdmin
          ).success
        )
          return failure(429);
        const command = record ? await recordBody(request, signal) : null;

        if (command instanceof Response) return command;

        const { data, error, status } = await ownerHistoryClient()
          .rpc('coexistence_owner_history', {
            p_actor_id: owner.actor,
            p_session_id: owner.session,
            p_action: command ? 'consent' : 'permissions',
            ...(command && {
              p_context: command.context,
              p_request_id: command.request_id,
              p_decision_id: command.previous_request_id,
              p_history: command.history,
            }),
          })
          .retry(false)
          .abortSignal(signal);

        signal.throwIfAborted();

        if (error || status !== 200) return failure(503);

        if (command) {
          if (data?.status === 'blocked' || data?.status === 'conflict')
            return failure(409);
          const receipt = importSettingsReceiptSchema.parse(data);

          if (
            receipt.request_id !== command.request_id ||
            receipt.contacts ||
            receipt.history !== command.history
          )
            return failure(503);

          return Response.json(receipt, { headers: connectionHeaders });
        }

        return Response.json(importSettingsStatusSchema.parse(data), {
          headers: connectionHeaders,
        });
      },
      signal
    );
  } catch {
    return failure(signal.aborted ? 504 : 503);
  }
}

export { handle as GET, handle as POST };

export function HEAD() {
  return failure(405);
}
