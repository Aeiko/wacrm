import { createServer } from 'node:http';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { listenForFetch } from '@/test/http-server';
import { withRequestDeadline } from '@/lib/request-deadline';
import {
  isDefinitiveConnectionRejection,
  listWabaPhoneNumbers,
  verifyPhoneNumber,
  MetaApiError,
  registerPhoneNumber,
  subscribeWabaToApp,
} from './meta-api';

const realFetch = globalThis.fetch;
let origin: string;
let status: number;
let body: string;
let mode: 'normal' | 'redirect' | 'drop' | 'truncated' | 'slow';
let requests: string[];
let pages: string[] | undefined;
let authorization: (string | undefined)[];

const server = createServer((request, response) => {
  requests.push(request.url ?? '');
  authorization.push(request.headers.authorization);

  if (mode === 'drop') {
    request.socket.destroy();

    return;
  }

  if (mode === 'redirect') {
    response.writeHead(307, { Location: `${origin}/redirect-target` });
    response.end();

    return;
  }

  response.setHeader('Content-Type', 'application/json');

  if (mode === 'truncated') response.setHeader('Content-Length', '1000');
  response.writeHead(status);

  if (mode === 'slow') {
    response.write('{"success":');

    return;
  }

  response.end(pages?.shift() ?? body);
});

