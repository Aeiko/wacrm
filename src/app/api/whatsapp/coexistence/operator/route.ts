import { createClient } from '@/lib/supabase/server';
import {
  operatorError,
  operatorInventory,
} from '@/lib/whatsapp/coexistence/operator';

export async function GET(request: Request) {
  try {
    return await operatorInventory(request, await createClient());
  } catch {
    return operatorError(503);
  }
}

function unsupported() {
  const response = operatorError(405);
  response.headers.set('Allow', 'GET');

  return response;
}

export {
  unsupported as POST,
  unsupported as PUT,
  unsupported as PATCH,
  unsupported as DELETE,
  unsupported as HEAD,
  unsupported as OPTIONS,
};
