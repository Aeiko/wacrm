import { createClient } from '@/lib/supabase/server';
import {
  operatorError,
  operatorRetry,
} from '@/lib/whatsapp/coexistence/operator';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> }
) {
  try {
    const { jobId } = await params;

    return await operatorRetry(request, jobId, await createClient());
  } catch {
    return operatorError(503);
  }
}

function unsupported() {
  const response = operatorError(405);
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
