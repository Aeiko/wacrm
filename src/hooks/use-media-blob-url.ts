'use client';

import { useEffect, useState } from 'react';
import {
  isPrivateMediaUrl,
  isProxiedMediaUrl,
  loadMediaBlob,
} from '@/lib/media/blob-cache';

export type MediaLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

interface MediaBlobUrlState {
  /** Ready-to-render URL: the original for public media, an object URL for proxied. */
  src: string | null;
  status: MediaLoadStatus;
  retry: () => void;
}

/** A settled load, tagged with the URL it belongs to. */
interface ResolvedMedia {
  url: string;
  attempt: number;
  objectUrl: string | null;
  failed: boolean;
}

/**
 * Resolve a `messages.media_url` into something an `<img>` can render.
 *
 * Public `chat-media` URLs are handed straight back — the browser fetches
 * and caches them itself. Inbound `/api/whatsapp/media/*` URLs are pulled
 * through `loadMediaBlob` (credentialed, cached, de-duplicated) and turned
 * into an object URL that is revoked when the URL changes or the component
 * unmounts.
 *
 * Also used for private video/audio: the server caps these at 16 MiB and
 * a complete local blob enables seeking without HTTP Range support.
 * Public and legacy video/audio keep native streaming URLs instead.
 * Private requests never reuse the legacy shared blob/in-flight caches.
 */
export function useMediaBlobUrl(url: string | undefined): MediaBlobUrlState {
  const [resolved, setResolved] = useState<ResolvedMedia | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = () => setAttempt((current) => current + 1);

  useEffect(() => {
    if (!url || !isProxiedMediaUrl(url)) return;

    let cancelled = false;
    const controller = isPrivateMediaUrl(url) ? new AbortController() : null;
    // Held in a local rather than read back off state, because that is
    // exactly the bug this replaces: the previous implementation's cleanup
    // closed over a `src` that was still null when the effect ran, so no
    // object URL was ever revoked.
    let objectUrl: string | null = null;

    loadMediaBlob(url, undefined, controller?.signal)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setResolved({ url, attempt, objectUrl, failed: false });
      })
      .catch(() => {
        if (cancelled) return;
        setResolved({ url, attempt, objectUrl: null, failed: true });
      });

    return () => {
      cancelled = true;
      controller?.abort();

      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url, attempt]);

  if (!url) return { src: null, status: 'idle', retry };

  // Nothing to load for a public URL — derived here rather than pushed
  // through state so the first paint already has the image.
  if (!isProxiedMediaUrl(url)) return { src: url, status: 'ready', retry };

  // A result for a *previous* URL is stale; the new URL's load is already
  // in flight, so report loading rather than flashing the old image.
  if (resolved?.url === url && resolved.attempt === attempt) {
    return resolved.failed
      ? { src: null, status: 'error', retry }
      : { src: resolved.objectUrl, status: 'ready', retry };
  }

  return { src: null, status: 'loading', retry };
}
