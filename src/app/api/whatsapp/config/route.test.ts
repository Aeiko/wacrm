import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { jsonSchema, type JsonValue } from '@/lib/whatsapp/coexistence/payload';

let callerRole = 'admin';
let signedIn = true;

const configInserts: Record<string, unknown>[] = [];
const configUpdates: Record<string, unknown>[] = [];
let configDeletes = 0;
let configLookupFailed = false;
let connectionRevision = '10000000-0000-4000-8000-000000000001';
let afterConfigRead = () => {};

const STORED_CONFIG = {
  id: 'cfg-1',
  phone_number_id: '111222333',
  waba_id: '444555666',
  access_token: 'enc-token',
  status: 'connected',
  registered_at: null,
  verify_token: null,
  // SAFETY: fixture starts unbound; managed scenarios replace this with a string ID.
  coexistence_app_id: null as string | null,
  coexistence_generation: 'epoch-1',
};

let storedConfig:
  | (Omit<typeof STORED_CONFIG, 'registered_at'> & {
      registered_at: string | null;
    })
  | null = null;

function makeSupabaseMock() {
  function builder(table: string) {
    let patch: (typeof configUpdates)[number] | null = null;
    const filters = new Map<string, string | null>();

    const result = () => {
      if (table === 'whatsapp_config' && patch) {
        const matches =
          storedConfig &&
          [...filters].every(
            ([key, value]) =>
              key === 'account_id' ||
              (key === 'id' && storedConfig?.id === value) ||
              (key === 'coexistence_generation' &&
                storedConfig?.coexistence_generation === value) ||
              (key === 'coexistence_app_id' &&
                storedConfig?.coexistence_app_id === value)
          );

        if (matches) configUpdates.push(patch);

        return { data: matches ? { id: storedConfig?.id } : null, error: null };
      }

      switch (table) {
        case 'profiles':
          return {
            data: { account_id: 'acct-1', account_role: callerRole },
            error: null,
          };
        case 'accounts':
          return {
            data: {
              id: 'acct-1',
              name: 'Acme',
              connection_revision: connectionRevision,
            },
            error: null,
          };
        case 'whatsapp_config': {
          const snapshot = {
            data: storedConfig,
            error: configLookupFailed ? { message: 'lookup failed' } : null,
          };

          afterConfigRead();

          return snapshot;
        }

        default:
          return { data: null, error: null };
      }
    };

    const b: Record<string, unknown> = {};
    const chain = () => b;

    for (const m of ['select', 'neq']) b[m] = vi.fn(chain);

    for (const m of ['eq', 'is'])
      b[m] = vi.fn((key: string, value: string | null) => {
        filters.set(key, value);

        return b;
      });
    b.insert = vi.fn((row: Record<string, unknown>) => {
      if (table === 'whatsapp_config') configInserts.push(row);

      return b;
    });
    b.update = vi.fn((value: (typeof configUpdates)[number]) => {
      if (table === 'whatsapp_config') patch = value;

      return b;
    });
    b.delete = vi.fn(() => {
      if (table === 'whatsapp_config') configDeletes += 1;

      return b;
    });
    b.single = vi.fn(async () => result());
    b.maybeSingle = vi.fn(async () => result());
    b.then = (resolve: (v: unknown) => unknown) =>
      resolve({ data: null, error: null });

    return b;
  }

  return {
    auth: {
      getUser: vi.fn(async () =>
        signedIn
          ? { data: { user: { id: 'user-1' } }, error: null }
          : { data: { user: null }, error: { message: 'no session' } }
      ),
    },
    from: vi.fn((table: string) => builder(table)),
  };
}

let supabaseMock = makeSupabaseMock();

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => supabaseMock),
}));

const serviceRole = vi.hoisted(() => ({ lookups: 0 }));
const rpcCalls: { name: string; args: Record<string, JsonValue> }[] = [];
const finishedConfigs: Record<string, JsonValue>[] = [];
let acquiredId: string | null;
let acquiredGeneration: string | null;
let registerOutcome: string;
let operationState = 'idle';
let rpcFailure = '';
let duplicateStart = false;

