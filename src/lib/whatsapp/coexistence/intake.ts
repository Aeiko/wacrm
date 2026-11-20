import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { postPrivateIngress } from './private-ingress';
import { MAX_WEBHOOK_BODY_BYTES } from '../webhook-body';
import {
  parseAppSecrets,
  verifyMetaWebhookSignature,
} from '../webhook-signature';
import { readRelayScope, isScopedRelayChange } from './relay-scope';
import { isTemplateWebhookField } from '../template-webhook';
import { jsonSchema, coexistenceFields, type JsonValue } from './payload';

const envelopeSchema = z.looseObject({
  entry: z.array(jsonSchema).max(1000).default([]),
});

const entrySchema = z.looseObject({
  id: jsonSchema.optional(),
  changes: z.array(jsonSchema),
});

const changeSchema = z.object({
  field: jsonSchema.optional(),
  value: jsonSchema.optional(),
});

const MAX_WEBHOOK_CHANGES = 1000;

const dedicatedEnvelopeSchema = z.strictObject({
  object: z.literal('whatsapp_business_account'),
  entry: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[1-9][0-9]{0,31}$/),
        time: z.int().nonnegative().optional(),
        changes: z
          .array(
            z.strictObject({
              field: z
                .string()
                .refine(
                  (field) =>
                    field === 'messages' || coexistenceFields.has(field)
                ),
              value: z.record(z.string(), jsonSchema),
            })
          )
          .min(1)
          .max(MAX_WEBHOOK_CHANGES),
      })
    )
    .min(1)
    .max(MAX_WEBHOOK_CHANGES),
});

const resultSchema = z.object({
  status: z.union([
    z.literal(200),
    z.literal(400),
    z.literal(401),
    z.literal(403),
    z.literal(503),
  ]),
  legacy_indices: z.array(z.number().int().nonnegative()),
  captured: z.number().int().nonnegative(),
  staged: z.number().int().nonnegative(),
});

const strictResultSchema = resultSchema.strict();
const strictChangeSchema = changeSchema.strict();

function signatureMatches(
  rawBody: string,
  signature: string | null,
  secret: string
): boolean {
  if (!signature || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) return false;

  return timingSafeEqual(
    Buffer.from(signature.slice(7), 'hex'),
    createHmac('sha256', secret).update(rawBody).digest()
  );
}

