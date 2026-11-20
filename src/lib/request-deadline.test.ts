import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { listenForFetch } from '@/test/http-server';
import { createClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { supabaseAdmin as flowAdmin } from './flows/admin-client';
import { supabaseAdmin as automationAdmin } from './automations/admin-client';
import { supabaseAdmin as aiAdmin } from './ai/admin-client';
import { deadlineFetch, withRequestDeadline } from './request-deadline';

let server: Server;
let url: string;
let requests: string[];

beforeEach(async () => {
  requests = [];
  server = createServer((req, res) => {
    requests.push(req.url ?? '');

    if (req.url === '/hold' || req.url?.startsWith('/rest/v1/held')) return;

    if (req.url === '/body') {
      res.writeHead(200);
      res.write('partial');

      return;
    }

    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/' });
      res.end();

      return;
    }

    res.end('ok');
  });
  url = await listenForFetch(server);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

it('stops PostgREST GET retries for both in-flight and elapsed deadlines', async () => {
  const db = createClient(url, 'loopback-service-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: deadlineFetch },
  });

  const controller = new AbortController();

  const timeout = vi
    .spyOn(AbortSignal, 'timeout')
    .mockReturnValueOnce(controller.signal);

  const received = once(server, 'request');
  const closed = received.then(([, res]) => once(res, 'close'));

  try {
    const action = withRequestDeadline(Date.now() + 5_000, async () => {
      const stalled = await db.from('held').select('id');
      expect(stalled.error?.message).toContain('AbortError');
      await withRequestDeadline(Date.now() - 1, async () => {
        const expired = await db.from('never-started').select('id');
        expect(expired.error?.message).toContain('AbortError');
      });
    });

    await received;
    const started = performance.now();
    controller.abort(
      new DOMException('Fixture deadline elapsed', 'TimeoutError')
    );
    await action;
    expect(performance.now() - started).toBeLessThan(900);
    await closed;
    expect(requests).toEqual(['/rest/v1/held?select=id']);
  } finally {
    timeout.mockRestore();
  }
}, 2_000);

it('cancels in-flight HTTP and blocks an expired follow-up attempt', async () => {
  const controller = new AbortController();

  const timeout = vi
    .spyOn(AbortSignal, 'timeout')
    .mockReturnValueOnce(controller.signal);

  const received = once(server, 'request');
  const closed = received.then(([, res]) => once(res, 'close'));

  try {
    const action = withRequestDeadline(Date.now() + 5_000, async () => {
      await expect(deadlineFetch(`${url}/hold`)).rejects.toMatchObject({
        name: 'AbortError',
      });
      await withRequestDeadline(Date.now() - 1, async () => {
        await expect(deadlineFetch(`${url}/late`)).rejects.toMatchObject({
          name: 'AbortError',
        });
      });
    });

    await received;
    // Other requests and scopes remain independent while this request is pending.
    const outside = deadlineFetch(url).then((res) => res.text());

    const otherScope = withRequestDeadline(Date.now() + 2_000, async () =>
      (await deadlineFetch(url)).text()
    );

    const started = performance.now();
    controller.abort(
      new DOMException('Fixture deadline elapsed', 'TimeoutError')
    );
    await action;
    expect(performance.now() - started).toBeLessThan(900);
    await closed;
    expect(await outside).toBe('ok');
    expect(await otherScope).toBe('ok');
    expect(requests.filter((path) => path === '/hold')).toHaveLength(1);
    expect(requests).not.toContain('/late');
  } finally {
    timeout.mockRestore();
  }
}, 2_000);

it.each(['init', 'request', 'timeout'] as const)(
  'preserves %s cancellation before the scope deadline',
  async (source) => {
    const controller = new AbortController();

    const signal =
      source === 'timeout' ? AbortSignal.timeout(150) : controller.signal;

    const received = once(server, 'request');
    const closed = received.then(([, res]) => once(res, 'close'));
    const request = new Request(`${url}/hold`, { signal });

    const action = withRequestDeadline(Date.now() + 5_000, async () => {
      const response =
        source === 'request'
          ? deadlineFetch(request)
          : deadlineFetch(`${url}/hold`, { signal });

      await expect(response).rejects.toMatchObject({
        name: source === 'timeout' ? 'TimeoutError' : 'AbortError',
      });
    });

    await received;

    if (source !== 'timeout') controller.abort();
    await action;
    await closed;
  },
  2_000
);

it('preserves a caller-provided cancellation reason unchanged', async () => {
  const controller = new AbortController();
  const reason = new Error('Caller cancelled');
  const received = once(server, 'request');
  const closed = received.then(([, res]) => once(res, 'close'));

  await withRequestDeadline(Date.now() + 5_000, async () => {
    const response = deadlineFetch(`${url}/hold`, {
      signal: controller.signal,
    });

    const rejection = expect(response).rejects.toBe(reason);

    await received;
    controller.abort(reason);
    await rejection;
    await closed;
  });
});

it('does not start HTTP for an already aborted caller signal', async () => {
  await withRequestDeadline(Date.now() + 5_000, async () => {
    await expect(
      deadlineFetch(url, { signal: AbortSignal.abort() })
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
      deadlineFetch(new Request(url, { signal: AbortSignal.abort() }))
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
  expect(requests).toEqual([]);
});

it('preserves Request options and allows init.signal to override Request.signal', async () => {
  const received = once(server, 'request');

  const request = new Request(url, {
    method: 'POST',
    body: 'payload',
    headers: { authorization: 'Bearer loopback-only', cookie: 'session=test' },
    credentials: 'include',
    redirect: 'manual',
    signal: AbortSignal.abort(),
  });

  const text = await withRequestDeadline(Date.now() + 5_000, async () =>
    (
      await deadlineFetch(request, { signal: new AbortController().signal })
    ).text()
  );

  const [req] = await received;
  expect(text).toBe('ok');
  expect(req.method).toBe('POST');
  expect(req.headers.authorization).toBe('Bearer loopback-only');
  expect(req.headers.cookie).toBe('session=test');
  expect(request.bodyUsed).toBe(true);
});

it('honors init.signal null clearing a Request signal', async () => {
  await withRequestDeadline(Date.now() + 5_000, async () => {
    const request = new Request(url, { signal: AbortSignal.abort() });
    expect(await (await deadlineFetch(request, { signal: null })).text()).toBe(
      'ok'
    );
  });
});

it('cancels response body reads after headers have arrived', async () => {
  await withRequestDeadline(Date.now() + 150, async () => {
    const response = await deadlineFetch(`${url}/body`);
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toMatchObject({
      name: expect.stringMatching(/^(AbortError|TimeoutError)$/),
    });
  });
}, 2_000);

it('preserves manual redirects', async () => {
  await withRequestDeadline(Date.now() + 5_000, async () => {
    const response = await deadlineFetch(`${url}/redirect`, {
      redirect: 'manual',
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/');
    await response.text();
  });
  expect(requests).toEqual(['/redirect']);
});

it.each([flowAdmin, automationAdmin, aiAdmin])(
  'guards a reused admin client on each new action without leaking the prior deadline',
  async (admin) => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', url);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'loopback-service-key');
    const db = admin();
    await withRequestDeadline(Date.now() - 1, async () => {
      const result = await db.from('contacts').insert({ id: 'loopback-only' });
      expect(result.error).not.toBeNull();
    });
    expect(requests).toEqual([]);
    await withRequestDeadline(Date.now() + 5_000, async () => {
      await db.from('contacts').insert({ id: 'loopback-only' });
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain('/rest/v1/contacts');
  }
);

it('restores an outer scope after an inner scope completes', async () => {
  await withRequestDeadline(Date.now() + 5_000, async () => {
    await withRequestDeadline(Date.now() - 1, async () => {
      await expect(deadlineFetch(url)).rejects.toMatchObject({
        name: 'AbortError',
      });
    });
    expect(await (await deadlineFetch(url)).text()).toBe('ok');
  });
  expect(requests).toEqual(['/']);
});

it('rejects an expired deadline before HTTP starts, including later attempts', async () => {
  await withRequestDeadline(Date.now() - 1, async () => {
    await expect(deadlineFetch(url)).rejects.toMatchObject({
      name: 'AbortError',
    });
    await expect(deadlineFetch(url)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
  expect(requests).toEqual([]);
  expect(await (await deadlineFetch(url)).text()).toBe('ok');
});

it('inherits the shorter parent deadline instead of extending its HTTP budget', async () => {
  const started = Date.now();
  await withRequestDeadline(started + 150, async () => {
    await withRequestDeadline(started + 5_000, async () => {
      await expect(deadlineFetch(`${url}/hold`)).rejects.toMatchObject({
        name: 'AbortError',
      });
      await expect(deadlineFetch(`${url}/late`)).rejects.toMatchObject({
        name: 'AbortError',
      });
    });
  });
  expect(Date.now() - started).toBeLessThan(900);
  expect(requests).toEqual(['/hold']);
}, 2_000);

it.each(['parent', 'child'] as const)(
  'preserves %s scope cancellation alongside an explicit HTTP signal',
  async (source) => {
    const parent = new AbortController();
    const child = new AbortController();
    const caller = new AbortController();
    const received = once(server, 'request');
    const closed = received.then(([, response]) => once(response, 'close'));

    const db = createClient(url, 'loopback-key', {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: deadlineFetch },
    });

    let settled = false;

    const pending = withRequestDeadline(
      Date.now() + 5_000,
      () =>
        withRequestDeadline(
          Date.now() + 10_000,
          async () => {
            const result = await db
              .from('held')
              .select('id')
              .abortSignal(caller.signal);

            settled = true;
            expect(result.error?.message).toContain('AbortError');
            const after = await db.from('late').select('id');
            expect(after.error?.message).toContain('AbortError');
          },
          child.signal
        ),
      parent.signal
    );

    await received;
    (source === 'parent' ? parent : child).abort(
      new Error('Owned scope reason')
    );
    await pending;
    expect(settled).toBe(true);
    await closed;
    expect(requests).toEqual(['/rest/v1/held?select=id']);
    expect(caller.signal.aborted).toBe(false);
    expect(await (await deadlineFetch(url)).text()).toBe('ok');
  },
  2_000
);

it('aborts a response body through the inherited scope signal without cancelling unrelated scopes', async () => {
  const controller = new AbortController();
  const received = once(server, 'request');
  const closed = received.then(([, response]) => once(response, 'close'));
  await withRequestDeadline(
    Date.now() + 5_000,
    async () => {
      await withRequestDeadline(Date.now() + 10_000, async () => {
        const response = await deadlineFetch(`${url}/body`);
        const body = response.text();

        const rejected = expect(body).rejects.toMatchObject({
          name: 'AbortError',
        });

        controller.abort();
        await rejected;
        await expect(deadlineFetch(`${url}/late`)).rejects.toMatchObject({
          name: 'AbortError',
        });
      });
    },
    controller.signal
  );
  await closed;
  expect(requests).toEqual(['/body']);
  expect(await (await deadlineFetch(url)).text()).toBe('ok');
});
