import { createServer } from 'node:http';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { listenForFetch } from '@/test/http-server';

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn((s: string) => s),
  encrypt: (s: string) => s,
}));

// Control the SSRF guard per-test.
vi.mock('@/lib/webhooks/ssrf', () => ({
  isDeliverableUrl: vi.fn(async () => true),
}));

import {
  dispatchWebhookEvent,
  dispatchWebhookEventWithOutcome,
  MAX_CONSECUTIVE_FAILURES,
} from './deliver';
import { verifySignatureHeader } from './sign';
import { isDeliverableUrl } from './ssrf';
import { decrypt } from '@/lib/whatsapp/encryption';

interface Row {
  id: string;
  url: string;
  secret: string;
}

interface Calls {
  updates: { id: string; payload: Record<string, unknown> }[];
  rpcs: { name: string; args: Record<string, unknown> }[];
}

function makeDb(
  rows: Row[] | null,
  calls: Calls,
  errors: { lookup?: Error; update?: Error; failure?: Error } = {}
) {
  const from = () => {
    let mode: 'select' | 'update' = 'select';
    let payload: Record<string, unknown> = {};
    let id: string | null = null;

    const b: Record<string, unknown> = {
      select: () => b,
      eq: (col: string, val: string) => {
        if (col === 'id') id = val;

        return b;
      },
      update: (p: Record<string, unknown>) => {
        mode = 'update';
        payload = p;

        return b;
      },
      contains: () =>
        Promise.resolve({ data: rows, error: errors.lookup ?? null }),
      then: (resolve: (v: unknown) => unknown) => {
        if (mode === 'update' && id) calls.updates.push({ id, payload });

        return resolve({ data: null, error: errors.update ?? null });
      },
    };

    return b;
  };

  const rpc = (name: string, args: Record<string, unknown>) => {
    calls.rpcs.push({ name, args });

    return Promise.resolve({ data: null, error: errors.failure ?? null });
  };

  return { from, rpc } as unknown as SupabaseClient;
}

const emptyCalls = (): Calls => ({ updates: [], rpcs: [] });

