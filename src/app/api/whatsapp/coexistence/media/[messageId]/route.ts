import { createClient } from '@/lib/supabase/server';
import { withRequestDeadline } from '@/lib/request-deadline';
import {
  privateMedia,
  privateMediaError,
} from '@/lib/whatsapp/coexistence/media';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ messageId: string }> }
) {
  const deadline = Date.now() + 25_000;

  try {
    return await withRequestDeadline(
      deadline,
      async () => {
        const { messageId } = await params;

        return privateMedia(request, messageId, await createClient(), deadline);
      },
      request.signal
    );
  } catch {
    return privateMediaError(503);
  }
}

// Explicit HEAD prevents Next's automatic HEAD from downloading a private body.
export function HEAD() {
  return privateMediaError(405);
}

export const POST = HEAD;
export const PUT = HEAD;
export const PATCH = HEAD;
export const DELETE = HEAD;
export const OPTIONS = HEAD;
