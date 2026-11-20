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
import { deadlineFetch, withRequestDeadline } from '@/lib/request-deadline';
import {
  CoexistenceMetaError,
  exchangeEmbeddedSignupCode,
  initiateCoexistenceSync,
  type CoexistenceFetch,
} from './coexistence-meta';
import { armHistoryPermit } from './coexistence-meta.test-helper';

let origin: string;
let body: Uint8Array;
let status: number;
let mode: 'json' | 'headers' | 'body' | 'redirect';
let received = Promise.withResolvers<void>();
let closed = Promise.withResolvers<void>();
let requests: number;

const exchangeArgs = {
  appId: '123',
  appSecret: 'fixture-secret',
  code: 'fixture-code',
};

const syncArgs = {
  phoneNumberId: '456',
  accessToken: 'fixture-token',
  syncType: 'history',
} as const;

const server = createServer((_request, response) => {
  requests++;
  response.on('close', () => closed.resolve());
  received.resolve();

  if (mode === 'headers') return;

  if (mode === 'redirect') {
    response.writeHead(307, { Location: `${origin}/redirect-target` });
    response.end();

    return;
  }

  response.writeHead(status, { 'Content-Type': 'application/json' });

  if (mode === 'body') {
    response.write('{"access_token":"');

    return;
  }

  response.end(body);
});

// Only the test transport maps the provider to loopback; production has no host override.
const transport: CoexistenceFetch = (url, init) => {
  expect(url.origin).toBe('https://graph.facebook.com');
  expect(url.pathname.startsWith('/v27.0/')).toBe(true);

  return deadlineFetch(`${origin}${url.pathname}${url.search}`, init);
};

beforeAll(async () => {
  origin = await listenForFetch(server);
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});

beforeEach(() => {
  body = Buffer.from(
    JSON.stringify({ access_token: 'fixture-token', token_type: 'bearer' })
  );
  status = 200;
  mode = 'json';
  received = Promise.withResolvers<void>();
  closed = Promise.withResolvers<void>();
  requests = 0;
});

afterEach(() => {
  server.closeIdleConnections();
});