function gateRpc(name: string, args: Record<string, JsonValue>) {
  rpcCalls.push({ name, args });

  const result = () => {
    if (name === rpcFailure)
      return { data: null, error: { message: 'private-sdk-error' } };
    let data: JsonValue;

    const changed =
      storedConfig?.coexistence_app_id != null ||
      (storedConfig?.id ?? null) !== acquiredId ||
      (storedConfig?.coexistence_generation ?? null) !== acquiredGeneration;

    if (name.endsWith('account_status')) data = { status: operationState };
    else if (name.endsWith('acquire')) {
      acquiredId = z.string().nullable().parse(args.p_expected_config_id);
      acquiredGeneration = z
        .string()
        .nullable()
        .parse(args.p_expected_generation);

      const conflict =
        args.p_expected_revision !== connectionRevision ||
        storedConfig?.coexistence_app_id != null ||
        (storedConfig?.id ?? null) !== acquiredId ||
        (storedConfig?.coexistence_generation ?? null) !== acquiredGeneration;

      data = conflict
        ? { status: 'conflict' }
        : {
            status: 'acquired',
            operation_id: '20000000-0000-4000-8000-000000000001',
            token: '30000000-0000-4000-8000-000000000001',
            lease_until: '2026-11-17T16:00:00Z',
          };
    } else if (name.endsWith('start_step'))
      data = configLookupFailed
        ? { status: 'blocked' }
        : changed
          ? { status: 'conflict' }
          : duplicateStart
            ? { status: 'duplicate', dispatch: false, step_status: 'started' }
            : { status: 'started', dispatch: true };
    else if (name.endsWith('record_step')) {
      if (args.p_step === 'register') registerOutcome = String(args.p_outcome);
      data = { status: 'recorded', step_status: args.p_outcome };
    } else if (name.endsWith('finish')) {
      if (changed) data = { status: 'conflict' };
      else {
        const config = z
          .record(z.string(), jsonSchema)
          .nullable()
          .parse(args.p_config);

        if (config) finishedConfigs.push(config);
        data = {
          status: 'completed',
          operation_id: '20000000-0000-4000-8000-000000000001',
          config_id: config ? '40000000-0000-4000-8000-000000000001' : null,
          revision: '50000000-0000-4000-8000-000000000001',
          saved: Boolean(config),
          registered: Boolean(config?.registered_at),
          registration_rejected: registerOutcome === 'rejected',
        };
      }
    } else data = { status: 'cancelled' };

    return { data, error: null };
  };

  return { retry: () => Promise.resolve(result()) };
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    rpc: gateRpc,
    from: vi.fn(() => {
      serviceRole.lookups += 1;
      const b: Record<string, unknown> = {};

      for (const m of ['select', 'eq', 'neq']) b[m] = vi.fn(() => b);
      b.maybeSingle = vi.fn(async () => ({ data: null, error: null }));

      return b;
    }),
  })),
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn(() => 'plaintext-token'),
  encrypt: vi.fn(() => 'enc-token'),
}));

const meta = vi.hoisted(() => ({
  verifyPhoneNumber: vi.fn(async () => ({
    id: '111222333',
    display_phone_number: '+1 555 0100',
  })),
  listWabaPhoneNumbers: vi.fn(async () => [{ id: '111222333' }]),
  registerPhoneNumber: vi.fn(async () => ({ success: true })),
  subscribeWabaToApp: vi.fn(async () => ({ success: true })),
  getSubscribedApps: vi.fn(async () => []),
  isDefinitiveConnectionRejection: vi.fn(() => false),
}));

vi.mock('@/lib/whatsapp/meta-api', () => meta);

import { DELETE, GET, POST } from './route';
import { GET as verifyRegistration } from './verify-registration/route';
import { __resetRateLimitForTests } from '@/lib/rate-limit';

function deleteConfig() {
  return DELETE(
    new Request('http://localhost/api/whatsapp/config', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost',
      },
      body: '{}',
    })
  );
}

