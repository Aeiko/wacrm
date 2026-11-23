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
  if (process.env.WHATSAPP_MEMBER_LAUNCH_PREVIEW === 'true') return signupError(404);

  if (!hasSignupCookieCredentials(request)) return signupError(401);

  try {
    const origin = process.env.NEXT_PUBLIC_SITE_URL;

    if (!origin || new URL(origin).origin !== origin || !origin.startsWith('https://'))
      return signupError(503);

    return await memberSignup(
      request,
      await createClient(),
      undefined,
      reviewMemberReceiver,
      reviewMemberAppRouting,
      origin
    );
  } catch {
    return signupError(503);
  }
}

export { handle as GET, handle as POST };
