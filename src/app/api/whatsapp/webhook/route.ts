import { postOutcomes } from '@/lib/whatsapp/coexistence/post-outcomes';
import { NextResponse, after } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  verifyMetaWebhookSignature,
  verifyTokenMatches,
} from '@/lib/whatsapp/webhook-signature';
import { readCappedBytes } from '@/lib/whatsapp/webhook-body';
import { captureCoexistenceWebhook } from '@/lib/whatsapp/coexistence/intake';
import {
  legacyWebhookSchema,
  processLegacyWebhook,
  type LegacyWebhookEnvelope,
} from '@/lib/whatsapp/coexistence/legacy';

// The `after()` callback in POST runs within this route's max duration.
// Inbound processing can fan out to per-media Meta verification calls, so
// give it headroom beyond the platform default (Vercel clamps this to the
// plan's ceiling). Tune as needed.
export const maxDuration = 60;

// Lazy-initialized to avoid build-time crash when env vars are missing
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null;

function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }

  return _adminClient;
}

function dedicatedReceiver(): boolean {
  const mode = process.env.WHATSAPP_COEXISTENCE_DEDICATED_RECEIVER;

  return mode !== undefined && mode !== 'false';
}

function challengeResponse(challenge: string): Response {
  return new Response(challenge, {
    headers: { 'Content-Type': 'text/plain' },
  });
}