beforeEach(() => {
  vi.mocked(decrypt)
    .mockReset()
    .mockImplementation((s: string) => s);
  vi.mocked(isDeliverableUrl).mockReset().mockResolvedValue(true);
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const identity = {
  id: '3dd0db50-40ca-40d8-b720-dc686a4c9781',
  occurredAt: '2026-11-16T12:00:00.000Z',
};

describe('dispatchWebhookEventWithOutcome', () => {
  it.each([
    { rows: [], error: undefined, outcome: 'completed' },
    { rows: [], error: new Error('lookup failed'), outcome: 'ambiguous' },
    { rows: null, error: undefined, outcome: 'ambiguous' },
  ])(
    'returns $outcome for endpoint lookup $rows / $error',
    async ({ rows, error, outcome }) => {
      await expect(
        dispatchWebhookEventWithOutcome(
          makeDb(rows, emptyCalls(), { lookup: error }),
          'acct-1',
          'message.received',
          {},
          identity
        )
      ).resolves.toBe(outcome);
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it.each([
    'SSRF',
    'DNS',
    'decrypt',
    'HTTP',
    'response',
    'non2xx',
    'update',
    'failure RPC',
  ])(
    'returns only ambiguous after %s failure, without retrying',
    async (failure) => {
      const sensitiveError = new Error(
        'secret=https://user:password@private.example'
      );

      const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response(null, { status: 204 }));

      vi.stubGlobal('fetch', fetchMock);

      if (failure === 'SSRF')
        vi.mocked(isDeliverableUrl).mockResolvedValue(false);

      if (failure === 'DNS')
        vi.mocked(isDeliverableUrl).mockRejectedValue(sensitiveError);

      if (failure === 'decrypt')
        vi.mocked(decrypt).mockImplementation(() => {
          throw sensitiveError;
        });

      if (failure === 'HTTP') fetchMock.mockRejectedValue(sensitiveError);

      if (failure === 'response') fetchMock.mockResolvedValue(undefined);

      if (failure === 'non2xx' || failure === 'failure RPC')
        fetchMock.mockResolvedValue(new Response(null, { status: 500 }));
      const calls = emptyCalls();

      await expect(
        dispatchWebhookEventWithOutcome(
          makeDb(
            [{ id: 'a', url: 'https://a.test/hook', secret: 's1' }],
            calls,
            {
              update: failure === 'update' ? sensitiveError : undefined,
              failure: failure === 'failure RPC' ? sensitiveError : undefined,
            }
          ),
          'acct-1',
          'message.received',
          {},
          identity
        )
      ).resolves.toBe('ambiguous');

      expect(
        JSON.stringify([...warnings.mock.calls, ...errors.mock.calls])
      ).not.toContain('private.example');
      expect(
        [...warnings.mock.calls, ...errors.mock.calls].flat()
      ).not.toContain(sensitiveError);
      expect(fetchMock).toHaveBeenCalledTimes(
        ['SSRF', 'DNS', 'decrypt'].includes(failure) ? 0 : 1
      );
      expect(calls.rpcs).toHaveLength(
        ['DNS', 'update'].includes(failure) ? 0 : 1
      );

      for (const rpc of calls.rpcs) {
        expect(rpc).toEqual({
          name: 'record_webhook_failure',
          args: { endpoint_id: 'a', max_failures: MAX_CONSECUTIVE_FAILURES },
        });
      }
    }
  );

  it('contains thrown lookup and rejected failure writes', async () => {
    const db = makeDb(
      [{ id: 'a', url: 'https://a.test/hook', secret: 's1' }],
      emptyCalls()
    );

    vi.spyOn(db, 'from').mockImplementationOnce(() => {
      throw new Error('lookup unavailable');
    });
    await expect(
      dispatchWebhookEventWithOutcome(
        db,
        'acct-1',
        'message.received',
        {},
        identity
      )
    ).resolves.toBe('ambiguous');
    vi.mocked(isDeliverableUrl).mockResolvedValue(false);
    vi.spyOn(db, 'rpc').mockRejectedValueOnce(new Error('write reply lost'));
    await expect(
      dispatchWebhookEventWithOutcome(
        db,
        'acct-1',
        'message.received',
        {},
        identity
      )
    ).resolves.toBe('ambiguous');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['success', 'partial', 'lost reply', 'redirect'])(
    'uses a single HTTP attempt per endpoint with %s fanout',
    async (scenario) => {
      vi.unstubAllGlobals();
      const received: string[] = [];

      const server = createServer((req, res) => {
        req.resume();
        req.on('end', () => {
          received.push(req.url ?? '');

          if (req.url === '/b' && scenario === 'lost reply') {
            req.socket.destroy();

            return;
          }

          res.statusCode =
            req.url !== '/b' || scenario === 'success'
              ? 204
              : scenario === 'redirect'
                ? 302
                : 500;
          res.setHeader('Location', '/must-not-follow');
          res.end();
        });
      });

      const origin = await listenForFetch(server);

      try {
        const calls = emptyCalls();

        const rows = ['a', 'b'].map((id) => ({
          id,
          url: `${origin}/${id}`,
          secret: 's1',
        }));

        await expect(
          dispatchWebhookEventWithOutcome(
            makeDb(rows, calls),
            'acct-1',
            'message.received',
            {},
            identity
          )
        ).resolves.toBe(scenario === 'success' ? 'completed' : 'ambiguous');
        expect(received.sort()).toEqual(['/a', '/b']);
        expect(calls.updates).toHaveLength(scenario === 'success' ? 2 : 1);
        expect(calls.rpcs).toHaveLength(scenario === 'success' ? 0 : 1);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
      }
    }
  );
  it('completes only after successful fanout using the caller identity and exact signed bytes', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));

    vi.stubGlobal('fetch', fetchMock);
    const calls = emptyCalls();

    await expect(
      dispatchWebhookEventWithOutcome(
        makeDb(
          [
            { id: 'a', url: 'https://a.test/hook', secret: 's1' },
            { id: 'b', url: 'https://b.test/hook', secret: 's2' },
          ],
          calls
        ),
        'acct-1',
        'message.received',
        { text: 'héllo 🌍' },
        identity
      )
    ).resolves.toBe('completed');

    expect(fetchMock).toHaveBeenCalledTimes(2);

    for (const [index, secret] of ['s1', 's2'].entries()) {
      const opts = fetchMock.mock.calls[index][1];
      expect(opts.body).toBe(
        '{"id":"3dd0db50-40ca-40d8-b720-dc686a4c9781","event":"message.received","occurred_at":"2026-11-16T12:00:00.000Z","account_id":"acct-1","data":{"text":"héllo 🌍"}}'
      );
      expect(
        verifySignatureHeader(
          opts.headers['X-Wacrm-Signature'],
          opts.body,
          secret,
          Math.floor(Date.now() / 1000)
        )
      ).toBe(true);
      expect(opts.redirect).toBe('manual');
      expect(opts.signal).toBeInstanceOf(AbortSignal);
    }

    expect(calls.updates).toHaveLength(2);
    expect(calls.rpcs).toHaveLength(0);
  });
});

describe('dispatchWebhookEvent', () => {
  it('signs + POSTs (no redirect follow) and resets failure_count on success', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200 } as Response);

    vi.stubGlobal('fetch', fetchMock);
    const calls = emptyCalls();

    await dispatchWebhookEvent(
      makeDb([{ id: 'a', url: 'https://a.test/hook', secret: 's1' }], calls),
      'acct-1',
      'message.received',
      { x: 1 }
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://a.test/hook');
    expect(opts.redirect).toBe('manual');
    expect(opts.headers['X-Wacrm-Event']).toBe('message.received');
    expect(opts.headers['X-Wacrm-Signature']).toMatch(
      /^t=\d+,v1=[0-9a-f]{64}$/
    );
    // Payload carries a dedupe id.
    expect(JSON.parse(opts.body).id).toMatch(/[0-9a-f-]{36}/);
    expect(calls.updates[0]).toMatchObject({
      id: 'a',
      payload: { failure_count: 0 },
    });
    expect(calls.rpcs).toHaveLength(0);
  });

  it('records an atomic failure (RPC) when the endpoint errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response)
    );
    const calls = emptyCalls();

    await dispatchWebhookEvent(
      makeDb([{ id: 'b', url: 'https://b.test/hook', secret: 's2' }], calls),
      'acct-1',
      'message.received',
      {}
    );

    expect(calls.rpcs[0]).toEqual({
      name: 'record_webhook_failure',
      args: { endpoint_id: 'b', max_failures: MAX_CONSECUTIVE_FAILURES },
    });
    expect(calls.updates).toHaveLength(0);
  });

  it('blocks a non-public target (SSRF guard) without fetching', async () => {
    vi.mocked(isDeliverableUrl).mockResolvedValue(false);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const calls = emptyCalls();

    await dispatchWebhookEvent(
      makeDb([{ id: 'c', url: 'https://127.0.0.1/hook', secret: 's3' }], calls),
      'acct-1',
      'message.received',
      {}
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(calls.rpcs[0].name).toBe('record_webhook_failure');
  });

  it('does nothing when no endpoints are subscribed', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const calls = emptyCalls();
    await dispatchWebhookEvent(
      makeDb([], calls),
      'acct-1',
      'message.received',
      {}
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(calls.rpcs).toHaveLength(0);
    expect(calls.updates).toHaveLength(0);
  });
});
