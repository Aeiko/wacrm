import { z } from 'zod';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { deadlineFetch } from '@/lib/request-deadline';

export const connectionHeaders = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
};

export class ConnectionGateError extends Error {
  constructor(
    public readonly status = 503,
    public readonly code = 'connection_unavailable'
  ) {
    super(code);
  }
}

const failureSchema = z.object({
  status: z.enum([
    'busy',
    'conflict',
    'forbidden',
    'expired',
    'blocked',
    'invalid',
    'not_found',
    'unsupported',
  ]),
});

const acquiredSchema = z.object({
  status: z.literal('acquired'),
  operation_id: z.uuid(),
  token: z.uuid(),
  lease_until: z.iso.datetime({ offset: true }),
});

const startedSchema = z.object({
  status: z.literal('started'),
  dispatch: z.literal(true),
});

const recordedSchema = z.object({
  status: z.enum(['recorded', 'duplicate']),
  step_status: z.enum(['success', 'rejected', 'unknown']),
});

const completedSchema = z.object({
  status: z.literal('completed'),
  operation_id: z.uuid(),
  config_id: z.uuid().nullable(),
  revision: z.uuid(),
  saved: z.boolean(),
  registered: z.boolean(),
  registration_rejected: z.boolean(),
});

const accountStatusSchema = z.object({
  status: z.enum(['idle', 'busy', 'blocked']),
  operation_id: z.uuid().optional(),
});

export function connectionServiceClient(fetch = deadlineFetch) {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      global: { fetch },
      auth: { persistSession: false, autoRefreshToken: false },
    }
  );
}

export interface ConnectionConfig {
  access_token: string;
  verify_token: string | null;
  connected_at: string | null;
  registered_at: string | null;
  subscribed_apps_at: string | null;
}

type ConnectionRpcArgs = Record<
  string,
  string | boolean | null | ConnectionConfig
>;

async function rpc<T>(
  db: SupabaseClient,
  name: string,
  args: ConnectionRpcArgs,
  schema: z.ZodType<T>
): Promise<T> {
  const { data, error } = await db.rpc(name, args).retry(false);

  if (error) throw new ConnectionGateError();
  const parsed = schema.safeParse(data);

  if (parsed.success) return parsed.data;
  const failure = failureSchema.safeParse(data);

  if (failure.success)
    throw new ConnectionGateError(
      failure.data.status === 'forbidden' ? 403 : 409,
      failure.data.status === 'blocked'
        ? 'connection_blocked'
        : failure.data.status === 'busy'
          ? 'connection_busy'
          : 'connection_conflict'
    );
  throw new ConnectionGateError();
}

export async function connectionAccountStatus(
  db: SupabaseClient,
  actorId: string,
  accountId: string
) {
  return (
    await rpc(
      db,
      'connection_operation_account_status',
      {
        p_actor_id: actorId,
        p_account_id: accountId,
      },
      accountStatusSchema
    )
  ).status;
}

export interface ConnectionIntent {
  p_actor_id: string;
  p_account_id: string;
  p_request_id: string;
  p_kind: 'manual_save' | 'manual_delete' | 'onboarding';
  p_expected_revision: string;
  p_expected_config_id: string | null;
  p_expected_generation: string | null;
  p_phone_number_id: string | null;
  p_waba_id: string | null;
  p_register: boolean;
  p_subscribe: boolean;
}

/** SQL073 protocol: authorize once before HTTP; uncertainty never releases a started claim. */
export class ConnectionOperation {
  private mayHaveStarted = false;
  private completed = false;
  private readonly args: Record<string, string>;
  constructor(
    private readonly db: SupabaseClient,
    actorId: string,
    reservation: { operation_id: string; token: string }
  ) {
    this.args = {
      p_actor_id: actorId,
      p_operation_id: reservation.operation_id,
      p_token: reservation.token,
    };
  }

  get requiresReconciliation() {
    return this.mayHaveStarted && !this.completed;
  }

