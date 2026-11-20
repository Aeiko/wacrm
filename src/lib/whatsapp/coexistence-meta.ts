// Server-side only: never return credentials or these raw results to a browser.
import { z } from 'zod';
import { isValidE164, normalizePhone } from './phone-utils';
import { consumeDispatchPermit } from './coexistence/history-permit-client';
import { deadlineFetch, withRequestDeadline } from '@/lib/request-deadline';

export const COEXISTENCE_GRAPH_VERSION = 'v27.0';
export const COEXISTENCE_REQUEST_TIMEOUT_MS = 10_000;

// Injected transports must settle on init.signal abort and use deadlineFetch to inherit request scope.
export type CoexistenceFetch = (
  url: URL,
  init: RequestInit
) => Promise<Response>;

const metaIdSchema = z.string().regex(/^[1-9][0-9]{0,31}$/);

const secretSchema = z
  .string()
  .min(1)
  .max(32768)
  .refine((value) => value.trim().length > 0 && !/[\r\n]/.test(value));

const graphSuccessSchema = z.object({ error: z.never().optional() });

const graphErrorSchema = z.object({
  error: z.object({ code: z.number().int(), message: z.string() }),
});

export const exchangedTokenSchema = z.object({
  access_token: secretSchema,
  token_type: z.literal('bearer'),
});

export type ExchangedToken = z.infer<typeof exchangedTokenSchema>;

export const debugTokenSchema = z.object({
  data: z.object({
    error: z.never().optional(),
    app_id: metaIdSchema,
    is_valid: z.boolean(),
    expires_at: z.number().int().nonnegative(),
    data_access_expires_at: z.number().int().nonnegative().optional(),
    scopes: z.array(z.string()),
    granular_scopes: z
      .array(
        z.object({
          scope: z.string(),
          target_ids: z.array(metaIdSchema).optional(),
        })
      )
      .optional(),
  }),
});

export type ValidatedCoexistenceToken = z.infer<
  typeof debugTokenSchema
>['data'];

export const COEXISTENCE_REQUIRED_SCOPES = [
  'whatsapp_business_management',
  'whatsapp_business_messaging',
] as const;

export type CoexistenceMetaErrorKind =
  | 'input'
  | 'transport'
  | 'http'
  | 'invalid_response'
  | 'validation'
  | 'pagination';

// Deliberately omit response text, URLs, causes, and Meta messages: all may contain credentials.
export class CoexistenceMetaError extends Error {
  constructor(
    public readonly kind: CoexistenceMetaErrorKind,
    public readonly httpStatus?: number,
    public readonly metaCode?: number
  ) {
    super(`Coexistence Meta request failed (${kind})`);
    this.name = 'CoexistenceMetaError';
  }
}

function graphUrl(path: string): URL {
  return new URL(
    `https://graph.facebook.com/${COEXISTENCE_GRAPH_VERSION}/${path}`
  );
}

async function request<T>(
  url: URL,
  init: RequestInit,
  schema: z.ZodType<T>,
  transport: CoexistenceFetch
): Promise<T> {
  const controller = new AbortController();

  const signal = init.signal
    ? AbortSignal.any([controller.signal, init.signal])
    : controller.signal;

  const timer = setTimeout(
    () => controller.abort(),
    COEXISTENCE_REQUEST_TIMEOUT_MS
  );

  const execute = async () => {
    signal.throwIfAborted();

    const response = await transport(url, {
      ...init,
      redirect: 'error',
      cache: 'no-store',
      signal,
    });

    if (response.status >= 300 && response.status < 400) {
      controller.abort();
      await response.body?.cancel().catch(() => {});
      throw new CoexistenceMetaError('transport');
    }

    const body = await readResponseBody(response, signal);

    if (!response.ok) {
      const error = graphErrorSchema.safeParse(body);

      if (error.success) {
        throw new CoexistenceMetaError(
          'http',
          response.status,
          error.data.error.code
        );
      }

      throw new CoexistenceMetaError('invalid_response', response.status);
    }

    if (!graphSuccessSchema.safeParse(body).success) {
      throw new CoexistenceMetaError('invalid_response', response.status);
    }

    const parsed = schema.safeParse(body);

    if (!parsed.success)
      throw new CoexistenceMetaError('invalid_response', response.status);

    return parsed.data;
  };

  try {
    return await withRequestDeadline(
      Date.now() + COEXISTENCE_REQUEST_TIMEOUT_MS,
      execute,
      signal
    );
  } catch (error) {
    if (error instanceof CoexistenceMetaError) throw error;

    throw new CoexistenceMetaError('transport');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

const responseJsonSchema = z.json();

type CoexistenceJson = z.infer<typeof responseJsonSchema>;

async function readResponseBody(
  response: Response,
  signal: AbortSignal
): Promise<CoexistenceJson> {
  const reader = response.body?.getReader();

  if (!reader)
    throw new CoexistenceMetaError('invalid_response', response.status);
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  let cancellation: Promise<void> | undefined;

  const abort = () => {
    cancellation = reader.cancel().catch(() => {});
  };

  signal.addEventListener('abort', abort, { once: true });

  try {
    signal.throwIfAborted();

    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();

      if (done) {
        complete = true;
        break;
      }

      total += value.byteLength;

      if (total > 64 * 1024)
        throw new CoexistenceMetaError('invalid_response', response.status);
      chunks.push(value);
    }

    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks)
    );

    return responseJsonSchema.parse(JSON.parse(text));
  } catch (error) {
    const aborted =
      signal.aborted ||
      (error instanceof DOMException &&
        (error.name === 'AbortError' || error.name === 'TimeoutError'));

    throw new CoexistenceMetaError(
      aborted ? 'transport' : 'invalid_response',
      response.status
    );
  } finally {
    signal.removeEventListener('abort', abort);

    if (!complete && cancellation === undefined) abort();
    await cancellation;
    reader.releaseLock();
  }
}

