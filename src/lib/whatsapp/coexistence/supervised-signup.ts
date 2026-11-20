import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { CoexistenceFetch } from '../coexistence-meta';
import { connectionHeaders } from '../connection-operation';
import {
  hasSignupCookieCredentials,
  readSignupBody,
  signupError,
  signupProtocol,
  withSignupOwner,
} from './signup';
import {
  signupCodeSchema,
  signupFinishSchema,
  signupPhoneSchema,
  type signupAttemptSchema,
} from './signup-contract';

const metaId = z.string().regex(/^[1-9]\d{0,31}$/);

export const supervisedSignupInvitationSchema = z.strictObject({
  actorId: z.uuid(),
  sessionId: z.uuid(),
  accountId: z.uuid(),
  attemptId: z.uuid(),
  nonce: z.uuid(),
  appId: metaId,
  loginConfigId: metaId,
  wabaId: metaId,
  phoneId: metaId,
  intendedPhone: signupPhoneSchema,
  intentId: z.uuid(),
  revision: z.uuid(),
});

export type SupervisedSignupInvitation = z.infer<
  typeof supervisedSignupInvitationSchema
>;

type Attempt = z.infer<typeof signupAttemptSchema>;

const commandSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.enum(['launch', 'confirm', 'intent', 'cancel']) }),
  z.strictObject({
    action: z.literal('finish'),
    code: signupCodeSchema,
    finish: signupFinishSchema,
  }),
]);

const inspectState = {
  prepared: 'prepared',
  launch_possible: 'pending',
  exchanging: 'pending',
  token_received: 'pending',
  verified: 'verified',
  confirmed: 'confirmed',
  review_required: 'held',
  cancelled: 'held',
} as const satisfies Record<Attempt['state'], string>;

const intentReceipt = z.object({
  status: z.literal('intent_recorded'),
  attempt_id: z.uuid(),
  request_id: z.uuid(),
  expires_at: z.iso.datetime({ offset: true }),
  dispatch_authorized: z.literal(false),
});

