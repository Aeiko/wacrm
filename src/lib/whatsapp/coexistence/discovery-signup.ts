import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { CoexistenceFetch } from '../coexistence-meta';
import { connectionHeaders } from '../connection-operation';
import {
  hasSignupCookieCredentials,
  readSignupBody,
  signupError,
  signupProtocol,
} from './signup';
import { signupCodeSchema, signupPhoneSchema } from './signup-contract';

const metaId = z.string().regex(/^[1-9]\d{0,31}$/);

export const discoveryInvitationSchema = z.strictObject({
  actorId: z.uuid(),
  sessionId: z.uuid(),
  accountId: z.uuid(),
  attemptId: z.uuid(),
  nonce: z.uuid(),
  appId: metaId,
  loginConfigId: metaId,
  intendedPhone: signupPhoneSchema,
  intentId: z.uuid(),
  revision: z.uuid(),
});

type DiscoveryInvitation = z.infer<typeof discoveryInvitationSchema>;

const commandSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('launch') }),
  z.strictObject({
    action: z.literal('finish'),
    state: z.uuid(),
    code: signupCodeSchema,
  }),
  z.strictObject({
    action: z.literal('confirm'),
    waba_id: metaId,
    phone_number_id: metaId,
  }),
]);

export function discoveryOwner(invite: DiscoveryInvitation) {
  return {
    p_actor_id: invite.actorId,
    p_account_id: invite.accountId,
    p_session_id: invite.sessionId,
  };
}

export async function requireDiscoveryReceipt(
  service: SupabaseClient,
  invite: DiscoveryInvitation,
  signal: AbortSignal
) {
  const receipt = await service
    .rpc('coexistence_signup_discovery_authorized', {
      ...discoveryOwner(invite),
      p_attempt_id: invite.attemptId,
      p_nonce_hash: createHash('sha256').update(invite.nonce).digest('hex'),
      p_app_id: invite.appId,
      p_login_config_id: invite.loginConfigId,
      p_expected_revision: invite.revision,
      p_intent_id: invite.intentId,
    })
    .retry(false)
    .abortSignal(signal);

  signal.throwIfAborted();

  if (receipt.error) throw signupError(503);

  if (receipt.data !== true) throw signupError(403);
}

/** Private host only; the browser supplies a code, never provider asset authority. */
export async function discoverySignup(
  request: Request,
  db: SupabaseClient,
  invitation: DiscoveryInvitation,
  transport: CoexistenceFetch
): Promise<Response> {
  const url = new URL(request.url);
  const site = request.headers.get('sec-fetch-site');

  if (request.method !== 'POST') return signupError(405);

  if (
    request.headers.get('origin') !== url.origin ||
    (site !== null && site !== 'same-origin')
  )
    return signupError(403);

  if (
    url.pathname !== '/supervised-discovery' ||
    url.href.includes('?') ||
    url.hash ||
    url.username ||
    url.password ||
    !hasSignupCookieCredentials(request)
  )
    return signupError(403);

  if (
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
    'application/json'
  )
    return signupError(400, 'invalid_request');

  const parsed = discoveryInvitationSchema.safeParse(invitation);

  if (!parsed.success) return signupError(403);

  const { accountId, attemptId, nonce, appId, loginConfigId, intendedPhone } =
    parsed.data;

  const owner = discoveryOwner(parsed.data);

  const assertPins = () => {
    if (
      process.env.WHATSAPP_COEXISTENCE_ENABLED !== 'true' ||
      process.env.WHATSAPP_COEXISTENCE_APP_ID !== appId ||
      process.env.WHATSAPP_COEXISTENCE_LOGIN_CONFIG_ID !== loginConfigId
    )
      throw signupError(409);
  };

  const deadline = Date.now() + 45_000;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]);

  try {
    const command = await readSignupBody(request, signal, commandSchema);
    let workspace = '';

    const run = (
      step: Parameters<typeof signupProtocol>[2],
      expected: 'prepared' | 'launch_possible' | 'token_received' | 'verified'
    ) =>
      signupProtocol(request, db, step, transport, attemptId, deadline, {
        owner,
        assertPins,
        discovery: true,
        check: async (service, signal, attempt) => {
          signal.throwIfAborted();
          assertPins();

          if (
            attempt?.id !== attemptId ||
            attempt.intended_phone !== intendedPhone ||
            attempt.state !== expected ||
            (command.action === 'confirm' &&
              (attempt.preview?.waba_id !== command.waba_id ||
                attempt.preview.phone_number_id !== command.phone_number_id))
          )
            throw signupError(409);

          await requireDiscoveryReceipt(service, parsed.data, signal);

          if (expected === 'prepared' || expected === 'token_received') {
            const account = await db
              .from('accounts')
              .select('name')
              .eq('id', accountId)
              .retry(false)
              .abortSignal(signal)
              .maybeSingle();

            if (account.error || !account.data?.name) throw signupError(503);
            workspace = `${account.data.name} (${accountId})`;
          }
        },
      });

    if (command.action === 'launch') {
      const result = await run({ action: 'launch', nonce }, 'prepared');

      return result.ok
        ? Response.json(
            { status: 'launch_authorized', state: nonce, workspace },
            { headers: connectionHeaders }
          )
        : result;
    }

    if (command.action === 'confirm')
      return run({ action: 'confirm', nonce }, 'verified');

    if (command.state !== nonce) return signupError(409);

    const exchanged = await run(
      { action: 'exchange', nonce, code: command.code },
      'launch_possible'
    );

    if (!exchanged.ok) return exchanged;
    const verified = await run({ action: 'discover', nonce }, 'token_received');

    if (!verified.ok) return verified;

    const receipt = z
      .object({
        status: z.literal('verified'),
        preview: z.object({
          waba_id: metaId,
          phone_number_id: metaId,
          normalized_phone_number: signupPhoneSchema,
        }),
      })
      .parse(await verified.json());

    return Response.json(
      { ...receipt, workspace },
      { headers: connectionHeaders }
    );
  } catch (error) {
    return error instanceof Response
      ? error
      : signupError(signal.aborted ? 504 : 503);
  }
}
