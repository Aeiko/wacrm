import { createServer, type RequestListener } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { listenForFetch } from '@/test/http-server';
import type { CoexistenceFetch } from '../coexistence-meta';
import { downloadCoexistenceMedia } from './media-download';

const args = {
  mediaId: '123',
  phoneNumberId: '456',
  accessToken: 'private-token',
  contentType: 'image',
} as const;

const attachment =
  'https://lookaside.fbsbx.com/whatsapp_business/attachments/?ext=123&hash=signed';

const metadata = {
  id: '123',
  url: attachment,
  mime_type: 'image/png',
  file_size: '3',
};

const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

async function fixture(handler: RequestListener) {
  const server = createServer(handler);
  const origin = await listenForFetch(server);
  cleanup.push(() => {
    server.closeAllConnections();
    server.close();
  });
  const requests: { url: URL; init: RequestInit }[] = [];

  const transport: CoexistenceFetch = async (url, init) => {
    requests.push({ url, init });
    // Never forward to Meta: both validated logical hosts map only to this fixture.
    expect(['graph.facebook.com', 'lookaside.fbsbx.com']).toContain(
      url.hostname
    );

    return fetch(
      new URL(
        url.hostname === 'graph.facebook.com' ? '/lookup' : '/cdn',
        origin
      ),
      init
    );
  };

  return { transport, requests };
}