  // Onboarding is reservation-only; no remote onboarding flow is exposed here.
  static async acquire(db: SupabaseClient, intent: ConnectionIntent) {
    const reservation = await rpc(
      db,
      'connection_operation_acquire',
      { ...intent },
      acquiredSchema
    );

    return new ConnectionOperation(db, intent.p_actor_id, reservation);
  }

  async start(step: 'register' | 'subscribe') {
    this.mayHaveStarted = true; // A lost start acknowledgement is not permission to dispatch or cancel.

    try {
      await rpc(
        this.db,
        'connection_operation_start_step',
        { ...this.args, p_step: step },
        startedSchema
      );
    } catch (error) {
      if (error instanceof ConnectionGateError && error.status !== 503)
        throw error;
      throw new ConnectionGateError(409, 'connection_blocked');
    }
  }

  async record(
    step: 'register' | 'subscribe',
    outcome: 'success' | 'rejected' | 'unknown'
  ) {
    try {
      const result = await this.settle(
        'connection_operation_record_step',
        {
          p_step: step,
          p_outcome: outcome,
        },
        recordedSchema
      );

      if (result.step_status !== outcome) throw new ConnectionGateError();
    } catch {
      throw new ConnectionGateError(409, 'connection_blocked');
    }
  }

  async finish(config: ConnectionConfig | null) {
    try {
      const receipt = await this.settle(
        'connection_operation_finish',
        { p_config: config },
        completedSchema
      );

      this.completed = true;

      return receipt;
    } catch (error) {
      if (this.mayHaveStarted)
        throw new ConnectionGateError(409, 'connection_blocked');
      throw error;
    }
  }

  // Only idempotent database settlement is retried, never start authorization or Meta HTTP.
  private async settle<T>(
    name: string,
    extra: ConnectionRpcArgs,
    schema: z.ZodType<T>
  ) {
    try {
      return await rpc(this.db, name, { ...this.args, ...extra }, schema);
    } catch (error) {
      if (!(error instanceof ConnectionGateError) || error.status !== 503)
        throw error;

      return rpc(this.db, name, { ...this.args, ...extra }, schema);
    }
  }

  async cancelUnstarted() {
    if (this.mayHaveStarted || this.completed) return;
    await rpc(
      this.db,
      'connection_operation_cancel_unstarted',
      this.args,
      z.object({ status: z.literal('cancelled') })
    );
  }
}

const optionalText = (max: number) => z.string().max(max).nullable().optional();

export const manualConnectionSchema = z
  .strictObject({
    phone_number_id: z.string().regex(/^[1-9]\d{0,31}$/),
    waba_id: z
      .union([z.string().regex(/^[1-9]\d{0,31}$/), z.literal(''), z.null()])
      .optional(),
    access_token: z
      .string()
      .min(1)
      .max(16 * 1024),
    verify_token: optionalText(1024),
    pin: z
      .union([z.string().regex(/^\d{6}$/), z.literal(''), z.null()])
      .optional(),
  })
  .refine(
    (body) =>
      Buffer.byteLength(body.access_token) +
        Buffer.byteLength(body.verify_token ?? '') <=
      16 * 1024
  );

/** House operator CSRF policy, including DELETE; no body is read before origin checks. */
export async function connectionBody<T>(
  request: Request,
  signal: AbortSignal,
  schema: z.ZodType<T>
): Promise<T> {
  const url = new URL(request.url);

  if (
    request.headers.get('origin') !== url.origin ||
    request.headers.get('sec-fetch-site') === 'cross-site'
  )
    throw new ConnectionGateError(403, 'invalid_origin');

  if (
    url.search ||
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
      'application/json'
  )
    throw new ConnectionGateError(400, 'invalid_request');
  const reader = request.body?.getReader();

  if (!reader) throw new ConnectionGateError(400, 'invalid_request');
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

      if (size > 64 * 1024) {
        cancel();
        throw new ConnectionGateError(413, 'invalid_request');
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
      throw new ConnectionGateError(400, 'invalid_request');
    }
  } finally {
    if (signal.aborted) cancel();
    signal.removeEventListener('abort', cancel);
    await cancellation;
    reader.releaseLock();
  }
}