// GET - Webhook verification
export async function GET(request: Request) {
  try {
    const { search, searchParams } = new URL(request.url);
    const dedicated = dedicatedReceiver();
    const mode = searchParams.get('hub.mode');
    const challenge = searchParams.get('hub.challenge');
    const verifyToken = searchParams.get('hub.verify_token');

    if (
      dedicated &&
      (search.length > 4096 ||
        /%(?![A-Fa-f0-9]{2})/.test(search) ||
        ['hub.mode', 'hub.challenge', 'hub.verify_token'].some(
          (key) => searchParams.getAll(key).length !== 1
        ) ||
        challenge === verifyToken ||
        (challenge !== null &&
          (challenge.length > 256 || challenge.trim() !== challenge)) ||
        [...searchParams].some(
          ([key, value]) =>
            !key || /[^A-Za-z0-9._-]/.test(key) || /[^ -~]|[<>]/.test(value)
        ))
    )
      return NextResponse.json(
        { error: 'Invalid verification parameters' },
        { status: 400 }
      );

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json(
        { error: 'Missing verification parameters' },
        { status: 400 }
      );
    }

    // Meta must verify the app callback before the first owner can connect.
    const appVerifyToken =
      process.env.WHATSAPP_COEXISTENCE_WEBHOOK_VERIFY_TOKEN;

    if (
      (!dedicated ||
        process.env.WHATSAPP_COEXISTENCE_DEDICATED_RECEIVER === 'true') &&
      process.env.WHATSAPP_COEXISTENCE_ENABLED === 'true' &&
      /^[1-9]\d{0,31}$/.test(process.env.WHATSAPP_COEXISTENCE_APP_ID ?? '') &&
      appVerifyToken &&
      verifyTokenMatches(appVerifyToken, verifyToken)
    )
      return dedicated
        ? new Response(challenge, {
            headers: {
              'Content-Type': 'text/plain; charset=utf-8',
              'X-Content-Type-Options': 'nosniff',
              'Cache-Control': 'no-store',
            },
          })
        : challengeResponse(challenge);

    if (dedicated)
      return NextResponse.json(
        { error: 'Verification token mismatch' },
        { status: 403 }
      );

    // Fetch all whatsapp configs to check verify tokens
    const { data: configs, error: configError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('id, verify_token');

    if (configError || !configs) {
      console.error('Error fetching configs for verification:', configError);

      return NextResponse.json(
        { error: 'Verification failed' },
        { status: 403 }
      );
    }

    // Verification is read-only; credential replacement belongs to gated setup.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let matchedConfig: any = null;

    for (const config of configs) {
      if (!config.verify_token) continue;

      try {
        if (verifyTokenMatches(decrypt(config.verify_token), verifyToken)) {
          matchedConfig = config;
          break;
        }
      } catch {
        // Malformed / wrong-key token row — skip it and keep checking.
      }
    }

    if (matchedConfig) return challengeResponse(challenge);

    return NextResponse.json(
      { error: 'Verification token mismatch' },
      { status: 403 }
    );
  } catch (error) {
    console.error('Error in webhook GET verification:', error);

    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

const dedicatedPostOutcomes = new Map<
  number,
  Parameters<typeof postOutcomes.count>[0]
>([
  [200, 'committed'],
  [400, 'invalid_delivery'],
  [401, 'auth_rejected'],
  [403, 'invalid_delivery'],
  [413, 'invalid_delivery'],
]);

function countDedicatedPost(status: number) {
  postOutcomes.count(dedicatedPostOutcomes.get(status) ?? 'storage_failure');
}

// POST - Receive messages
export async function POST(request: Request) {
  const dedicated = dedicatedReceiver();

  if (dedicated) postOutcomes.count('seen');

  // Read raw body first so we can HMAC-verify the exact bytes Meta
  // signed. request.json() would re-encode and break the signature.
  const bytes = await readCappedBytes(request);

  if (bytes === null) {
    if (dedicated) countDedicatedPost(413);
    console.warn('[webhook] rejected oversized payload');

    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }

  let rawBody: string;

  try {
    // Never replace malformed bytes or strip a BOM before signature checking.
    rawBody = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes
    );
  } catch {
    if (dedicated) countDedicatedPost(400);

    return NextResponse.json({ error: 'Invalid UTF-8' }, { status: 400 });
  }

  const signature = request.headers.get('x-hub-signature-256');

  if (dedicated) {
    const result =
      process.env.WHATSAPP_COEXISTENCE_DEDICATED_RECEIVER === 'true'
        ? await captureCoexistenceWebhook(rawBody, signature, 'dedicated')
        : null;

    const response =
      result instanceof Response
        ? result
        : Response.json(
            { error: 'Dedicated receiver unavailable' },
            { status: 503 }
          );

    countDedicatedPost(response.status);

    return response;
  }

  let legacy;

  try {
    const captured = await captureCoexistenceWebhook(
      rawBody,
      signature,
      supabaseAdmin()
    );

    if (captured instanceof Response) return captured;
    legacy = captured?.legacy;
  } catch {
    return NextResponse.json(
      { error: 'Webhook capture unavailable' },
      { status: 503 }
    );
  }

  if (!verifyMetaWebhookSignature(rawBody, signature)) {
    // 401 (not 200) — we want Meta's delivery dashboard to show failures
    // loudly if a misconfiguration causes signatures to stop matching,
    // rather than silently eating events.
    console.warn('[webhook] rejected request with invalid signature');

    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let body: LegacyWebhookEnvelope;

  try {
    body = legacyWebhookSchema.parse(legacy ?? JSON.parse(rawBody));
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Process AFTER the response so we ack Meta within their ~20s timeout
  // (a slow ack triggers Meta retries + duplicate inserts), while still
  // guaranteeing the work runs to completion.
  //
  // This MUST use `after()` rather than a detached `processLegacyWebhook(body)`
  // promise: on serverless platforms (we run on Vercel) the function can
  // be frozen or terminated the moment the response is sent, so a floating
  // promise's DB writes are not guaranteed to finish. That dropped a
  // non-deterministic *subset* of inbound messages — contacts/conversations
  // were created but the message insert never landed, leaving conversations
  // that show in the inbox with an empty thread, and no logs to explain it
  // (see issue #301). `after()` hands the callback to the runtime, which
  // keeps the function alive until it resolves (within the route's
  // maxDuration).
  after(async () => {
    try {
      await processLegacyWebhook(body);
    } catch (error) {
      console.error('Error processing webhook:', error);
    }
  });

  return NextResponse.json({ status: 'received' }, { status: 200 });
}
