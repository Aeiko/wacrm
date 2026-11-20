import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  __resetMediaBlobCache,
  isPrivateMediaUrl,
  isProxiedMediaUrl,
  loadMediaBlob,
  MediaResponseError,
  type MediaFetch,
} from './blob-cache';

const PROXY = '/api/whatsapp/media/';

const BUCKET =
  'https://x.supabase.co/storage/v1/object/public/chat-media/a/1-p.png';

function okResponse(body: string): Response {
  return new Response(body, { status: 200 });
}

/** Records every URL requested so de-duplication is observable. */
function trackingFetch(): MediaFetch & { calls: string[] } {
  const calls: string[] = [];

  const impl = vi.fn(async (url: string) => {
    calls.push(url);

    return okResponse(`bytes:${url}`);
  }) as unknown as MediaFetch & { calls: string[] };

  impl.calls = calls;

  return impl;
}

beforeEach(() => {
  __resetMediaBlobCache();
});

describe('isProxiedMediaUrl', () => {
  it('recognises inbound media, not bucket URLs', () => {
    expect(isProxiedMediaUrl(`${PROXY}123`)).toBe(true);
    expect(isProxiedMediaUrl(BUCKET)).toBe(false);
  });
});

const PRIVATE_URL =
  '/api/whatsapp/coexistence/media/12345678-1234-4234-8234-123456789abc?v=87654321-1234-4234-8234-123456789abc';

describe('private media', () => {
  it('recognises only relative message UUID endpoints as private proxies', () => {
    expect(isPrivateMediaUrl(PRIVATE_URL)).toBe(true);
    expect(isProxiedMediaUrl(PRIVATE_URL)).toBe(true);
    expect(isPrivateMediaUrl(`https://other.test${PRIVATE_URL}`)).toBe(false);
    expect(isPrivateMediaUrl(`//other.test${PRIVATE_URL}`)).toBe(false);
    expect(
      isPrivateMediaUrl('/api/whatsapp/coexistence/media/not-a-uuid')
    ).toBe(false);
    expect(isPrivateMediaUrl(`${PRIVATE_URL}/extra`)).toBe(false);
    expect(isPrivateMediaUrl(`${PROXY}123`)).toBe(false);
  });
});