const cursorSchema = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[A-Za-z0-9_+/=-]+$/);

export const wabaPhonePageSchema = z.object({
  data: z.array(
    z.object({
      id: metaIdSchema,
      display_phone_number: z
        .string()
        .regex(/^\+?[\d\s().-]+$/)
        .optional(),
    })
  ),
  paging: z
    .object({
      next: z.string().min(1).optional(),
      cursors: z.object({ after: cursorSchema.optional() }).optional(),
    })
    .optional(),
});

export const coexistencePhoneSchema = z.object({
  id: metaIdSchema,
  display_phone_number: z.string().regex(/^\+?[\d\s().-]+$/),
  is_on_biz_app: z.literal(true),
  platform_type: z.literal('CLOUD_API'),
});

export interface VerifyCoexistencePhoneArgs {
  signal?: AbortSignal;
  wabaId: string;
  accessToken: string;
}

type PhoneSelection =
  | { phoneNumberId: string; discoveryPhone?: never }
  | { discoveryPhone: string; phoneNumberId?: never };

export interface VerifiedCoexistencePhone {
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string;
  normalizedPhoneNumber: string;
}

// Browser IDs are hints: exhaust bounded pagination and verify the selected phone with the business token.
export async function verifyCoexistencePhone(
  args: VerifyCoexistencePhoneArgs & PhoneSelection,
  transport: CoexistenceFetch = deadlineFetch
): Promise<VerifiedCoexistencePhone> {
  const parsed = z
    .object({
      wabaId: metaIdSchema,
      phoneNumberId: metaIdSchema.optional(),
      discoveryPhone: z
        .string()
        .regex(/^\+[1-9]\d{7,14}$/)
        .optional(),
      accessToken: secretSchema,
    })
    .safeParse(args);

  if (!parsed.success) throw new CoexistenceMetaError('input');

  const init = {
    method: 'GET',
    headers: { Authorization: `Bearer ${args.accessToken}` },
  };

  const cursors = new Set<string>();
  let after: string | undefined;
  let found = false;
  const listed = new Set<string>();
  const matches = new Set<string>();

  for (let page = 0; ; page++) {
    if (page >= 100) throw new CoexistenceMetaError('pagination');

    const url = graphUrl(`${args.wabaId}/phone_numbers`);
    url.searchParams.set(
      'fields',
      args.discoveryPhone ? 'id,display_phone_number' : 'id'
    );

    if (after !== undefined) url.searchParams.set('after', after);

    const result = await request(
      url,
      { ...init, signal: args.signal },
      wabaPhonePageSchema,
      transport
    );

    for (const phone of result.data) {
      found ||= phone.id === args.phoneNumberId;

      if (args.discoveryPhone) {
        const digits = normalizePhone(phone.display_phone_number ?? '');

        if (!isValidE164(digits) || listed.has(phone.id))
          throw new CoexistenceMetaError('validation');
        listed.add(phone.id);

        if (`+${digits}` === args.discoveryPhone) matches.add(phone.id);
      }
    }

    if (!result.paging?.next) break;

    after = result.paging.cursors?.after;

    // Never follow paging.next (it may contain a token or foreign origin); only forward a validated cursor.
    if (after === undefined || cursors.has(after))
      throw new CoexistenceMetaError('pagination');

    cursors.add(after);
  }

  const phoneId = args.discoveryPhone
    ? matches.size === 1 && [...matches][0]
    : found && args.phoneNumberId;

  if (!phoneId) throw new CoexistenceMetaError('validation');

  const url = graphUrl(phoneId);
  url.searchParams.set(
    'fields',
    'id,display_phone_number,is_on_biz_app,platform_type'
  );

  const phone = await request(
    url,
    { ...init, signal: args.signal },
    coexistencePhoneSchema,
    transport
  );

  const normalizedPhoneNumber = normalizePhone(phone.display_phone_number);

  if (
    phone.id !== phoneId ||
    !isValidE164(normalizedPhoneNumber) ||
    (args.discoveryPhone && `+${normalizedPhoneNumber}` !== args.discoveryPhone)
  ) {
    throw new CoexistenceMetaError('validation');
  }

  return {
    wabaId: args.wabaId,
    phoneNumberId: phone.id,
    displayPhoneNumber: phone.display_phone_number,
    normalizedPhoneNumber,
  };
}