function failure(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

/** SQL selects lanes; any legacy continuation must still authenticate the original body. */
export async function captureCoexistenceWebhook(
  rawBody: string,
  signature: string | null,
  db: SupabaseClient | 'dedicated',
  mode?: 'relay'
): Promise<Response | null | { status: 200; legacy: JsonValue }> {
  const dedicated = db === 'dedicated';
  const configuredAppId = process.env.WHATSAPP_COEXISTENCE_APP_ID;

  const appId =
    configuredAppId && /^[1-9]\d{0,31}$/.test(configuredAppId)
      ? configuredAppId
      : null;

  const configuredPartnerId =
    process.env.WHATSAPP_COEXISTENCE_PARTNER_BUSINESS_ID;

  const partnerId =
    configuredPartnerId && /^[1-9]\d{0,31}$/.test(configuredPartnerId)
      ? configuredPartnerId
      : null;

  const secret = process.env.WHATSAPP_COEXISTENCE_APP_SECRET;
  const enabled = process.env.WHATSAPP_COEXISTENCE_ENABLED === 'true';

  const scope = mode === 'relay' ? readRelayScope(appId, partnerId) : null;

  if (
    scope &&
    (!scope.success ||
      !enabled ||
      !secret ||
      secret.trim() !== secret ||
      secret.includes(',') ||
      parseAppSecrets(process.env.META_APP_SECRET).includes(secret))
  )
    return failure(503, 'Coexistence relay unavailable');

  if (
    dedicated &&
    (!enabled ||
      !appId ||
      !secret ||
      secret.trim() !== secret ||
      secret.includes(','))
  )
    return failure(503, 'Dedicated receiver unavailable');

  if (Buffer.byteLength(rawBody, 'utf8') > MAX_WEBHOOK_BODY_BYTES)
    return failure(413, 'Payload too large');

  const authorized = Boolean(
    appId && secret && signatureMatches(rawBody, signature, secret)
  );

  if ((scope || dedicated) && !authorized)
    return failure(401, 'Invalid signature');

  let body;

  try {
    const parsed: unknown = JSON.parse(rawBody);

    body = dedicated
      ? dedicatedEnvelopeSchema.parse(parsed)
      : envelopeSchema.parse(jsonSchema.parse(parsed));
  } catch {
    return failure(400, 'Invalid webhook JSON');
  }

  if (
    scope &&
    (!body.entry.length ||
      Object.keys(body).some((key) => key !== 'entry' && key !== 'object') ||
      (body.object !== undefined &&
        body.object !== 'whatsapp_business_account'))
  )
    return failure(400, 'Invalid relay envelope');

  const bodyHash = createHash('sha256').update(rawBody).digest('hex');

  const changes: {
    entry_id: string | null;
    field: string;
    value: JsonValue;
    dedupe_key: string;
    invalid?: true;
  }[] = [];

  for (const [entryIndex, rawEntry] of body.entry.entries()) {
    const entry = entrySchema.safeParse(rawEntry);
    const entryId = z.string().safeParse(entry.success ? entry.data.id : null);

    const invalidEntry =
      !entry.success ||
      (entry.data.id !== undefined &&
        entry.data.id !== null &&
        !entryId.success);

    if (
      scope &&
      (!entry.success ||
        !entry.data.changes.length ||
        (entry.data.time !== undefined &&
          !Number.isSafeInteger(entry.data.time)) ||
        Object.keys(entry.data).some(
          (key) => key !== 'id' && key !== 'changes' && key !== 'time'
        ))
    )
      return failure(400, 'Invalid relay entry');

    const siblings = entry.success ? entry.data.changes : [null];

    // Preserve a malformed empty entry beside valid authoritative siblings.
    if (invalidEntry && !siblings.length) siblings.push(null);

    for (const [changeIndex, rawChange] of siblings.entries()) {
      if (changes.length === MAX_WEBHOOK_CHANGES)
        return failure(400, 'Too many webhook changes');

      const change = (scope ? strictChangeSchema : changeSchema).safeParse(
        rawChange
      );

      const field = z
        .string()
        .min(1)
        .safeParse(change.success ? change.data.field : null);

      const descriptor: (typeof changes)[number] = {
        entry_id: entryId.success ? entryId.data : null,
        field: field.success ? field.data : '',
        value: change.success ? (change.data.value ?? null) : null,
        dedupe_key: `${bodyHash}:${entryIndex}:${changeIndex}`,
      };

      if (
        invalidEntry ||
        !change.success ||
        !field.success ||
        change.data.value === undefined
      )
        descriptor.invalid = true;

      if (
        scope?.success &&
        (descriptor.invalid ||
          !isScopedRelayChange(
            descriptor.entry_id,
            descriptor.field,
            descriptor.value,
            scope.data
          ))
      )
        return failure(400, 'Invalid or out-of-scope relay change');

      changes.push(descriptor);
    }
  }

  // Ingress can lock business resources, so authenticate before crossing the SQL boundary.
  if (!authorized && !verifyMetaWebhookSignature(rawBody, signature))
    return failure(401, 'Invalid signature');

  const args = {
    p_app_id: appId,
    p_partner_business_id: partnerId,
    p_enabled: enabled,
    p_authorized: authorized,
    p_changes: changes,
  };

  let result;

  try {
    if (dedicated) {
      result = strictResultSchema.safeParse(await postPrivateIngress(args));
    } else {
      const {
        data,
        error,
        status: rpcStatus,
      } = await db.rpc('coexistence_ingress', args).retry(false);

      if (error || (scope && rpcStatus !== 200))
        return failure(503, 'Coexistence ingress unavailable');

      result = (scope ? strictResultSchema : resultSchema).safeParse(data);
    }
  } catch {
    return failure(503, 'Coexistence ingress unavailable');
  }

  if (!result.success)
    return failure(503, 'Invalid coexistence ingress result');

  const { status, legacy_indices: indices } = result.data;

  if (scope || dedicated) {
    if (status !== 200) return failure(status, 'Coexistence ingress rejected');

    if (indices.length || !changes.length)
      return failure(503, 'Invalid coexistence ingress result');

    return Response.json({ status: dedicated ? 'received' : 'captured' });
  }

  const selected = new Set(indices);

  if (
    selected.size !== indices.length ||
    indices.some((index) => index >= changes.length || changes[index].invalid)
  )
    return failure(503, 'Invalid coexistence ingress result');

  // A bad SQL receipt must not expose private changes to the field-agnostic legacy parser.
  for (const index of indices) {
    const { field, value } = changes[index];

    if (coexistenceFields.has(field) || field.startsWith('smb_'))
      return failure(503, 'Invalid coexistence ingress result');

    if (field === 'messages' || isTemplateWebhookField(field)) continue;

    const content = z.record(z.string(), jsonSchema).safeParse(value);

    if (
      content.success &&
      (Object.hasOwn(content.data, 'messages') ||
        Object.hasOwn(content.data, 'statuses'))
    )
      return failure(503, 'Invalid coexistence ingress result');
  }

  if (status !== 200) return failure(status, 'Coexistence ingress rejected');

  if (indices.length === changes.length) return null;

  if (!indices.length) return Response.json({ status: 'received' });

  const selectedKeys = new Set(
    indices.map((index) => changes[index].dedupe_key)
  );

  const legacy = jsonSchema.parse({
    ...body,
    entry: body.entry.flatMap((rawEntry, entryIndex) => {
      const entry = entrySchema.safeParse(rawEntry);

      if (!entry.success) return [];

      const legacyChanges = entry.data.changes.filter((_, index) =>
        selectedKeys.has(`${bodyHash}:${entryIndex}:${index}`)
      );

      return legacyChanges.length
        ? [{ ...entry.data, changes: legacyChanges }]
        : [];
    }),
  });

  return { status: 200, legacy };
}