describe('loadMediaBlob', () => {
  it('admits only four independent private consumers through full body completion', async () => {
    const bodies = Array.from({ length: 6 }, () =>
      Promise.withResolvers<Response>()
    );

    let started = 0;
    const fetchImpl: MediaFetch = () => bodies[started++].promise;

    const loads = Array.from({ length: 6 }, () =>
      loadMediaBlob(PRIVATE_URL, fetchImpl)
    );

    expect(started).toBe(4);
    bodies[0].resolve(okResponse('first'));
    expect(await (await loads[0]).text()).toBe('first');
    expect(started).toBe(5);
    bodies[1].resolve(okResponse('second'));
    await loads[1];
    expect(started).toBe(6);

    for (const body of bodies.slice(2)) body.resolve(okResponse('independent'));
    await Promise.all(loads);
  });

  it('holds admission until bodies finish and authorizes queued consumers when they start', async () => {
    const streams = Array.from({ length: 5 }, () =>
      Promise.withResolvers<void>()
    );

    let session = 'first';
    const sessions: string[] = [];

    const fetchImpl: MediaFetch = async () => {
      const index = sessions.length;
      sessions.push(session);

      return new Response(
        new ReadableStream({
          start(controller) {
            void streams[index].promise.then(() => {
              controller.enqueue(new TextEncoder().encode(sessions[index]));
              controller.close();
            });
          },
        })
      );
    };

    const loads = Array.from({ length: 5 }, () =>
      loadMediaBlob(PRIVATE_URL, fetchImpl)
    );

    expect(sessions).toEqual(['first', 'first', 'first', 'first']);
    session = 'second';
    streams[0].resolve();
    expect(await (await loads[0]).text()).toBe('first');
    expect(sessions).toEqual(['first', 'first', 'first', 'first', 'second']);

    for (const stream of streams.slice(1)) stream.resolve();
    expect(await (await loads[4]).text()).toBe('second');
    await Promise.all(loads);
  });

  it('cancels queued private requests without fetching and releases active admission on abort', async () => {
    const controllers = Array.from({ length: 6 }, () => new AbortController());

    const bodies = Array.from({ length: 6 }, () =>
      Promise.withResolvers<Response>()
    );

    let started = 0;
    const fetchImpl: MediaFetch = () => bodies[started++].promise;

    const loads = controllers.map((controller) =>
      loadMediaBlob(PRIVATE_URL, fetchImpl, controller.signal)
    );

    const settled = Promise.allSettled(loads);

    expect(started).toBe(4);
    controllers[4].abort();
    controllers[0].abort();
    await expect(loads[4]).rejects.toMatchObject({ name: 'AbortError' });
    await expect(loads[0]).rejects.toMatchObject({ name: 'AbortError' });
    expect(started).toBe(5);

    for (const body of bodies) body.resolve(okResponse('remaining'));
    await settled;
    expect(started).toBe(5);
  });

  it('does not start an already-aborted request and retries a 429 only on another explicit load', async () => {
    const controller = new AbortController();
    controller.abort();

    const fetchImpl = vi
      .fn<MediaFetch>()
      .mockResolvedValueOnce(new Response('busy', { status: 429 }))
      .mockResolvedValueOnce(okResponse('fresh authorization'));

    await expect(
      loadMediaBlob(PRIVATE_URL, fetchImpl, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(loadMediaBlob(PRIVATE_URL, fetchImpl)).rejects.toMatchObject({
      status: 429,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await (await loadMediaBlob(PRIVATE_URL, fetchImpl)).text()).toBe(
      'fresh authorization'
    );
  });

  it('refetches private bytes and observes revocation at the same URL', async () => {
    const fetchImpl = vi
      .fn<MediaFetch>()
      .mockResolvedValueOnce(okResponse('first session'))
      .mockResolvedValueOnce(okResponse('second session'))
      .mockResolvedValueOnce(new Response('unavailable', { status: 404 }));

    expect(await (await loadMediaBlob(PRIVATE_URL, fetchImpl)).text()).toBe(
      'first session'
    );
    expect(await (await loadMediaBlob(PRIVATE_URL, fetchImpl)).text()).toBe(
      'second session'
    );
    await expect(loadMediaBlob(PRIVATE_URL, fetchImpl)).rejects.toMatchObject({
      status: 404,
    });
    expect(fetchImpl).toHaveBeenLastCalledWith(PRIVATE_URL, {
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
    });
  });

  it('does not share private in-flight requests between consumers', async () => {
    const fetchImpl = vi
      .fn<MediaFetch>()
      .mockResolvedValueOnce(okResponse('allowed'))
      .mockResolvedValueOnce(new Response('revoked', { status: 404 }));

    const results = await Promise.allSettled([
      loadMediaBlob(PRIVATE_URL, fetchImpl),
      loadMediaBlob(PRIVATE_URL, fetchImpl),
    ]);

    expect(results[0].status).toBe('fulfilled');
    expect(results[1]).toMatchObject({
      status: 'rejected',
      reason: { status: 404 },
    });
  });

  it('caches proxied media so a second consumer costs nothing', async () => {
    const fetchImpl = trackingFetch();
    const first = await loadMediaBlob(`${PROXY}1`, fetchImpl);
    const second = await loadMediaBlob(`${PROXY}1`, fetchImpl);

    expect(fetchImpl.calls).toEqual([`${PROXY}1`]);
    // Same Blob instance — the thumbnail, the viewer and a download all end
    // up holding the bytes that were fetched once.
    expect(second).toBe(first);
  });

  it('de-duplicates concurrent loads of the same URL', async () => {
    const fetchImpl = trackingFetch();

    const [a, b] = await Promise.all([
      loadMediaBlob(`${PROXY}2`, fetchImpl),
      loadMediaBlob(`${PROXY}2`, fetchImpl),
    ]);

    expect(fetchImpl.calls).toEqual([`${PROXY}2`]);
    expect(a).toBe(b);
  });

  it('does not cache public bucket URLs', async () => {
    // The browser's HTTP cache already covers these, and a 16 MB video has
    // no business being pinned in JS memory.
    const fetchImpl = trackingFetch();
    await loadMediaBlob(BUCKET, fetchImpl);
    await loadMediaBlob(BUCKET, fetchImpl);

    expect(fetchImpl.calls).toEqual([BUCKET, BUCKET]);
  });

  it('evicts the least-recently-used entry past the cap', async () => {
    const fetchImpl = trackingFetch();

    for (let i = 0; i < 30; i++) {
      await loadMediaBlob(`${PROXY}${i}`, fetchImpl);
    }

    // Touch the oldest so it is no longer the eviction candidate.
    await loadMediaBlob(`${PROXY}0`, fetchImpl);
    // One more entry pushes the cache over the cap.
    await loadMediaBlob(`${PROXY}30`, fetchImpl);

    const before = fetchImpl.calls.length;
    await loadMediaBlob(`${PROXY}0`, fetchImpl); // still cached
    expect(fetchImpl.calls.length).toBe(before);

    await loadMediaBlob(`${PROXY}1`, fetchImpl); // evicted → refetched
    expect(fetchImpl.calls.length).toBe(before + 1);
  });

  it('throws on a failed request and caches nothing', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 404 }));

    await expect(
      loadMediaBlob(`${PROXY}3`, fetchImpl as unknown as MediaFetch)
    ).rejects.toThrow('404');

    // A retry genuinely retries rather than replaying the failure.
    await expect(
      loadMediaBlob(`${PROXY}3`, fetchImpl as unknown as MediaFetch)
    ).rejects.toThrow('404');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('distinguishes a refused response from a fetch that never completed', async () => {
    // `downloadMediaMessage` branches on this: a refused response must
    // surface as an error, while a blocked fetch falls back to a new tab.
    // Getting the two confused made an expired attachment silently open a
    // tab onto its own 401 instead of telling the agent.
    const refuse = vi.fn(async () => new Response('no', { status: 401 }));
    await expect(
      loadMediaBlob(`${PROXY}5`, refuse as unknown as MediaFetch)
    ).rejects.toBeInstanceOf(MediaResponseError);

    const blocked = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });

    await expect(
      loadMediaBlob(BUCKET, blocked as unknown as MediaFetch)
    ).rejects.not.toBeInstanceOf(MediaResponseError);
  });

  it('carries the status on a refused response', async () => {
    const refuse = vi.fn(async () => new Response('no', { status: 401 }));
    await expect(
      loadMediaBlob(`${PROXY}6`, refuse as unknown as MediaFetch)
    ).rejects.toMatchObject({ status: 401, name: 'MediaResponseError' });
  });

  it('lets a retry succeed after a failure', async () => {
    let attempt = 0;

    const fetchImpl = vi.fn(async () => {
      attempt += 1;

      return attempt === 1
        ? new Response('nope', { status: 500 })
        : okResponse('bytes');
    });

    await expect(
      loadMediaBlob(`${PROXY}4`, fetchImpl as unknown as MediaFetch)
    ).rejects.toThrow();

    const blob = await loadMediaBlob(
      `${PROXY}4`,
      fetchImpl as unknown as MediaFetch
    );

    expect(await blob.text()).toBe('bytes');
  });
});
