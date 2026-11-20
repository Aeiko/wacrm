import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from './encryption';

function stubMetaFetch(
  transport: (url: string, init: RequestInit) => Promise<Response>
) {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'fixture-service-key');
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.startsWith('http://127.0.0.1:54321/rest/v1/whatsapp_config?')) {
        return Response.json([
          {
            id: 'fixture-config',
            account_id: 'fixture-account',
            status: 'connected',
            access_token: encrypt('test-token'),
            coexistence_app_id: null,
            coexistence_generation: 'fixture-epoch',
            coexistence_verified_at: null,
          },
        ]);
      }

      if (!url.startsWith('https://graph.facebook.com/'))
        throw new Error('Unexpected fixture URL');

      return transport(url, init ?? {});
    }
  );
}

afterEach(() => vi.unstubAllEnvs());

import { getMediaUrl, sendMediaMessage } from './meta-api';

// Capture the JSON body each helper POSTs to Meta so we can assert the
// exact payload shape per media kind without hitting the network.
interface CapturedBody {
  type?: string;
  image?: Record<string, unknown>;
  video?: Record<string, unknown>;
  document?: Record<string, unknown>;
  audio?: Record<string, unknown>;
}

let captured: CapturedBody | null = null;

function okFetch() {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    captured = init?.body
      ? (JSON.parse(init.body as string) as CapturedBody)
      : null;

    return {
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.TEST' }] }),
    } as Response;
  });
}

const BASE = {
  phoneNumberId: 'test-phone',
  accessToken: 'test-token',
  to: '1234567890',
  link: 'https://cdn.example.com/file',
} as const;

describe('getMediaUrl — phone ownership', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('always asks Meta to check the server-selected phone owner', async () => {
    stubMetaFetch(async (url, init) => {
      expect(new URL(url).searchParams.get('phone_number_id')).toBe('1234');
      expect(init.redirect).toBe('error');
      expect(init.cache).toBe('no-store');

      return Response.json({
        url: 'https://lookaside.fbsbx.com/media',
        file_size: '3',
      });
    });
    await expect(
      getMediaUrl({
        mediaId: '123',
        phoneNumberId: '1234',
        accessToken: 'test-token',
      })
    ).resolves.toMatchObject({ fileSize: 3 });
  });
});

describe('sendMediaMessage — payload shape', () => {
  beforeEach(() => {
    captured = null;
    stubMetaFetch(okFetch());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends image with a caption and no filename', async () => {
    await sendMediaMessage({
      ...BASE,
      kind: 'image',
      caption: 'hello',
      filename: 'x.png',
    });
    expect(captured?.type).toBe('image');
    expect(captured?.image).toEqual({ link: BASE.link, caption: 'hello' });
    expect(captured?.image?.filename).toBeUndefined();
  });

  it('sends document with both caption and filename', async () => {
    await sendMediaMessage({
      ...BASE,
      kind: 'document',
      caption: 'invoice',
      filename: 'invoice.pdf',
    });
    expect(captured?.type).toBe('document');
    expect(captured?.document).toEqual({
      link: BASE.link,
      caption: 'invoice',
      filename: 'invoice.pdf',
    });
  });

  it('sends audio with NO caption and NO filename (Meta rejects both)', async () => {
    await sendMediaMessage({
      ...BASE,
      kind: 'audio',
      caption: 'should be dropped',
      filename: 'voice.ogg',
    });
    expect(captured?.type).toBe('audio');
    expect(captured?.audio).toEqual({ link: BASE.link });
  });

  it('throws when no link is provided', async () => {
    await expect(
      sendMediaMessage({ ...BASE, link: '', kind: 'image' })
    ).rejects.toThrow(/requires a link/);
  });
});