describe('Coexistence HTTP transport ownership', () => {
  it('confirms a valid exchange exactly once', async () => {
    await expect(
      exchangeEmbeddedSignupCode(exchangeArgs, transport)
    ).resolves.toEqual({ access_token: 'fixture-token', token_type: 'bearer' });
    expect(requests).toBe(1);
  });

  it.each([
    '',
    'private-body',
    '{"access_token":"fixture-token","token_type":"bearer","extra":1e999}',
  ])(
    'rejects empty, malformed, or nonfinite JSON without exposing it',
    async (invalid) => {
      body = Buffer.from(invalid);
      await expect(
        exchangeEmbeddedSignupCode(exchangeArgs, transport)
      ).rejects.toMatchObject({ kind: 'invalid_response', httpStatus: 200 });
      expect(requests).toBe(1);
    }
  );

  it('rejects invalid UTF-8 rather than replacing bytes in a token', async () => {
    body = Buffer.concat([
      Buffer.from('{"access_token":"'),
      Buffer.from([0xff]),
      Buffer.from('","token_type":"bearer"}'),
    ]);
    await expect(
      exchangeEmbeddedSignupCode(exchangeArgs, transport)
    ).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it.each(['headers', 'body'] as const)(
    'inherits cancellation during %s and waits for native closure',
    async (stage) => {
      mode = stage;
      const controller = new AbortController();

      const pending = withRequestDeadline(
        Date.now() + 60_000,
        () => exchangeEmbeddedSignupCode(exchangeArgs, transport),
        controller.signal
      );

      const checked = expect(pending).rejects.toMatchObject({
        kind: 'transport',
      });

      await received.promise;
      controller.abort();
      await checked;
      await closed.promise;
      expect(requests).toBe(1);
    }
  );

  it.each(['headers', 'body'] as const)(
    'honors explicit cancellation during %s',
    async (stage) => {
      mode = stage;
      const controller = new AbortController();

      const checked = expect(
        exchangeEmbeddedSignupCode(
          { ...exchangeArgs, signal: controller.signal },
          transport
        )
      ).rejects.toMatchObject({ kind: 'transport' });

      await received.promise;
      controller.abort();
      await checked;
      await closed.promise;
      expect(requests).toBe(1);
    }
  );

  it('does not dispatch under an expired inherited deadline or explicit cancellation', async () => {
    await expect(
      withRequestDeadline(Date.now() - 1, () =>
        exchangeEmbeddedSignupCode(exchangeArgs, transport)
      )
    ).rejects.toMatchObject({ kind: 'transport' });
    await expect(
      exchangeEmbeddedSignupCode(
        { ...exchangeArgs, signal: AbortSignal.abort() },
        transport
      )
    ).rejects.toMatchObject({ kind: 'transport' });
    expect(requests).toBe(0);
  });

  it('uses the earlier inherited deadline, not a fresh ten-second timeout', async () => {
    mode = 'body';

    const pending = withRequestDeadline(Date.now() + 2000, () =>
      exchangeEmbeddedSignupCode(exchangeArgs, transport)
    );

    const checked = expect(pending).rejects.toMatchObject({
      kind: 'transport',
    });

    await received.promise;
    await checked;
    await closed.promise;
    expect(requests).toBe(1);
  }, 8000);

  it('does not detach a network operation whose abort settlement is still pending', async () => {
    mode = 'headers';
    const controller = new AbortController();
    const release = Promise.withResolvers<void>();
    let finished = false;

    const heldTransport: CoexistenceFetch = async (url, init) => {
      try {
        return await transport(url, init);
      } catch (error) {
        await release.promise;
        throw error;
      }
    };

    const pending = exchangeEmbeddedSignupCode(
      { ...exchangeArgs, signal: controller.signal },
      heldTransport
    ).finally(() => {
      finished = true;
    });

    const checked = expect(pending).rejects.toMatchObject({
      kind: 'transport',
    });

    try {
      await received.promise;
      controller.abort();
      await closed.promise;
      expect(finished).toBe(false);
    } finally {
      release.resolve();
      await checked;
    }

    expect(finished).toBe(true);
    expect(requests).toBe(1);
  });

  it('does not dispatch when an inherited deadline or explicit signal already expired', async () => {
    await expect(
      withRequestDeadline(Date.now() - 1, () =>
        exchangeEmbeddedSignupCode(exchangeArgs, transport)
      )
    ).rejects.toMatchObject({ kind: 'transport' });
    await expect(
      exchangeEmbeddedSignupCode(
        { ...exchangeArgs, signal: AbortSignal.abort() },
        transport
      )
    ).rejects.toMatchObject({ kind: 'transport' });
    expect(requests).toBe(0);
  });

  it('refuses redirects without follow or exchange retry', async () => {
    mode = 'redirect';
    await expect(
      exchangeEmbeddedSignupCode(exchangeArgs, transport)
    ).rejects.toMatchObject({ kind: 'transport' });
    expect(requests).toBe(1);
  });

  it('refuses missing, malformed, mismatched, expired, or cancelled history receipts without spending the permit', async () => {
    const receipt = armHistoryPermit();
    const args = { ...syncArgs, historyReceipt: receipt };

    const denied = [
      syncArgs,
      { ...args, historyReceipt: { ...receipt, extra: true } },
      { ...args, historyReceipt: { ...receipt, phone_number_id: '789' } },
      { ...args, historyReceipt: { ...receipt, request_id: 'other' } },
      {
        ...args,
        historyReceipt: {
          ...receipt,
          request_id: '12345678-1234-4234-8234-123456789abd',
        },
      },
      { ...args, historyReceipt: { ...receipt, deadline_at: 'tomorrow' } },
      {
        ...args,
        historyReceipt: { ...receipt, deadline_at: new Date().toISOString() },
      },
      { ...args, signal: AbortSignal.abort() },
    ];

    const send = vi.fn(transport);

    for (const candidate of denied) {
      await expect(initiateCoexistenceSync(candidate, send)).resolves.toEqual({
        outcome: 'not_sent',
      });
    }

    expect(send).not.toHaveBeenCalled();
    expect(requests).toBe(0);

    body = Buffer.from('{"messaging_product":"whatsapp","request_id":"sent"}');

    await expect(initiateCoexistenceSync(args, send)).resolves.toEqual({
      outcome: 'accepted',
      requestId: 'sent',
    });
    expect(requests).toBe(1);
  });

  it('does not dispatch if the receipt expires while consuming the permit', async () => {
    const receipt = armHistoryPermit();
    const args = { ...syncArgs, historyReceipt: receipt };
    const deadline = Date.parse(receipt.deadline_at);

    const clock = vi
      .spyOn(Date, 'now')
      .mockReturnValue(deadline)
      .mockReturnValueOnce(deadline - 1) // Request scope setup.
      .mockReturnValueOnce(deadline - 1); // Before consuming the permit.

    const send = vi.fn(transport);

    try {
      await expect(initiateCoexistenceSync(args, send)).resolves.toEqual({
        outcome: 'not_sent',
      });
    } finally {
      clock.mockRestore();
    }

    await expect(initiateCoexistenceSync(args, send)).resolves.toEqual({
      outcome: 'not_sent',
    });
    expect(send).not.toHaveBeenCalled();
    expect(requests).toBe(0);
  });

  it.each([500, 502, 503])(
    'preserves ambiguous sync status %i without retry',
    async (httpStatus) => {
      status = httpStatus;
      body = Buffer.from(
        JSON.stringify({ error: { code: 1, message: 'private-body' } })
      );
      const args = { ...syncArgs, historyReceipt: armHistoryPermit() };

      await expect(initiateCoexistenceSync(args, transport)).resolves.toEqual({
        outcome: 'ambiguous',
        reason: 'server_error',
        httpStatus,
      });
      await expect(initiateCoexistenceSync(args, transport)).resolves.toEqual({
        outcome: 'not_sent',
      });
      expect(requests).toBe(1);
    }
  );

  it.each(['0', '0123', '1'.repeat(33), '-1', ' 123'])(
    'rejects noncanonical app ID %s without HTTP',
    async (appId) => {
      await expect(
        exchangeEmbeddedSignupCode({ ...exchangeArgs, appId }, transport)
      ).rejects.toMatchObject({ kind: 'input' });
      expect(requests).toBe(0);
    }
  );

  it('bounds secret inputs and token results without disclosing their contents', async () => {
    await expect(
      exchangeEmbeddedSignupCode(
        { ...exchangeArgs, code: 'x'.repeat(32769) },
        transport
      )
    ).rejects.toMatchObject({ kind: 'input' });
    expect(requests).toBe(0);
    body = Buffer.from(
      JSON.stringify({ access_token: 'x'.repeat(32769), token_type: 'bearer' })
    );
    await expect(
      exchangeEmbeddedSignupCode(exchangeArgs, transport)
    ).rejects.toMatchObject({ kind: 'invalid_response' });
    expect(requests).toBe(1);
  });

  it('redacts errors including URLs, code, tokens and body', async () => {
    status = 400;
    body = Buffer.from(
      JSON.stringify({
        error: {
          code: 190,
          message: 'fixture-secret fixture-code fixture-token private-body',
        },
      })
    );

    try {
      await exchangeEmbeddedSignupCode(exchangeArgs, transport);
      expect.fail('Expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(CoexistenceMetaError);
      expect(String(error) + JSON.stringify(error)).not.toMatch(
        /fixture-secret|fixture-code|fixture-token|private-body|https:/
      );
    }
  });

  it('rejects oversized JSON rather than confirming a one-time exchange', async () => {
    body = Buffer.from(
      JSON.stringify({
        access_token: 'fixture-token',
        token_type: 'bearer',
        padding: 'x'.repeat(65536),
      })
    );
    await expect(
      exchangeEmbeddedSignupCode(exchangeArgs, transport)
    ).rejects.toMatchObject({ kind: 'invalid_response', httpStatus: 200 });
    expect(requests).toBe(1);
  });
});
