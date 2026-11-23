import { z } from 'zod';
import { deadlineFetch } from '@/lib/request-deadline';
import { connectionServiceClient } from '../connection-operation';

export function isOwnerHistoryOrigin(request: Request) {
  const origin = process.env.NEXT_PUBLIC_SITE_URL;
  const site = request.headers.get('sec-fetch-site');

  return (
    !!origin &&
    URL.canParse(origin) &&
    origin.startsWith('https://') &&
    new URL(origin).origin === origin &&
    request.headers.get('origin') === origin &&
    (site === null || site === 'same-origin')
  );
}

export function ownerHistoryClient() {
  return connectionServiceClient((input, init) => {
    const bytes = new TextEncoder().encode(z.string().parse(init?.body));

    // A non-replayable body also prevents Fetch's automatic HTTP 421 replay.
    const options = {
      ...init,
      cache: 'no-store',
      redirect: 'error',
      duplex: 'half',
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    } satisfies RequestInit & { duplex: 'half' };

    return deadlineFetch(input, options);
  });
}
