import { createClient } from '@/lib/supabase/server';
import {
  hasSignupCookieCredentials,
  signupError,
} from '@/lib/whatsapp/coexistence/signup';
import { memberSignup } from '@/lib/whatsapp/coexistence/member-signup';

async function handle(request: Request) {
  if (!hasSignupCookieCredentials(request)) return signupError(401);

  try {
    return await memberSignup(request, await createClient());
  } catch {
    return signupError(503);
  }
}

export { handle as GET, handle as POST };
