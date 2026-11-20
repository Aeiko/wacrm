import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { readRelayScope } from '@/lib/whatsapp/coexistence/relay-scope';
import { readCappedBytes } from '@/lib/whatsapp/webhook-body';
import {
  parseAppSecrets,
  verifyTokenMatches,
} from '@/lib/whatsapp/webhook-signature';

export const runtime = 'nodejs';

const path = '/api/whatsapp/coexistence/receiver-stop';
const noStore = { 'Cache-Control': 'no-store' };
const hex = /^[0-9a-f]{64}$/;
const resourceId = z.string().regex(/^[1-9][0-9]{0,31}$/);
const coordinate = z.number().int().min(0).max(999);

const projection = z.strictObject({
  version: z.literal(1),
  app_id: resourceId,
  waba_id: resourceId,
  phone_number_id: resourceId,
  kind: z.enum([
    'ACCOUNT_OFFBOARDED',
    'PARTNER_REMOVED',
    'PARTNER_APP_UNINSTALLED',
  ]),
  source_sha256: z.string().regex(hex),
  entry_index: coordinate,
  change_index: coordinate,
});

function failure(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: noStore });
}

function isJson(headers: Headers): boolean {
  return /^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/i.test(
    headers.get('content-type') ?? ''
  );
}

export async function POST(request: Request): Promise<Response> {
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(3000)]);
  const url = new URL(request.url);

  if (url.href !== `${url.origin}${path}`) return failure(404, 'Not found');

  const key = process.env.WHATSAPP_COEXISTENCE_RECEIVER_STOP_KEY;
  const dbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const scope = readRelayScope(
    process.env.WHATSAPP_COEXISTENCE_APP_ID ?? null,
    process.env.WHATSAPP_COEXISTENCE_PARTNER_BUSINESS_ID ?? null
  );

  const knownSecrets = [
    ...parseAppSecrets(process.env.META_APP_SECRET),
    process.env.WHATSAPP_COEXISTENCE_APP_SECRET,
    process.env.AUTOMATION_CRON_SECRET,
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    process.env.ENCRYPTION_KEY,
    serviceKey,
  ];

  if (
    process.env.WHATSAPP_COEXISTENCE_ENABLED !== 'true' ||
    !key ||
    !hex.test(key) ||
    knownSecrets.some((secret) => secret?.trim() === key) ||
    !scope.success ||
    new Set(Object.values(scope.data)).size !== 4 ||
    !dbUrl ||
    !serviceKey
  )
    return failure(503, 'Receiver stop unavailable');

  const { headers } = request;

  const bearer = /^Bearer ([0-9a-f]{64})$/.exec(
    headers.get('authorization') ?? ''
  );

  if (
    !bearer ||
    !verifyTokenMatches(key, bearer[1]) ||
    [
      'cookie',
      'origin',
      'sec-fetch-site',
      'x-hub-signature',
      'x-hub-signature-256',
      'x-cron-secret',
      'x-api-key',
      'apikey',
    ].some((name) => headers.has(name))
  )
    return failure(401, 'Unauthorized');

  if (!isJson(headers)) return failure(415, 'Expected JSON');

  let payload: z.infer<typeof projection>;

  try {
    const bytes = await readCappedBytes(request, 1024, signal);

    if (bytes === null) return failure(413, 'Payload too large');

    const text = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);

    payload = projection.parse(JSON.parse(text));

    // JSON.parse collapses duplicate names. A valid flat projection has one colon per member.
    if (
      text.replace(/"(?:[^"\\]|\\.)*"/g, '').split(':').length !==
      Object.keys(payload).length + 1
    )
      return failure(400, 'Invalid receiver stop');
  } catch {
    return signal.aborted
      ? failure(503, 'Receiver stop unavailable')
      : failure(400, 'Invalid receiver stop');
  }

  if (
    payload.app_id !== scope.data.app ||
    payload.waba_id !== scope.data.waba ||
    payload.phone_number_id !== scope.data.phone
  )
    return failure(403, 'Receiver stop scope mismatch');

  try {
    signal.throwIfAborted();

    const db = createClient(dbUrl, serviceKey, {
      accessToken: async () => serviceKey,
      global: {
        fetch: async (input, init) => {
          const response = await fetch(input, {
            ...init,
            redirect: 'error',
            credentials: 'omit',
            cache: 'no-store',
          });

          // Check the wire status before PostgREST can normalize it.
          if (response.status !== 200 || !isJson(response.headers)) {
            void response.body?.cancel().catch(() => {});
            throw new Error('Unconfirmed receiver stop');
          }

          const bytes = await readCappedBytes(response, 1024, signal);
          const receipt = bytes?.toString('utf8');

          if (
            !receipt ||
            !/^[\x20\t\r\n]*\{[\x20\t\r\n]*"status"[\x20\t\r\n]*:[\x20\t\r\n]*"blocked"[\x20\t\r\n]*\}[\x20\t\r\n]*$/.test(
              receipt
            )
          )
            throw new Error('Unconfirmed receiver stop');

          return new Response(receipt, { headers: response.headers });
        },
      },
    });

    const { error, status } = await db
      .schema('public')
      .rpc('coexistence_receiver_stop', {
        p_app_id: scope.data.app,
        p_waba_id: scope.data.waba,
        p_phone_number_id: scope.data.phone,
        p_kind: payload.kind,
        p_source_sha256: payload.source_sha256,
        p_entry_index: payload.entry_index,
        p_change_index: payload.change_index,
      })
      .retry(false)
      .abortSignal(signal);

    if (!error && status === 200 && !signal.aborted)
      return Response.json({ status: 'blocked' }, { headers: noStore });
  } catch {
    // Do not expose upstream errors or request details.
  }

  return failure(503, 'Receiver stop unavailable');
}
