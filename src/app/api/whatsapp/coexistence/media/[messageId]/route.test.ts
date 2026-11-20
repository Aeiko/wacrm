import { expect, it } from 'vitest';
import { GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS } from './route';

it('sanitizes SSR cookie/client construction errors without exposing request context', async () => {
  const response = await GET(
    new Request('http://localhost/api/whatsapp/coexistence/media/private-id'),
    {
      params: Promise.resolve({ messageId: 'private-id' }),
    }
  );

  expect(response.status).toBe(503);
  expect(await response.text()).toBe('{"error":"Media unavailable"}');
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(response.headers.get('Content-Security-Policy')).toBe(
    "default-src 'none'; sandbox"
  );
  expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
});

it.each([HEAD, POST, PUT, PATCH, DELETE, OPTIONS])(
  'explicitly rejects unsupported methods without an automatic GET fallback',
  async (handler) => {
    const response = handler();
    expect(response.status).toBe(405);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.text()).toBe('{"error":"Media unavailable"}');
  }
);
