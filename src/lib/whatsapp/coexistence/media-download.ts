import { z } from 'zod';
import {
  baseMimeType,
  isInlineSafeMimeType,
} from '@/lib/media/proxy-response-headers';
import { MEDIA_HEADER_SPECS } from '../media-header-types';
import { deadlineFetch } from '@/lib/request-deadline';
import {
  COEXISTENCE_GRAPH_VERSION,
  type CoexistenceFetch,
} from '../coexistence-meta';

const metadataSchema = z.object({
  id: z.string().regex(/^\d+$/),
  url: z.string().min(1).max(8192),
  mime_type: z.string().min(1).max(256),
  file_size: z
    .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
    .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)),
  error: z.never().optional(),
});

function allowedMime(
  kind: DownloadArgs['contentType'],
  mime: string | null
): mime is string {
  if (!mime) return false;

  if (kind === 'document')
    return MEDIA_HEADER_SPECS.document.mimeTypes.includes(mime);

  return (
    mime.startsWith(`${kind}/`) &&
    mime !== 'image/jpg' &&
    isInlineSafeMimeType(mime)
  );
}

export class redactedPrivateMediaError extends Error {
  constructor(
    public readonly status: number,
    public readonly code:
      | 'input'
      | 'oversize'
      | 'unsupported'
      | 'unavailable'
      | 'upstream'
      | 'deadline'
  ) {
    super('Private media download failed');
    this.name = 'redactedPrivateMediaError';
  }
}

function attachmentUrl(value: string, accessToken: string): URL {
  const url = new URL(value);

  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'lookaside.fbsbx.com' ||
    url.port !== '' ||
    url.username ||
    url.password ||
    value.includes('#') ||
    !url.pathname.startsWith('/whatsapp_business/attachments/') ||
    [...url.searchParams].some(
      ([key, val]) =>
        /token|authorization|bearer|appsecret|password|secret/i.test(key) ||
        val.includes(accessToken)
    )
  )
    throw new redactedPrivateMediaError(502, 'upstream');

  return url;
}

function requireSuccess(response: Response): void {
  if (response.redirected) throw new redactedPrivateMediaError(502, 'upstream');

  if (response.status === 404 || response.status === 410)
    throw new redactedPrivateMediaError(410, 'unavailable');

  if (response.status !== 200)
    throw new redactedPrivateMediaError(502, 'upstream');
}

async function boundedBody(
  response: Response,
  cap: number,
  signal: AbortSignal,
  metadata = false
): Promise<Uint8Array> {
  const overflow = () =>
    new redactedPrivateMediaError(
      metadata ? 502 : 413,
      metadata ? 'upstream' : 'oversize'
    );

  const length = response.headers.get('Content-Length');

  if (length !== null) {
    if (!/^\d+$/.test(length))
      throw new redactedPrivateMediaError(502, 'upstream');

    if (Number(length) > cap) throw overflow();
  }

  if (!response.body) throw new redactedPrivateMediaError(502, 'upstream');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();

      if (done) break;
      size += value.byteLength;

      if (size > cap) {
        await reader.cancel();
        throw overflow();
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const buffer = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return buffer;
}

interface DownloadArgs {
  mediaId: string;
  phoneNumberId: string;
  accessToken: string;
  contentType: 'image' | 'audio' | 'video' | 'document';
  signal?: AbortSignal;
}

export async function downloadCoexistenceMedia(
  args: DownloadArgs,
  transport: CoexistenceFetch = deadlineFetch
): Promise<{ buffer: Uint8Array; contentType: string }> {
  args.signal?.throwIfAborted();

  if (
    !/^\d+$/.test(args.mediaId) ||
    !/^\d+$/.test(args.phoneNumberId) ||
    !args.accessToken.trim() ||
    /[\r\n]/.test(args.accessToken)
  )
    throw new redactedPrivateMediaError(400, 'input');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);

  const signal = args.signal
    ? AbortSignal.any([args.signal, controller.signal])
    : controller.signal;

  // Documents deliberately share the local 16 MiB ceiling, not Meta's 100 MiB limit.
  const cap =
    args.contentType === 'image'
      ? MEDIA_HEADER_SPECS.image.maxBytes
      : MEDIA_HEADER_SPECS.video.maxBytes;

  const url = new URL(
    `https://graph.facebook.com/${COEXISTENCE_GRAPH_VERSION}/${args.mediaId}`
  );

  url.searchParams.set('phone_number_id', args.phoneNumberId);

  const init: RequestInit = {
    method: 'GET',
    redirect: 'error',
    cache: 'no-store',
    headers: { Authorization: `Bearer ${args.accessToken}` },
    signal,
  };

  try {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const response = await transport(url, init);
      requireSuccess(response);
      const bytes = await boundedBody(response, 64 * 1024, signal, true);

      const parsed = metadataSchema.safeParse(
        JSON.parse(new TextDecoder().decode(bytes))
      );

      if (!parsed.success || parsed.data.id !== args.mediaId)
        throw new redactedPrivateMediaError(502, 'upstream');
      const metadata = parsed.data;

      if (metadata.file_size > cap)
        throw new redactedPrivateMediaError(413, 'oversize');
      const mime = baseMimeType(metadata.mime_type);

      if (!allowedMime(args.contentType, mime))
        throw new redactedPrivateMediaError(415, 'unsupported');

      const media = await transport(
        attachmentUrl(metadata.url, args.accessToken),
        init
      );

      if (media.status === 404 && !media.redirected && attempt === 0) {
        await media.body?.cancel();
        continue;
      }

      requireSuccess(media);
      const cdnMime = baseMimeType(media.headers.get('Content-Type'));

      // Missing or conflicting CDN types cannot safely override the trusted Graph type.
      if (cdnMime !== mime && cdnMime !== 'application/octet-stream')
        throw new redactedPrivateMediaError(415, 'unsupported');

      return {
        buffer: await boundedBody(media, cap, signal),
        contentType: mime,
      };
    }
  } catch (error) {
    if (args.signal?.aborted && signal.reason === args.signal.reason)
      throw args.signal.reason;

    if (controller.signal.aborted)
      throw new redactedPrivateMediaError(504, 'deadline');

    if (error instanceof redactedPrivateMediaError) throw error;
    throw new redactedPrivateMediaError(502, 'upstream');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
