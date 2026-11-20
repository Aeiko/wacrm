import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { isAccountRole } from '@/lib/auth/roles';
import {
  MEDIA_PROXY_CSP,
  mediaProxyHeaders,
} from '@/lib/media/proxy-response-headers';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { withRequestDeadline } from '@/lib/request-deadline';
import { decrypt } from '../encryption';
import {
  downloadCoexistenceMedia,
  redactedPrivateMediaError,
} from './media-download';

export function privateMediaError(status: number): Response {
  const response = Response.json(
    { error: 'Media unavailable' },
    {
      status,
      headers: {
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': MEDIA_PROXY_CSP,
        'Referrer-Policy': 'no-referrer',
      },
    }
  );

  if (status === 405) response.headers.set('Allow', 'GET');

  return response;
}

async function ownedMessage(
  db: SupabaseClient,
  messageId: string,
  signal: AbortSignal
) {
  const {
    data: { user },
    error: authError,
  } = await db.auth.getUser();

  signal.throwIfAborted();

  if (authError || !user) throw privateMediaError(401);

  const { data: profile, error: profileError } = await db
    .from('profiles')
    .select('account_id,account_role')
    .eq('user_id', user.id)
    .abortSignal(signal)
    .maybeSingle();

  if (profileError) throw privateMediaError(503);

  if (
    !profile ||
    !z.uuid().safeParse(profile.account_id).success ||
    !isAccountRole(profile.account_role)
  )
    throw privateMediaError(404);

  const { data: account, error: accountError } = await db
    .from('accounts')
    .select('id')
    .eq('id', profile.account_id)
    .abortSignal(signal)
    .maybeSingle();

  if (accountError) throw privateMediaError(503);

  if (!account || account.id !== profile.account_id)
    throw privateMediaError(404);

  const { data: message, error: messageError } = await db
    .from('messages')
    .select('id,conversations!inner(account_id)')
    .eq('id', messageId)
    .eq('conversations.account_id', account.id)
    .abortSignal(signal)
    .maybeSingle();

  if (messageError) throw privateMediaError(503);

  const parsed = z
    .object({
      id: z.literal(messageId),
      conversations: z.object({ account_id: z.literal(account.id) }),
    })
    .safeParse(message);

  if (!parsed.success) throw privateMediaError(404);

  return { userId: user.id, accountId: account.id, role: profile.account_role };
}

const contextSchema = z.object({
  config_id: z.uuid(),
  generation: z.uuid(),
  phone_number_id: z.string().regex(/^\d+$/).max(32),
  access_token: z.string().min(1).max(16384),
  media_id: z.string().regex(/^\d+$/).max(128),
  media_type: z.string().max(256).nullable(),
  content_type: z.enum(['image', 'video', 'audio', 'document']),
  media_url: z.string().max(256),
});

async function mediaContext(
  accountId: string,
  messageId: string,
  appId: string,
  signal: AbortSignal
) {
  const { data, error } = await supabaseAdmin()
    .rpc('coexistence_media_context', {
      p_account_id: accountId,
      p_message_id: messageId,
      p_app_id: appId,
    })
    .abortSignal(signal);

  if (error) throw privateMediaError(503);
  const parsed = z.array(contextSchema).max(1).safeParse(data);

  if (!parsed.success) throw privateMediaError(503);
  const context = parsed.data[0];

  if (!context) throw privateMediaError(404);
  const path = `/api/whatsapp/coexistence/media/${messageId}`;

  if (
    context.media_url !== path &&
    !(
      context.media_url.startsWith(`${path}?v=`) &&
      z.uuid().safeParse(context.media_url.slice(path.length + 3)).success
    )
  )
    throw privateMediaError(404);

  return context;
}

function enabledApp(): string | null {
  const app = process.env.WHATSAPP_COEXISTENCE_APP_ID;

  return process.env.WHATSAPP_COEXISTENCE_ENABLED === 'true' &&
    app &&
    /^\d+$/.test(app) &&
    process.env.WHATSAPP_COEXISTENCE_APP_SECRET?.trim() &&
    /^\d+$/.test(process.env.WHATSAPP_COEXISTENCE_PARTNER_BUSINESS_ID ?? '')
    ? app
    : null;
}

// shortcut: process-local admission only, use shared admission when deploying multiple workers.
let downloads = 0;

export async function privateMedia(
  request: Request,
  messageId: string,
  db: SupabaseClient,
  deadline = Date.now() + 25_000
): Promise<Response> {
  if (request.method !== 'GET') return privateMediaError(405);
  const appId = enabledApp();

  if (!appId || !z.uuid().safeParse(messageId).success)
    return privateMediaError(404);
  const remaining = deadline - Date.now();

  if (remaining <= 0) return privateMediaError(504);

  const timeout = AbortSignal.timeout(remaining);
  const signal = AbortSignal.any([request.signal, timeout]);

  try {
    signal.throwIfAborted();

    return await withRequestDeadline(
      deadline,
      async () => {
        const owner = await ownedMessage(db, messageId, signal);

        const rate = checkRateLimit(
          `whatsapp-media:${owner.userId}`,
          RATE_LIMITS.whatsappMedia
        );

        if (!rate.success) {
          const response = privateMediaError(429);
          response.headers.set(
            'Retry-After',
            String(Math.max(1, Math.ceil((rate.reset - Date.now()) / 1000)))
          );

          return response;
        }

        const context = await mediaContext(
          owner.accountId,
          messageId,
          appId,
          signal
        );

        const accessToken = decrypt(context.access_token);
        signal.throwIfAborted();

        if (downloads >= 8) {
          const response = privateMediaError(429);
          response.headers.set('Retry-After', '1');

          return response;
        }

        downloads++;

        try {
          const media = await downloadCoexistenceMedia({
            mediaId: context.media_id,
            phoneNumberId: context.phone_number_id,
            accessToken,
            contentType: context.content_type,
            signal,
          });

          const currentOwner = await ownedMessage(db, messageId, signal);

          if (
            JSON.stringify(currentOwner) !== JSON.stringify(owner) ||
            enabledApp() !== appId
          )
            throw privateMediaError(404);

          const current = await mediaContext(
            owner.accountId,
            messageId,
            appId,
            signal
          );

          if (JSON.stringify(current) !== JSON.stringify(context))
            throw privateMediaError(404);
          signal.throwIfAborted();

          return new Response(Buffer.from(media.buffer), {
            status: 200,
            headers: {
              ...mediaProxyHeaders(messageId, media.contentType),
              'Cache-Control': 'private, no-store',
              'Referrer-Policy': 'no-referrer',
              'Content-Length': String(media.buffer.byteLength),
            },
          });
        } finally {
          downloads--;
        }
      },
      signal
    );
  } catch (error) {
    if (signal.aborted || Date.now() >= deadline)
      return privateMediaError(request.signal.aborted ? 499 : 504);

    if (error instanceof Response) return error;

    if (error instanceof redactedPrivateMediaError)
      return privateMediaError(error.status);

    return privateMediaError(503);
  }
}
