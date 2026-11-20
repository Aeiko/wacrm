import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { z } from 'zod';
import {
  ConnectionGateError,
  ConnectionOperation,
  connectionAccountStatus,
  connectionBody,
  connectionHeaders,
  connectionServiceClient,
  manualConnectionSchema,
} from '@/lib/whatsapp/connection-operation';
import {
  ForbiddenError,
  UnauthorizedError,
  requireRole,
  getCurrentAccount,
} from '@/lib/auth/account';
import {
  getSubscribedApps,
  isDefinitiveConnectionRejection,
  listWabaPhoneNumbers,
  registerPhoneNumber,
  subscribeWabaToApp,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api';
import {
  explainMetaError,
  metaErrorPayload,
  type MetaConnectStep,
  type MetaErrorContext,
} from '@/lib/whatsapp/meta-error-explain';
import {
  appSubscriptionState,
  phoneNumberBelongsToWaba,
} from '@/lib/whatsapp/waba-pairing';
import { encrypt, decrypt } from '@/lib/whatsapp/encryption';
import { resolveVerifyTokenForSave } from '@/lib/whatsapp/verify-token';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { getT } from '@/lib/i18n/translate';
import { withRequestDeadline } from '@/lib/request-deadline';

const t = getT('Api');

/**
 * Resolve the caller's account_id from their profile. Inlined here
 * (rather than going through `@/lib/auth/account.getCurrentAccount`)
 * because the GET handler wants to return shaped 200s for every
 * non-auth failure mode, not throw — keeping the helper minimal lets
 * the existing response branches stay as-is.
 *
 * Returns null if the user has no profile or no account; callers
 * should treat that the same as "not connected".
 */
async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle();

  if (error || !data?.account_id) return null;

  return data.account_id as string;
}

// Provider text and trace IDs can echo credentials; expose fixed text and numeric diagnostics only.
function safeConnectionError(
  err: Error,
  step: MetaConnectStep,
  ctx: MetaErrorContext
) {
  const explained = explainMetaError(err, step, ctx);

  return {
    ...explained,
    code: z.number().int().nullable().catch(null).parse(explained.code),
    subcode: z.number().int().nullable().catch(null).parse(explained.subcode),
    summary:
      step === 'register'
        ? 'Meta rejected registration. Check the number and PIN.'
        : 'Meta could not verify these credentials.',
    metaMessage: 'Meta connection request rejected.',
    fbtraceId: null,
  };
}

function metaFailure(err: Error, step: MetaConnectStep, ctx: MetaErrorContext) {
  const explained = safeConnectionError(err, step, ctx);

  return NextResponse.json(
    { error: explained.summary, meta: metaErrorPayload(explained) },
    { status: explained.httpStatus }
  );
}

/**
 * GET /api/whatsapp/config
 *
 * Used by the "Test API Connection" button and by the page to check
 * whether the saved config is healthy. Returns 200 in all non-auth cases
 * so the UI can render an appropriate message rather than show a 500.
 *
 * Response shape:
 *   { connected: true,  phone_info: {...},
 *     waba_subscription: { checked, subscribed, app_id_match, error? } }
 *   { connected: false, reason: 'no_config',        message: '...' }
 *   { connected: false, reason: 'token_corrupted',  message: '...', needs_reset: true }
 *   { connected: false, reason: 'meta_api_error',   message: '...',
 *     meta: { code, subcode, fbtrace_id, step, field, message } }
 */
async function localMode(request: Request) {
  const headers = {
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  };

  const params = new URL(request.url).searchParams;

  if (params.get('mode') !== 'local' || params.size !== 1)
    return NextResponse.json(
      { error: 'invalid_mode' },
      { status: 400, headers }
    );
  const deadline = Date.now() + 15_000;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]);

  try {
    return await withRequestDeadline(
      deadline,
      async () => {
        signal.throwIfAborted();

        const { supabase, accountId, userId } = await getCurrentAccount(
          await createClient()
        );

        signal.throwIfAborted();

        const { data: config, error } = await supabase
          .from('whatsapp_config')
          .select('coexistence_app_id')
          .eq('account_id', accountId)
          .maybeSingle();

        signal.throwIfAborted();

        if (error) throw new Error('Config unavailable');

        return NextResponse.json(
          {
            managed: config?.coexistence_app_id != null,
            operation_state: await connectionAccountStatus(
              connectionServiceClient(),
              userId,
              accountId
            ),
          },
          { headers }
        );
      },
      signal
    );
  } catch (error) {
    const status =
      signal.aborted || Date.now() >= deadline
        ? request.signal.aborted
          ? 499
          : 504
        : error instanceof UnauthorizedError || error instanceof ForbiddenError
          ? error.status
          : 503;

    return NextResponse.json(
      { error: 'config_unavailable' },
      { status, headers }
    );
  }
}

