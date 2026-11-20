import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getSubscribedApps,
  registerPhoneNumber,
  subscribeWabaToApp,
} from './meta-api';

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function errorResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('registerPhoneNumber', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(okResponse({ success: true }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs to /{phone_number_id}/register with messaging_product + pin', async () => {
    const result = await registerPhoneNumber({
      phoneNumberId: 'PNID_123',
      accessToken: 'tok',
      pin: '123456',
    });

    expect(result).toEqual({ success: true, alreadyRegistered: false });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/PNID_123/register');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: 'whatsapp',
      pin: '123456',
    });
  });

  it('does not infer this-app registration from already-registered text', async () => {
    fetchMock.mockResolvedValueOnce(
      errorResponse(400, {
        error: {
          message: 'Phone number is already registered to this app.',
          code: 133005,
        },
      })
    );

    await expect(
      registerPhoneNumber({
        phoneNumberId: 'PNID_123',
        accessToken: 'tok',
        pin: '123456',
      })
    ).rejects.toThrow('Phone number is already registered to this app.');
  });

  it("surfaces Meta's PIN-required error verbatim so the UI can show it", async () => {
    fetchMock.mockResolvedValueOnce(
      errorResponse(400, {
        error: {
          message:
            'Two-step verification PIN required. Set one in Meta WhatsApp Manager → Two-step verification.',
          code: 133007,
        },
      })
    );
    await expect(
      registerPhoneNumber({
        phoneNumberId: 'P',
        accessToken: 't',
        pin: '000000',
      })
    ).rejects.toThrow(/Two-step verification PIN required/);
  });

  it('surfaces generic Meta errors as throw', async () => {
    fetchMock.mockResolvedValueOnce(
      errorResponse(500, {
        error: { message: 'Internal Meta error' },
      })
    );
    await expect(
      registerPhoneNumber({
        phoneNumberId: 'P',
        accessToken: 't',
        pin: '123456',
      })
    ).rejects.toThrow(/Internal Meta error/);
  });
});

describe('subscribeWabaToApp', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(okResponse({ success: true }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs to /{waba_id}/subscribed_apps with bearer token', async () => {
    await subscribeWabaToApp({ wabaId: 'WABA_1', accessToken: 'tok' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/WABA_1/subscribed_apps');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  it('throws on non-OK', async () => {
    fetchMock.mockResolvedValueOnce(
      errorResponse(403, { error: { message: 'Insufficient permissions' } })
    );
    await expect(
      subscribeWabaToApp({ wabaId: 'WABA_1', accessToken: 'tok' })
    ).rejects.toThrow(/Insufficient permissions/);
  });
});

describe.each([
  [
    'registration',
    () =>
      registerPhoneNumber({
        phoneNumberId: 'P',
        accessToken: 'tok',
        pin: '123456',
      }),
  ],
  [
    'subscription',
    () => subscribeWabaToApp({ wabaId: 'W', accessToken: 'tok' }),
  ],
])('%s confirmation', (_name, call) => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([{}, { success: false }, { success: 'true' }, null, []])(
    'does not confirm an invalid success body: %j',
    async (body) => {
      const fetchMock = vi.fn().mockResolvedValue(okResponse(body));
      vi.stubGlobal('fetch', fetchMock);
      await expect(call()).rejects.toThrow('Invalid Meta connection response');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );
});

describe('getSubscribedApps', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the list of subscribed apps', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({
        data: [
          {
            whatsapp_business_api_data: {
              id: 'APP1',
              name: 'wacrm',
              link: 'https://example.com/app',
            },
          },
        ],
      })
    );

    const apps = await getSubscribedApps({
      wabaId: 'WABA_1',
      accessToken: 'tok',
    });

    expect(apps).toHaveLength(1);
    expect(apps[0].whatsapp_business_api_data?.name).toBe('wacrm');
  });

  it('returns empty array when Meta returns no data field', async () => {
    fetchMock.mockResolvedValueOnce(okResponse({}));

    const apps = await getSubscribedApps({
      wabaId: 'WABA_1',
      accessToken: 'tok',
    });

    expect(apps).toEqual([]);
  });

  it('throws on non-OK', async () => {
    fetchMock.mockResolvedValueOnce(
      errorResponse(401, { error: { message: 'Invalid OAuth token' } })
    );
    await expect(
      getSubscribedApps({ wabaId: 'WABA_1', accessToken: 'tok' })
    ).rejects.toThrow(/Invalid OAuth token/);
  });
});
