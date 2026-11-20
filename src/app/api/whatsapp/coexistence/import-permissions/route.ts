import { z } from 'zod';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { withRequestDeadline } from '@/lib/request-deadline';
import { createClient } from '@/lib/supabase/server';
import {
  importSettingsReceiptSchema,
  importSettingsRequestSchema,
  importSettingsStatusSchema,
  type ImportSettingsRequest,
} from '@/lib/whatsapp/coexistence/import-settings-contract';
import {
  connectionHeaders,
  connectionServiceClient,
} from '@/lib/whatsapp/connection-operation';
import { readCappedBytes } from '@/lib/whatsapp/webhook-body';

const identitySchema = z.object({ sub: z.uuid(), session_id: z.uuid() });

const profileSchema = z.object({
  account_id: z.uuid(),
  account_role: z.literal('owner'),
});

const resourceId = z.string().regex(/^[1-9][0-9]{0,31}$/);

const trustedPinsSchema = z
  .tuple([resourceId, resourceId, resourceId])
  .refine((ids) => new Set(ids).size === ids.length);

function trustedPins() {
  if (
    process.env.WHATSAPP_COEXISTENCE_ENABLED !== 'true' ||
    process.env.WHATSAPP_COEXISTENCE_IMPORT_SETTINGS_ENABLED !== 'true'
  )
    return null;

  return (
    trustedPinsSchema.safeParse([
      process.env.WHATSAPP_COEXISTENCE_APP_ID,
      process.env.WHATSAPP_COEXISTENCE_RELAY_WABA_ID,
      process.env.WHATSAPP_COEXISTENCE_RELAY_PHONE_ID,
    ]).data ?? null
  );
}

function failure(status: number, code = 'import_settings_unavailable') {
  return Response.json({ error: code }, { status, headers: connectionHeaders });
}

async function recordBody(request: Request, signal: AbortSignal) {
  if (
    !/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/i.test(
      request.headers.get('content-type') ?? ''
    )
  )
    return failure(400, 'invalid_request');

  try {
    const bytes = await readCappedBytes(request, 1024, signal);

    if (bytes === null) return failure(413, 'invalid_request');

    const text = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);

    const body = importSettingsRequestSchema.parse(JSON.parse(text));

    // For this flat JSON object, each member contributes one colon outside quotes.
    if (
      text.replace(/"(?:[^"\\]|\\.)*"/g, '').split(':').length !==
      Object.keys(body).length + 1
    )
      return failure(400, 'invalid_request');

    return body;
  } catch {
    signal.throwIfAborted();

    return failure(400, 'invalid_request');
  }
}

async function settings(request: Request, record: boolean) {
  const url = new URL(request.url);
  const { headers } = request;

  if (url.search) return failure(400, 'invalid_request');

  if (
    ['authorization', 'apikey', 'x-api-key'].some((name) => headers.has(name))
  )
    return failure(401);
  const site = headers.get('sec-fetch-site');

  if (
    record &&
    (headers.get('origin') !== url.origin ||
      (site !== null && site !== 'same-origin'))
  )
    return failure(403, 'invalid_origin');

  const timeout = 15_000;
  const deadline = Date.now() + timeout;

  const signal = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(timeout),
  ]);

  try {
    return await withRequestDeadline(
      deadline,
      async () => {
        signal.throwIfAborted();
        let command: ImportSettingsRequest | null = null;

        if (record) {
          const body = await recordBody(request, signal);

          if (body instanceof Response) return body;
          command = body;
        }

        const db = await createClient();

        const {
          data: { user },
          error: authError,
        } = await db.auth.getUser();

        signal.throwIfAborted();

        if (authError || !user) return failure(401);

        const claims = await db.auth.getClaims();
        signal.throwIfAborted();
        const identity = identitySchema.safeParse(claims.data?.claims);

        if (claims.error || !identity.success || identity.data.sub !== user.id)
          return failure(401);

        const profile = await db
          .from('profiles')
          .select('account_id, account_role')
          .eq('user_id', user.id)
          .retry(false)
          .abortSignal(signal)
          .maybeSingle();

        signal.throwIfAborted();

        if (profile.error) return failure(503);
        const scope = profileSchema.safeParse(profile.data);

        if (!scope.success) return failure(403);
        const accountId = scope.data.account_id;

        const account = await db
          .from('accounts')
          .select('owner_user_id')
          .eq('id', accountId)
          .retry(false)
          .abortSignal(signal)
          .maybeSingle();

        signal.throwIfAborted();

        if (account.error) return failure(503);

        if (account.data?.owner_user_id !== user.id) return failure(403);

        for (const key of [
          `import-settings:user:${user.id}`,
          `import-settings:account:${accountId}`,
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

        const pins = trustedPins();

        if (!pins && (command?.history || command?.contacts))
          return failure(409);

        const args = {
          p_actor_id: user.id,
          p_account_id: accountId,
          p_session_id: identity.data.session_id,
          p_allowed_app_id: pins?.[0] ?? null,
          p_allowed_waba_id: pins?.[1] ?? null,
          p_allowed_phone_id: pins?.[2] ?? null,
        };

        const service = connectionServiceClient();
        signal.throwIfAborted();

        const { data, error, status } = await (
          command
            ? service.rpc('coexistence_import_settings_record', {
                ...args,
                p_context: command.context,
                p_request_id: command.request_id,
                p_previous_request_id: command.previous_request_id,
                p_history: command.history,
                p_contacts: command.contacts,
                p_version: command.version,
              })
            : service.rpc('coexistence_import_settings_status', args)
        )
          .retry(false)
          .abortSignal(signal);

        signal.throwIfAborted();

        if (error || status !== 200) return failure(503);

        const rejected = rejectionSchema.safeParse(data);

        if (rejected.success) return rejectionResponse(rejected.data);

        if (command) {
          const receipt = importSettingsReceiptSchema.safeParse(data);

          if (
            !receipt.success ||
            receipt.data.request_id.toLowerCase() !==
              command.request_id.toLowerCase() ||
            receipt.data.history !== command.history ||
            receipt.data.contacts !== command.contacts
          )
            return failure(503);

          return Response.json(receipt.data, { headers: connectionHeaders });
        }

        const state = importSettingsStatusSchema.safeParse(data);

        if (!state.success) return failure(503);

        if (!pins && state.data.connection)
          state.data.connection.can_grant = false;

        return Response.json(state.data, { headers: connectionHeaders });
      },
      signal
    );
  } catch {
    if (signal.aborted || Date.now() >= deadline)
      return failure(request.signal.aborted ? 499 : 504);

    return failure(503);
  }
}

const rejectionSchema = z.strictObject({
  status: z.enum([
    'busy',
    'conflict',
    'superseded',
    'blocked',
    'expired',
    'forbidden',
    'invalid',
  ]),
});

function rejectionResponse({ status }: z.infer<typeof rejectionSchema>) {
  if (status === 'forbidden') return failure(403);

  if (status === 'invalid') return failure(400, 'invalid_request');

  return failure(409);
}

export function GET(request: Request) {
  return settings(request, false);
}

export function POST(request: Request) {
  return settings(request, true);
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
