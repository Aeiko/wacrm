import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const pages = new Map(
  ['/privacy', '/data-deletion'].map((path) => [
    path,
    readFileSync(new URL(`.${path}.html`, import.meta.url)),
  ])
);

createServer({ maxHeaderSize: 8192, requestTimeout: 5000 }, (request, response) => {
  const page = pages.get(request.url);

  if (request.headers.host !== 'wacrm.sqkii.land' || !page) {
    response.writeHead(404).end();

    return;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();

    return;
  }

  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': page.length,
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  }).end(request.method === 'HEAD' ? undefined : page);
}).listen(8080, '0.0.0.0');
