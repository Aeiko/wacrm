import { createClient } from '@/lib/supabase/server';
import { signupError, signupPost } from '@/lib/whatsapp/coexistence/signup';

export async function POST(
  request: Request,
  context: { params: Promise<{ attemptId: string }> }
) {
  try {
    const { attemptId } = await context.params;

    return await signupPost(request, await createClient(), attemptId);
  } catch {
    return signupError(503);
  }
}

function unsupported() {
  const response = signupError(405);
  response.headers.set('Allow', 'POST');

  return response;
}

export {
  unsupported as GET,
  unsupported as PUT,
  unsupported as PATCH,
  unsupported as DELETE,
  unsupported as HEAD,
  unsupported as OPTIONS,
};