function saveConfig(
  overrides: Record<string, JsonValue | undefined> = {},
  signal?: AbortSignal
) {
  return POST(
    new Request('http://localhost/api/whatsapp/config', {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost',
      },
      body: JSON.stringify({
        phone_number_id: '111222333',
        waba_id: '444555666',
        access_token: 'caller-supplied-token',
        pin: '123456',
        ...overrides,
      }),
    })
  );
}

it.each([true, false])(
  'local mode reports managed=%s without decrypting or calling Meta',
  async (managed) => {
    storedConfig = {
      ...STORED_CONFIG,
      coexistence_app_id: managed ? '123' : null,
    };
    callerRole = 'viewer';

    const response = await GET(
      new Request('http://localhost/api/whatsapp/config?mode=local')
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ managed, operation_state: 'idle' });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(metaCallCount()).toBe(0);
  }
);

it.each(['busy', 'blocked'])(
  'local mode exposes %s without decrypting or Meta',
  async (state) => {
    operationState = state;

    const response = await GET(
      new Request('http://localhost/api/whatsapp/config?mode=local')
    );

    expect(await response.json()).toEqual({
      managed: false,
      operation_state: state,
    });
    expect(metaCallCount()).toBe(0);
  }
);

it('local mode handles no configuration without a health call', async () => {
  storedConfig = null;
  expect(
    await (
      await GET(new Request('http://localhost/api/whatsapp/config?mode=local'))
    ).json()
  ).toEqual({ managed: false, operation_state: 'idle' });
  expect(metaCallCount()).toBe(0);
});

it.each([
  '?mode=',
  '?mode=health',
  '?mode=local&mode=local',
  '?mode=local&account_id=other',
])('fails closed on malformed local mode %s', async (query) => {
  const response = await GET(
    new Request(`http://localhost/api/whatsapp/config${query}`)
  );

  expect(response.status).toBe(400);
  expect(metaCallCount()).toBe(0);
});

it('local mode sanitizes database failures', async () => {
  configLookupFailed = true;

  const response = await GET(
    new Request('http://localhost/api/whatsapp/config?mode=local')
  );

  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'config_unavailable' });
  expect(metaCallCount()).toBe(0);
});

function metaCallCount() {
  return (
    meta.verifyPhoneNumber.mock.calls.length +
    meta.listWabaPhoneNumbers.mock.calls.length +
    meta.registerPhoneNumber.mock.calls.length +
    meta.subscribeWabaToApp.mock.calls.length +
    meta.getSubscribedApps.mock.calls.length
  );
}

beforeEach(() => {
  __resetRateLimitForTests();
  callerRole = 'admin';
  signedIn = true;
  storedConfig = null;
  configLookupFailed = false;
  connectionRevision = '10000000-0000-4000-8000-000000000001';
  afterConfigRead = () => {};

  configInserts.length = 0;
  configUpdates.length = 0;
  configDeletes = 0;
  serviceRole.lookups = 0;
  supabaseMock = makeSupabaseMock();

  rpcCalls.length = 0;
  finishedConfigs.length = 0;
  acquiredId = null;
  acquiredGeneration = null;
  registerOutcome = '';
  operationState = 'idle';
  rpcFailure = '';
  duplicateStart = false;

  for (const fn of Object.values(meta)) fn.mockClear();
});

describe('Coexistence configuration isolation', () => {
  it.each(['save', 'delete', 'health', 'registration'])(
    'blocks the legacy %s path without contacting Meta',
    async (operation) => {
      storedConfig = { ...STORED_CONFIG, coexistence_app_id: '9999' };

      const response =
        operation === 'save'
          ? await saveConfig()
          : operation === 'delete'
            ? await deleteConfig()
            : operation === 'health'
              ? await GET()
              : await verifyRegistration();

      expect(response.status).toBe(
        operation === 'save' || operation === 'delete' ? 409 : 200
      );
      expect(await response.json()).toMatchObject({
        reason: 'coexistence_managed',
      });
      expect(metaCallCount()).toBe(0);
      expect(configInserts).toHaveLength(0);
      expect(configUpdates).toHaveLength(0);
      expect(configDeletes).toBe(0);
    }
  );
});

