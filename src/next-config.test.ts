import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match';
import nextConfig from '../next.config';

async function cacheControlFor(pathname: string) {
  const rules = (await nextConfig.headers?.()) ?? [];

  const values = rules
    .filter((rule) => getPathMatch(rule.source, { strict: true })(pathname))
    .flatMap((rule) => rule.headers)
    .filter((header) => header.key.toLowerCase() === 'cache-control')
    .map((header) => header.value);

  return values.at(-1);
}

describe('next.config Supabase CSP', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function cspFor(url: string | undefined) {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', url);
    vi.resetModules();
    const { default: config } = await import('../next.config');
    const rules = (await config.headers?.()) ?? [];

    return rules
      .flatMap((rule) => rule.headers)
      .find((header) => header.key === 'Content-Security-Policy-Report-Only')!
      .value;
  }

  it.each([
    [
      'http://localhost:8000/storage/v1',
      'http://localhost:8000',
      'ws://localhost:8000',
    ],
    [
      'https://supabase.example.com/',
      'https://supabase.example.com',
      'wss://supabase.example.com',
    ],
    [
      'https://project.supabase.co',
      'https://project.supabase.co',
      'wss://project.supabase.co',
    ],
  ])(
    'allows only the configured origins for %s',
    async (url, origin, websocket) => {
      const csp = await cspFor(url);
      const directives = csp.split('; ');
      expect(directives).toContain(
        `img-src 'self' data: blob: https: ${origin}`
      );
      expect(directives).toContain(
        `media-src 'self' blob: https://*.supabase.co ${origin} ${websocket}`
      );
      expect(directives).toContain(
        `connect-src 'self' https://*.supabase.co wss://*.supabase.co ${origin} ${websocket}`
      );
      expect(directives).toContain("default-src 'self'");
      expect(directives).toContain("frame-ancestors 'none'");
      expect(directives).toContain("base-uri 'self'");
      expect(directives).toContain("form-action 'self'");
    }
  );

  it.each([
    undefined,
    '',
    'not a URL',
    'javascript:alert(1)',
    'data:text/plain,test',
  ])(
    'does not broaden the policy for an absent or invalid URL (%s)',
    async (url) => {
      const directives = (await cspFor(url)).split('; ');
      expect(directives).toContain("img-src 'self' data: blob: https:");
      expect(directives).toContain(
        "media-src 'self' blob: https://*.supabase.co"
      );
      expect(directives).toContain(
        "connect-src 'self' https://*.supabase.co wss://*.supabase.co"
      );
    }
  );
});

describe('next.config Cache-Control', () => {
  it.each([
    '/',
    '/login',
    '/signup',
    '/dashboard',
    '/inbox/123',
    '/settings/team',
    '/join/abc',
  ])('keeps %s out of shared caches', async (pathname) => {
    const value = await cacheControlFor(pathname);
    expect(value).toBe('private, no-store');
    expect(value).not.toMatch(/public|s-maxage|stale-while-revalidate/);
  });

  it('sends no-store on API routes', async () => {
    expect(await cacheControlFor('/api/whatsapp/templates')).toBe('no-store');
  });

  it.each(['/_next/static/chunks/app.js', '/_next/image'])(
    "leaves %s to Next's own caching",
    async (pathname) => {
      expect(await cacheControlFor(pathname)).toBeUndefined();
    }
  );
});
