import { request } from 'node:https';
import { Readable } from 'node:stream';
import {
  COEXISTENCE_GRAPH_VERSION,
  CoexistenceMetaError,
  type CoexistenceFetch,
} from '../coexistence-meta';

const prefix = `/${COEXISTENCE_GRAPH_VERSION}/`;
const asset = /^[1-9]\d{0,31}(\/phone_numbers)?$/;

function allowed(url: URL, authorization: string | null) {
  if (
    url.origin !== 'https://graph.facebook.com' ||
    url.username ||
    url.password ||
    url.hash ||
    !url.pathname.startsWith(prefix)
  )
    return false;

  const path = url.pathname.slice(prefix.length);
  const query = url.searchParams;

  const hasExactKeys = (...keys: string[]) =>
    query.size === keys.length && keys.every((key) => query.get(key));

  if (path === 'oauth/access_token')
    return (
      authorization === null &&
      hasExactKeys('client_id', 'client_secret', 'code')
    );

  if (!authorization?.startsWith('Bearer ') || !authorization.slice(7))
    return false;

  if (path === 'debug_token') return hasExactKeys('input_token');

  if (/^[1-9]\d{0,31}\/subscribed_apps$/.test(path)) return query.size === 0;

  if (!asset.test(path)) return false;

  if (path.endsWith('/phone_numbers')) {
    const after = query.get('after');

    return (
      query.get('fields') === 'id,display_phone_number' &&
      (hasExactKeys('fields') ||
        (hasExactKeys('fields', 'after') &&
          /^[A-Za-z0-9_+/=-]{1,2048}$/.test(after ?? '')))
    );
  }

  return (
    hasExactKeys('fields') &&
    query.get('fields') ===
      'id,display_phone_number,is_on_biz_app,platform_type'
  );
}

// One direct TLS request on a fresh connection: no redirect, retry, proxy client, or Next fetch/cache tracing.
export async function memberGraphTransport(
  target: URL,
  init: RequestInit,
  send: typeof request = request
): ReturnType<CoexistenceFetch> {
  const url = new URL(target.href);
  const authorization = new Headers(init.headers).get('authorization');
  const { signal } = init;
  const failed = () => new CoexistenceMetaError('transport');

  if (
    !signal ||
    signal.aborted ||
    init.method !== 'GET' ||
    init.body != null ||
    !allowed(url, authorization)
  )
    throw failed();

  const headers = new Headers({
    Accept: 'application/json',
    'Cache-Control': 'no-store',
  });

  if (authorization) headers.set('Authorization', authorization);

  return new Promise<Response>((resolve, reject) => {
    const connection = send(
      url,
      {
        agent: false,
        method: 'GET',
        signal,
        maxHeaderSize: 16 * 1024,
        rejectUnauthorized: true,
        headers: Object.fromEntries(headers),
      },
      (incoming) => {
        const status = incoming.statusCode ?? 0;

        if (status < 200 || status > 599) {
          incoming.destroy();

          return reject(failed());
        }

        if (
          status === 204 ||
          status === 205 ||
          (status >= 300 && status < 400)
        ) {
          incoming.destroy();

          return resolve(new Response(null, { status }));
        }

        const body = Readable.toWeb(incoming);

        if (!(body instanceof ReadableStream)) {
          incoming.destroy();

          return reject(failed());
        }

        resolve(new Response(body, { status }));
      }
    );

    connection.on('error', () => reject(failed()));
    connection.end();
  });
}
