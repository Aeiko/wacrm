import { isIPv4 } from 'node:net';
import { z } from 'zod';
import { requireRole } from '@/lib/auth/account';
import { deadlineFetch } from '@/lib/request-deadline';
import { createClient } from '@/lib/supabase/server';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { withSendConnection } from '@/lib/whatsapp/coexistence/send-guard';
import { sendMessageToConversation } from '@/lib/whatsapp/send-message';

const bodySchema = z.strictObject({
  conversation_id: z.uuid(),
  message_type: z.literal('text'),
  content_text: z.string().trim().min(1).max(4096),
  reply_to_message_id: z.uuid().optional(),
});

function failure(status: number, error: string) {
  return Response.json(
    { error },
    { status, headers: { 'Cache-Control': 'no-store' } }
  );
}

export async function POST(request: Request) {
  if (process.env.MANAGED_INBOX_REPLY_ENABLED !== 'true')
    return failure(404, 'Not found');
  const site = process.env.NEXT_PUBLIC_SITE_URL;

  if (!site || request.headers.get('origin') !== site)
    return failure(403, 'Reply denied');

  const binding = z
    .object({
      account: z.uuid(),
      config: z.uuid(),
      generation: z.uuid(),
      rest: z.url(),
    })
    .safeParse({
      account: process.env.MANAGED_INBOX_REPLY_ACCOUNT,
      config: process.env.MANAGED_INBOX_REPLY_CONFIG,
      generation: process.env.MANAGED_INBOX_REPLY_GENERATION,
      rest: process.env.MANAGED_INBOX_REPLY_REST_ORIGIN,
    });

  if (!binding.success) return failure(503, 'Reply unavailable');
  const { account, config, generation, rest } = binding.data;
  const privateRest = new URL(rest);

  if (
    privateRest.origin !== rest ||
    privateRest.protocol !== 'http:' ||
    !isIPv4(privateRest.hostname) ||
    !/^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/.test(
      privateRest.hostname
    )
  )
    return failure(503, 'Reply unavailable');
  const key = z.uuid().safeParse(request.headers.get('idempotency-key'));

  if (
    !key.success ||
    request.headers.get('content-type') !== 'application/json'
  )
    return failure(400, 'Invalid reply');
  const input = bodySchema.safeParse(await request.json().catch(() => null));

  if (!input.success) return failure(400, 'Invalid reply');

  try {
    // Keep the normal Auth issuer and cookie name; only server-side PostgREST is private.
    const db = await createClient((input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);

      if (
        url.origin === process.env.NEXT_PUBLIC_SUPABASE_URL &&
        url.pathname.startsWith('/rest/v1/')
      ) {
        return deadlineFetch(
          new URL(url.pathname.slice('/rest/v1'.length) + url.search, rest),
          { ...init, redirect: 'error' }
        );
      }

      return deadlineFetch(input, init);
    });

    const actor = await requireRole('agent', db);

    if (actor.accountId !== account) return failure(403, 'Reply denied');
    const claims = await db.auth.getClaims();

    const identity = z
      .object({ sub: z.literal(actor.userId), session_id: z.uuid() })
      .safeParse(claims.data?.claims);

    if (claims.error || !identity.success) return failure(401, 'Sign in again');

    if (
      !checkRateLimit(`managed-reply:${actor.userId}`, RATE_LIMITS.send).success
    )
      return failure(429, 'Too many replies');
    const b = input.data;

    const claim = await db.rpc('claim_managed_inbox_reply', {
      p_account: account,
      p_conversation: b.conversation_id,
      p_request: key.data,
      p_config: config,
      p_generation: generation,
      p_session: identity.data.session_id,
    });

    if (claim.error) return failure(503, 'Reply unavailable');

    if (claim.data === 'duplicate')
      return failure(
        409,
        'Reply already attempted. Check the inbox before sending again.'
      );

    if (claim.data !== 'claimed') return failure(403, 'Reply denied');
    // A claim is never released, even on an ambiguous provider or persistence result.

    const sent = await withSendConnection(
      {
        accountId: account,
        configId: config,
        generation,
        privateRestOrigin: rest,
      },
      () =>
        sendMessageToConversation(db, account, {
          conversationId: b.conversation_id,
          messageType: 'text',
          contentText: b.content_text,
          replyToMessageId: b.reply_to_message_id,
          senderId: actor.userId,
          singleAttempt: true,
        })
    );

    return Response.json({
      success: true,
      message_id: sent.messageId,
      whatsapp_message_id: sent.whatsappMessageId,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'UnauthorizedError')
      return failure(401, 'Sign in again');

    if (error instanceof Error && error.name === 'ForbiddenError')
      return failure(403, 'Reply denied');

    return failure(
      503,
      'Reply not confirmed. Check the inbox before sending again.'
    );
  }
}
