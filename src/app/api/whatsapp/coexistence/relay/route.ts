import { createClient } from '@supabase/supabase-js';
import { captureCoexistenceWebhook } from '@/lib/whatsapp/coexistence/intake';
import { readCappedBytes } from '@/lib/whatsapp/webhook-body';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  let bytes;

  try {
    bytes = await readCappedBytes(request);
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (bytes === null)
    return Response.json({ error: 'Payload too large' }, { status: 413 });

  let body;

  try {
    // Keep any BOM so that JSON parsing rejects it; never change signed bytes.
    body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes
    );
  } catch {
    return Response.json({ error: 'Invalid UTF-8' }, { status: 400 });
  }

  try {
    const db = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      {
        auth: { persistSession: false, autoRefreshToken: false },
        db: { timeout: 15_000 },
      }
    );

    const response = await captureCoexistenceWebhook(
      body,
      request.headers.get('x-hub-signature-256'),
      db,
      'relay'
    );

    if (response instanceof Response) return response;
  } catch {
    // Never expose upstream errors, credentials or payload.
  }

  return Response.json(
    { error: 'Coexistence relay unavailable' },
    { status: 503 }
  );
}
