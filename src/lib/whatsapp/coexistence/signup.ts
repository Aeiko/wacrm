import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import {
  getCurrentAccount,
  ForbiddenError,
  UnauthorizedError,
} from '@/lib/auth/account';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { withRequestDeadline } from '@/lib/request-deadline';
import {
  connectionHeaders,
  connectionServiceClient,
} from '../connection-operation';
import { encrypt, decrypt } from '../encryption';
import {
  exchangeEmbeddedSignupCode,
  validateCoexistenceToken,
  verifyCoexistencePhone,
  type CoexistenceFetch,
} from '../coexistence-meta';
import {
  signupActionSchema,
  signupAttemptSchema,
  signupLaunchUnavailable,
  signupPhoneSchema,
  signupPrepareSchema,
} from './signup-contract';

export function signupError(status: number, code = 'signup_unavailable') {
  return Response.json({ error: code }, { status, headers: connectionHeaders });
}

function configuration() {
  const id = /^[1-9]\d{0,31}$/;
  const appId = process.env.WHATSAPP_COEXISTENCE_APP_ID ?? '';
  const loginConfigId = process.env.WHATSAPP_COEXISTENCE_LOGIN_CONFIG_ID ?? '';
  const appSecret = process.env.WHATSAPP_COEXISTENCE_APP_SECRET ?? '';

  if (
    process.env.WHATSAPP_COEXISTENCE_ENABLED !== 'true' ||
    !id.test(appId) ||
    !id.test(loginConfigId) ||
    !id.test(process.env.WHATSAPP_COEXISTENCE_PARTNER_BUSINESS_ID ?? '') ||
    !appSecret.trim() ||
    /[\r\n]/.test(appSecret)
  )
    return null;

  return { appId, loginConfigId, appSecret };
}

type SignupCommand = z.infer<ReturnType<typeof z.json>>;

const statusReceipt = z.object({
  status: z.literal('ok'),
  attempt: signupAttemptSchema.nullable(),
});

const identitySchema = z.object({ sub: z.uuid(), session_id: z.uuid() });

const failureSchema = z.object({
  status: z.enum([
    'forbidden',
    'busy',
    'conflict',
    'expired',
    'blocked',
    'invalid',
    'not_found',
    'unsupported',
    'duplicate',
  ]),
});

type Args = Record<string, string | null>;

async function rpc<T>(
  service: SupabaseClient,
  name: string,
  args: Args,
  schema: z.ZodType<T>,
  signal: AbortSignal
): Promise<T> {
  signal.throwIfAborted();

  const result = await service
    .rpc(`coexistence_signup_${name}`, args)
    .retry(false)
    .abortSignal(signal);

  if (result.error) throw signupError(503);
  const parsed = schema.safeParse(result.data);

  if (parsed.success) return parsed.data;
  const failure = failureSchema.safeParse(result.data);

  if (failure.success)
    throw signupError(failure.data.status === 'forbidden' ? 403 : 409);
  throw signupError(503);
}

async function ownerIdentity(db: SupabaseClient, signal: AbortSignal) {
  const owner = await getCurrentAccount(db);
  signal.throwIfAborted();

  if (owner.role !== 'owner') throw signupError(403);
  // getClaims validates the JWT; a decoded cookie/getSession payload is not authority.
  const claims = await db.auth.getClaims();
  const identity = identitySchema.safeParse(claims.data?.claims);

  if (claims.error || !identity.success || identity.data.sub !== owner.userId)
    throw signupError(401);

  const actual = await db
    .from('accounts')
    .select('owner_user_id')
    .eq('id', owner.accountId)
    .abortSignal(signal)
    .maybeSingle();

  signal.throwIfAborted();

  if (actual.error) throw signupError(503);

  if (actual.data?.owner_user_id !== owner.userId) throw signupError(403);

  return {
    p_actor_id: owner.userId,
    p_account_id: owner.accountId,
    p_session_id: identity.data.session_id,
  };
}

