export const MAX_WEBHOOK_BODY_BYTES = 4 * 1024 * 1024;

export async function readCappedBody(
  request: Request,
  maxBytes: number = MAX_WEBHOOK_BODY_BYTES
): Promise<string | null> {
  return (await readCappedBytes(request, maxBytes))?.toString('utf8') ?? null;
}

export async function readCappedBytes(
  source: Pick<Request, 'headers' | 'body'>,
  maxBytes: number = MAX_WEBHOOK_BODY_BYTES,
  signal?: AbortSignal
): Promise<Buffer | null> {
  const declared = Number(source.headers.get('content-length'));

  if (Number.isFinite(declared) && declared > maxBytes) {
    if (signal) void source.body?.cancel().catch(() => {});

    return null;
  }

  if (!source.body) return Buffer.alloc(0);

  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  // Cancelling resolves a pending read even if the source's cleanup stalls.
  const onAbort = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };

  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    if (signal?.aborted) onAbort();
    signal?.throwIfAborted();

    for (;;) {
      const { done, value } = await reader.read();

      signal?.throwIfAborted();

      if (done) break;
      total += value.byteLength;

      if (total > maxBytes) {
        const cleanup = reader.cancel().catch(() => {});

        if (!signal) await cleanup;

        return null;
      }

      chunks.push(value);
    }

    return Buffer.concat(chunks, total);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}
