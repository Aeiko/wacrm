import { Client, type buildConnector } from 'undici';
import {
  COEXISTENCE_GRAPH_VERSION,
  type CoexistenceFetch,
} from '../coexistence-meta';

const origin = 'https://graph.facebook.com';
const historyBody = '{"messaging_product":"whatsapp","sync_type":"history"}';

// The optional connector is used only by the loopback wire test, never sourced from a request or environment.
export function createHistoryRequestTransport(
  connect?: buildConnector.connector
): CoexistenceFetch {
  return async (url, init) => {
    const phone = process.env.WHATSAPP_COEXISTENCE_RELAY_PHONE_ID;
    const authorization = new Headers(init.headers).get('authorization');

    if (
      !phone ||
      !/^[1-9][0-9]{0,31}$/.test(phone) ||
      url.href !==
        `${origin}/${COEXISTENCE_GRAPH_VERSION}/${phone}/smb_app_data` ||
      init.method !== 'POST' ||
      init.redirect !== 'error' ||
      init.body !== historyBody ||
      !init.signal ||
      !authorization?.startsWith('Bearer ')
    ) {
      throw new Error('History transport unavailable');
    }

    init.signal.throwIfAborted();

    const client = new Client(origin, {
      connect,
      maxResponseSize: 65_536,
      connectTimeout: 3000,
    });

    try {
      const { statusCode, body } = await client.request({
        method: 'POST',
        path: url.pathname,
        body: historyBody,
        headers: { authorization, 'content-type': 'application/json' },
        signal: init.signal,
        idempotent: false,
      });

      const bytes = await body.arrayBuffer();

      return new Response(
        statusCode === 204 || statusCode === 205 || statusCode === 304
          ? null
          : bytes,
        { status: statusCode }
      );
    } finally {
      await client.destroy();
    }
  };
}

export const historyRequestTransport = createHistoryRequestTransport();