describe('private Coexistence media HTTP boundary', () => {
  it.each([
    'http://lookaside.fbsbx.com/whatsapp_business/attachments/a',
    'https://lookaside.fbsbx.com.evil.test/whatsapp_business/attachments/a',
    'https://lookaside.fbsbx.com@evil.test/whatsapp_business/attachments/a',
    'https://user:pass@lookaside.fbsbx.com/whatsapp_business/attachments/a',
    'https://lookaside.fbsbx.com:8443/whatsapp_business/attachments/a',
    'https://lookaside.fbsbx.com/other/a',
    'https://lookaside.fbsbx.com/whatsapp_business/attachments/a#secret',
    'https://lookaside.fbsbx.com/whatsapp_business/attachments/a?access_token=secret',
    'https://lookaside.fbsbx.com/whatsapp_business/attachments/a?hash=private-token',
    'https://scontent.xx.fbcdn.net/whatsapp_business/attachments/a',
  ])(
    'never sends credentials to an untrusted metadata URL: %s',
    async (url) => {
      const { transport, requests } = await fixture((_req, res) =>
        res.end(JSON.stringify({ ...metadata, url }))
      );

      await expect(
        downloadCoexistenceMedia(args, transport)
      ).rejects.toMatchObject({ status: 502 });
      expect(requests).toHaveLength(1);
    }
  );
  it.each([
    { id: '999' },
    { id: 123 },
    { url: 'not a url' },
    { file_size: '-1' },
    { file_size: 'Infinity' },
    { file_size: 1.5 },
    { file_size: null },
    { error: { message: 'private-token', code: 190 } },
  ])(
    'rejects malformed Graph metadata %j without downloading',
    async (change) => {
      const { transport, requests } = await fixture((_req, res) =>
        res.end(JSON.stringify({ ...metadata, ...change }))
      );

      await expect(
        downloadCoexistenceMedia(args, transport)
      ).rejects.toMatchObject({ status: 502 });
      expect(requests).toHaveLength(1);
    }
  );

  it.each([
    'text/html',
    'image/svg+xml',
    'application/javascript',
    'audio/ogg',
  ])('refuses active or wrong-kind Graph MIME %s', async (mime_type) => {
    const { transport, requests } = await fixture((_req, res) =>
      res.end(JSON.stringify({ ...metadata, mime_type }))
    );

    await expect(
      downloadCoexistenceMedia(args, transport)
    ).rejects.toMatchObject({ status: 415 });
    expect(requests).toHaveLength(1);
  });

  it.each([undefined, 'text/html', 'image/jpeg'])(
    'fails closed on missing or mismatched CDN MIME %s',
    async (mime) => {
      const { transport } = await fixture((req, res) => {
        if (req.url === '/lookup') res.end(JSON.stringify(metadata));
        else {
          if (mime) res.setHeader('Content-Type', mime);
          res.end('png');
        }
      });

      await expect(
        downloadCoexistenceMedia(args, transport)
      ).rejects.toMatchObject({ status: 415 });
    }
  );

  it.each(['application/octet-stream', 'IMAGE/PNG; charset=binary'])(
    'accepts a safe normalized or generic CDN MIME %s',
    async (mime) => {
      const { transport } = await fixture((req, res) => {
        if (req.url === '/lookup') res.end(JSON.stringify(metadata));
        else {
          res.setHeader('Content-Type', mime);
          res.end('png');
        }
      });

      await expect(
        downloadCoexistenceMedia(args, transport)
      ).resolves.toMatchObject({ contentType: 'image/png' });
    }
  );

  it.each(['metadata', 'length', 'chunks', 'lookup-chunks'] as const)(
    'bounds %s before waiting for an unending body',
    async (mode) => {
      const { transport, requests } = await fixture((req, res) => {
        if (req.url === '/lookup') {
          if (mode === 'lookup-chunks') {
            res.writeHead(200);
            res.write(' '.repeat(65537));
          } else
            res.end(
              JSON.stringify({
                ...metadata,
                file_size: mode === 'metadata' ? 5242881 : 3,
              })
            );
        } else {
          res.setHeader('Content-Type', 'image/png');

          if (mode === 'length') {
            res.setHeader('Content-Length', '5242881');
            res.flushHeaders();
          } else {
            res.writeHead(200);
            res.write(Buffer.alloc(5242881));
          }
        }
      });

      await expect(
        downloadCoexistenceMedia(args, transport)
      ).rejects.toMatchObject({ status: mode === 'lookup-chunks' ? 502 : 413 });
      expect(requests).toHaveLength(
        mode === 'metadata' || mode === 'lookup-chunks' ? 1 : 2
      );
    }
  );

  it.each(['/lookup', '/cdn'])(
    'preserves caller cancellation during a stalled %s body',
    async (stalled) => {
      const controller = new AbortController();
      const reason = new DOMException('caller cancellation', 'AbortError');

      const { transport } = await fixture((req, res) => {
        if (req.url === stalled) {
          res.setHeader('Content-Type', 'image/png');
          res.write(' ');
        } else res.end(JSON.stringify(metadata));
      });

      await expect(
        downloadCoexistenceMedia(
          { ...args, signal: controller.signal },
          async (url, init) => {
            const response = await transport(url, init);

            if (
              (url.hostname === 'graph.facebook.com' ? '/lookup' : '/cdn') ===
              stalled
            ) {
              const timer = setTimeout(() => controller.abort(reason), 30);
              cleanup.push(() => clearTimeout(timer));
            }

            return response;
          }
        )
      ).rejects.toBe(reason);
    }
  );

  it('uses one 20-second budget through lookup, URL refresh, and a stalled CDN body', async () => {
    let downloads = 0;

    const { transport, requests } = await fixture((req, res) => {
      if (req.url === '/lookup') res.end(JSON.stringify(metadata));
      else if (++downloads === 1) {
        res.statusCode = 404;
        res.end();
      } else {
        res.setHeader('Content-Type', 'image/png');
        res.write('x');
      }
    });

    await expect(
      downloadCoexistenceMedia(args, transport)
    ).rejects.toMatchObject({ status: 504, code: 'deadline' });
    expect(requests).toHaveLength(4);
    expect(new Set(requests.map(({ init }) => init.signal)).size).toBe(1);
    expect(requests[3].init.signal?.aborted).toBe(true);
  }, 25000);

  it.each([false, true])(
    'refreshes an expired URL only once (still missing: %s)',
    async (stillMissing) => {
      let lookups = 0;
      let downloads = 0;

      const { transport, requests } = await fixture((req, res) => {
        if (req.url === '/lookup') {
          lookups++;
          res.end(
            JSON.stringify({
              ...metadata,
              url: `${attachment}&generation=${lookups}`,
            })
          );
        } else {
          downloads++;
          res.setHeader('Content-Type', 'image/png');
          res.statusCode = downloads === 1 || stillMissing ? 404 : 200;
          res.end('png');
        }
      });

      const result = downloadCoexistenceMedia(args, transport);

      if (stillMissing)
        await expect(result).rejects.toMatchObject({ status: 410 });
      else
        await expect(result).resolves.toMatchObject({
          contentType: 'image/png',
        });
      expect(lookups).toBe(2);
      expect(downloads).toBe(2);
      expect(requests[3].url.searchParams.get('generation')).toBe('2');
      expect(new Set(requests.map(({ init }) => init.signal)).size).toBe(1);
    }
  );

  it.each([
    ['/lookup', 404, 410],
    ['/lookup', 500, 502],
    ['/cdn', 500, 502],
    ['/cdn', 410, 410],
  ] as const)(
    'does not retry %s status %i and discards the upstream body',
    async (path, upstream, status) => {
      const { transport, requests } = await fixture((req, res) => {
        if (req.url === path) {
          res.statusCode = upstream;
          res.write('private-token upstream URL');
        } else res.end(JSON.stringify(metadata));
      });

      await expect(
        downloadCoexistenceMedia(args, transport)
      ).rejects.toMatchObject({ status });
      expect(requests).toHaveLength(path === '/lookup' ? 1 : 2);
    }
  );

  it.each(['/lookup', '/cdn'])(
    'never follows %s redirects, even to the allowed host',
    async (path) => {
      let followed = false;

      const { transport } = await fixture((req, res) => {
        if (req.url === path) {
          res.writeHead(302, {
            Location:
              'https://lookaside.fbsbx.com/whatsapp_business/attachments/steal',
          });
          res.end('private-token');
        } else if (req.url === '/lookup') res.end(JSON.stringify(metadata));
        else {
          followed = true;
          res.end('png');
        }
      });

      await expect(
        downloadCoexistenceMedia(args, transport)
      ).rejects.toMatchObject({ status: 502 });
      // Also reject a 3xx returned by a transport instead of relying on fetch's redirect mode.
      await expect(
        downloadCoexistenceMedia(args, (url, init) =>
          transport(url, { ...init, redirect: 'manual' })
        )
      ).rejects.toMatchObject({ status: 502 });
      expect(followed).toBe(false);
    }
  );

  it('redacts a network failure and does not retry it', async () => {
    const { transport, requests } = await fixture((req) =>
      req.socket.destroy(new Error('private-token'))
    );

    try {
      await downloadCoexistenceMedia(args, transport);
      expect.fail('expected a private media error');
    } catch (error) {
      expect(error).toMatchObject({
        message: 'Private media download failed',
        status: 502,
        code: 'upstream',
      });
      expect(error).not.toHaveProperty('cause');
      expect(JSON.stringify(error)).not.toContain('private-token');
      expect(String(error)).not.toContain('http');
    }

    expect(requests).toHaveLength(1);
  });

  it.each([
    ['image', 'image/jpeg'],
    ['image', 'image/webp'],
    ['image', 'image/gif'],
    ['audio', 'audio/aac'],
    ['audio', 'audio/amr'],
    ['audio', 'audio/mp4'],
    ['audio', 'audio/mpeg'],
    ['audio', 'audio/ogg'],
    ['audio', 'audio/opus'],
    ['video', 'video/mp4'],
    ['video', 'video/3gpp'],
    ['document', 'application/pdf'],
    ['document', 'text/plain'],
    ['document', 'application/msword'],
    ['document', 'application/vnd.ms-excel'],
    ['document', 'application/vnd.ms-powerpoint'],
    [
      'document',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    [
      'document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
    [
      'document',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ],
  ] as const)('supports house %s MIME %s', async (contentType, mime_type) => {
    const { transport } = await fixture((req, res) => {
      if (req.url === '/lookup')
        res.end(JSON.stringify({ ...metadata, mime_type }));
      else {
        res.setHeader('Content-Type', mime_type);
        res.end('abc');
      }
    });

    await expect(
      downloadCoexistenceMedia({ ...args, contentType }, transport)
    ).resolves.toMatchObject({ contentType: mime_type });
  });

  it.each(['audio', 'video', 'document'] as const)(
    'caps %s metadata at 16 MiB, not the provider document limit',
    async (contentType) => {
      const mime_type = {
        audio: 'audio/ogg',
        video: 'video/mp4',
        document: 'application/pdf',
      }[contentType];

      const { transport, requests } = await fixture((_req, res) =>
        res.end(JSON.stringify({ ...metadata, mime_type, file_size: 16777217 }))
      );

      await expect(
        downloadCoexistenceMedia({ ...args, contentType }, transport)
      ).rejects.toMatchObject({ status: 413 });
      expect(requests).toHaveLength(1);
    }
  );

  it.each([
    { mediaId: '../123' },
    { phoneNumberId: '456&other=1' },
    { accessToken: 'secret\r\ninjected: header' },
    { accessToken: ' ' },
  ])('rejects invalid inputs before HTTP: %j', async (change) => {
    const { transport, requests } = await fixture((_req, res) => res.end());
    await expect(
      downloadCoexistenceMedia({ ...args, ...change }, transport)
    ).rejects.toMatchObject({ status: 400 });
    expect(requests).toHaveLength(0);
  });

  it('does not start HTTP for an already-aborted caller', async () => {
    const controller = new AbortController();
    controller.abort();
    const { transport, requests } = await fixture((_req, res) => res.end());
    await expect(
      downloadCoexistenceMedia(
        { ...args, signal: controller.signal },
        transport
      )
    ).rejects.toBe(controller.signal.reason);
    expect(requests).toHaveLength(0);
  });

  it('closes the upstream connection when chunked bytes overflow', async () => {
    let notifyClosed = () => {};

    const closed = new Promise<void>((resolve) => {
      notifyClosed = resolve;
    });

    const { transport } = await fixture((req, res) => {
      if (req.url === '/lookup') res.end(JSON.stringify(metadata));
      else {
        req.socket.once('close', notifyClosed);
        res.setHeader('Content-Type', 'image/png');
        res.write(Buffer.alloc(5242881));
      }
    });

    await expect(
      downloadCoexistenceMedia(args, transport)
    ).rejects.toMatchObject({ status: 413 });
    await closed;
  });

  it('returns only bounded bytes and the Graph MIME, with phone ownership and header-only credentials', async () => {
    const { transport, requests } = await fixture((req, res) => {
      if (req.url === '/lookup') res.end(JSON.stringify(metadata));
      else {
        res.setHeader('Content-Type', 'image/png');
        res.end('png');
      }
    });

    await expect(downloadCoexistenceMedia(args, transport)).resolves.toEqual({
      buffer: new TextEncoder().encode('png'),
      contentType: 'image/png',
    });
    expect(requests.map(({ url }) => url.href)).toEqual([
      'https://graph.facebook.com/v27.0/123?phone_number_id=456',
      attachment,
    ]);

    for (const { url, init } of requests) {
      expect(init).toMatchObject({
        method: 'GET',
        redirect: 'error',
        cache: 'no-store',
      });
      expect(new Headers(init.headers).get('Authorization')).toBe(
        'Bearer private-token'
      );
      expect(url.href).not.toContain('private-token');
    }
  });
});
