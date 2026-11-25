import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import {
  getCurrentAccount,
  UnauthorizedError,
  ForbiddenError,
} from '@/lib/auth/account';
import { withRequestDeadline } from '@/lib/request-deadline';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { connectionHeaders } from '../connection-operation';
import {
  exchangeEmbeddedSignupCode,
  validateCoexistenceToken,
  verifyCoexistencePhone,
  type CoexistenceFetch,
} from '../coexistence-meta';
import { decrypt, encrypt } from '../encryption';
import {
  verifyMemberActivationEvidence,
  type MemberReceiverReview,
} from './member-activation-evidence';
import {
  hasSignupCookieCredentials,
  readSignupBody,
  signupError,
  verifiedSignupCookieIdentity,
} from './signup';
import { signupCodeSchema, signupPhoneSchema } from './signup-contract';
import { memberGraphTransport } from './member-graph-transport';
import { memberSignupRpc } from './member-signup-rpc';

const id = z.string().regex(/^[1-9]\d{0,31}$/);

const configSchema = z.object({
  app_id: id,
  login_config_id: id,
  partner_id: id,
  secret: z
    .string()
    .min(1)
    .regex(/^[^\r\n]+$/),
});

const commandSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('launch'),
    intended_phone: signupPhoneSchema,
  }),
  z.strictObject({
    action: z.literal('finish'),
    state: z.uuid(),
    code: signupCodeSchema,
  }),
  z.strictObject({
    action: z.literal('confirm'),
    state: z.uuid(),
    waba_id: id,
    phone_number_id: id,
  }),
  z.strictObject({
    action: z.literal('activate'),
    state: z.uuid(),
    waba_id: id,
    phone_number_id: id,
    normalized_phone_number: signupPhoneSchema,
  }),
]);

function config() {
  if (
    process.env.WHATSAPP_COEXISTENCE_ENABLED !== 'true' ||
    process.env.WHATSAPP_COEXISTENCE_MEMBER_SIGNUP_ENABLED !== 'true'
  )
    return null;

  const parsed = configSchema.safeParse({
    app_id: process.env.WHATSAPP_COEXISTENCE_APP_ID,
    login_config_id: process.env.WHATSAPP_COEXISTENCE_LOGIN_CONFIG_ID,
    partner_id: process.env.WHATSAPP_COEXISTENCE_PARTNER_BUSINESS_ID,
    secret: process.env.WHATSAPP_COEXISTENCE_APP_SECRET,
  });

  return parsed.success ? parsed.data : null;
}