type Identity = Awaited<ReturnType<typeof ownerIdentity>>;

export function hasSignupCookieCredentials(request: Request) {
  return (
    !!request.headers.get('cookie')?.trim() &&
    !['authorization', 'apikey', 'x-api-key'].some((header) =>
      request.headers.has(header)
    )
  );
}

export async function verifiedSignupCookieIdentity(
  db: SupabaseClient,
  signal: AbortSignal,
  expectedActor?: string
) {
  const session = await db.auth.getSession();
  const token = session.data.session?.access_token;
  signal.throwIfAborted();

  if (session.error || !token) throw signupError(401);

  // Both checks must verify the same SSR cookie token, not a decoded session payload.
  const user = await db.auth.getUser(token);
  signal.throwIfAborted();

  const actor = user.data.user?.id;

  if (
    user.error ||
    !actor ||
    (expectedActor !== undefined && actor !== expectedActor)
  )
    throw signupError(401);

  const claims = await db.auth.getClaims(token);
  signal.throwIfAborted();
  const identity = identitySchema.safeParse(claims.data?.claims);

  if (claims.error || !identity.success || identity.data.sub !== actor)
    throw signupError(401);

  return identity.data;
}

async function cookieOwner(
  db: SupabaseClient,
  expected: Identity,
  signal: AbortSignal
) {
  const identity = await verifiedSignupCookieIdentity(
    db,
    signal,
    expected.p_actor_id
  );

  if (identity.session_id !== expected.p_session_id) throw signupError(401);

  const profile = await db
    .from('profiles')
    .select('account_id, account_role')
    .eq('user_id', expected.p_actor_id)
    .retry(false)
    .abortSignal(signal)
    .maybeSingle();

  signal.throwIfAborted();

  if (profile.error) throw signupError(503);

  if (
    profile.data?.account_id !== expected.p_account_id ||
    profile.data.account_role !== 'owner'
  )
    throw signupError(403);

  // The status RPC independently checks live session, exact owner and membership.
  return expected;
}

export async function withSignupOwner(
  request: Request,
  db: SupabaseClient,
  deadline: number,
  action: (
    identity: Identity,
    service: SupabaseClient,
    signal: AbortSignal,
    status: z.infer<typeof statusReceipt>
  ) => Promise<Response>,
  expectedCookieOwner?: Identity
) {
  if (deadline <= Date.now()) return signupError(504);

  const signal = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(deadline - Date.now()),
  ]);

  try {
    return await withRequestDeadline(deadline, async () => {
      const identity = await withRequestDeadline(
        deadline,
        () =>
          expectedCookieOwner
            ? cookieOwner(db, expectedCookieOwner, signal)
            : ownerIdentity(db, signal),
        signal
      );

      for (const key of [
        `signup:user:${identity.p_actor_id}`,
        `signup:account:${identity.p_account_id}`,
      ]) {
        const rate = checkRateLimit(key, RATE_LIMITS.whatsappAdmin);

        if (!rate.success) {
          const response = signupError(429);
          response.headers.set(
            'Retry-After',
            String(Math.max(1, Math.ceil((rate.reset - Date.now()) / 1000)))
          );

          return response;
        }
      }

      const service = connectionServiceClient();

      // Independently checks SQL session liveness, actual owner and tenant membership, even while disabled.
      const status = await rpc(
        service,
        'status',
        identity,
        statusReceipt,
        signal
      );

      return action(identity, service, signal, status);
    });
  } catch (error) {
    if (signal.aborted || Date.now() >= deadline)
      return signupError(request.signal.aborted ? 499 : 504);

    if (error instanceof Response) return error;

    if (error instanceof UnauthorizedError || error instanceof ForbiddenError)
      return signupError(error.status);

    return signupError(503);
  }
}

