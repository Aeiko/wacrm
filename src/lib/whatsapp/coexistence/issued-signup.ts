import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { withRequestDeadline } from '@/lib/request-deadline';
import type { CoexistenceFetch } from '../coexistence-meta';
import {
  hasSignupCookieCredentials,
  signupError,
  verifiedSignupCookieIdentity,
} from './signup';
import {
  supervisedSignup,
  supervisedSignupInvitationSchema,
  type SupervisedSignupInvitation,
} from './supervised-signup';

const invitationsSchema = z.array(supervisedSignupInvitationSchema);

/** Private host only. Use a request-scoped SSR client reading this request's cookies. */
export async function findIssuedSignupInvitation(
  request: Request,
  db: SupabaseClient,
  invites: readonly SupervisedSignupInvitation[]
): Promise<SupervisedSignupInvitation | null> {
  if (!hasSignupCookieCredentials(request) || request.signal.aborted)
    return null;

  try {
    const documents = invitationsSchema.safeParse(invites);

    if (!documents.success || documents.data.length === 0) return null;

    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(10_000),
    ]);

    const identity = await withRequestDeadline(
      Date.now() + 10_000,
      () => verifiedSignupCookieIdentity(db, signal),
      signal
    );

    const matches = documents.data.filter(
      (invite) =>
        invite.actorId === identity.sub &&
        invite.sessionId === identity.session_id
    );

    return matches.length === 1 ? matches[0] : null;
  } catch {
    return null;
  }
}

export async function issuedSignup(
  request: Request,
  db: SupabaseClient,
  invites: readonly SupervisedSignupInvitation[],
  transport: CoexistenceFetch
): Promise<Response> {
  const invitation = await findIssuedSignupInvitation(request, db, invites);

  return invitation
    ? supervisedSignup(request, db, invitation, transport)
    : signupError(401);
}