export async function memberSignup(
  request: Request,
  db: SupabaseClient,
  transport: CoexistenceFetch = memberGraphTransport,
  reviewReceiver?: MemberReceiverReview,
  reviewRouting?: (pins: {
    appId: string;
    loginConfigId: string;
    partnerId: string;
  }) => Promise<boolean>,
  canonicalOrigin?: string
) {
  const url = new URL(request.url);
  const post = request.method === 'POST';

  if (!post && request.method !== 'GET') return signupError(405);

  if (!hasSignupCookieCredentials(request)) return signupError(401);

  if (
    url.pathname !== '/supervised-discovery' ||
    url.href.includes('?') ||
    url.hash ||
    url.username ||
    url.password ||
    (post && request.headers.get('origin') !== (canonicalOrigin ?? url.origin)) ||
    (request.headers.has('sec-fetch-site') &&
      request.headers.get('sec-fetch-site') !== 'same-origin')
  )
    return signupError(403);

  if (
    post &&
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
      'application/json'
  )
    return signupError(400);

  const deadline = Date.now() + (post ? 45_000 : 10_000);

  const signal = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(deadline - Date.now()),
  ]);

  try {
    return await withRequestDeadline(
      deadline,
      async () => {
        const identity = await verifiedSignupCookieIdentity(db, signal);
        const account = await getCurrentAccount(db);

        if (account.userId !== identity.sub) throw signupError(401);

        for (const key of [
          `member-signup:user:${identity.sub}`,
          `member-signup:account:${account.accountId}`,
        ]) {
          if (!checkRateLimit(key, RATE_LIMITS.whatsappAdmin).success)
            throw signupError(429);
        }

        const workspace = `${account.account.name} (${account.accountId})`;
        const settings = config();

        const json = (value: z.input<ReturnType<typeof z.json>>) =>
          Response.json(value, { headers: connectionHeaders });

        if (!settings)
          return post
            ? signupError(404)
            : json({ status: 'unavailable', workspace });

        const { secret, ...pins } = settings;

        const activationEnabled = () =>
          process.env.WHATSAPP_COEXISTENCE_MEMBER_ACTIVATION_ENABLED === 'true';

        const routingReady = () =>
          reviewRouting?.({
            appId: pins.app_id,
            loginConfigId: pins.login_config_id,
            partnerId: pins.partner_id,
          });

        const rpc = async <
          Action extends Parameters<typeof memberSignupRpc>[1],
        >(
          action: Action,
          payload: Parameters<typeof memberSignupRpc<Action>>[2]
        ) => {
          signal.throwIfAborted();

          const current = config();

          if (
            !current ||
            current.app_id !== pins.app_id ||
            current.login_config_id !== pins.login_config_id ||
            current.partner_id !== pins.partner_id ||
            current.secret !== secret
          )
            throw signupError(409);

          const data = await memberSignupRpc(
            {
              p_actor_id: identity.sub,
              p_session_id: identity.session_id,
              p_account_id: account.accountId,
            },
            action,
            payload,
            signal
          );

          if (data.status === 'forbidden') throw signupError(403);

          return data;
        };

        if (!post) {
          const { status } = await rpc('inspect', {});

          if (
            status === 'available' &&
            reviewRouting &&
            (!activationEnabled() || !(await routingReady()))
          )
            return json({ status: 'unavailable', workspace });

          if (status === 'available')
            return json({
              status,
              workspace,
              appId: pins.app_id,
              loginConfigId: pins.login_config_id,
            });

          return json({
            status:
              status === 'linked' || status === 'pending'
                ? status
                : 'unavailable',
            workspace,
          });
        }

        const command = await readSignupBody(request, signal, commandSchema);

        if (reviewRouting && (!activationEnabled() || !(await routingReady())))
          throw signupError(409);

        if (command.action === 'launch') {
          const launched = z
            .object({ status: z.literal('launch_authorized'), state: z.uuid() })
            .safeParse(
              await rpc('launch', {
                ...pins,
                intended_phone: command.intended_phone,
              })
            );

          if (!launched.success) throw signupError(409);

          return json({ ...launched.data, workspace });
        }

        if (command.action === 'confirm') {
          const selection = await rpc('confirm', {
            ...pins,
            state: command.state,
            waba_id: command.waba_id,
            phone_number_id: command.phone_number_id,
          });

          if (selection.status !== 'confirmed') throw signupError(409);

          return reviewReceiver && activationEnabled()
            ? json({ status: 'confirmed', activation_available: true })
            : json({ status: 'confirmed' });
        }

        if (command.action === 'activate') {
          if (!reviewReceiver || !activationEnabled()) throw signupError(404);

          const target = {
            ...pins,
            state: command.state,
            waba_id: command.waba_id,
            phone_number_id: command.phone_number_id,
          };

          const credential = await rpc('activation_read', target);

          if (
            credential.status !== 'activation_ready' ||
            credential.normalized_phone_number !==
              command.normalized_phone_number
          )
            throw signupError(409);

          try {
            const authorized: CoexistenceFetch = async (url, init) => {
              const current = await rpc('activation_read', target);

              if (
                current.status !== 'activation_ready' ||
                current.access_token !== credential.access_token
              )
                throw signupError(409);

              return transport(url, init);
            };

            const expiresAt = await verifyMemberActivationEvidence(
              {
                appId: pins.app_id,
                loginConfigId: pins.login_config_id,
                partnerId: pins.partner_id,
                wabaId: target.waba_id,
                phoneNumberId: target.phone_number_id,
                intendedPhone: credential.normalized_phone_number,
              },
              decrypt(credential.access_token),
              `${pins.app_id}|${secret}`,
              authorized,
              reviewReceiver,
              signal
            );

            if (
              Date.parse(expiresAt) < Date.parse(credential.token_expires_at) ||
              !activationEnabled() ||
              (reviewRouting && !(await routingReady()))
            )
              throw signupError(409);

            const result = await rpc('activate', {
              ...target,
              normalized_phone_number: credential.normalized_phone_number,
            });

            if (result.status !== 'activated') throw signupError(409);

            return json({ status: 'activated' });
          } catch {
            // Revoke only the staged credential; never undo a committed activation on an ambiguous reply.
            await rpc('activation_abort', target).catch(() => {});
            throw signupError(409);
          }
        }

        const state = command.state;

        const start = z
          .object({
            status: z.literal('started'),
            dispatch: z.literal(true),
            intended_phone: signupPhoneSchema,
          })
          .safeParse(
            await rpc('exchange_start', {
              ...pins,
              state,
              code_hash: createHash('sha256')
                .update(command.code)
                .digest('hex'),
            })
          );

        if (!start.success) throw signupError(409);

        const authorized: CoexistenceFetch = async (target, init) => {
          if (
            reviewRouting &&
            (!activationEnabled() || !(await routingReady()))
          )
            throw signupError(409);

          if (
            (await rpc('exchange_authorized', { ...pins, state })).status !==
            'authorized'
          )
            throw signupError(409);

          return transport(target, init);
        };

        try {
          const token = await exchangeEmbeddedSignupCode(
            {
              appId: pins.app_id,
              appSecret: secret,
              code: command.code,
              signal,
            },
            authorized
          );

          const grants = await validateCoexistenceToken(
            {
              expectedAppId: pins.app_id,
              appAccessToken: `${pins.app_id}|${secret}`,
              accessToken: token.access_token,
              signal,
            },
            authorized
          );

          const management = grants.granular_scopes?.filter(
            ({ scope }) => scope === 'whatsapp_business_management'
          );

          const targets = new Set(
            management?.flatMap(({ target_ids }) => target_ids ?? [])
          );

          const wabaId =
            targets.size === 1 &&
            !management?.some(({ target_ids }) => !target_ids?.length) &&
            [...targets][0];

          if (!wabaId) throw signupError(409);

          const phone = await verifyCoexistencePhone(
            {
              wabaId,
              accessToken: token.access_token,
              discoveryPhone: start.data.intended_phone,
              signal,
            },
            authorized
          );

          const preview = {
            waba_id: phone.wabaId,
            phone_number_id: phone.phoneNumberId,
            normalized_phone_number: `+${phone.normalizedPhoneNumber}`,
          };

          if (reviewRouting && (!activationEnabled() || !(await routingReady())))
            throw signupError(409);

          const verified = await rpc('verify', {
            ...pins,
            state,
            ...preview,
            token_expires_at: new Date(
              Math.min(
                grants.expires_at,
                grants.data_access_expires_at ?? grants.expires_at
              ) * 1000
            ).toISOString(),
            access_token: encrypt(token.access_token),
          });

          if (verified.status !== 'verified') throw signupError(409);

          return json({ status: 'verified', workspace, preview });
        } catch {
          // A spent exchange is never retried, even if Graph or SQL did not acknowledge it.
          throw signupError(409);
        }
      },
      signal
    );
  } catch (error) {
    if (error instanceof Response) return error;

    if (error instanceof UnauthorizedError || error instanceof ForbiddenError)
      return signupError(error.status);

    return signupError(signal.aborted ? 504 : 503);
  }
}
