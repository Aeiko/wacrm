import { afterEach, expect, it, vi } from 'vitest';
import { loadDiscoverySdk } from './discovery-sdk';
import type { DiscoverySdk } from './discovery-provider';

interface FixtureWindow {
  location: { pathname: string; protocol: string; hostname: string };
  FB?: DiscoverySdk;
  fbAsyncInit?: () => void;
}

interface FixtureScript {
  remove: () => void;
  onerror: null | (() => void);
}

function fixture(pathname = '/settings/connect-whatsapp', protocol = 'https:') {
  const sdk = { init: vi.fn(), login: vi.fn() };

  const window: FixtureWindow = {
    location: {
      pathname,
      protocol,
      hostname: protocol === 'http:' ? 'localhost' : 'host.example',
    },
  };

  const script: FixtureScript = { remove: vi.fn(), onerror: null };
  const head = { append: vi.fn() };
  const document = { createElement: vi.fn(() => script), head };
  const request = new AbortController();
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', document);

  return { window, document, script, sdk, request };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('uses the preloaded localhost fixture without a script request', async () => {
  const { window, document, sdk, request } = fixture(undefined, 'http:');
  window.FB = sdk;

  await expect(loadDiscoverySdk(request.signal)).resolves.toBe(sdk);
  expect(document.createElement).not.toHaveBeenCalled();
});

it.each([
  ['/settings', 'https:'],
  ['/settings/connect-whatsapp', 'http:'],
])('does not load at %s over %s', async (path, protocol) => {
  const { document, request } = fixture(path, protocol);

  await expect(loadDiscoverySdk(request.signal)).resolves.toBeNull();
  expect(document.createElement).not.toHaveBeenCalled();
});

it('does not trust an unrelated preloaded SDK on a hosted origin', async () => {
  const { window, document, sdk, request } = fixture();
  window.FB = sdk;

  await expect(loadDiscoverySdk(request.signal)).resolves.toBeNull();
  expect(document.createElement).not.toHaveBeenCalled();
});

it('loads only the documented SDK URL and waits for the SDK readiness callback', async () => {
  const { window, document, script, sdk, request } = fixture();
  const loaded = loadDiscoverySdk(request.signal);

  expect(document.head.append).toHaveBeenCalledExactlyOnceWith(script);
  expect(script).toMatchObject({
    src: 'https://connect.facebook.net/en_US/sdk.js',
    async: true,
    crossOrigin: 'anonymous',
    referrerPolicy: 'no-referrer',
  });

  window.FB = sdk;
  window.fbAsyncInit?.();
  await expect(loaded).resolves.toBe(sdk);
  expect(window.fbAsyncInit).toBeUndefined();
  expect(script.remove).toHaveBeenCalledOnce();
  expect(sdk.init).not.toHaveBeenCalled();
  expect(sdk.login).not.toHaveBeenCalled();
});

it.each(['abort', 'error', 'timeout', 'missing SDK'])(
  'fails closed on %s and removes the pending script',
  async (outcome) => {
    vi.useFakeTimers();
    const { window, script, request } = fixture();
    const loaded = loadDiscoverySdk(request.signal);

    switch (outcome) {
      case 'abort':
        request.abort();
        break;
      case 'error':
        script.onerror?.();
        break;
      case 'timeout':
        vi.runAllTimers();
        break;
      case 'missing SDK':
        window.fbAsyncInit?.();
        break;
    }

    await expect(loaded).resolves.toBeNull();
    expect(window.fbAsyncInit).toBeUndefined();
    expect(script.remove).toHaveBeenCalledOnce();
  }
);
