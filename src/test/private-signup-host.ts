import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { z } from 'zod';

const signup = '/supervised-signup';
const maxBody = 40 * 1024;

const headers = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  Connection: 'close',
};

export async function withPrivateSignupHost(
  handle: (request: Request) => Promise<Response>,
  run: (origin: string) => Promise<void>
) {
  const directory = process.env.WACRM_SUPERVISED_ASSETS;

  if (!directory) throw new Error('Private signup assets are required');

  const html = readFileSync(join(directory, 'screen.html'));
  const script = readFileSync(join(directory, 'screen.js'));
  let origin = '';
  let authority = '';

  const server = createServer(
    {
      headersTimeout: 5_000,
      requestTimeout: 10_000,
      connectionsCheckingInterval: 1_000,
      maxHeaderSize: 16 * 1024,
    },
    async (incoming, outgoing) => {
      const abort = new AbortController();
      const timeout = setTimeout(() => outgoing.destroy(), 15_000);
      outgoing.once('close', () => {
        clearTimeout(timeout);
        abort.abort();
      });

      const reject = (status: number) =>
        outgoing
          .writeHead(status, { ...headers, 'Content-Type': 'application/json' })
          .end('{"error":"unavailable"}');

      try {
        if (
          incoming.headersDistinct.host?.length !== 1 ||
          incoming.headers.host !== authority ||
          Object.keys(incoming.headers).some(
            (name) => name === 'forwarded' || name.startsWith('x-forwarded-')
          )
        )
          return reject(403);

        const path = incoming.url;
        const page = path === '/';
        const asset = page || path === '/fixture.js';
        const favicon = path === '/favicon.ico';
        const post = incoming.method === 'POST';

        if (!asset && !favicon && path !== signup) return reject(404);

        if (incoming.method !== 'GET' && !(post && path === signup))
          return reject(405);

        const length = Number(incoming.headers['content-length'] ?? 0);

        if (length > maxBody) return reject(413);

        if (!post && (length || incoming.headers['transfer-encoding']))
          return reject(400);

        if (favicon) return outgoing.writeHead(204, headers).end();

        const requestHeaders = new Headers();

        for (const name of [
          'origin',
          'sec-fetch-site',
          'cookie',
          'content-type',
          'authorization',
          'apikey',
          'x-api-key',
        ]) {
          const values = incoming.headersDistinct[name];

          if (values)
            requestHeaders.set(
              name,
              values.join(name === 'cookie' ? '; ' : ', ')
            );
        }

        if (asset) {
          const site = requestHeaders.get('sec-fetch-site');
          const claimedOrigin = requestHeaders.get('origin');
          const referer = incoming.headers.referer;

          const directNavigation =
            page &&
            site === 'none' &&
            incoming.headers['sec-fetch-mode'] === 'navigate' &&
            incoming.headers['sec-fetch-dest'] === 'document';

          if (
            (site !== 'same-origin' && !directNavigation) ||
            (claimedOrigin !== null && claimedOrigin !== origin) ||
            (referer !== undefined && URL.parse(referer)?.origin !== origin)
          )
            return reject(403);

          // Only the host-checked, read-only page probe may normalize navigation metadata.
          requestHeaders.set('sec-fetch-site', 'same-origin');
        }

        const chunks: Buffer[] = [];
        let size = 0;

        if (post) {
          for await (const chunk of incoming.iterator({
            destroyOnReturn: false,
          })) {
            size += chunk.length;

            if (size > maxBody) return reject(413);
            chunks.push(chunk);
          }
        }

        const response = await handle(
          new Request(`${origin}${signup}`, {
            method: post ? 'POST' : 'GET',
            headers: requestHeaders,
            body: post ? Buffer.concat(chunks) : undefined,
            signal: abort.signal,
          })
        );

        if (asset) {
          await response.body?.cancel();

          if (!response.ok) return reject(response.status);

          return outgoing
            .writeHead(200, {
              ...headers,
              'Content-Type': page
                ? 'text/html; charset=utf-8'
                : 'text/javascript; charset=utf-8',
            })
            .end(page ? html : script);
        }

        const body = await response.text();

        return outgoing
          .writeHead(response.status, {
            ...headers,
            'Content-Type': 'application/json',
          })
          .end(body);
      } catch {
        if (!outgoing.destroyed) return reject(500);
      }
    }
  );

  // Reject forwarded and duplicate Host fields even at the header-count limit.
  server.maxHeadersCount = 0;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const { port } = z.object({ port: z.number() }).parse(server.address());
    authority = `127.0.0.1:${port}`;
    origin = `http://${authority}`;
    await run(origin);
  } finally {
    server.closeAllConnections();
    await server[Symbol.asyncDispose]();
  }
}

export async function rehearsePrivateSignupBrowser(
  origin: string,
  cookie: string,
  scenario?:
    | 'owner'
    | 'second'
    | 'cancel'
    | 'wrongAccount'
    | 'lostLaunch'
    | 'lostExchange'
) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(systemroot|windir|temp|tmp|tmpdir|localappdata|userprofile|home|path|ld_library_path|chromium_path)$/i.test(
        key
      )
    )
  );

  const child = spawn(
    process.execPath,
    ['supabase/ci/rehearse-private-signup-browser.mjs'],
    {
      env: { ...env, NODE_ENV: 'test' },
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: 65_000,
      killSignal: 'SIGKILL',
    }
  );

  const closed = once(child, 'close');
  child.stdin.on('error', () => child.kill('SIGKILL'));
  child.stdin.end(JSON.stringify({ origin, cookie, scenario }));

  try {
    const [code] = await closed;

    if (code === 0) return;
  } catch {
    // Do not surface child diagnostics from a credential-bearing process.
  }

  throw new Error('Private signup browser failed (details withheld)');
}