export async function signupStatus(
  request: Request,
  db: SupabaseClient,
  deadline = Date.now() + 15_000
) {
  if (request.method !== 'GET') return signupError(405);

  if (new URL(request.url).search) return signupError(400, 'invalid_request');

  return withSignupOwner(
    request,
    db,
    deadline,
    async (_identity, _service, _signal, result) => {
      return Response.json(
        {
          enabled: Boolean(configuration()),
          launch_available: false,
          reason: signupLaunchUnavailable,
          attempt: result.attempt,
        },
        { headers: connectionHeaders }
      );
    }
  );
}

export async function readSignupBody<T>(
  request: Request,
  signal: AbortSignal,
  schema: z.ZodType<T>
) {
  const reader = request.body?.getReader();

  if (!reader) throw signupError(400, 'invalid_request');
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

      if (size > 40 * 1024) {
        cancel();
        throw signupError(413, 'invalid_request');
      }

      chunks.push(value);
    }

    try {
      return schema.parse(
        JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(
            Buffer.concat(chunks)
          )
        )
      );
    } catch {
      throw signupError(400, 'invalid_request');
    }
  } finally {
    if (signal.aborted) cancel();
    signal.removeEventListener('abort', cancel);
    await cancellation;
    reader.releaseLock();
  }
}

function postGuard(request: Request, attemptId?: string) {
  if (request.method !== 'POST') return signupError(405);
  const url = new URL(request.url);

  if (
    request.headers.get('origin') !== url.origin ||
    request.headers.get('sec-fetch-site') === 'cross-site'
  )
    return signupError(403);

  if (
    url.search ||
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
      'application/json' ||
    (attemptId !== undefined && !z.uuid().safeParse(attemptId).success)
  )
    return signupError(400, 'invalid_request');
}

export async function signupPost(
  request: Request,
  db: SupabaseClient,
  attemptId?: string,
  deadline = Date.now() + 15_000
) {
  const invalid = postGuard(request, attemptId);

  if (invalid) return invalid;

  return withSignupOwner(
    request,
    db,
    deadline,
    async (_identity, _service, signal) => {
      if (attemptId === undefined)
        await readSignupBody(request, signal, signupPrepareSchema);
      else await readSignupBody(request, signal, signupActionSchema);

      // No public mutation until staged receiver, real callback association and resolution ship.
      return signupError(409, signupLaunchUnavailable);
    }
  );
}

const prepared = z.object({
  status: z.literal('prepared'),
  attempt_id: z.uuid(),
  lease_until: z.iso.datetime({ offset: true }),
});

const started = z.object({
  status: z.literal('started'),
  dispatch: z.literal(true),
  app_id: z.string().regex(/^[1-9]\d{0,31}$/),
  login_config_id: z.string().regex(/^[1-9]\d{0,31}$/),
});

const recorded = z.object({ status: z.literal('recorded') });

const tokenReceipt = z.object({
  status: z.literal('token'),
  access_token: z.string().min(1).max(196666),
  intended_phone: signupPhoneSchema,
  app_id: z.string(),
  login_config_id: z.string(),
});