describe('manual configuration concurrent binding fences', () => {
  it.each(['managed', 'generation', 'replacement'])(
    'final compare-and-swap rejects %s changes during subscription',
    async (change) => {
      storedConfig = { ...STORED_CONFIG };
      meta.subscribeWabaToApp.mockImplementationOnce(async () => {
        storedConfig = {
          ...STORED_CONFIG,
          id: change === 'replacement' ? 'cfg-2' : 'cfg-1',
          coexistence_app_id: change === 'managed' ? '9999' : null,
          coexistence_generation:
            change === 'generation' ? 'epoch-2' : 'epoch-1',
        };

        return { success: true };
      });
      const response = await saveConfig();
      expect(response.status).toBe(409);
      expect(configUpdates).toHaveLength(0);
    }
  );

  it('blocks subscription if its fresh lookup fails after registration', async () => {
    storedConfig = { ...STORED_CONFIG };
    meta.registerPhoneNumber.mockImplementationOnce(async () => {
      configLookupFailed = true;

      return { success: true };
    });
    const response = await saveConfig();
    expect(response.status).toBe(409);
    expect(meta.subscribeWabaToApp).not.toHaveBeenCalled();
    expect(configUpdates).toHaveLength(0);
  });

  it('blocks registration when an initially absent config becomes managed', async () => {
    meta.verifyPhoneNumber.mockImplementationOnce(async () => {
      storedConfig = { ...STORED_CONFIG, coexistence_app_id: '9999' };

      return { id: '111222333', display_phone_number: '+1 555 0100' };
    });
    const response = await saveConfig();
    expect(response.status).toBe(409);
    expect(meta.registerPhoneNumber).not.toHaveBeenCalled();
    expect(meta.subscribeWabaToApp).not.toHaveBeenCalled();
    expect(configInserts).toHaveLength(0);
  });
  it.each(['verify', 'register', 'subscribe'])(
    'rejects a managed binding established during %s',
    async (step) => {
      storedConfig = { ...STORED_CONFIG };

      const bind = () => {
        storedConfig = {
          ...STORED_CONFIG,
          coexistence_app_id: '9999',
          coexistence_generation: 'epoch-2',
        };
      };

      if (step === 'verify')
        meta.verifyPhoneNumber.mockImplementationOnce(async () => {
          bind();

          return { id: '111222333', display_phone_number: '+1 555 0100' };
        });

      if (step === 'register')
        meta.registerPhoneNumber.mockImplementationOnce(async () => {
          bind();

          return { success: true };
        });

      if (step === 'subscribe')
        meta.subscribeWabaToApp.mockImplementationOnce(async () => {
          bind();

          return { success: true };
        });
      const response = await saveConfig();
      expect(response.status).toBe(409);
      expect(meta.registerPhoneNumber).toHaveBeenCalledTimes(
        step === 'verify' ? 0 : 1
      );
      expect(meta.subscribeWabaToApp).toHaveBeenCalledTimes(
        step === 'subscribe' ? 1 : 0
      );
      expect(configUpdates).toHaveLength(0);
      expect(configInserts).toHaveLength(0);
    }
  );

  it.each(['generation', 'replacement', 'lookup'])(
    'fails closed on %s changes before registration',
    async (change) => {
      storedConfig = { ...STORED_CONFIG };
      meta.verifyPhoneNumber.mockImplementationOnce(async () => {
        if (change === 'lookup') configLookupFailed = true;
        else
          storedConfig = {
            ...STORED_CONFIG,
            id: change === 'replacement' ? 'cfg-2' : 'cfg-1',
            coexistence_generation:
              change === 'generation' ? 'epoch-2' : 'epoch-1',
          };

        return { id: '111222333', display_phone_number: '+1 555 0100' };
      });
      const response = await saveConfig();
      expect(response.status).toBe(409);
      expect(meta.registerPhoneNumber).not.toHaveBeenCalled();
      expect(meta.subscribeWabaToApp).not.toHaveBeenCalled();
      expect(configUpdates).toHaveLength(0);
    }
  );
});

