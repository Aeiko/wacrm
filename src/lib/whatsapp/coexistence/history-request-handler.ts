import { z } from 'zod';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';
import { deadlineFetch, withRequestDeadline } from '@/lib/request-deadline';
import {
  connectionHeaders,
  connectionServiceClient,
} from '../connection-operation';
import {
  initiateCoexistenceSync,
  type CoexistenceFetch,
} from '../coexistence-meta';
import { decrypt } from '../encryption';
import { readCappedBytes } from '../webhook-body';
import { historyRequestStatusSchema } from './history-request-contract';
import { readHistoryRequestOwner } from './history-request-owner';

const resourceId = z.string().regex(/^[1-9][0-9]{0,31}$/);

const pinsSchema = z
  .tuple([resourceId, resourceId, resourceId])
  .refine((ids) => new Set(ids).size === ids.length);

const canonicalUuid = z.uuid().refine((id) => id.toLowerCase() === id);

const formSchema = z.strictObject({
  context: z.string().regex(/^[0-9a-f]{64}$/),
  decision_id: canonicalUuid,
  request_id: canonicalUuid,
  confirmation: z.literal('history-now-v1'),
});

const receiptSchema = z.discriminatedUnion('dispatch', [
  z.strictObject({ dispatch: z.literal(false) }),
  z.strictObject({
    dispatch: z.literal(true),
    request_id: canonicalUuid,
    phone_number_id: resourceId,
    deadline_at: z.iso.datetime({ offset: true }),
    encrypted_token: z.string().min(1).max(16_384),
  }),
]);

const headers = { ...connectionHeaders, 'Referrer-Policy': 'no-referrer' };
const unavailable = { state: 'unavailable' };

function respond(status: number) {
  return Response.json(unavailable, { status, headers });
}

function seeStatus() {
  return new Response(null, {
    status: 303,
    headers: { ...headers, Location: '/history-request' },
  });
}

