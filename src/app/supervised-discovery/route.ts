import { createClient } from '@/lib/supabase/server';
import {
  hasSignupCookieCredentials,
  signupError,
} from '@/lib/whatsapp/coexistence/signup';
import { memberSignup } from '@/lib/whatsapp/coexistence/member-signup';
import {
  reviewMemberAppRouting,
  reviewMemberReceiver,
} from '@/lib/whatsapp/coexistence/member-receiver-review';

async function handle(request: Request) {
  if (!hasSignupCookieCredentials(request)) return signupError(401);

  try {
    return await memberSignup(
      request,
      await createClient(),
      undefined,
      reviewMemberReceiver,
      reviewMemberAppRouting
    );
  } catch {
    return signupError(503);
  }
}

export { handle as GET, handle as POST };