export async function GET(request?: Request) {
  if (request && new URL(request.url).searchParams.has('mode'))
    return localMode(request);

  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: t('common.unauthorized') },
        { status: 401 }
      );
    }

    const accountId = await resolveAccountId(supabase, user.id);

    if (!accountId) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_account',
          message: t('common.profileNotLinked'),
        },
        { status: 200 }
      );
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select(
        'phone_number_id, waba_id, access_token, status, coexistence_app_id'
      )
      .eq('account_id', accountId)
      .maybeSingle();

    if (configError) {
      console.error('Error fetching whatsapp_config:', configError);

      return NextResponse.json(
        {
          connected: false,
          reason: 'db_error',
          message: t('whatsappConfig.fetchFailed'),
        },
        { status: 200 }
      );
    }

    if (!config) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_config',
          message: t('whatsappConfig.noConfig'),
        },
        { status: 200 }
      );
    }

    if (config.coexistence_app_id != null) {
      return NextResponse.json({
        connected: false,
        reason: 'coexistence_managed',
        message:
          'Use verified Coexistence onboarding to manage this connection.',
      });
    }

    // Try to decrypt the stored token with the current ENCRYPTION_KEY.
    // If this fails, the key changed (or was never consistent across envs).
    let accessToken: string;

    try {
      accessToken = decrypt(config.access_token);
    } catch (err) {
      console.error('[whatsapp/config GET] Token decryption failed:', err);

      return NextResponse.json(
        {
          connected: false,
          reason: 'token_corrupted',
          needs_reset: true,
          message: t('whatsappConfig.tokenCorrupted'),
        },
        { status: 200 }
      );
    }

    // Validate credentials against Meta
    let phoneInfo;

    try {
      phoneInfo = await verifyPhoneNumber({
        phoneNumberId: config.phone_number_id,
        accessToken,
      });
    } catch (err) {
      const explained = explainMetaError(err, 'verify_number', {
        phoneNumberId: config.phone_number_id,
        wabaId: config.waba_id,
      });

      console.error(
        '[whatsapp/config GET] Meta API verification failed:',
        explained.metaMessage
      );

      return NextResponse.json(
        {
          connected: false,
          reason: 'meta_api_error',
          message: explained.summary,
          meta: metaErrorPayload(explained),
        },
        { status: 200 }
      );
    }

    // Credentials work. Also report whether the WABA is subscribed to
    // this app — valid credentials with an unsubscribed WABA is exactly
    // the "connected but no messages arrive" state (issue #505). Never
    // fatal: the token may lack whatsapp_business_management and still
    // be fine for sending.
    let wabaSubscription: {
      checked: boolean;
      subscribed: boolean | null;
      app_id_match: boolean | null;
      error?: string;
    } = { checked: false, subscribed: null, app_id_match: null };

    if (config.waba_id) {
      try {
        const subs = await getSubscribedApps({
          wabaId: config.waba_id,
          accessToken,
        });

        const state = appSubscriptionState(subs, process.env.META_APP_ID);
        wabaSubscription = {
          checked: true,
          subscribed: state.subscribed,
          app_id_match: state.appIdMatch,
        };
      } catch (err) {
        const explained = explainMetaError(err, 'subscribed_apps', {
          wabaId: config.waba_id,
        });

        wabaSubscription = {
          checked: true,
          subscribed: null,
          app_id_match: null,
          error: explained.summary,
        };
      }
    }

    return NextResponse.json({
      connected: true,
      phone_info: phoneInfo,
      waba_subscription: wabaSubscription,
    });
  } catch (error) {
    console.error('Error in WhatsApp config GET:', error);

    return NextResponse.json(
      {
        connected: false,
        reason: 'unknown',
        message: t('common.internalServerError'),
      },
      { status: 500 }
    );
  }
}