describe('POST /api/whatsapp/config', () => {
  it.each(['viewer', 'agent'])(
    'refuses the %s role before any Meta call',
    async (role) => {
      callerRole = role;

      const res = await saveConfig();

      expect(res.status).toBe(403);
      expect(metaCallCount()).toBe(0);
      expect(serviceRole.lookups).toBe(0);
      expect(configInserts).toHaveLength(0);
      expect(configUpdates).toHaveLength(0);
    }
  );

  it('answers 401 without a session and calls nothing', async () => {
    signedIn = false;

    const res = await saveConfig();

    expect(res.status).toBe(401);
    expect(metaCallCount()).toBe(0);
    expect(serviceRole.lookups).toBe(0);
  });

  it.each(['admin', 'owner'])(
    'lets the %s role verify, register, subscribe and save',
    async (role) => {
      callerRole = role;

      const res = await saveConfig();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toMatchObject({
        success: true,
        saved: true,
        registered: true,
      });
      expect(meta.verifyPhoneNumber).toHaveBeenCalledTimes(1);
      expect(meta.listWabaPhoneNumbers).toHaveBeenCalledTimes(1);
      expect(meta.registerPhoneNumber).toHaveBeenCalledTimes(1);
      expect(meta.subscribeWabaToApp).toHaveBeenCalledTimes(1);
      expect(configInserts).toHaveLength(0);
      expect(configUpdates).toHaveLength(0);
      expect(finishedConfigs).toHaveLength(1);
      expect(
        rpcCalls.find((call) => call.name.endsWith('acquire'))?.args
      ).toMatchObject({
        p_actor_id: 'user-1',
        p_account_id: 'acct-1',
        p_kind: 'manual_save',
        p_phone_number_id: '111222333',
        p_waba_id: '444555666',
      });
    }
  );
});

describe('POST /api/whatsapp/config registration state', () => {
  const REGISTERED_AT = '2026-01-01T00:00:00.000Z';

  it('clears registered_at when the phone number changes and no PIN is given', async () => {
    storedConfig = { ...STORED_CONFIG, registered_at: REGISTERED_AT };
    meta.verifyPhoneNumber.mockResolvedValueOnce({
      id: '999888777',
      display_phone_number: '+1 555 0199',
    });
    meta.listWabaPhoneNumbers.mockResolvedValueOnce([{ id: '999888777' }]);

    const res = await saveConfig({
      phone_number_id: '999888777',
      pin: undefined,
    });

    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      saved: true,
      registered: false,
      registration_skipped: true,
    });
    expect(meta.registerPhoneNumber).not.toHaveBeenCalled();
    expect(configUpdates).toHaveLength(0);
    expect(finishedConfigs[0]).toMatchObject({ registered_at: null });
  });

  it('keeps registered_at when the same registered number is saved without a PIN', async () => {
    storedConfig = { ...STORED_CONFIG, registered_at: REGISTERED_AT };

    const res = await saveConfig({ pin: undefined });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      registered: true,
      registration_skipped: false,
    });
    expect(meta.registerPhoneNumber).not.toHaveBeenCalled();
    expect(finishedConfigs[0]).toMatchObject({ registered_at: REGISTERED_AT });
  });
});

describe('DELETE /api/whatsapp/config', () => {
  it.each(['viewer', 'agent'])(
    'refuses the %s role and deletes nothing',
    async (role) => {
      callerRole = role;
      storedConfig = STORED_CONFIG;

      const res = await deleteConfig();

      expect(res.status).toBe(403);
      expect(configDeletes).toBe(0);
    }
  );

  it('lets an admin reset the configuration', async () => {
    storedConfig = STORED_CONFIG;

    const res = await deleteConfig();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(configDeletes).toBe(0);
    expect(
      rpcCalls.some(
        (call) => call.name.endsWith('finish') && call.args.p_config === null
      )
    ).toBe(true);
  });
});

