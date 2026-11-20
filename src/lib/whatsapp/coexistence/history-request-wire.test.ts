import { Client } from 'undici';
import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  initiateCoexistenceSync,
  type CoexistenceFetch,
  type CoexistenceSyncOutcome,
} from '../coexistence-meta';

const receiptSchema = z.strictObject({
  dispatch: z.literal(true),
  request_id: z.guid(),
  phone_number_id: z.string().regex(/^[1-9][0-9]{0,31}$/),
  deadline_at: z.iso.datetime({ offset: true }),
});

const outcomeSchema = z.enum(['accepted', 'rejected', 'ambiguous', 'not_sent']);
const token = 'fixture-history-token';

type Outcome = CoexistenceSyncOutcome['outcome'] | 'not_sent';

function readReceipt(raw: string | undefined) {
  if (!raw) return;

  try {
    return receiptSchema.safeParse(JSON.parse(raw)).data;
  } catch {
    return undefined;
  }
}

async function sendClaimedHistory(): Promise<Outcome> {
  const receipt = readReceipt(process.env.WACRM_HISTORY_REQUEST_RECEIPT);

  if (!receipt) return 'not_sent';

  const deadline = Date.parse(receipt.deadline_at);

  if (!Number.isFinite(deadline) || Date.now() >= deadline) return 'not_sent';

  const stub = process.env.WACRM_HISTORY_REQUEST_STUB ?? '';

  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/?$/.test(stub)) {
    throw new Error('Expected a loopback-only history stub');
  }

  const phoneNumberId = receipt.phone_number_id;
  const path = `/v27.0/${phoneNumberId}/smb_app_data`;

  const signal = AbortSignal.timeout(
    Math.max(0, Math.min(deadline - Date.now(), 10_000))
  );

  // A fresh direct client avoids proxy settings, redirects, and fetch's implicit 421 retry.
  const client = new Client(new URL(stub).origin, {
    maxResponseSize: 64 * 1024,
  });

  let attempts = 0;
  let invalidWire = false;
  let dispatched = false;

  const transport: CoexistenceFetch = async (url, init) => {
    attempts++;
    const headers = new Headers(init.headers);

    if (
      attempts !== 1 ||
      url.href !== `https://graph.facebook.com${path}` ||
      init.method !== 'POST' ||
      init.redirect !== 'error' ||
      !init.signal ||
      headers.get('authorization') !== `Bearer ${token}` ||
      headers.get('content-type') !== 'application/json' ||
      init.body !== '{"messaging_product":"whatsapp","sync_type":"history"}'
    ) {
      invalidWire = true;
      throw new Error('Unexpected history request wire shape');
    }

    init.signal.throwIfAborted();

    if (Date.now() >= deadline) throw new Error('History deadline elapsed');

    dispatched = true;

    const { statusCode, body } = await client.request({
      path: url.pathname,
      method: init.method,
      headers: Object.fromEntries(headers),
      body: init.body,
      signal: init.signal,
      idempotent: false,
    });

    if (statusCode >= 300 && statusCode < 400) {
      throw new Error('History redirect refused');
    }

    const bytes = await body.arrayBuffer();

    return new Response(
      statusCode === 204 || statusCode === 205 ? null : bytes,
      {
        status: statusCode,
      }
    );
  };

  try {
    const result = await initiateCoexistenceSync(
      {
        phoneNumberId,
        accessToken: token,
        syncType: 'history',
        historyReceipt: receipt,
        signal,
      },
      transport
    );

    // The helper translates transport errors into ambiguity, including wire guard failures.
    expect(invalidWire, 'Unexpected history request wire shape').toBe(false);

    if (result.outcome === 'not_sent') {
      expect(dispatched).toBe(false);

      return 'not_sent';
    }

    if (dispatched) return result.outcome;

    expect(
      signal.aborted || Date.now() >= deadline,
      'History transport was not invoked'
    ).toBe(true);

    return 'not_sent';
  } finally {
    await client.destroy();
  }
}

// Run only via the parent's isolated Vitest config (envDir: false) and process environment.
it.skipIf(process.env.WACRM_HISTORY_REQUEST_EXPECT === undefined)(
  'dispatches history only with a fresh committed receipt',
  async () => {
    const expected = outcomeSchema.safeParse(
      process.env.WACRM_HISTORY_REQUEST_EXPECT
    );

    expect(expected.success, 'Invalid history rehearsal expectation').toBe(
      true
    );

    const outcome = await sendClaimedHistory();

    process.stdout.write(`HISTORY_REQUEST_OUTCOME ${outcome}\n`);
    expect(outcome).toBe(expected.data);
  },
  15_000
);