const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/** Controlled protocol seam only. Public routes never supply a provider transport or launch permission. */
export async function signupProtocol(
  request: Request,
  db: SupabaseClient,
  command: SignupCommand,
  transport: CoexistenceFetch,
  attemptId?: string,
  deadline = Date.now() + 45_000,
  supervised?: {
    owner: Identity;
    check: (
      service: SupabaseClient,
      signal: AbortSignal,
      attempt: z.infer<typeof signupAttemptSchema> | null
    ) => Promise<void>;
    assertPins: () => void;
    discovery?: true;
  }
) {
  deadline = Math.min(deadline, Date.now() + 45_000);
  const invalid = postGuard(request, attemptId);

  if (invalid) return invalid;

  const parsed =
    attemptId === undefined
      ? signupPrepareSchema.safeParse(command)
      : supervised?.discovery
        ? signupActionSchema
            .or(
              z.strictObject({ action: z.literal('discover'), nonce: z.uuid() })
            )
            .safeParse(command)
        : signupActionSchema.safeParse(command);

  if (!parsed.success) return signupError(400, 'invalid_request');

  return withSignupOwner(
    request,
    db,
    deadline,
    async (identity, service, outerSignal, status) => {
      if (supervised)
        await supervised.check(service, outerSignal, status.attempt);
      const config = configuration();

      if (!config) throw signupError(409, 'signup_disabled');
      const phaseRemaining = Math.min(deadline - Date.now(), 45_000) - 5000;

      if (phaseRemaining <= 0) throw signupError(504);

      const signal = AbortSignal.any([
        outerSignal,
        AbortSignal.timeout(phaseRemaining),
      ]);

      const pinned = () => {
        signal.throwIfAborted();
        supervised?.assertPins();
        const current = configuration();

        if (
          !current ||
          current.appId !== config.appId ||
          current.loginConfigId !== config.loginConfigId ||
          current.appSecret !== config.appSecret
        )
          throw signupError(409, 'signup_disabled');
      };

      const args = { ...identity, p_nonce_hash: hash(parsed.data.nonce) };

      if ('request_id' in parsed.data) {
        const account = await db
          .from('accounts')
          .select('connection_revision')
          .eq('id', identity.p_account_id)
          .abortSignal(signal)
          .maybeSingle();

        if (
          account.error ||
          !z.uuid().safeParse(account.data?.connection_revision).success
        )
          throw signupError(503);

        const existing = await db
          .from('whatsapp_config')
          .select('id, coexistence_generation')
          .eq('account_id', identity.p_account_id)
          .abortSignal(signal)
          .maybeSingle();

        if (existing.error) throw signupError(503);
        pinned();

        const result = await rpc(
          service,
          'prepare',
          {
            ...args,
            p_request_id: parsed.data.request_id,
            p_app_id: config.appId,
            p_login_config_id: config.loginConfigId,
            p_expected_revision: account.data!.connection_revision,
            p_expected_config_id: existing.data?.id ?? null,
            p_expected_generation:
              existing.data?.coexistence_generation ?? null,
            p_intended_phone: parsed.data.intended_phone,
          },
          prepared,
          signal
        );

        return Response.json(result, { headers: connectionHeaders });
      }

      if (!attemptId) throw signupError(400, 'invalid_request');
      const bound = { ...args, p_attempt_id: attemptId };

      // Only idempotent DB settlement repeats, using original ciphertext and a reserved deadline.
      const settle = async <T>(
        name: string,
        extra: Args,
        schema: z.ZodType<T>
      ) => {
        const remaining = deadline - Date.now();

        if (remaining <= 0) throw signupError(504);
        const settlementSignal = AbortSignal.timeout(remaining);

        try {
          return await rpc(
            service,
            name,
            { ...bound, ...extra },
            schema,
            settlementSignal
          );
        } catch (error) {
          if (!(error instanceof Response) || error.status !== 503) throw error;

          return rpc(
            service,
            name,
            { ...bound, ...extra },
            schema,
            settlementSignal
          );
        }
      };

      const review = (reason: string) =>
        settle('review', { p_reason: reason }, recorded);

      const action = parsed.data;
      pinned();

      if (action.action === 'launch') {
        const result = await rpc(service, 'launch', bound, started, signal);

        try {
          pinned();

          if (
            result.app_id !== config.appId ||
            result.login_config_id !== config.loginConfigId
          )
            throw signupError(409);
        } catch {
          await review('callback_invalid');
          throw signupError(409);
        }

        return Response.json(
          { status: result.status, dispatch: result.dispatch },
          { headers: connectionHeaders }
        );
      }

      if (action.action === 'exchange') {
        // A missing/duplicate start acknowledgement is NEVER permission to send a code.
        const receipt = await rpc(
          service,
          'exchange_start',
          { ...bound, p_code_hash: hash(action.code) },
          started,
          signal
        );

        try {
          pinned();

          if (
            receipt.app_id !== config.appId ||
            receipt.login_config_id !== config.loginConfigId
          )
            throw signupError(409);

          const token = await exchangeEmbeddedSignupCode(
            {
              appId: config.appId,
              appSecret: config.appSecret,
              code: action.code,
              signal,
            },
            transport
          );

          const ciphertext = encrypt(token.access_token);
          await settle('store_token', { p_access_token: ciphertext }, recorded);

          return Response.json(
            { status: 'recorded' },
            { headers: connectionHeaders }
          );
        } catch {
          await review('exchange_unknown');
          throw signupError(409);
        }
      }

      if (action.action === 'review') {
        await review(action.reason);

        return Response.json(
          { status: 'recorded' },
          { headers: connectionHeaders }
        );
      }

      if (action.action === 'confirm') {
        const result = await rpc(
          service,
          'confirm',
          bound,
          z.object({ status: z.literal('confirmed') }),
          signal
        );

        return Response.json(result, { headers: connectionHeaders });
      }

      try {
        const token = await rpc(service, 'token', bound, tokenReceipt, signal);

        if (
          token.app_id !== config.appId ||
          token.login_config_id !== config.loginConfigId
        )
          throw signupError(409);
        const accessToken = decrypt(token.access_token);

        // Each Graph request (including membership pages) requires fresh SQL authority, not only a prior read.
        const authorizedTransport: CoexistenceFetch = async (url, init) => {
          pinned();

          const current = await rpc(
            service,
            'token',
            bound,
            tokenReceipt,
            signal
          );

          if (
            current.access_token !== token.access_token ||
            current.app_id !== token.app_id ||
            current.login_config_id !== token.login_config_id ||
            current.intended_phone !== token.intended_phone
          )
            throw signupError(409);
          pinned();

          return transport(url, init);
        };

        const grants = await validateCoexistenceToken(
          {
            expectedAppId: config.appId,
            accessToken,
            appAccessToken: `${config.appId}|${config.appSecret}`,
            signal,
          },
          authorizedTransport
        );

        const management = grants.granular_scopes?.filter(
          ({ scope }) => scope === 'whatsapp_business_management'
        );

        const targets = new Set(
          management?.flatMap(({ target_ids }) => target_ids ?? [])
        );

        // shortcut: require one scoped WABA; broaden only with reviewed multi-WABA discovery.
        const wabaId =
          action.action === 'discover'
            ? targets.size === 1 &&
              !management?.some(({ target_ids }) => !target_ids?.length) &&
              [...targets][0]
            : action.finish.data.messaging_account_ids[0];

        if (!wabaId || !targets.has(wabaId)) throw signupError(409);

        const phone = await verifyCoexistencePhone(
          action.action === 'discover'
            ? {
                wabaId,
                accessToken,
                signal,
                discoveryPhone: token.intended_phone,
              }
            : {
                wabaId,
                accessToken,
                signal,
                phoneNumberId: action.finish.data.phone_number_id,
              },
          authorizedTransport
        );

        const providerPhone = `+${phone.normalizedPhoneNumber}`;

        if (providerPhone !== token.intended_phone) throw signupError(409);
        pinned();

        const expiry = Math.min(
          grants.expires_at,
          grants.data_access_expires_at ?? grants.expires_at
        );

        const result = await rpc(
          service,
          'verify',
          {
            ...bound,
            p_phone_number_id: phone.phoneNumberId,
            p_waba_id: phone.wabaId,
            p_display_phone_number: phone.displayPhoneNumber,
            p_normalized_phone_number: providerPhone,
            p_token_expires_at: new Date(expiry * 1000).toISOString(),
          },
          z.object({ status: z.literal('verified') }),
          signal
        );

        return Response.json(
          supervised?.discovery
            ? {
                ...result,
                preview: {
                  waba_id: phone.wabaId,
                  phone_number_id: phone.phoneNumberId,
                  normalized_phone_number: providerPhone,
                },
              }
            : result,
          { headers: connectionHeaders }
        );
      } catch {
        await review('verification_failed');
        throw signupError(409);
      }
    },
    supervised?.owner
  );
}