/** Private composition only: db must be the current request's SSR cookie client. */
export async function supervisedSignup(
  request: Request,
  db: SupabaseClient,
  invitation: SupervisedSignupInvitation,
  transport: CoexistenceFetch
): Promise<Response> {
  const post = request.method === 'POST';

  if (!post && request.method !== 'GET') return signupError(405);

  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');

  if (
    (post ? origin !== url.origin : origin !== null && origin !== url.origin) ||
    (site !== null && site !== 'same-origin')
  )
    return signupError(403);

  if (
    url.pathname !== '/supervised-signup' ||
    url.href.includes('?') ||
    url.hash ||
    url.username ||
    url.password ||
    (post
      ? request.headers
          .get('content-type')
          ?.split(';')[0]
          .trim()
          .toLowerCase() !== 'application/json'
      : request.body !== null)
  )
    return signupError(400);

  if (!hasSignupCookieCredentials(request)) return signupError(401);

  const parsed = supervisedSignupInvitationSchema.safeParse(invitation);

  if (!parsed.success) return signupError(403);
  const invite = parsed.data;

  const owner = {
    p_actor_id: invite.actorId,
    p_account_id: invite.accountId,
    p_session_id: invite.sessionId,
  };

  const status = (
    state:
      | (typeof inspectState)[keyof typeof inspectState]
      | 'launch_authorized'
      | 'intent_recorded'
  ) =>
    Response.json(
      { state, phone_suffix: invite.intendedPhone.slice(-4) },
      { headers: connectionHeaders }
    );

  const assertPins = () => {
    if (
      process.env.WHATSAPP_COEXISTENCE_ENABLED !== 'true' ||
      process.env.WHATSAPP_COEXISTENCE_APP_ID !== invite.appId ||
      process.env.WHATSAPP_COEXISTENCE_LOGIN_CONFIG_ID !==
        invite.loginConfigId ||
      process.env.WHATSAPP_COEXISTENCE_RELAY_WABA_ID !== invite.wabaId ||
      process.env.WHATSAPP_COEXISTENCE_RELAY_PHONE_ID !== invite.phoneId
    )
      throw signupError(409);
  };

  const check = async (
    service: SupabaseClient,
    signal: AbortSignal,
    attempt: Attempt | null,
    expected?: Attempt['state']
  ) => {
    if (
      !attempt ||
      attempt.id !== invite.attemptId ||
      attempt.intended_phone !== invite.intendedPhone
    )
      throw signupError(403);
    assertPins();

    if (
      (expected && attempt.state !== expected) ||
      ((attempt.state === 'verified' || attempt.state === 'confirmed') &&
        !attempt.preview) ||
      (attempt.preview &&
        (attempt.preview.waba_id !== invite.wabaId ||
          attempt.preview.phone_number_id !== invite.phoneId ||
          attempt.preview.normalized_phone_number !== invite.intendedPhone))
    )
      throw signupError(409);

    const account = await service
      .from('accounts')
      .select('owner_user_id, connection_revision')
      .eq('id', invite.accountId)
      .retry(false)
      .abortSignal(signal)
      .maybeSingle();

    if (account.error) throw signupError(503);

    if (account.data?.owner_user_id !== invite.actorId) throw signupError(403);

    if (account.data.connection_revision !== invite.revision)
      throw signupError(409);

    const config = await service
      .from('whatsapp_config')
      .select('id')
      .eq('account_id', invite.accountId)
      .retry(false)
      .abortSignal(signal)
      .maybeSingle();

    signal.throwIfAborted();

    if (config.error) throw signupError(503);

    if (config.data) throw signupError(409);
    assertPins();
  };

  const deadline = Date.now() + (post ? 45_000 : 15_000);

  const signal = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(deadline - Date.now()),
  ]);

  try {
    const command = post
      ? await readSignupBody(request, signal, commandSchema)
      : null;

    if (!command || command.action === 'intent') {
      return await withSignupOwner(
        request,
        db,
        deadline,
        async (identity, service, signal, result) => {
          const attempt = result.attempt;
          await check(
            service,
            signal,
            attempt,
            command ? 'confirmed' : undefined
          );
          // SQL074 deliberately does not read SQL077 receipts; GET must not attempt to record one.

          if (!command) return status(inspectState[attempt!.state]);

          const receipt = await service
            .rpc('coexistence_history_intent_record', {
              ...identity,
              p_attempt_id: invite.attemptId,
              p_request_id: invite.intentId,
              p_expected_revision: invite.revision,
              p_expected_config_id: null,
              p_expected_generation: null,
              p_app_id: invite.appId,
              p_waba_id: invite.wabaId,
              p_phone_number_id: invite.phoneId,
              p_consent_version: 'history-only-v1',
              p_history: true,
              p_contacts: false,
            })
            .retry(false)
            .abortSignal(signal);

          signal.throwIfAborted();

          if (receipt.error) throw signupError(503);
          const accepted = intentReceipt.safeParse(receipt.data);

          if (
            !accepted.success ||
            accepted.data.attempt_id !== invite.attemptId ||
            accepted.data.request_id !== invite.intentId
          )
            throw signupError(409);

          return status('intent_recorded');
        },
        owner
      );
    }

    const run = (
      step: z.infer<typeof import('./signup-contract').signupActionSchema>,
      expected: Attempt['state']
    ) =>
      signupProtocol(request, db, step, transport, invite.attemptId, deadline, {
        owner,
        assertPins,
        check: (service, signal, attempt) =>
          check(service, signal, attempt, expected),
      });

    const { nonce } = invite;

    if (command.action === 'launch') {
      const result = await run({ action: 'launch', nonce }, 'prepared');

      return result.ok
        ? status('launch_authorized')
        : signupError(result.status);
    }

    if (command.action === 'confirm') {
      const result = await run({ action: 'confirm', nonce }, 'verified');

      return result.ok ? status('confirmed') : signupError(result.status);
    }

    if (
      command.action === 'cancel' ||
      (command.action === 'finish' &&
        (command.finish.data.messaging_account_ids[0] !== invite.wabaId ||
          command.finish.data.phone_number_id !== invite.phoneId))
    ) {
      const result = await run(
        {
          action: 'review',
          nonce,
          reason:
            command.action === 'cancel'
              ? 'provider_cancelled'
              : 'selection_conflict',
        },
        'launch_possible'
      );

      return result.ok ? status('held') : signupError(result.status);
    }

    if (command.action === 'finish') {
      const exchanged = await run(
        { action: 'exchange', nonce, code: command.code },
        'launch_possible'
      );

      if (!exchanged.ok) return signupError(exchanged.status);

      const verified = await run(
        { action: 'verify', nonce, finish: command.finish },
        'token_received'
      );

      return verified.ok ? status('verified') : signupError(verified.status);
    }

    return signupError(400);
  } catch (error) {
    if (signal.aborted) return signupError(request.signal.aborted ? 499 : 504);

    return signupError(error instanceof Response ? error.status : 503);
  }
}