describe('mutation trust boundary', () => {
  it.each([
    { phone_number_id: 123 },
    { phone_number_id: '12/34' },
    { phone_number_id: '0111222333' },
    { phone_number_id: '0' },
    { phone_number_id: '1'.repeat(33) },
    { waba_id: {} },
    { waba_id: '0444555666' },
    { waba_id: '0' },
    { access_token: '' },
    { access_token: 123 },
    { access_token: 'x'.repeat(16 * 1024 + 1) },
    { access_token: 'é'.repeat(8192), verify_token: 'extra' },
    { verify_token: 'v'.repeat(1025) },
    { pin: 123456 },
    { pin: '12345' },
    { account_id: 'foreign' },
  ])(
    'rejects invalid or oversized intent before Meta or acquire: %j',
    async (body) => {
      const response = await saveConfig(body);
      expect(response.status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(metaCallCount()).toBe(0);
      expect(rpcCalls).toHaveLength(0);
    }
  );

  it.each(['POST', 'DELETE'])(
    'requires same-origin JSON for %s',
    async (method) => {
      const headerCases: HeadersInit[] = [
        { 'Content-Type': 'application/json' },
        { 'Content-Type': 'application/json', Origin: 'http://foreign' },
        {
          'Content-Type': 'application/json',
          Origin: 'http://localhost',
          'Sec-Fetch-Site': 'cross-site',
        },
        { 'Content-Type': 'text/plain', Origin: 'http://localhost' },
      ];

      for (const headers of headerCases) {
        const request = new Request('http://localhost/api/whatsapp/config', {
          method,
          headers,
          body: '{}',
        });

        const response = await (method === 'POST'
          ? POST(request)
          : DELETE(request));

        expect([400, 403]).toContain(response.status);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
      }

      expect(metaCallCount()).toBe(0);
      expect(rpcCalls).toHaveLength(0);
    }
  );

  it('rejects DELETE fields instead of accepting a foreign account selector', async () => {
    const response = await DELETE(
      new Request('http://localhost/api/whatsapp/config', {
        method: 'DELETE',
        headers: {
          Origin: 'http://localhost',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ account_id: 'foreign' }),
      })
    );

    expect(response.status).toBe(400);
    expect(rpcCalls).toHaveLength(0);
  });

  it('cancels and awaits a stalled request body on caller abort', async () => {
    const controller = new AbortController();
    let cancelled = false;

    const stream = new ReadableStream<Uint8Array>({
      async cancel() {
        await Promise.resolve();
        cancelled = true;
      },
    });

    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      duplex: 'half',
      signal: controller.signal,
      headers: {
        Origin: 'http://localhost',
        'Content-Type': 'application/json',
      },
      body: stream,
    };

    const response = POST(
      new Request('http://localhost/api/whatsapp/config', init)
    );

    controller.abort();
    expect((await response).status).toBe(499);
    expect(cancelled).toBe(true);
    expect(metaCallCount()).toBe(0);
    expect(rpcCalls).toHaveLength(0);
  });

  it('cancels a body even when the request was already aborted', async () => {
    let cancelled = false;

    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });

    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      duplex: 'half',
      signal: AbortSignal.abort(),
      headers: {
        Origin: 'http://localhost',
        'Content-Type': 'application/json',
      },
      body: stream,
    };

    const response = await POST(
      new Request('http://localhost/api/whatsapp/config', init)
    );

    expect(response.status).toBe(499);
    expect(cancelled).toBe(true);
  });

  it('caps streamed bodies at 64 KiB without relying on Content-Length', async () => {
    let cancelled = false;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(64 * 1024 + 1));
      },
      cancel() {
        cancelled = true;
      },
    });

    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      duplex: 'half',
      headers: {
        Origin: 'http://localhost',
        'Content-Type': 'application/json',
      },
      body: stream,
    };

    const response = await POST(
      new Request('http://localhost/api/whatsapp/config', init)
    );

    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(metaCallCount()).toBe(0);
  });
});

