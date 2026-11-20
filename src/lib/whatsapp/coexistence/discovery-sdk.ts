import type { DiscoverySdk } from './discovery-provider';

// Meta Embedded Signup implementation, SDK loading / SDK initialization.
const sdkUrl = 'https://connect.facebook.net/en_US/sdk.js';
const loopback = ['localhost', '127.0.0.1', '[::1]'];
let loadedSdk: DiscoverySdk | null = null;

export function loadDiscoverySdk(
  signal: AbortSignal
): Promise<DiscoverySdk | null> {
  const host: Window & { FB?: DiscoverySdk; fbAsyncInit?: () => void } = window;

  const readSdk = () => {
    const sdk = host.FB;

    return sdk?.init instanceof Function && sdk.login instanceof Function
      ? sdk
      : null;
  };

  if (signal.aborted || host.location.pathname !== '/settings/connect-whatsapp')
    return Promise.resolve(null);

  // Supports the offline rehearsal's preloaded SDK without any network access.
  const preloaded = readSdk();

  if (
    preloaded &&
    (preloaded === loadedSdk || loopback.includes(host.location.hostname))
  )
    return Promise.resolve(preloaded);

  if (host.location.protocol !== 'https:' || host.FB || host.fbAsyncInit)
    return Promise.resolve(null);

  return new Promise((resolve) => {
    const script = document.createElement('script');

    const finish = (sdk: DiscoverySdk | null) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', fail);

      if (host.fbAsyncInit === ready) delete host.fbAsyncInit;

      script.onerror = null;
      script.remove();
      resolve(sdk);
    };

    const fail = () => finish(null);

    const ready = () => {
      loadedSdk = readSdk();
      finish(loadedSdk);
    };

    const timer = setTimeout(fail, 10_000);

    signal.addEventListener('abort', fail, { once: true });
    host.fbAsyncInit = ready;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.referrerPolicy = 'no-referrer';
    script.src = sdkUrl;
    script.onerror = fail;
    document.head.append(script);
  });
}