export interface ValidateCoexistenceTokenArgs {
  signal?: AbortSignal;
  expectedAppId: string;
  accessToken: string;
  appAccessToken: string;
}

// This verifies grants, not tenant ownership, asset access, App Review, publication, or login-code binding.
export async function validateCoexistenceToken(
  args: ValidateCoexistenceTokenArgs,
  transport: CoexistenceFetch = deadlineFetch
): Promise<ValidatedCoexistenceToken> {
  const parsed = z
    .object({
      expectedAppId: metaIdSchema,
      accessToken: secretSchema,
      appAccessToken: secretSchema,
    })
    .safeParse(args);

  if (!parsed.success) throw new CoexistenceMetaError('input');

  const url = graphUrl('debug_token');
  url.searchParams.set('input_token', args.accessToken);

  const { data } = await request(
    url,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${args.appAccessToken}` },
      signal: args.signal,
    },
    debugTokenSchema,
    transport
  );

  const now = Math.floor(Date.now() / 1000);

  // Unknown/zero expiry is refused until its semantics for this token contract are independently confirmed.
  if (
    !data.is_valid ||
    data.app_id !== args.expectedAppId ||
    data.expires_at <= now ||
    (data.data_access_expires_at !== undefined &&
      data.data_access_expires_at <= now) ||
    !COEXISTENCE_REQUIRED_SCOPES.every((scope) => data.scopes.includes(scope))
  ) {
    throw new CoexistenceMetaError('validation');
  }

  return data;
}

export const coexistenceCallbackUrlSchema = z
  .string()
  .max(200)
  .refine((value) => {
    const url = URL.parse(value);

    return (
      url !== null &&
      url.protocol === 'https:' &&
      /^https:\/\//i.test(value) &&
      !url.username &&
      !url.password &&
      !/[\\\s#]/.test(value) &&
      !/^https:\/\/[^/?#]*@/i.test(value)
    );
  });

export const wabaSubscriptionSchema = z.object({ success: z.literal(true) });

export type WabaSubscription = z.infer<typeof wabaSubscriptionSchema>;

export interface SubscribeCoexistenceWabaArgs {
  signal?: AbortSignal;
  wabaId: string;
  accessToken: string;
  callbackUrl: string;
  verifyToken: string;
}

// A WABA override reroutes its other numbers too; callers must authorize that scope and preserve the default receiver.
export async function subscribeCoexistenceWaba(
  args: SubscribeCoexistenceWabaArgs,
  transport: CoexistenceFetch = deadlineFetch
): Promise<WabaSubscription> {
  const parsed = z
    .object({
      wabaId: metaIdSchema,
      accessToken: secretSchema,
      callbackUrl: coexistenceCallbackUrlSchema,
      verifyToken: secretSchema,
    })
    .safeParse(args);

  if (!parsed.success) throw new CoexistenceMetaError('input');

  // Never POST an empty subscription body: Meta would remove the existing override.
  return request(
    graphUrl(`${args.wabaId}/subscribed_apps`),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        override_callback_uri: args.callbackUrl,
        verify_token: args.verifyToken,
      }),
      signal: args.signal,
    },
    wabaSubscriptionSchema,
    transport
  );
}

export const coexistenceSyncTypeSchema = z.enum([
  'smb_app_state_sync',
  'history',
]);

export type CoexistenceSyncType = z.infer<typeof coexistenceSyncTypeSchema>;

export const coexistenceSyncResponseSchema = z.object({
  messaging_product: z.literal('whatsapp'),
  request_id: z.string().trim().min(1),
});

const historyReceiptSchema = z.strictObject({
  dispatch: z.literal(true),
  request_id: z.guid(),
  phone_number_id: metaIdSchema,
  deadline_at: z.iso.datetime({ offset: true }),
});

export type CoexistenceSyncOutcome =
  | { outcome: 'not_sent' }
  | { outcome: 'accepted'; requestId: string }
  | { outcome: 'rejected'; httpStatus: number; metaCode: number }
  | {
      outcome: 'ambiguous';
      reason: 'transport' | 'invalid_response' | 'server_error';
      httpStatus?: number;
    };

export interface InitiateCoexistenceSyncArgs {
  signal?: AbortSignal;
  phoneNumberId: string;
  accessToken: string;
  syncType: CoexistenceSyncType;
  historyReceipt?: z.infer<typeof historyReceiptSchema>;
}

// Callers must durably claim the exact consented type; a history request never authorizes contacts.
export async function initiateCoexistenceSync(
  args: InitiateCoexistenceSyncArgs,
  transport: CoexistenceFetch
): Promise<CoexistenceSyncOutcome> {
  const parsed = z
    .object({
      phoneNumberId: metaIdSchema,
      accessToken: secretSchema,
      syncType: coexistenceSyncTypeSchema,
    })
    .safeParse(args);

  if (!parsed.success) throw new CoexistenceMetaError('input');

  if (!z.function().safeParse(transport).success)
    return { outcome: 'not_sent' };

  const { phoneNumberId, accessToken, syncType } = parsed.data;

  if (args.historyReceipt !== undefined && syncType !== 'history')
    return { outcome: 'not_sent' };
  let send = transport;
  let dispatched = false;

  if (syncType === 'history') {
    const receipt = historyReceiptSchema.safeParse(args.historyReceipt).data;

    if (!receipt || receipt.phone_number_id !== phoneNumberId)
      return { outcome: 'not_sent' };

    const deadline = Date.parse(receipt.deadline_at);

    send = async (url, init) => {
      if (
        init.signal?.aborted ||
        !(Date.now() < deadline) ||
        !(await consumeDispatchPermit(phoneNumberId, receipt.request_id)) ||
        init.signal?.aborted ||
        !(Date.now() < deadline)
      ) {
        throw new CoexistenceMetaError('transport');
      }

      dispatched = true;

      return transport(url, init);
    };
  }

  try {
    const response = await request(
      graphUrl(`${phoneNumberId}/smb_app_data`),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          sync_type: syncType,
        }),
        signal: args.signal,
      },
      coexistenceSyncResponseSchema,
      send
    );

    return { outcome: 'accepted', requestId: response.request_id };
  } catch (error) {
    if (syncType === 'history' && !dispatched) return { outcome: 'not_sent' };

    if (error instanceof CoexistenceMetaError) {
      if (
        error.kind === 'http' &&
        error.httpStatus !== undefined &&
        error.metaCode !== undefined
      ) {
        // A server failure can occur after accepting the one-shot request.
        if (error.httpStatus >= 500) {
          return {
            outcome: 'ambiguous',
            reason: 'server_error',
            httpStatus: error.httpStatus,
          };
        }

        return {
          outcome: 'rejected',
          httpStatus: error.httpStatus,
          metaCode: error.metaCode,
        };
      }

      if (error.kind === 'invalid_response') {
        return {
          outcome: 'ambiguous',
          reason: 'invalid_response',
          httpStatus: error.httpStatus,
        };
      }
    }

    return { outcome: 'ambiguous', reason: 'transport' };
  }
}

export interface ExchangeEmbeddedSignupCodeArgs {
  signal?: AbortSignal;
  appId: string;
  appSecret: string;
  code: string;
}

// App validation does not bind a login code to initiation; the route/SDK must enforce CSRF/code binding.
export async function exchangeEmbeddedSignupCode(
  args: ExchangeEmbeddedSignupCodeArgs,
  transport: CoexistenceFetch = deadlineFetch
): Promise<ExchangedToken> {
  const parsed = z
    .object({
      appId: metaIdSchema,
      appSecret: secretSchema,
      code: secretSchema,
    })
    .safeParse(args);

  if (!parsed.success) throw new CoexistenceMetaError('input');

  const url = graphUrl('oauth/access_token');
  url.search = new URLSearchParams({
    client_id: args.appId,
    client_secret: args.appSecret,
    code: args.code,
  }).toString();

  // Official GET includes secrets: transport/proxy tracing must redact query strings.
  return request(
    url,
    { method: 'GET', signal: args.signal },
    exchangedTokenSchema,
    transport
  );
}
