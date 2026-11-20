import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { deadlineFetch } from '@/lib/request-deadline';
import { decrypt } from '../encryption';
import { z } from 'zod';

export interface SendConnection {
  accountId: string;
  configId: string | null;
  generation: string | null;
  privateRestOrigin?: string;
}

const sendConnection = new AsyncLocalStorage<SendConnection>();

const sendConnectionSchema = z.union([
  z.object({
    accountId: z.string().min(1),
    configId: z.null(),
    generation: z.null(),
  }),
  z.object({
    accountId: z.string().min(1),
    configId: z.string().min(1),
    generation: z.string().min(1),
  }),
]);

export async function withSendConnection<T>(
  connection: SendConnection,
  action: () => Promise<T>
): Promise<T> {
  if (!sendConnectionSchema.safeParse(connection).success)
    throw new Error('Invalid outbound connection identity');

  const inherited = sendConnection.getStore();

  if (inherited) {
    if (
      inherited.accountId !== connection.accountId ||
      inherited.configId !== connection.configId ||
      inherited.generation !== connection.generation
    ) {
      throw new Error('Conflicting outbound connection identity');
    }

    return action();
  }

  return sendConnection.run({ ...connection }, action);
}

const connectionRowSchema = z.object({
  id: z.string().min(1),
  account_id: z.string().min(1),
  coexistence_app_id: z.string().min(1).nullable(),
  coexistence_generation: z.string().min(1),
});

async function loadAccountSendConnection(
  db: SupabaseClient,
  accountId: string
): Promise<SendConnection> {
  const { data, error } = await db
    .from('whatsapp_config')
    .select('id,account_id,coexistence_app_id,coexistence_generation')
    .eq('account_id', accountId)
    .limit(2);

  const parsed = z.array(connectionRowSchema).max(1).safeParse(data);

  if (error || !parsed.success)
    throw new Error('Outbound connection lookup failed');
  const row = parsed.data[0];

  if (row && row.account_id !== accountId)
    throw new Error('Outbound connection account mismatch');

  return {
    accountId,
    configId: row?.coexistence_app_id ? row.id : null,
    generation: row?.coexistence_app_id ? row.coexistence_generation : null,
  };
}

export async function withAccountSendConnection<T>(
  db: SupabaseClient,
  accountId: string,
  action: () => Promise<T>
): Promise<T> {
  const inherited = sendConnection.getStore();

  if (inherited) {
    if (inherited.accountId !== accountId)
      throw new Error('Conflicting outbound connection account');

    return action();
  }

  return withSendConnection(
    await loadAccountSendConnection(db, accountId),
    action
  );
}

/** Validate authority for lifecycle writes without replacing the originating scope. */
export async function assertCurrentSendConnection(
  db: SupabaseClient,
  accountId: string
): Promise<void> {
  const inherited = sendConnection.getStore();

  if (!inherited || inherited.accountId !== accountId)
    throw new Error('Outbound connection scope required');

  const current = await loadAccountSendConnection(db, accountId);

  if (
    inherited.configId !== current.configId ||
    inherited.generation !== current.generation
  )
    throw new Error('Outbound connection authority changed');
}

export function sendConnectionColumns() {
  const connection = sendConnection.getStore();

  if (!connection) throw new Error('Outbound connection scope required');

  return {
    send_config_id: connection.configId,
    send_generation: connection.generation,
  };
}

const outboundRowSchema = connectionRowSchema.extend({
  waba_id: z.string().nullish(),
  access_token: z.string().min(1),
  status: z.literal('connected'),
  coexistence_verified_at: z.string().min(1).nullable(),
});

function sameToken(current: string, outgoing: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(current).digest(),
    createHash('sha256').update(outgoing).digest()
  );
}

/** Fresh last-mile snapshot; rotation after this check or an in-flight POST cannot be recalled. */
export async function assertOutboundSendAllowed(
  phoneNumberId: string,
  accessToken: string
): Promise<void> {
  try {
    const context = sendConnection.getStore();

    const db = createClient(
      context?.privateRestOrigin ?? process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      {
        global: { fetch: deadlineFetch },
        auth: { persistSession: false, autoRefreshToken: false },
      }
    );

    const { data, error } = await db
      .from('whatsapp_config')
      .select(
        'id,account_id,waba_id,access_token,status,coexistence_app_id,coexistence_generation,coexistence_verified_at'
      )
      .eq('phone_number_id', phoneNumberId)
      .limit(2);

    const parsed = z.array(outboundRowSchema).length(1).safeParse(data);

    if (error || !parsed.success)
      throw new Error('Invalid current configuration');
    const row = parsed.data[0];

    // The history pilot is receive-only, including while a held stop cannot reach us.
    const pilotPhone = process.env.WHATSAPP_COEXISTENCE_RELAY_PHONE_ID;
    const pilotWaba = process.env.WHATSAPP_COEXISTENCE_RELAY_WABA_ID;

    if (
      (pilotPhone && phoneNumberId.replace(/^0+/, '') === pilotPhone) ||
      (pilotWaba &&
        row.coexistence_app_id === process.env.WHATSAPP_COEXISTENCE_APP_ID &&
        (!row.waba_id || row.waba_id.replace(/^0+/, '') === pilotWaba))
    )
      throw new Error('History pilot is receive-only');

    if (!sameToken(decrypt(row.access_token), accessToken))
      throw new Error('Credential mismatch');

    if (context && context.accountId !== row.account_id)
      throw new Error('Account mismatch');

    if (row.coexistence_app_id !== null) {
      if (
        process.env.WHATSAPP_COEXISTENCE_ENABLED !== 'true' ||
        !process.env.WHATSAPP_COEXISTENCE_APP_SECRET ||
        !/^\d+$/.test(
          process.env.WHATSAPP_COEXISTENCE_PARTNER_BUSINESS_ID ?? ''
        ) ||
        row.coexistence_app_id !== process.env.WHATSAPP_COEXISTENCE_APP_ID ||
        !row.coexistence_verified_at ||
        !context ||
        context.configId !== row.id ||
        context.generation !== row.coexistence_generation
      )
        throw new Error('Managed connection mismatch');
    } else if (
      context &&
      (context.configId !== null || context.generation !== null)
    ) {
      throw new Error('Managed connection removed');
    }
  } catch {
    // Never expose database responses, ciphertext, decrypted credentials, or transport errors.
    throw new Error(
      'Outbound send denied: current connection unavailable or changed'
    );
  }
}

export function withStoredSendConnection<T>(
  accountId: string,
  row: { send_config_id?: string | null; send_generation?: string | null },
  action: () => Promise<T>
): Promise<T> {
  return withSendConnection(
    {
      accountId,
      configId: row.send_config_id ?? null,
      generation: row.send_generation ?? null,
    },
    action
  );
}
