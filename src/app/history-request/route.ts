import { historyRequestHandlers } from '@/lib/whatsapp/coexistence/history-request-handler';
import { historyRequestTransport } from '@/lib/whatsapp/coexistence/history-request-transport';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const { GET, POST } = historyRequestHandlers(historyRequestTransport);
