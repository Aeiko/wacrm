import { createClient } from '@/lib/supabase/server';
import {
  signupError,
  signupPost,
  signupStatus,
} from '@/lib/whatsapp/coexistence/signup';

export async function GET(request: Request) {
  try {
    return await signupStatus(request, await createClient());
  } catch {
    return signupError(503);
  }
}

export async function POST(request: Request) {
  try {
    return await signupPost(request, await createClient());
  } catch {
    return signupError(503);
  }
}

function unsupported() {
  const response = signupError(405);
  response.headers.set('Allow', 'GET, POST');

  return response;
}

export {
  unsupported as PUT,
  unsupported as PATCH,
  unsupported as DELETE,
  unsupported as HEAD,
  unsupported as OPTIONS,
};