describe('gate failure safety', () => {
  it.each(['save', 'delete'])(
    'fences absent-config ABA between snapshot reads during %s',
    async (operation) => {
      afterConfigRead = () => {
        connectionRevision = '10000000-0000-4000-8000-000000000002';
      };

      const response = await (operation === 'save'
        ? saveConfig()
        : deleteConfig());

      expect(response.status).toBe(409);
      expect(
        rpcCalls.find((call) => call.name.endsWith('acquire'))?.args
          .p_expected_revision
      ).toBe('10000000-0000-4000-8000-000000000001');
      expect(meta.registerPhoneNumber).not.toHaveBeenCalled();
      expect(meta.subscribeWabaToApp).not.toHaveBeenCalled();
      expect(finishedConfigs).toHaveLength(0);
      expect(rpcCalls.some((call) => call.name.endsWith('finish'))).toBe(false);
    }
  );

  it.each(['deadline', 'abort'])(
    'reports blocked when %s prevents the next step after registration',
    async (mode) => {
      const controller = new AbortController();
      const initialTime = Date.now();
      let now = initialTime;
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      meta.registerPhoneNumber.mockImplementationOnce(async () => {
        if (mode === 'deadline') now = initialTime + 35_001;
        else controller.abort();

        return { success: true };
      });

      try {
        const response = await saveConfig({}, controller.signal);
        expect(response.status).toBe(mode === 'deadline' ? 504 : 499);
        expect(await response.json()).toMatchObject({
          reason: 'connection_operation_blocked',
        });
        expect(meta.subscribeWabaToApp).not.toHaveBeenCalled();
        expect(
          rpcCalls.some(
            (call) =>
              call.name.endsWith('finish') ||
              call.name.endsWith('cancel_unstarted')
          )
        ).toBe(false);
      } finally {
        clock.mockRestore();
      }
    }
  );
  it('snapshots account revision before credential proof, fencing absent-config ABA', async () => {
    meta.verifyPhoneNumber.mockImplementationOnce(async () => {
      connectionRevision = '10000000-0000-4000-8000-000000000002';

      return { id: '111222333', display_phone_number: '+1 555 0100' };
    });
    const response = await saveConfig();
    expect(response.status).toBe(409);
    expect(
      rpcCalls.find((call) => call.name.endsWith('acquire'))?.args
    ).toMatchObject({
      p_expected_revision: '10000000-0000-4000-8000-000000000001',
      p_expected_config_id: null,
      p_expected_generation: null,
    });
    expect(meta.registerPhoneNumber).not.toHaveBeenCalled();
    expect(meta.subscribeWabaToApp).not.toHaveBeenCalled();
  });

  it('does not reserve foreign resources before successful credential proof', async () => {
    meta.verifyPhoneNumber.mockRejectedValueOnce(new Error('secret-token'));
    const response = await saveConfig();
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain('secret-token');
    expect(rpcCalls).toHaveLength(0);
    expect(meta.registerPhoneNumber).not.toHaveBeenCalled();
  });

  it('does not echo arbitrary error codes from a failed credential read', async () => {
    meta.verifyPhoneNumber.mockRejectedValueOnce(
      Object.assign(new Error('secret-message'), { code: 'secret-code' })
    );
    const response = await saveConfig();
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(body.meta.code).toBe(null);
    expect(rpcCalls).toHaveLength(0);
  });

  it('does not reserve before WABA pairing proof succeeds', async () => {
    meta.listWabaPhoneNumbers.mockResolvedValueOnce([{ id: 'foreign' }]);
    const response = await saveConfig();
    expect(response.status).toBe(400);
    expect(rpcCalls).toHaveLength(0);
    expect(meta.registerPhoneNumber).not.toHaveBeenCalled();
  });

  it('does not send remote HTTP after a lost start acknowledgement', async () => {
    rpcFailure = 'connection_operation_start_step';
    const response = await saveConfig();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'connection_blocked',
      reason: 'connection_operation_blocked',
    });
    expect(meta.registerPhoneNumber).not.toHaveBeenCalled();
    expect(meta.subscribeWabaToApp).not.toHaveBeenCalled();
    expect(
      rpcCalls.filter((call) => call.name.endsWith('start_step'))
    ).toHaveLength(1);
    expect(
      rpcCalls.some((call) => call.name.endsWith('cancel_unstarted'))
    ).toBe(false);
  });

  it('does not resend a duplicate SQL dispatch authorization', async () => {
    duplicateStart = true;
    const response = await saveConfig();
    expect(response.status).toBe(409);
    expect(meta.registerPhoneNumber).not.toHaveBeenCalled();
    expect(meta.subscribeWabaToApp).not.toHaveBeenCalled();
    expect(
      rpcCalls.some((call) => call.name.endsWith('cancel_unstarted'))
    ).toBe(false);
  });

  it('can finish disconnected after definitive registration rejection without persisting raw errors', async () => {
    meta.isDefinitiveConnectionRejection.mockReturnValueOnce(true);
    meta.registerPhoneNumber.mockRejectedValueOnce(new Error('secret-token'));
    const response = await saveConfig();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: false,
      saved: true,
      registered: false,
      error: 'Meta rejected registration. Check the number and PIN.',
      registration_error:
        'Meta rejected registration. Check the number and PIN.',
      meta: { step: 'register' },
    });
    expect(meta.subscribeWabaToApp).toHaveBeenCalledTimes(1);
    expect(finishedConfigs[0]).toMatchObject({
      registered_at: null,
      connected_at: null,
    });
    expect(finishedConfigs[0]).not.toHaveProperty('last_registration_error');
    expect(JSON.stringify(rpcCalls)).not.toContain('secret-token');
    expect(
      rpcCalls.some((call) => call.name.endsWith('cancel_unstarted'))
    ).toBe(false);
  });

  it.each([true, false])(
    'blocks both rejected and uncertain subscription (definitive=%s)',
    async (definitive) => {
      meta.isDefinitiveConnectionRejection.mockReturnValueOnce(definitive);
      meta.subscribeWabaToApp.mockRejectedValueOnce(new Error('secret-token'));
      const response = await saveConfig();
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: 'connection_blocked',
        reason: 'connection_operation_blocked',
      });
      expect(finishedConfigs).toHaveLength(0);
      expect(
        rpcCalls.some((call) => call.name.endsWith('cancel_unstarted'))
      ).toBe(false);
    }
  );

  it('retains started claims if persistence fails after remote success', async () => {
    rpcFailure = 'connection_operation_finish';
    const response = await saveConfig();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'connection_blocked',
      reason: 'connection_operation_blocked',
    });
    expect(meta.registerPhoneNumber).toHaveBeenCalledTimes(1);
    expect(meta.subscribeWabaToApp).toHaveBeenCalledTimes(1);
    expect(
      rpcCalls.filter((call) => call.name.endsWith('finish'))
    ).toHaveLength(2);
    expect(
      rpcCalls.some((call) => call.name.endsWith('cancel_unstarted'))
    ).toBe(false);
  });
  it('holds the gate when registration acknowledgement is uncertain', async () => {
    meta.registerPhoneNumber.mockRejectedValueOnce(new Error('secret-token'));
    const response = await saveConfig();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'connection_blocked',
      reason: 'connection_operation_blocked',
    });
    expect(meta.subscribeWabaToApp).not.toHaveBeenCalled();
    expect(
      rpcCalls.flatMap((call) =>
        call.name.endsWith('record_step') ? [call.args.p_outcome] : []
      )
    ).toEqual(['unknown']);
    expect(
      rpcCalls.some(
        (call) =>
          call.name.endsWith('cancel_unstarted') || call.name.endsWith('finish')
      )
    ).toBe(false);
  });

  it('reports blocked if durable receipt recording fails after remote success', async () => {
    rpcFailure = 'connection_operation_record_step';
    const response = await saveConfig();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'connection_blocked',
      reason: 'connection_operation_blocked',
    });
    expect(meta.registerPhoneNumber).toHaveBeenCalledTimes(1);
    expect(meta.subscribeWabaToApp).not.toHaveBeenCalled();
    expect(
      rpcCalls.some((call) => call.name.endsWith('cancel_unstarted'))
    ).toBe(false);
  });
});

describe('GET /api/whatsapp/config', () => {
  it('stays readable for a viewer and never returns the token', async () => {
    callerRole = 'viewer';
    storedConfig = STORED_CONFIG;

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.connected).toBe(true);
    expect(JSON.stringify(body)).not.toContain('plaintext-token');
    expect(JSON.stringify(body)).not.toContain('enc-token');
  });
});
