import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';

const uuid = z.uuid();

/** Server-only (Next cookies). SQL must still verify the session and current account owner. */
export async function readHistoryRequestOwner(
  request: Request
): Promise<{ actor: string; session: string } | null> {
  if (
    !request.headers.get('cookie') ||
    request.headers.has('authorization') ||
    request.headers.has('apikey') ||
    request.headers.has('x-api-key') ||
    new URL(request.url).search
  )
    return null;

  try {
    const { auth } = await createClient();

    // Only take the token from SSR cookie storage. Both checks must use that same token.
    const stored = await auth.getSession();
    const token = stored.data.session?.access_token;

    if (stored.error || !token) return null;

    const verified = await auth.getUser(token);
    const actor = verified.data.user?.id;

    if (verified.error || !actor || !uuid.safeParse(actor).success) return null;

    const claims = await auth.getClaims(token);
    const session = claims.data?.claims.session_id;

    if (claims.error || claims.data?.claims.sub !== actor) return null;

    const parsed = uuid.safeParse(session);

    return parsed.success ? { actor, session: parsed.data } : null;
  } catch {
    return null;
  }
}
