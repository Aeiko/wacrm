import { describe, expect, it, vi } from 'vitest';
import {
  exchangeEmbeddedSignupCode,
  validateCoexistenceToken,
  verifyCoexistencePhone,
  subscribeCoexistenceWaba,
  initiateCoexistenceSync,
  CoexistenceMetaError,
  COEXISTENCE_REQUEST_TIMEOUT_MS,
  type CoexistenceFetch,
} from './coexistence-meta';
import { armHistoryPermit } from './coexistence-meta.test-helper';

describe('Coexistence Meta HTTP boundary', () => {
  it('refuses a debug result carrying an explicit token error even when other fields look valid', async () => {
    const transport: CoexistenceFetch = async () =>
      Response.json({
        data: {
          app_id: '123',
          is_valid: true,
          expires_at: 4_000_000_000,
          scopes: [
            'whatsapp_business_management',
            'whatsapp_business_messaging',
          ],
          error: { code: 190, message: 'token-secret' },
        },
      });

    await expect(
      validateCoexistenceToken(
        {
          expectedAppId: '123',
          accessToken: 'business-token',
          appAccessToken: 'app-token',
        },
        transport
      )
    ).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('rejects blank exchanged tokens rather than treating dashboard readiness as authorization', async () => {
    const transport: CoexistenceFetch = async () =>
      Response.json({ access_token: ' ', token_type: 'bearer' });

    await expect(
      exchangeEmbeddedSignupCode(
        {
          appId: '123',
          appSecret: 'dedicated-secret',
          code: 'signup-code',
        },
        transport
      )
    ).rejects.toMatchObject({ kind: 'invalid_response' });
  });
  it('never uses a history receipt for an address-book request', async () => {
    const transport = vi.fn();

    await expect(
      initiateCoexistenceSync(
        {
          phoneNumberId: '456',
          accessToken: 'synthetic',
          syncType: 'smb_app_state_sync',
          historyReceipt: armHistoryPermit(),
        },
        transport
      )
    ).resolves.toEqual({ outcome: 'not_sent' });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(['smb_app_state_sync', 'history'] as const)(
    'initiates %s with one POST and returns the accepted request ID',
    async (syncType) => {
      let calls = 0;

      const transport: CoexistenceFetch = async (url, init) => {
        calls++;
        expect(url.toString()).toBe(
          'https://graph.facebook.com/v27.0/456/smb_app_data'
        );
        expect(init.method).toBe('POST');
        expect(new Headers(init.headers).get('Authorization')).toBe(
          'Bearer business-token'
        );
        expect(new Headers(init.headers).get('Content-Type')).toBe(
          'application/json'
        );
        expect(init.redirect).toBe('error');
        expect(JSON.parse(String(init.body))).toEqual({
          messaging_product: 'whatsapp',
          sync_type: syncType,
        });

        return Response.json({
          messaging_product: 'whatsapp',
          request_id: 'sync-request-1',
        });
      };

      await expect(
        initiateCoexistenceSync(
          {
            phoneNumberId: '456',
            accessToken: 'business-token',
            syncType,
            historyReceipt:
              syncType === 'history' ? armHistoryPermit() : undefined,
          },
          transport
        )
      ).resolves.toEqual({ outcome: 'accepted', requestId: 'sync-request-1' });
      expect(calls).toBe(1);
    }
  );
  it('always includes both WABA override parameters, including on a repeated subscription', async () => {
    let calls = 0;

    const transport: CoexistenceFetch = async (url, init) => {
      calls++;
      expect(url.toString()).toBe(
        'https://graph.facebook.com/v27.0/321/subscribed_apps'
      );
      expect(init.method).toBe('POST');
      expect(new Headers(init.headers).get('Authorization')).toBe(
        'Bearer business-token'
      );
      expect(new Headers(init.headers).get('Content-Type')).toBe(
        'application/json'
      );
      expect(JSON.parse(String(init.body))).toEqual({
        override_callback_uri: 'https://crm.example/webhooks/coexistence',
        verify_token: 'verification-secret',
      });

      return Response.json({ success: true });
    };

    const args = {
      wabaId: '321',
      accessToken: 'business-token',
      callbackUrl: 'https://crm.example/webhooks/coexistence',
      verifyToken: 'verification-secret',
    };

    await expect(subscribeCoexistenceWaba(args, transport)).resolves.toEqual({
      success: true,
    });
    await expect(subscribeCoexistenceWaba(args, transport)).resolves.toEqual({
      success: true,
    });
    expect(calls).toBe(2);
  });
  it('completes WABA pagination at the pinned endpoint before verifying the phone state', async () => {
    const urls: string[] = [];

    const transport: CoexistenceFetch = async (url, init) => {
      urls.push(url.toString());
      expect(init.method).toBe('GET');
      expect(new Headers(init.headers).get('Authorization')).toBe(
        'Bearer business-token'
      );

      if (urls.length === 1)
        return Response.json({
          data: [{ id: '456' }],
          paging: {
            cursors: { after: 'page_2' },
            next: 'https://evil.example/steal?access_token=untrusted',
          },
        });

      if (urls.length === 2) return Response.json({ data: [{ id: '789' }] });

      return Response.json({
        id: '456',
        display_phone_number: '+1 (415) 555-0123',
        is_on_biz_app: true,
        platform_type: 'CLOUD_API',
      });
    };

    await expect(
      verifyCoexistencePhone(
        {
          wabaId: '321',
          phoneNumberId: '456',
          accessToken: 'business-token',
        },
        transport
      )
    ).resolves.toEqual({
      wabaId: '321',
      phoneNumberId: '456',
      displayPhoneNumber: '+1 (415) 555-0123',
      normalizedPhoneNumber: '14155550123',
    });
    expect(urls).toEqual([
      'https://graph.facebook.com/v27.0/321/phone_numbers?fields=id',
      'https://graph.facebook.com/v27.0/321/phone_numbers?fields=id&after=page_2',
      'https://graph.facebook.com/v27.0/456?fields=id%2Cdisplay_phone_number%2Cis_on_biz_app%2Cplatform_type',
    ]);
  });
  it('requires actual WhatsApp grants and app identity from debug_token', async () => {
    const transport: CoexistenceFetch = async (url, init) => {
      expect(url.pathname).toBe('/v27.0/debug_token');
      expect(url.searchParams.get('input_token')).toBe('business-token');
      expect(new Headers(init.headers).get('Authorization')).toBe(
        'Bearer app-token'
      );
      expect(init.method).toBe('GET');

      return Response.json({
        data: {
          app_id: '123',
          is_valid: true,
          expires_at: 4_000_000_000,
          scopes: [
            'whatsapp_business_management',
            'whatsapp_business_messaging',
          ],
        },
      });
    };

    await expect(
      validateCoexistenceToken(
        {
          expectedAppId: '123',
          accessToken: 'business-token',
          appAccessToken: 'app-token',
        },
        transport
      )
    ).resolves.toMatchObject({ app_id: '123', is_valid: true });
  });
  it('exchanges the code using the dedicated app credentials and official GET contract', async () => {
    const transport: CoexistenceFetch = async (url, init) => {
      expect(url.origin).toBe('https://graph.facebook.com');
      expect(url.pathname).toBe('/v27.0/oauth/access_token');
      expect(Object.fromEntries(url.searchParams)).toEqual({
        client_id: '123',
        client_secret: 'dedicated-secret',
        code: 'signup-code',
      });
      expect(init.method).toBe('GET');
      expect(init.redirect).toBe('error');
      expect(init.cache).toBe('no-store');
      expect(init.signal).toBeInstanceOf(AbortSignal);

      return Response.json({
        access_token: 'business-token',
        token_type: 'bearer',
      });
    };

    await expect(
      exchangeEmbeddedSignupCode(
        {
          appId: '123',
          appSecret: 'dedicated-secret',
          code: 'signup-code',
        },
        transport
      )
    ).resolves.toEqual({
      access_token: 'business-token',
      token_type: 'bearer',
    });
  });
});

const exchangeArgs = {
  appId: '123',
  appSecret: 'dedicated-secret',
  code: 'signup-code',
};

const tokenArgs = {
  expectedAppId: '123',
  accessToken: 'business-token',
  appAccessToken: 'app-token',
};

const phoneArgs = {
  wabaId: '321',
  phoneNumberId: '456',
  accessToken: 'business-token',
};

const subscriptionArgs = {
  wabaId: '321',
  accessToken: 'business-token',
  callbackUrl: 'https://crm.example/webhooks/coexistence',
  verifyToken: 'verification-secret',
};

const syncArgs = {
  phoneNumberId: '456',
  accessToken: 'business-token',
  syncType: 'history',
} as const;

const validDebugData = {
  app_id: '123',
  is_valid: true,
  expires_at: 4_000_000_000,
  scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
};

const validPhone = {
  id: '456',
  display_phone_number: '+1 415 555 0123',
  is_on_biz_app: true,
  platform_type: 'CLOUD_API',
};

describe('external schema and grant checks', () => {
  it.each([
    { ...validDebugData, app_id: '999' },
    { ...validDebugData, is_valid: false },
    { ...validDebugData, expires_at: 1 },
    { ...validDebugData, expires_at: 0 },
    { ...validDebugData, data_access_expires_at: 1 },
    { ...validDebugData, data_access_expires_at: 0 },
    { ...validDebugData, expires_at: '4000000000' },
    { ...validDebugData, scopes: [] },
    { ...validDebugData, scopes: ['whatsapp_business_management'] },
    { ...validDebugData, scopes: ['whatsapp_business_messaging'] },
    { app_id: '123', is_valid: true, expires_at: 4_000_000_000 },
    { app_id: '123', is_valid: true, scopes: validDebugData.scopes },
    { app_id: '123', scopes: validDebugData.scopes, expires_at: 4_000_000_000 },
  ])(
    'refuses invalid, foreign, expired, unknown-expiry, or incomplete token metadata: %j',
    async (data) => {
      const transport: CoexistenceFetch = async () => Response.json({ data });

      await expect(
        validateCoexistenceToken(tokenArgs, transport)
      ).rejects.toBeInstanceOf(CoexistenceMetaError);
    }
  );

  it('accepts explicit future token and data-access expiries', async () => {
    const transport: CoexistenceFetch = async () =>
      Response.json({
        data: { ...validDebugData, data_access_expires_at: 4_000_000_001 },
      });

    await expect(
      validateCoexistenceToken(tokenArgs, transport)
    ).resolves.toMatchObject({
      data_access_expires_at: 4_000_000_001,
    });
  });

  it.each([
    {},
    { access_token: 'business-token' },
    { token_type: 'bearer' },
    { access_token: 123, token_type: 'bearer' },
    { access_token: 'business-token', token_type: 'unknown' },
    {
      access_token: 'business-token',
      token_type: 'bearer',
      error: { code: 190, message: 'secret' },
    },
  ])('refuses malformed exchange success: %j', async (body) => {
    const transport: CoexistenceFetch = async () => Response.json(body);

    await expect(
      exchangeEmbeddedSignupCode(exchangeArgs, transport)
    ).rejects.toMatchObject({ kind: 'invalid_response' });
  });
});

describe('authoritative phone verification', () => {
  it.each([false, true])(
    'requires a unique full number across the entire discovery listing (ambiguous: %s)',
    async (ambiguous) => {
      const calls: string[] = [];

      const transport: CoexistenceFetch = async (url) => {
        calls.push(url.pathname);

        if (calls.length === 1) {
          expect(url.searchParams.get('fields')).toBe(
            'id,display_phone_number'
          );

          return Response.json({
            data: [{ id: '456', display_phone_number: '+1 415 555 0123' }],
            paging: { next: 'ignored', cursors: { after: 'cursor_2' } },
          });
        }

        if (calls.length === 2)
          return Response.json({
            data: [
              {
                id: '789',
                display_phone_number: ambiguous
                  ? '+1 415 555 0123'
                  : '+1 415 123 0123',
              },
            ],
          });

        return Response.json(validPhone);
      };

      const result = verifyCoexistencePhone(
        {
          wabaId: phoneArgs.wabaId,
          accessToken: phoneArgs.accessToken,
          discoveryPhone: '+14155550123',
        },
        transport
      );

      if (ambiguous)
        await expect(result).rejects.toMatchObject({ kind: 'validation' });
      else
        await expect(result).resolves.toMatchObject({ phoneNumberId: '456' });

      expect(calls).toHaveLength(ambiguous ? 2 : 3);
    }
  );
  it('rejects a foreign phone without probing that phone', async () => {
    let calls = 0;

    const transport: CoexistenceFetch = async () => {
      calls++;

      return Response.json({ data: [{ id: '999' }] });
    };

    await expect(
      verifyCoexistencePhone(phoneArgs, transport)
    ).rejects.toMatchObject({ kind: 'validation' });
    expect(calls).toBe(1);
  });

  it('finds a phone on a later page and ignores terminal cursors with no next page', async () => {
    let calls = 0;

    const transport: CoexistenceFetch = async (url) => {
      calls++;

      if (calls === 1)
        return Response.json({
          data: [],
          paging: { next: 'ignored', cursors: { after: 'cursor_2' } },
        });

      if (calls === 2) {
        expect(url.searchParams.get('after')).toBe('cursor_2');

        return Response.json({
          data: [{ id: '456' }],
          paging: { cursors: { after: 'terminal' } },
        });
      }

      return Response.json(validPhone);
    };

    await expect(
      verifyCoexistencePhone(phoneArgs, transport)
    ).resolves.toMatchObject({ normalizedPhoneNumber: '14155550123' });
    expect(calls).toBe(3);
  });

  it.each([
    { ...validPhone, id: '999' },
    { ...validPhone, is_on_biz_app: false },
    { ...validPhone, platform_type: 'ON_PREMISE' },
    { ...validPhone, display_phone_number: '123' },
    { ...validPhone, display_phone_number: 'not a phone +1 415 555 0123' },
    {
      id: '456',
      display_phone_number: '+1 415 555 0123',
      platform_type: 'CLOUD_API',
    },
    { id: '456', display_phone_number: '+1 415 555 0123', is_on_biz_app: true },
  ])(
    'refuses a mismatched or non-coexistence phone response: %j',
    async (body) => {
      let calls = 0;

      const transport: CoexistenceFetch = async () => {
        calls++;

        return Response.json(calls === 1 ? { data: [{ id: '456' }] } : body);
      };

      await expect(
        verifyCoexistencePhone(phoneArgs, transport)
      ).rejects.toBeInstanceOf(CoexistenceMetaError);
    }
  );

  it('does not accept a matching early page if a later page fails', async () => {
    let calls = 0;

    const transport: CoexistenceFetch = async () => {
      calls++;

      if (calls === 1)
        return Response.json({
          data: [{ id: '456' }],
          paging: { next: 'ignored', cursors: { after: 'cursor_2' } },
        });

      return Response.json(
        { error: { code: 190, message: 'secret' } },
        { status: 400 }
      );
    };

    await expect(
      verifyCoexistencePhone(phoneArgs, transport)
    ).rejects.toMatchObject({ kind: 'http' });
    expect(calls).toBe(2);
  });

  it.each([
    { data: [{ id: 456 }] },
    { data: [{ id: '456' }], paging: { next: 'https://evil.example/' } },
    {
      data: [{ id: '456' }],
      paging: { next: 'ignored', cursors: { after: 'https://evil.example/' } },
    },
    {
      data: [{ id: '456' }],
      paging: { next: 'ignored', cursors: { after: 'x'.repeat(2049) } },
    },
  ])('fails closed on malformed pages or cursors: %j', async (body) => {
    let calls = 0;

    const transport: CoexistenceFetch = async () => {
      calls++;

      return Response.json(body);
    };

    await expect(
      verifyCoexistencePhone(phoneArgs, transport)
    ).rejects.toBeInstanceOf(CoexistenceMetaError);
    expect(calls).toBe(1);
  });

  it('rejects repeated cursors rather than looping', async () => {
    let calls = 0;

    const transport: CoexistenceFetch = async () => {
      calls++;

      return Response.json({
        data: [{ id: '456' }],
        paging: { next: 'ignored', cursors: { after: 'repeat' } },
      });
    };

    await expect(
      verifyCoexistencePhone(phoneArgs, transport)
    ).rejects.toMatchObject({ kind: 'pagination' });
    expect(calls).toBe(2);
  });

  it('refuses an unbounded listing even when every cursor is distinct and the phone was found', async () => {
    let calls = 0;

    const transport: CoexistenceFetch = async () => {
      calls++;

      return Response.json({
        data: [{ id: '456' }],
        paging: { next: 'ignored', cursors: { after: `page_${calls}` } },
      });
    };

    await expect(
      verifyCoexistencePhone(phoneArgs, transport)
    ).rejects.toMatchObject({ kind: 'pagination' });
    expect(calls).toBe(100);
  });
});

describe('subscription safeguards', () => {
  it.each([
    'http://crm.example/webhook',
    'https://user:password@crm.example/webhook',
    'https://user@crm.example/webhook',
    'https://%75ser:password@crm.example/webhook',
    'https://crm.example/webhook#fragment',
    'https://crm.example/webhook#',
    'https://@crm.example/webhook',
    'https:crm.example/webhook',
    '//crm.example/webhook',
    ' https://crm.example/webhook',
    'https://crm.example/back\\\\slash',
    `https://crm.example/${'x'.repeat(200)}`,
    'not a URL',
    '',
  ])('rejects unsafe callback %s before any request', async (callbackUrl) => {
    let calls = 0;

    const transport: CoexistenceFetch = async () => {
      calls++;

      return Response.json({ success: true });
    };

    await expect(
      subscribeCoexistenceWaba({ ...subscriptionArgs, callbackUrl }, transport)
    ).rejects.toMatchObject({ kind: 'input' });
    expect(calls).toBe(0);
  });

  it.each(['', ' ', '\r\nsecret'])(
    'refuses an empty or header-unsafe verification token',
    async (verifyToken) => {
      let calls = 0;

      const transport: CoexistenceFetch = async () => {
        calls++;

        return Response.json({ success: true });
      };

      await expect(
        subscribeCoexistenceWaba(
          { ...subscriptionArgs, verifyToken },
          transport
        )
      ).rejects.toMatchObject({ kind: 'input' });
      expect(calls).toBe(0);
    }
  );

  it.each([{}, { success: false }, { success: 'true' }])(
    'rejects malformed subscription success: %j',
    async (body) => {
      const transport: CoexistenceFetch = async () => Response.json(body);

      await expect(
        subscribeCoexistenceWaba(subscriptionArgs, transport)
      ).rejects.toMatchObject({ kind: 'invalid_response' });
    }
  );
});

describe('HTTP failure safety', () => {
  it('discards Meta error text and never exposes exchange query secrets in errors', async () => {
    const transport: CoexistenceFetch = async () =>
      Response.json(
        {
          error: {
            code: 190,
            message: 'dedicated-secret signup-code business-token secret-body',
          },
        },
        { status: 400 }
      );

    try {
      await exchangeEmbeddedSignupCode(exchangeArgs, transport);
      expect.fail('Expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(CoexistenceMetaError);

      if (!(error instanceof CoexistenceMetaError)) throw error;

      expect(error.kind).toBe('http');
      expect(error.httpStatus).toBe(400);
      expect(error.metaCode).toBe(190);
      expect(error.cause).toBeUndefined();
      expect(`${error.stack} ${JSON.stringify(error)}`).not.toMatch(
        /dedicated-secret|signup-code|business-token|secret-body|graph.facebook.com/
      );
    }
  });

  it('discards a fetch exception containing the full secret exchange URL', async () => {
    const transport: CoexistenceFetch = async (url) => {
      throw new Error(url.toString());
    };

    try {
      await exchangeEmbeddedSignupCode(exchangeArgs, transport);
      expect.fail('Expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(CoexistenceMetaError);

      if (!(error instanceof CoexistenceMetaError)) throw error;

      expect(error.kind).toBe('transport');
      expect(error.cause).toBeUndefined();
      expect(`${error.stack} ${JSON.stringify(error)}`).not.toMatch(
        /dedicated-secret|signup-code|graph.facebook.com/
      );
    }
  });

  it('refuses a returned redirect without following the Location or retrying a sync', async () => {
    let calls = 0;

    const transport: CoexistenceFetch = async (_url, init) => {
      calls++;
      expect(init.redirect).toBe('error');

      return new Response(null, {
        status: 302,
        headers: { Location: 'https://evil.example/business-token' },
      });
    };

    await expect(
      initiateCoexistenceSync(
        { ...syncArgs, historyReceipt: armHistoryPermit() },
        transport
      )
    ).resolves.toEqual({ outcome: 'ambiguous', reason: 'transport' });
    expect(calls).toBe(1);
  });

  it.each(['fetch', 'body'])(
    'bounds a hung %s, aborts, and never repeats the sync request',
    async (stage) => {
      vi.useFakeTimers();
      let calls = 0;
      let signal: AbortSignal | null | undefined;

      const transport: CoexistenceFetch = async (_url, init) => {
        calls++;
        signal = init.signal;

        if (stage === 'body')
          return new Response(new ReadableStream<Uint8Array>());

        if (!init.signal) throw new Error('Expected owned signal');
        const ownedSignal = init.signal;

        return new Promise<Response>((_resolve, reject) => {
          ownedSignal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true }
          );
        });
      };

      try {
        const pending = initiateCoexistenceSync(
          { ...syncArgs, historyReceipt: armHistoryPermit() },
          transport
        );

        const checked = expect(pending).resolves.toEqual({
          outcome: 'ambiguous',
          reason: 'transport',
        });

        await vi.advanceTimersByTimeAsync(COEXISTENCE_REQUEST_TIMEOUT_MS);
        await checked;
        expect(signal?.aborted).toBe(true);
        expect(calls).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it('bounds code exchange too and sanitizes the timeout', async () => {
    vi.useFakeTimers();

    const transport: CoexistenceFetch = async (_url, init) => {
      if (!init.signal) throw new Error('Expected owned signal');
      const signal = init.signal;

      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true }
        );
      });
    };

    try {
      const checked = expect(
        exchangeEmbeddedSignupCode(exchangeArgs, transport)
      ).rejects.toMatchObject({ kind: 'transport' });

      await vi.advanceTimersByTimeAsync(COEXISTENCE_REQUEST_TIMEOUT_MS);
      await checked;
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    '../register',
    '456/deregister',
    'https://evil.example',
    '456?access_token=secret',
  ])(
    'rejects untrusted identifiers %s without sending',
    async (phoneNumberId) => {
      let calls = 0;

      const transport: CoexistenceFetch = async () => {
        calls++;

        return Response.json({});
      };

      await expect(
        verifyCoexistencePhone({ ...phoneArgs, phoneNumberId }, transport)
      ).rejects.toMatchObject({ kind: 'input' });
      await expect(
        initiateCoexistenceSync({ ...syncArgs, phoneNumberId }, transport)
      ).rejects.toMatchObject({ kind: 'input' });
      expect(calls).toBe(0);
    }
  );

  it('refuses missing runtime secrets without sending or leaking validation input', async () => {
    let calls = 0;

    const transport: CoexistenceFetch = async () => {
      calls++;

      return Response.json({});
    };

    await expect(
      exchangeEmbeddedSignupCode({ ...exchangeArgs, appSecret: '' }, transport)
    ).rejects.toMatchObject({ kind: 'input' });
    await expect(
      validateCoexistenceToken({ ...tokenArgs, appAccessToken: '' }, transport)
    ).rejects.toMatchObject({ kind: 'input' });
    await expect(
      verifyCoexistencePhone({ ...phoneArgs, accessToken: '' }, transport)
    ).rejects.toMatchObject({ kind: 'input' });
    await expect(
      subscribeCoexistenceWaba(
        { ...subscriptionArgs, verifyToken: '' },
        transport
      )
    ).rejects.toMatchObject({ kind: 'input' });
    await expect(
      initiateCoexistenceSync({ ...syncArgs, accessToken: '' }, transport)
    ).rejects.toMatchObject({ kind: 'input' });
    expect(calls).toBe(0);
  });
});

describe('one-shot sync uncertainty', () => {
  it.each(['smb_app_state_sync', 'history'] as const)(
    'has no implicit transport for %s',
    async (syncType) => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);

      try {
        await expect(
          // @ts-expect-error Runtime callers without a transport must also fail closed.
          initiateCoexistenceSync({
            ...syncArgs,
            syncType,
            historyReceipt: armHistoryPermit(),
          })
        ).resolves.toEqual({ outcome: 'not_sent' });
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    }
  );

  it.each([2593107, 2593108, 190])(
    'returns explicit rejection code %i without retrying or leaking Meta text',
    async (code) => {
      let calls = 0;

      const transport: CoexistenceFetch = async () => {
        calls++;

        return Response.json(
          { error: { code, message: 'business-token secret-body' } },
          { status: 400 }
        );
      };

      await expect(
        initiateCoexistenceSync(
          { ...syncArgs, historyReceipt: armHistoryPermit() },
          transport
        )
      ).resolves.toEqual({
        outcome: 'rejected',
        httpStatus: 400,
        metaCode: code,
      });
      expect(calls).toBe(1);
    }
  );

  it.each([
    {},
    { request_id: 'request-1' },
    { messaging_product: 'whatsapp' },
    { messaging_product: 'whatsapp', request_id: '' },
    { messaging_product: 'whatsapp', request_id: 123 },
    { messaging_product: 'other', request_id: 'request-1' },
    {
      messaging_product: 'whatsapp',
      request_id: 'request-1',
      error: { code: 1, message: 'secret' },
    },
  ])(
    'marks malformed success ambiguous and never retries: %j',
    async (body) => {
      let calls = 0;

      const transport: CoexistenceFetch = async () => {
        calls++;

        return Response.json(body);
      };

      await expect(
        initiateCoexistenceSync(
          { ...syncArgs, historyReceipt: armHistoryPermit() },
          transport
        )
      ).resolves.toEqual({
        outcome: 'ambiguous',
        reason: 'invalid_response',
        httpStatus: 200,
      });
      expect(calls).toBe(1);
    }
  );

  it.each([500, 502, 503])(
    'treats structured server error %i as ambiguous without retrying',
    async (status) => {
      let calls = 0;

      const transport: CoexistenceFetch = async () => {
        calls++;

        return Response.json(
          { error: { code: 2, message: 'temporary failure' } },
          { status }
        );
      };

      expect(
        await initiateCoexistenceSync(
          {
            phoneNumberId: '456',
            accessToken: 'business-token',
            syncType: 'history',
            historyReceipt: armHistoryPermit(),
          },
          transport
        )
      ).toEqual({
        outcome: 'ambiguous',
        reason: 'server_error',
        httpStatus: status,
      });
      expect(calls).toBe(1);
    }
  );

  it('does not call an unknown HTTP response a confirmed rejection', async () => {
    let calls = 0;

    const transport: CoexistenceFetch = async () => {
      calls++;

      return new Response('secret-body', { status: 502 });
    };

    await expect(
      initiateCoexistenceSync(
        { ...syncArgs, historyReceipt: armHistoryPermit() },
        transport
      )
    ).resolves.toEqual({
      outcome: 'ambiguous',
      reason: 'invalid_response',
      httpStatus: 502,
    });
    expect(calls).toBe(1);
  });

  it('marks a transport exception ambiguous without retrying or returning its secret URL', async () => {
    let calls = 0;

    const transport: CoexistenceFetch = async (url) => {
      calls++;
      throw new Error(`${url}?access_token=business-token`);
    };

    await expect(
      initiateCoexistenceSync(
        { ...syncArgs, historyReceipt: armHistoryPermit() },
        transport
      )
    ).resolves.toEqual({ outcome: 'ambiguous', reason: 'transport' });
    expect(calls).toBe(1);
  });
  it('treats a non-JSON success as ambiguous rather than rejected or accepted', async () => {
    let calls = 0;

    const transport: CoexistenceFetch = async () => {
      calls++;

      return new Response('secret-body');
    };

    await expect(
      initiateCoexistenceSync(
        { ...syncArgs, historyReceipt: armHistoryPermit() },
        transport
      )
    ).resolves.toEqual({
      outcome: 'ambiguous',
      reason: 'invalid_response',
      httpStatus: 200,
    });
    expect(calls).toBe(1);
  });
});