beforeAll(async () => {
  origin = await listenForFetch(server);
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => {
  status = 200;
  body = '{"success":true}';
  mode = 'normal';
  requests = [];
  pages = undefined;
  authorization = [];
  // Replace only the external HTTP boundary; requests still exercise native fetch and body streams.
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));

    if (url.origin !== 'https://graph.facebook.com')
      throw new Error('Unexpected fixture URL');

    return realFetch(`${origin}${url.pathname}${url.search}`, init);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each([
  [
    'registration',
    () =>
      registerPhoneNumber({
        phoneNumberId: 'P',
        accessToken: 'fixture-token',
        pin: '123456',
      }),
  ],
  [
    'subscription',
    () => subscribeWabaToApp({ wabaId: 'W', accessToken: 'fixture-token' }),
  ],
])('%s HTTP outcome', (_name, call) => {
  async function failure(): Promise<Error> {
    try {
      await call();
    } catch (error) {
      expect(requests).toHaveLength(1);

      if (error instanceof Error) return error;
      throw error;
    }

    throw new Error('Expected connection mutation to fail');
  }

  it('confirms explicit success without retry', async () => {
    await call();
    expect(requests).toHaveLength(1);
  });

  it('preserves structured rejection diagnostics without claiming no external effects', async () => {
    status = 400;
    body = JSON.stringify({
      error: {
        message: 'Incorrect PIN',
        code: 133005,
        error_subcode: 7,
        type: 'OAuthException',
        fbtrace_id: 'fixture-trace',
        error_data: { details: 'Check the PIN' },
      },
    });
    const error = await failure();

    expect(error).toBeInstanceOf(MetaApiError);
    expect(error).toMatchObject({
      message: 'Incorrect PIN',
      code: 133005,
      subcode: 7,
      type: 'OAuthException',
      fbtraceId: 'fixture-trace',
      details: 'Check the PIN',
      httpStatus: 400,
    });
    expect(isDefinitiveConnectionRejection(error)).toBe(true);
  });

  it.each([
    [500, { message: 'Server failed', code: 100 }],
    [408, { message: 'Request timed out', code: 100 }],
    [429, { message: 'Rate limited', code: 4 }],
    [400, { message: 'Transient', code: 100, is_transient: true }],
    [400, { message: 'No numeric code' }],
    [400, { message: 'String code', code: '100' }],
    [400, { message: 'Zero code', code: 0 }],
    [400, { message: 'Negative code', code: -1 }],
    [400, { message: 'Fractional code', code: 1.5 }],
    [400, { code: 100 }],
    [400, { message: 123, code: 100 }],
  ])('keeps status %i / %j uncertain', async (httpStatus, errorBody) => {
    status = httpStatus;
    body = JSON.stringify({ error: errorBody });
    expect(isDefinitiveConnectionRejection(await failure())).toBe(false);
  });

  it.each([
    '',
    'private-token-not-json',
    'null',
    '[]',
    '{}',
    '{"success":false}',
    '{"success":"true"}',
    '{"success":true,"error":{"message":"contradictory"}}',
    JSON.stringify({ success: true, padding: 'private-token'.repeat(6000) }),
  ])(
    'rejects malformed or oversized success body without exposing it',
    async (invalidBody) => {
      body = invalidBody;
      const error = await failure();

      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({
        message: 'Invalid Meta connection response',
      });
      expect(isDefinitiveConnectionRejection(error)).toBe(false);
    }
  );

  it.each(['redirect', 'drop', 'truncated', 'slow'] as const)(
    'keeps %s uncertain, without redirect follow or retry',
    async (failureMode) => {
      mode = failureMode;
      const error = await withRequestDeadline(Date.now() + 100, failure);

      expect(error).toBeInstanceOf(Error);
      expect(isDefinitiveConnectionRejection(error)).toBe(false);
      expect(requests).not.toContain('/redirect-target');
    }
  );
});

describe('credential proof', () => {
  it('validates the requested phone metadata', async () => {
    body = JSON.stringify({
      id: '111',
      display_phone_number: '+1 555',
      verified_name: 'Fixture',
      quality_rating: 'GREEN',
    });
    await expect(
      verifyPhoneNumber({ phoneNumberId: '111', accessToken: 'fixture-token' })
    ).resolves.toEqual({
      id: '111',
      display_phone_number: '+1 555',
      verified_name: 'Fixture',
      quality_rating: 'GREEN',
    });
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0], origin).pathname).toBe('/v21.0/111');
    expect(authorization).toEqual(['Bearer fixture-token']);
  });

  it.each([
    {},
    null,
    [],
    { id: '111' },
    { id: 111, display_phone_number: '+1' },
    { id: '111', display_phone_number: 123 },
    { id: '111', display_phone_number: '' },
    { id: '111', display_phone_number: '+1', quality_rating: {} },
  ])('rejects malformed phone proof %j', async (invalidPhone) => {
    body = JSON.stringify(invalidPhone);
    await expect(
      verifyPhoneNumber({ phoneNumberId: '111', accessToken: 'fixture-token' })
    ).rejects.toThrow('Invalid Meta connection response');
  });

  it('rejects a successful response for a different phone', async () => {
    body = JSON.stringify({ id: '222', display_phone_number: '+1 555' });
    await expect(
      verifyPhoneNumber({ phoneNumberId: '111', accessToken: 'fixture-token' })
    ).rejects.toThrow('Invalid Meta connection response');
  });

  it('exhausts pages on the expected Graph path using validated cursors, never provider URLs', async () => {
    pages = [
      JSON.stringify({
        data: [{ id: '111' }],
        paging: {
          next: 'https://foreign.invalid/other?access_token=private-provider-token',
          cursors: { after: 'cursor+/=' },
        },
      }),
      JSON.stringify({
        data: [{ id: '222', display_phone_number: '+2' }],
        paging: { cursors: { after: 'terminal' } },
      }),
    ];
    await expect(
      listWabaPhoneNumbers({ wabaId: '333', accessToken: 'fixture-token' })
    ).resolves.toEqual([
      { id: '111' },
      { id: '222', display_phone_number: '+2' },
    ]);
    expect(requests).toHaveLength(2);
    expect(
      requests.every(
        (url) => new URL(url, origin).pathname === '/v21.0/333/phone_numbers'
      )
    ).toBe(true);
    expect(new URL(requests[1], origin).searchParams.get('after')).toBe(
      'cursor+/='
    );
    expect(requests.join(' ')).not.toContain('private-provider-token');
    expect(authorization).toEqual([
      'Bearer fixture-token',
      'Bearer fixture-token',
    ]);
  });

  it.each([
    {},
    { data: null },
    { data: {} },
    { data: [{}] },
    { data: [{ id: 111 }] },
    { data: [{ id: 'invalid' }] },
    { data: [{ id: '111', display_phone_number: 123 }] },
    { data: [], paging: null },
    { data: [], paging: { next: '' } },
    {
      data: [],
      paging: { next: 'next', cursors: { after: 'bad?access_token=secret' } },
    },
    {
      data: [],
      paging: { next: 'next', cursors: { after: 'a'.repeat(2049) } },
    },
  ])('rejects malformed WABA page %j', async (invalidPage) => {
    body = JSON.stringify(invalidPage);
    await expect(
      listWabaPhoneNumbers({ wabaId: '333', accessToken: 'fixture-token' })
    ).rejects.toThrow('Invalid Meta connection response');
  });

  it('accepts a validated empty complete WABA list', async () => {
    body = '{"data":[]}';
    await expect(
      listWabaPhoneNumbers({ wabaId: '333', accessToken: 'fixture-token' })
    ).resolves.toEqual([]);
  });

  it('rejects missing continuation evidence rather than returning partial proof', async () => {
    body = JSON.stringify({ data: [{ id: '111' }], paging: { next: 'next' } });
    await expect(
      listWabaPhoneNumbers({ wabaId: '333', accessToken: 'fixture-token' })
    ).rejects.toThrow('Invalid Meta connection pagination');
    expect(requests).toHaveLength(1);
  });

  it('rejects repeated cursors rather than looping or returning partial proof', async () => {
    body = JSON.stringify({
      data: [{ id: '111' }],
      paging: { next: 'next', cursors: { after: 'same' } },
    });
    await expect(
      listWabaPhoneNumbers({ wabaId: '333', accessToken: 'fixture-token' })
    ).rejects.toThrow('Invalid Meta connection pagination');
    expect(requests).toHaveLength(2);
  });

  it('fails closed when ten pages do not complete the WABA list', async () => {
    pages = Array.from({ length: 10 }, (_, page) =>
      JSON.stringify({
        data: [{ id: '111' }],
        paging: { next: 'next', cursors: { after: `cursor${page}` } },
      })
    );
    await expect(
      listWabaPhoneNumbers({ wabaId: '333', accessToken: 'fixture-token' })
    ).rejects.toThrow('Incomplete Meta connection pagination');
    expect(requests).toHaveLength(10);
  });
});