/** Manual writes always finish through SQL073; no direct config control writes. */
async function mutateConfig(request: Request, deleting: boolean) {
  const overallDeadline = Date.now() + 45_000;
  const httpDeadline = overallDeadline - 10_000;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]);
  let gate: ConnectionOperation | undefined;

  try {
    return await withRequestDeadline(
      overallDeadline,
      async () => {
        try {
          const body = deleting
            ? (await connectionBody(request, signal, z.strictObject({})), null)
            : await connectionBody(request, signal, manualConnectionSchema);

          const { supabase, accountId, userId } = await requireRole('admin');
          signal.throwIfAborted();

          const limit = checkRateLimit(
            `whatsapp-admin:${userId}`,
            RATE_LIMITS.whatsappAdmin
          );

          if (!limit.success) return rateLimitResponse(limit);

          // Revision first fences save/delete ABA even when both config snapshots are absent.
          const { data: account, error: accountError } = await supabase
            .from('accounts')
            .select('connection_revision')
            .eq('id', accountId)
            .single();

          if (
            accountError ||
            !z.uuid().safeParse(account?.connection_revision).success
          )
            throw new ConnectionGateError();

          const { data: existing, error: configError } = await supabase
            .from('whatsapp_config')
            .select(
              'id, coexistence_generation, coexistence_app_id, registered_at, phone_number_id, verify_token'
            )
            .eq('account_id', accountId)
            .maybeSingle();

          if (configError) throw new ConnectionGateError();

          if (existing?.coexistence_app_id != null)
            return NextResponse.json(
              {
                error:
                  'Use verified Coexistence onboarding to manage this connection.',
                reason: 'coexistence_managed',
              },
              { status: 409 }
            );

          const db = connectionServiceClient();

          const intent = {
            p_actor_id: userId,
            p_account_id: accountId,
            p_request_id: crypto.randomUUID(),
            p_expected_revision: account.connection_revision,
            p_expected_config_id: existing?.id ?? null,
            p_expected_generation: existing?.coexistence_generation ?? null,
          };

          if (body === null) {
            gate = await ConnectionOperation.acquire(db, {
              ...intent,
              p_kind: 'manual_delete',
              p_phone_number_id: null,
              p_waba_id: null,
              p_register: false,
              p_subscribe: false,
            });
            await gate.finish(null);

            return NextResponse.json({ success: true });
          }

          const { phone_number_id, access_token, verify_token, pin } = body;
          const waba_id = body.waba_id || null;

          const sameNumber =
            existing?.phone_number_id === phone_number_id &&
            existing?.registered_at != null;

          const register = Boolean(pin);
          const registrationSkipped = !sameNumber && !pin;

          let registeredAt: string | null = sameNumber
            ? existing.registered_at
            : null;

          let subscribedAt: string | null = null;

          let registrationError: ReturnType<typeof explainMetaError> | null =
            null;

          let phoneInfo;

          // No claims before proof: a bogus token must not lock somebody else's phone/WABA.
          await withRequestDeadline(
            httpDeadline,
            async () => {
              try {
                phoneInfo = await verifyPhoneNumber({
                  phoneNumberId: phone_number_id,
                  accessToken: access_token,
                });
              } catch (error) {
                throw metaFailure(
                  error instanceof Error
                    ? error
                    : new Error('Verification failed'),
                  'verify_number',
                  { phoneNumberId: phone_number_id, wabaId: waba_id }
                );
              }

              if (waba_id) {
                let numbers;

                try {
                  numbers = await listWabaPhoneNumbers({
                    wabaId: waba_id,
                    accessToken: access_token,
                  });
                } catch (error) {
                  throw metaFailure(
                    error instanceof Error
                      ? error
                      : new Error('Verification failed'),
                    'waba_phone_numbers',
                    { phoneNumberId: phone_number_id, wabaId: waba_id }
                  );
                }

                if (!phoneNumberBelongsToWaba(numbers, phone_number_id))
                  throw new ConnectionGateError(400, 'phone_waba_mismatch');
              }
            },
            signal
          );
          signal.throwIfAborted();
          const encryptedAccessToken = encrypt(access_token);

          const encryptedVerifyToken = resolveVerifyTokenForSave(
            verify_token,
            existing?.verify_token ?? null
          );

          gate = await ConnectionOperation.acquire(db, {
            ...intent,
            p_kind: 'manual_save',
            p_phone_number_id: phone_number_id,
            p_waba_id: waba_id,
            p_register: register,
            p_subscribe: Boolean(waba_id),
          });

          const operation = gate;

          async function step(
            name: 'register' | 'subscribe',
            remote: () => Promise<void>
          ) {
            signal.throwIfAborted();

            if (Date.now() >= httpDeadline) throw new ConnectionGateError(504);
            await operation.start(name);
            let outcome: 'success' | 'rejected' | 'unknown' = 'success';
            let rejection: ReturnType<typeof safeConnectionError> | null = null;

            try {
              await withRequestDeadline(httpDeadline, remote, signal);
            } catch (error) {
              outcome = isDefinitiveConnectionRejection(error)
                ? 'rejected'
                : 'unknown';

              if (outcome === 'rejected' && error instanceof Error)
                rejection = safeConnectionError(error, 'register', {
                  phoneNumberId: phone_number_id,
                  wabaId: waba_id,
                });
            }

            // Settlement retains the overall reserve, rather than the spent HTTP deadline.
            await operation.record(name, outcome);

            if (
              outcome === 'unknown' ||
              (name === 'subscribe' && outcome === 'rejected')
            )
              throw new ConnectionGateError(409, 'connection_blocked');

            return rejection;
          }

          if (register) {
            const rejection = await step('register', async () => {
              await registerPhoneNumber({
                phoneNumberId: phone_number_id,
                accessToken: access_token,
                pin: pin!,
              });
            });

            if (rejection) {
              registeredAt = null;
              registrationError = rejection;
            } else registeredAt = new Date().toISOString();
          }

          if (waba_id) {
            await step('subscribe', () =>
              subscribeWabaToApp({ wabaId: waba_id, accessToken: access_token })
            );
            subscribedAt = new Date().toISOString();
          }

          const receipt = await gate.finish({
            access_token: encryptedAccessToken,
            verify_token: encryptedVerifyToken,
            connected_at: registrationError ? null : new Date().toISOString(),
            registered_at: registeredAt,
            subscribed_apps_at: subscribedAt,
          });

          const registrationFailure = receipt.registration_rejected
            ? (registrationError ??
              safeConnectionError(
                new Error('Registration rejected'),
                'register',
                {}
              ))
            : null;

          const result = {
            success: !receipt.registration_rejected,
            saved: receipt.saved,
            registered: receipt.registered,
            phone_info: phoneInfo,
            registration_skipped: registrationSkipped,
            registration_error: registrationFailure?.summary ?? null,
          };

          if (registrationFailure)
            return NextResponse.json({
              ...result,
              error: registrationFailure.summary,
              meta: metaErrorPayload(registrationFailure),
            });

          return NextResponse.json(result);
        } finally {
          // SQL also checks never-started; failed cleanup must not replace a safe response.
          if (gate) await gate.cancelUnstarted().catch(() => {});
        }
      },
      signal
    );
  } catch (error) {
    const blocked = gate?.requiresReconciliation === true;

    if (error instanceof Response && !blocked) return error;

    const status =
      signal.aborted || Date.now() >= overallDeadline
        ? request.signal.aborted
          ? 499
          : 504
        : error instanceof ConnectionGateError ||
            error instanceof UnauthorizedError ||
            error instanceof ForbiddenError
          ? error.status
          : 503;

    return NextResponse.json(
      {
        error: blocked
          ? 'connection_blocked'
          : error instanceof ConnectionGateError
            ? error.code === 'connection_conflict'
              ? 'WhatsApp connection changed. Reload before making changes.'
              : error.code === 'phone_waba_mismatch'
                ? 'The phone number does not belong to this WhatsApp Business Account.'
                : error.code
            : 'The WhatsApp connection is unavailable. Reload before making changes.',
        ...(blocked ||
        (error instanceof ConnectionGateError &&
          error.code === 'connection_blocked')
          ? { reason: 'connection_operation_blocked' }
          : error instanceof ConnectionGateError &&
              error.code === 'connection_busy'
            ? { reason: 'connection_operation_busy' }
            : {}),
      },
      { status }
    );
  }
}

async function mutationResponse(request: Request, deleting: boolean) {
  const response = await mutateConfig(request, deleting);

  for (const [name, value] of Object.entries(connectionHeaders))
    response.headers.set(name, value);

  return response;
}

export async function POST(request: Request) {
  return mutationResponse(request, false);
}

export async function DELETE(request: Request) {
  return mutationResponse(request, true);
}