async function readForm(request: Request, signal: AbortSignal) {
  if (
    !/^application\/x-www-form-urlencoded(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/i.test(
      request.headers.get('content-type') ?? ''
    )
  )
    return respond(400);

  try {
    const bytes = await readCappedBytes(request, 1024, signal);

    if (!bytes) return respond(413);

    const fields = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      .decode(bytes)
      .split('&')
      .map((field) =>
        field
          .split('=')
          .map((part) => decodeURIComponent(part.replaceAll('+', ' ')))
      );

    if (fields.length !== 4 || fields.some((field) => field.length !== 2))
      return respond(400);

    return formSchema.parse(Object.fromEntries(fields));
  } catch {
    signal.throwIfAborted();

    return respond(400);
  }
}

function reviewExpiry(value: string) {
  const expires = Date.parse(value);
  const now = Date.now();

  return expires > now && expires <= now + 24 * 60 * 60 * 1000 ? expires : null;
}

export function historyRequestHandlers(transport: CoexistenceFetch) {
  async function handle(request: Request, submitting: boolean) {
    if (
      process.env.WHATSAPP_COEXISTENCE_ENABLED !== 'true' ||
      process.env.WHATSAPP_COEXISTENCE_HISTORY_REQUEST_ENABLED !== 'true'
    )
      return respond(404);

    const pins = pinsSchema.safeParse([
      process.env.WHATSAPP_COEXISTENCE_APP_ID,
      process.env.WHATSAPP_COEXISTENCE_RELAY_WABA_ID,
      process.env.WHATSAPP_COEXISTENCE_RELAY_PHONE_ID,
    ]);

    if (!pins.success) return respond(404);
    const [app, waba, phone] = pins.data;
    const url = new URL(request.url);
    const site = request.headers.get('sec-fetch-site');

    if (url.search) return respond(400);

    if (
      submitting &&
      (request.headers.get('origin') !== url.origin ||
        (site !== null && site !== 'same-origin'))
    )
      return respond(403);

    const lane = submitting ? 'submit' : 'inspect';
    const windowMs = 60_000;

    if (
      !checkRateLimit(`history-request:${lane}:ip:${getClientIp(request)}`, {
        limit: 60,
        windowMs,
      }).success
    )
      return respond(429);

    const deadline = Date.now() + 15_000;

    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(15_000),
    ]);

    let confirmedStart = false;

    try {
      return await withRequestDeadline(
        deadline,
        async () => {
          const command = submitting ? await readForm(request, signal) : null;

          if (command instanceof Response) return command;

          const owner = await readHistoryRequestOwner(request);
          signal.throwIfAborted();

          if (!owner) return respond(401);

          if (
            !checkRateLimit(`history-request:${lane}:actor:${owner.actor}`, {
              limit: submitting ? 5 : 20,
              windowMs,
            }).success
          )
            return respond(429);

          const db = connectionServiceClient((input, init) => {
            const bytes = new TextEncoder().encode(
              z.string().parse(init?.body)
            );

            // A non-replayable body also prevents Fetch's automatic HTTP 421 replay.
            const options = {
              ...init,
              cache: 'no-store',
              redirect: 'error',
              duplex: 'half',
              body: new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(bytes);
                  controller.close();
                },
              }),
            } satisfies RequestInit & { duplex: 'half' };

            return deadlineFetch(input, options);
          });

          const args = {
            p_actor_id: owner.actor,
            p_session_id: owner.session,
            p_app_id: app,
            p_waba_id: waba,
            p_phone_id: phone,
          };

          async function rpc<T>(
            name: string,
            params: Record<string, string>,
            schema: z.ZodType<T>
          ) {
            signal.throwIfAborted();

            const { data, error } = await db
              .rpc(name, params)
              .retry(false)
              .abortSignal(signal);

            if (error) throw new Error('History RPC unavailable');

            return schema.parse(data);
          }

          if (!command) {
            const status = await rpc(
              'coexistence_history_request_status',
              args,
              historyRequestStatusSchema
            );

            signal.throwIfAborted();

            if (status.state === 'ready') {
              if (status.review.phone_id_suffix !== phone.slice(-4))
                return respond(503);

              if (!reviewExpiry(status.review.deadline_at)) return respond(200);
            }

            return Response.json(status, { headers });
          }

          const start = await rpc(
            'coexistence_history_request_start',
            {
              ...args,
              p_context: command.context,
              p_decision_id: command.decision_id,
              p_request_id: command.request_id,
            },
            receiptSchema
          );

          if (!start.dispatch) return respond(409);

          if (
            start.request_id !== command.request_id ||
            start.phone_number_id !== phone
          )
            return respond(503);

          confirmedStart = true;

          const expires = reviewExpiry(start.deadline_at);

          const sendBudget = Math.min(
            expires === null ? 0 : expires - Date.now(),
            deadline - Date.now() - 3_000
          );

          let outcome: 'accepted' | 'rejected' | 'ambiguous' | 'not_sent' =
            'not_sent';

          if (!signal.aborted && sendBudget > 0) {
            const { encrypted_token, ...receipt } = start;
            let accessToken: string | undefined;

            try {
              accessToken = decrypt(encrypted_token);
            } catch {
              // Invalid local credentials cannot have caused a send.
            }

            if (accessToken) {
              const result = await initiateCoexistenceSync(
                {
                  phoneNumberId: phone,
                  accessToken,
                  syncType: 'history',
                  historyReceipt: receipt,
                  signal: AbortSignal.any([
                    signal,
                    AbortSignal.timeout(sendBudget),
                  ]),
                },
                transport
              );

              outcome = result.outcome;
            }
          }

          await rpc(
            'coexistence_history_request_finish',
            { p_request_id: start.request_id, p_outcome: outcome },
            z.literal(true)
          );

          return seeStatus();
        },
        signal
      );
    } catch {
      // A lost/malformed start ACK never authorizes dispatch; a known start is never retried.
      return confirmedStart ? seeStatus() : respond(503);
    }
  }

  return {
    GET: (request: Request) => handle(request, false),
    POST: (request: Request) => handle(request, true),
  };
}