describe.each([
  [
    'phone',
    () =>
      verifyPhoneNumber({ phoneNumberId: '111', accessToken: 'fixture-token' }),
  ],
  [
    'WABA',
    () => listWabaPhoneNumbers({ wabaId: '333', accessToken: 'fixture-token' }),
  ],
])('%s proof transport', (_name, call) => {
  it.each(['redirect', 'drop', 'truncated', 'slow'] as const)(
    'rejects %s without follow or retry',
    async (failureMode) => {
      mode = failureMode;
      await expect(
        withRequestDeadline(Date.now() + 100, async () => {
          await call();
        })
      ).rejects.toThrow();
      expect(requests).toHaveLength(1);
    }
  );

  it.each(['private-token-invalid-json', 'x'.repeat(65537)])(
    'rejects invalid or oversized body without leaking it',
    async (invalidBody) => {
      body = invalidBody;
      await expect(call()).rejects.toThrow('Invalid Meta connection response');
    }
  );

  it('does not accept partial HTTP content as complete ownership evidence', async () => {
    status = 206;
    body = JSON.stringify({
      id: '111',
      display_phone_number: '+1',
      data: [{ id: '111' }],
    });
    await expect(call()).rejects.toThrow('Invalid Meta connection response');
  });

  it('preserves structured Graph diagnostics but never treats a read as mutation rejection', async () => {
    status = 500;
    body = JSON.stringify({
      error: { message: 'Graph unavailable', code: 100 },
    });
    await expect(call()).rejects.toMatchObject({
      name: 'MetaApiError',
      message: 'Graph unavailable',
      code: 100,
      httpStatus: 500,
    });
    expect(requests).toHaveLength(1);
  });
});

it.each([
  () =>
    verifyPhoneNumber({
      phoneNumberId: '../other?access_token=secret',
      accessToken: 'fixture-token',
    }),
  () =>
    listWabaPhoneNumbers({
      wabaId: '../other?access_token=secret',
      accessToken: 'fixture-token',
    }),
])('rejects nonnumeric resource IDs before HTTP', async (call) => {
  await expect(call()).rejects.toThrow('Invalid Meta connection request');
  expect(requests).toHaveLength(0);
});

it('does not classify unrelated MetaApiErrors or arbitrary errors as definitive', () => {
  expect(
    isDefinitiveConnectionRejection(
      new MetaApiError('Not from connection transport', {
        httpStatus: 400,
        code: 100,
      })
    )
  ).toBe(false);
  expect(isDefinitiveConnectionRejection(new Error('Unknown'))).toBe(false);
  expect(isDefinitiveConnectionRejection(null)).toBe(false);
});
