import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { beforeEach, expect, it, vi } from 'vitest';
import { memberGraphTransport } from './member-graph-transport';

const request = vi.fn();

const base = 'https://graph.facebook.com/v27.0';
const exchange = `${base}/oauth/access_token?client_id=123&client_secret=fixture&code=fixture`;
const headers = { authorization: 'Bearer fixture' };

const get = (extra?: RequestInit) => ({
  method: 'GET',
  signal: new AbortController().signal,
  ...extra,
});

function reply(statusCode: number) {
  request.mockImplementation((_url, _options, callback) =>
    Object.assign(new EventEmitter(), {
      end: () =>
        callback(
          Object.assign(Readable.from(['ok'].map(Buffer.from)), { statusCode })
        ),
    })
  );
}

beforeEach(() => request.mockReset());

it.each([
  [exchange, undefined],
  [`${base}/debug_token?input_token=fixture`, headers],
  [`${base}/123/phone_numbers?fields=id%2Cdisplay_phone_number`, headers],
  [
    `${base}/123/phone_numbers?fields=id%2Cdisplay_phone_number&after=page`,
    headers,
  ],
  [
    `${base}/456?fields=id%2Cdisplay_phone_number%2Cis_on_biz_app%2Cplatform_type`,
    headers,
  ],
] as const)(
  'makes one direct GET for an allowed operation',
  async (url, headers) => {
    reply(200);
    const target = new URL(url);
    const init = get({ headers: { ...headers, Cookie: 'must-not-forward' } });

    await expect(
      memberGraphTransport(target, init, request).then((response) =>
        response.text()
      )
    ).resolves.toBe('ok');
    expect(request).toHaveBeenCalledExactlyOnceWith(
      target,
      {
        agent: false,
        method: 'GET',
        signal: init.signal,
        maxHeaderSize: 16384,
        rejectUnauthorized: true,
        headers: {
          accept: 'application/json',
          'cache-control': 'no-store',
          ...headers,
        },
      },
      expect.any(Function)
    );
  }
);

it.each([
  [exchange.replace('graph.facebook.com', 'graph.facebook.com.example'), get()],
  [exchange.replace('graph.facebook.com', 'fixture@graph.facebook.com'), get()],
  [exchange.replace('graph.facebook.com', 'graph.facebook.com:8443'), get()],
  [exchange.replace('https:', 'http:'), get()],
  [exchange.replace('v27.0', 'v26.0'), get()],
  [`${exchange}#fragment`, get()],
  [`${exchange}&code=other`, get()],
  [exchange, get({ method: 'POST' })],
  [exchange, get({ body: 'payload' })],
  [exchange, get({ signal: AbortSignal.abort() })],
  [exchange, get({ headers })],
  [`${base}/debug_token?input_token=fixture`, get()],
  [`${base}/123/subscribed_apps`, get({ headers })],
  [
    `${base}/123/phone_numbers?fields=id%2Cdisplay_phone_number&access_token=extra`,
    get({ headers }),
  ],
  [
    `${base}/123/phone_numbers?fields=id%2Cdisplay_phone_number&after=https%3A%2F%2Fexample.com`,
    get({ headers }),
  ],
] as const)(
  'blocks invalid transport arguments before dispatch (%#)',
  async (url, init) => {
    await expect(
      memberGraphTransport(new URL(url), init, request)
    ).rejects.toThrow('transport');
    expect(request).not.toHaveBeenCalled();
  }
);

it.each([302, 429, 503])(
  'does not follow or retry status %i',
  async (status) => {
    reply(status);

    const response = await memberGraphTransport(
      new URL(exchange),
      get(),
      request
    );

    expect(response.status).toBe(status);
    expect(response.headers.get('location')).toBeNull();
    await response.body?.cancel();
    expect(request).toHaveBeenCalledOnce();
  }
);

it('does not retry a socket failure or expose its cause', async () => {
  request.mockImplementation(() => {
    const socket = new EventEmitter();

    return Object.assign(socket, {
      end: () => socket.emit('error', new Error(exchange)),
    });
  });

  await expect(
    memberGraphTransport(new URL(exchange), get(), request)
  ).rejects.toThrow(/^Coexistence Meta request failed \(transport\)$/);
  expect(request).toHaveBeenCalledOnce();
});
