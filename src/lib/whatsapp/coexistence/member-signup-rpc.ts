import { request } from 'node:http';
import { z } from 'zod';
import { signupPhoneSchema } from './signup-contract';

const endpoint = 'http://127.0.0.1:3904/rpc/coexistence_member_signup';
const profile = 'member_signup_private';
const role = 'member_signup_runtime';
const id = z.string().regex(/^[1-9]\d{0,31}$/);
const pins = { app_id: id, login_config_id: id, partner_id: id };
const state = { ...pins, state: z.uuid() };
const selection = { ...state, waba_id: id, phone_number_id: id };

const payloads = {
  inspect: z.strictObject({}),
  launch: z.strictObject({ ...pins, intended_phone: signupPhoneSchema }),
  exchange_start: z.strictObject({
    ...state,
    code_hash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  exchange_authorized: z.strictObject(state),
  verify: z.strictObject({
    ...selection,
    normalized_phone_number: signupPhoneSchema,
    token_expires_at: z.iso.datetime({ offset: true }),
    access_token: z.string().max(16_384).regex(/^[a-f0-9]{24}:([a-f0-9]{2})+:[a-f0-9]{32}$/),
  }),
  confirm: z.strictObject(selection),
  activation_read: z.strictObject(selection),
  activation_abort: z.strictObject(selection),
  activate: z.strictObject({ ...selection, normalized_phone_number: signupPhoneSchema }),
};

const results = {
  inspect: z.strictObject({ status: z.enum(['available', 'pending', 'linked']) }),
  launch: z.strictObject({ status: z.literal('launch_authorized'), state: z.uuid(), expires_at: z.iso.datetime({ offset: true }) }),
  exchange_start: z.strictObject({ status: z.literal('started'), dispatch: z.literal(true), intended_phone: signupPhoneSchema }),
  exchange_authorized: z.strictObject({ status: z.literal('authorized') }),
  verify: z.strictObject({ status: z.literal('verified') }),
  confirm: z.strictObject({ status: z.literal('confirmed') }),
  activation_read: z.strictObject({
    status: z.literal('activation_ready'),
    access_token: z.string().max(16_384).regex(/^[a-f0-9]{24}:([a-f0-9]{2})+:[a-f0-9]{32}$/),
    token_expires_at: z.iso.datetime({ offset: true }),
    normalized_phone_number: signupPhoneSchema,
  }).or(z.strictObject({ status: z.literal('activated') })),
  activation_abort: z.strictObject({ status: z.literal('activation_aborted') }),
  activate: z.strictObject({ status: z.literal('activated') }),
};

const negative = z.strictObject({
  status: z.enum(['invalid', 'forbidden', 'busy', 'conflict', 'expired', 'blocked', 'duplicate']),
});

const identity = z.strictObject({ p_actor_id: z.uuid(), p_session_id: z.uuid(), p_account_id: z.uuid() });
const claims = z.object({ aud: z.literal(profile), role: z.literal(role), exp: z.number().int() });

function capability() {
  const value = process.env.WHATSAPP_MEMBER_SIGNUP_RPC_TOKEN ?? '';

  if (value.length > 2048 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(value))
    throw new Error();

  const parsed = claims.parse(JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString('utf8')));

  if (parsed.exp <= Date.now() / 1000) throw new Error();

  return value;
}

export async function memberSignupRpc<Action extends keyof typeof payloads>(
  actor: z.input<typeof identity>,
  action: Action,
  payload: z.input<(typeof payloads)[Action]>,
  signal: AbortSignal
) {
  try {
    const body = JSON.stringify({
      ...identity.parse(actor),
      p_action: action,
      p_payload: payloads[action].parse(payload),
    });

    const authorization = `Bearer ${capability()}`;
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(7_000)]);

    deadline.throwIfAborted();

    // One direct HTTP request; no proxy agent, redirect, retry, or Next fetch tracing.
    const value = await new Promise<unknown>((resolve, reject) => {
      const outgoing = request(endpoint, {
        agent: false,
        method: 'POST',
        signal: deadline,
        maxHeaderSize: 8192,
        headers: {
          authorization,
          accept: 'application/json',
          'content-profile': profile,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      }, (incoming) => {
        incoming.on('error', reject);

        if (incoming.statusCode !== 200 || incoming.headers['content-type']?.split(';')[0] !== 'application/json') {
          incoming.destroy();

          return reject(new Error());
        }

        const chunks: Buffer[] = [];
        let size = 0;

        incoming.on('data', (chunk: Buffer) => {
          size += chunk.length;

          if (size > (action === 'activation_read' ? 17_408 : 1024)) {
            incoming.destroy();
            reject(new Error());
          } else {
            chunks.push(chunk);
          }
        });
        incoming.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            reject(new Error());
          }
        });
      });

      outgoing.on('error', reject);
      outgoing.end(body);
    });

    deadline.throwIfAborted();

    return z.union([results[action], negative]).parse(value);
  } catch {
    throw new Error('Member signup RPC unavailable');
  }
}
