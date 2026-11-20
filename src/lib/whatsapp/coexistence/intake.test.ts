import { createHash, createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { listenForFetch } from '@/test/http-server';
import { createClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureCoexistenceWebhook } from './intake';
import { jsonSchema, type JsonValue } from './payload';
import { MAX_WEBHOOK_BODY_BYTES } from '../webhook-body';

// SQL075 owns binding discovery, lifecycle authority/fanout, capture ordering,
// staged retries and quarantine. These tests assert only the HTTP transport contract.
let server: Server;
let origin: string;
let handleRequest: (request: Request) => Promise<Response>;

class CaptureDatabase {
  requests: JsonValue[] = [];
  result: JsonValue = {
    status: 200,
    legacy_indices: [],
    captured: 0,
    staged: 1,
  };
  fail = false;

  async handle(request: Request): Promise<Response> {
    expect(new URL(request.url).pathname).toBe(
      '/rest/v1/rpc/coexistence_ingress'
    );
    this.requests.push(jsonSchema.parse(await request.json()));

    return this.fail
      ? Response.json({ message: 'secret database error' }, { status: 503 })
      : Response.json(this.result);
  }

  client() {
    handleRequest = this.handle.bind(this);

    return createClient(origin, 'test-service-key', {
      auth: { persistSession: false },
    });
  }
}

function signed(body: string, secret = 'dedicated-secret'): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

const stop = {
  field: 'account_update',
  value: { event: 'ACCOUNT_OFFBOARDED' },
};

const ordinary = {
  field: 'messages',
  value: { metadata: { phone_number_id: '1234' } },
};

const privateChange = {
  field: 'smb_future_event',
  value: { unassigned: true },
};

function envelope(changes: JsonValue[] = [privateChange]) {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: '005678', changes }],
  });
}

beforeEach(async () => {
  server = createServer(async (request, response) => {
    try {
      let raw = '';

      for await (const chunk of request) raw += chunk;

      const result = await handleRequest(
        new Request(`${origin}${request.url}`, {
          method: request.method,
          body: raw,
        })
      );

      response.writeHead(result.status, { 'Content-Type': 'application/json' });
      response.end(await result.text());
    } catch {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ message: 'Unexpected test request' }));
    }
  });
  origin = await listenForFetch(server);
  vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
  vi.stubEnv('WHATSAPP_COEXISTENCE_PARTNER_BUSINESS_ID', '7777');
  vi.stubEnv('WHATSAPP_COEXISTENCE_APP_ID', '9999');
  vi.stubEnv('WHATSAPP_COEXISTENCE_APP_SECRET', 'dedicated-secret');
  vi.stubEnv('META_APP_SECRET', 'legacy-secret');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});

describe('signed private ingress HTTP transport', () => {
  it('sends exact original per-change descriptors and trusted attestation, with stable duplicate keys', async () => {
    const db = new CaptureDatabase();
    db.result = { status: 200, legacy_indices: [], captured: 1, staged: 2 };

    const body = JSON.stringify({
      entry: [
        { id: '005678', changes: [ordinary, ordinary] },
        { id: '900719925474099312345', changes: [stop] },
      ],
    });

    const hash = createHash('sha256').update(body).digest('hex');

    for (let attempt = 0; attempt < 2; attempt++) {
      expect(
        (await captureCoexistenceWebhook(body, signed(body), db.client()))
          ?.status
      ).toBe(200);
    }

    expect(db.requests).toEqual(
      [0, 1].map(() => ({
        p_app_id: '9999',
        p_partner_business_id: '7777',
        p_enabled: true,
        p_authorized: true,
        p_changes: [
          { entry_id: '005678', ...ordinary, dedupe_key: `${hash}:0:0` },
          { entry_id: '005678', ...ordinary, dedupe_key: `${hash}:0:1` },
          {
            entry_id: '900719925474099312345',
            ...stop,
            dedupe_key: `${hash}:1:0`,
          },
        ],
      }))
    );
  });

  it('retains nullable entry identity for SQL quarantine and nested lifecycle authority', async () => {
    const db = new CaptureDatabase();

    const body = JSON.stringify({
      entry: [{ id: null, changes: [privateChange] }],
    });

    expect(
      (await captureCoexistenceWebhook(body, signed(body), db.client()))?.status
    ).toBe(200);
    expect(db.requests).toMatchObject([
      { p_changes: [{ entry_id: null, ...privateChange }] },
    ]);
    expect(JSON.stringify(db.requests)).not.toContain('invalid');
  });

  it.each([null, 'sha256=bad', signed(envelope(), 'forged-secret')])(
    'rejects unauthenticated signature %s before any SQL request',
    async (signature) => {
      const db = new CaptureDatabase();
      db.result = { status: 401, legacy_indices: [], captured: 0, staged: 0 };
      expect(
        (await captureCoexistenceWebhook(envelope(), signature, db.client()))
          ?.status
      ).toBe(401);
      expect(db.requests).toEqual([]);
    }
  );

  it.each([401, 503])(
    'allows original legacy authentication to reach SQL without private permission or fallback on status %i',
    async (status) => {
      const db = new CaptureDatabase();
      db.result = { status, legacy_indices: [], captured: 0, staged: 0 };
      vi.stubEnv(
        'META_APP_SECRET',
        'first-secret, legacy-secret, another-secret'
      );
      const body = envelope();

      expect(
        (
          await captureCoexistenceWebhook(
            body,
            signed(body, 'legacy-secret'),
            db.client()
          )
        )?.status
      ).toBe(status);
      expect(db.requests).toMatchObject([{ p_authorized: false }]);
    }
  );

  it('accepts dedicated-only authentication without evaluating a missing legacy secret', async () => {
    const db = new CaptureDatabase();
    vi.stubEnv('META_APP_SECRET', '');
    const error = vi.spyOn(console, 'error');
    const body = envelope();

    try {
      expect(
        (await captureCoexistenceWebhook(body, signed(body), db.client()))
          ?.status
      ).toBe(200);
      expect(db.requests).toMatchObject([{ p_authorized: true }]);
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it.each(['WHATSAPP_COEXISTENCE_APP_ID', 'WHATSAPP_COEXISTENCE_APP_SECRET'])(
    'does not attest authorization without %s',
    async (setting) => {
      const db = new CaptureDatabase();
      const body = envelope();
      vi.stubEnv(setting, '');
      db.result = { status: 503, legacy_indices: [], captured: 0, staged: 0 };
      expect(
        (
          await captureCoexistenceWebhook(
            body,
            signed(body, 'legacy-secret'),
            db.client()
          )
        )?.status
      ).toBe(503);
      expect(db.requests).toMatchObject([{ p_authorized: false }]);
    }
  );

  it.each(['0', '09999', '1'.repeat(33), '9x', '-1', ' 9999'])(
    'withholds configured app attestation for invalid ID %s',
    async (appId) => {
      const db = new CaptureDatabase();
      vi.stubEnv('WHATSAPP_COEXISTENCE_APP_ID', appId);
      const body = envelope();

      expect(
        (await captureCoexistenceWebhook(body, signed(body), db.client()))
          ?.status
      ).toBe(401);
      expect(db.requests).toEqual([]);

      await captureCoexistenceWebhook(
        body,
        signed(body, 'legacy-secret'),
        db.client()
      );
      expect(db.requests).toMatchObject([
        { p_app_id: null, p_authorized: false },
      ]);
    }
  );

  it.each(['0', '07777', '1'.repeat(33), '7x', '-1', ' 7777'])(
    'withholds invalid configured partner ID %s',
    async (partnerId) => {
      const db = new CaptureDatabase();
      vi.stubEnv('WHATSAPP_COEXISTENCE_PARTNER_BUSINESS_ID', partnerId);
      const body = envelope();

      await captureCoexistenceWebhook(body, signed(body), db.client());
      expect(db.requests).toMatchObject([
        { p_partner_business_id: null, p_authorized: true },
      ]);
    }
  );

  it.each(['1', '9'.repeat(32)])(
    'accepts bounded canonical configured ID %s without numeric conversion',
    async (id) => {
      const db = new CaptureDatabase();
      vi.stubEnv('WHATSAPP_COEXISTENCE_APP_ID', id);
      vi.stubEnv('WHATSAPP_COEXISTENCE_PARTNER_BUSINESS_ID', id);
      const body = envelope();

      await captureCoexistenceWebhook(body, signed(body), db.client());
      expect(db.requests).toMatchObject([
        { p_app_id: id, p_partner_business_id: id, p_authorized: true },
      ]);
    }
  );

  it.each([1001, Number.MAX_SAFE_INTEGER])(
    'allows safe-integer fanout count %i without imposing a change-count cap',
    async (captured) => {
      const db = new CaptureDatabase();
      db.result = { status: 200, legacy_indices: [], captured, staged: 0 };
      const body = envelope();

      expect(
        (await captureCoexistenceWebhook(body, signed(body), db.client()))
          ?.status
      ).toBe(200);
    }
  );

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1', null])(
    'rejects invalid staged count %j',
    async (staged) => {
      const db = new CaptureDatabase();
      db.result = { status: 200, legacy_indices: [], captured: 0, staged };
      const body = envelope();

      expect(
        (await captureCoexistenceWebhook(body, signed(body), db.client()))
          ?.status
      ).toBe(503);
    }
  );

  it.each([
    'message_template_status_update',
    'message_template_quality_update',
    'message_template_components_update',
  ])(
    'allows only recognized template field %s to carry legacy content',
    async (field) => {
      const db = new CaptureDatabase();
      db.result = { status: 200, legacy_indices: [0], captured: 0, staged: 0 };

      const body = envelope([{ field, value: { messages: [], statuses: [] } }]);

      expect(
        await captureCoexistenceWebhook(body, signed(body), db.client())
      ).toBeNull();
    }
  );

  it.each(['messages', 'statuses'])(
    'does not treat an unrecognized template prefix as permission for %s content',
    async (property) => {
      const db = new CaptureDatabase();
      db.result = { status: 200, legacy_indices: [0], captured: 0, staged: 0 };

      const body = envelope([
        { field: 'message_template_future_update', value: { [property]: [] } },
      ]);

      expect(
        (await captureCoexistenceWebhook(body, signed(body), db.client()))
          ?.status
      ).toBe(503);
    }
  );

  it('returns only SQL-selected original legacy changes in original order', async () => {
    const db = new CaptureDatabase();
    db.result = { status: 200, legacy_indices: [2, 0], captured: 0, staged: 1 };
    const body = envelope([ordinary, privateChange, ordinary]);
    expect(
      await captureCoexistenceWebhook(body, signed(body), db.client())
    ).toEqual({
      status: 200,
      legacy: {
        object: 'whatsapp_business_account',
        entry: [{ id: '005678', changes: [ordinary, ordinary] }],
      },
    });
  });

  it.each(['false', 'true'])(
    'leaves SQL-known legacy to original authentication with flag %s and no dedicated settings',
    async (enabled) => {
      const db = new CaptureDatabase();
      vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', enabled);
      vi.stubEnv('WHATSAPP_COEXISTENCE_APP_ID', '');
      vi.stubEnv('WHATSAPP_COEXISTENCE_APP_SECRET', '');
      db.result = { status: 200, legacy_indices: [0], captured: 0, staged: 0 };
      const body = envelope([ordinary]);

      expect(
        await captureCoexistenceWebhook(
          body,
          signed(body, 'legacy-secret'),
          db.client()
        )
      ).toBeNull();
      expect(db.requests).toMatchObject([
        { p_app_id: null, p_enabled: enabled === 'true', p_authorized: false },
      ]);
    }
  );

  it.each([400, 401, 403, 503])(
    'suppresses all legacy continuation on SQL status %i, even after a durable stop',
    async (status) => {
      const db = new CaptureDatabase();
      db.result = { status, legacy_indices: [0], captured: 1, staged: 0 };
      const body = envelope([ordinary, stop]);

      const response = await captureCoexistenceWebhook(
        body,
        signed(body),
        db.client()
      );

      expect(response).toBeInstanceOf(Response);
      expect(response?.status).toBe(status);
    }
  );

  it.each([null, {}, { field: 42 }, { field: 'messages' }])(
    'preserves signed valid negative alongside malformed descriptor %j',
    async (bad) => {
      const db = new CaptureDatabase();
      db.result = { status: 400, legacy_indices: [], captured: 1, staged: 0 };
      const body = envelope([jsonSchema.parse(bad), stop]);
      expect(
        (await captureCoexistenceWebhook(body, signed(body), db.client()))
          ?.status
      ).toBe(400);
      expect(db.requests).toMatchObject([
        { p_changes: [{ invalid: true }, { entry_id: '005678', ...stop }] },
      ]);
    }
  );

  it.each([null, {}, { id: 42, changes: [] }])(
    'preserves a stop after malformed entry %j',
    async (entry) => {
      const db = new CaptureDatabase();
      db.result = { status: 400, legacy_indices: [], captured: 1, staged: 0 };

      const body = JSON.stringify({
        entry: [entry, { id: '5678', changes: [stop] }],
      });

      expect(
        (await captureCoexistenceWebhook(body, signed(body), db.client()))
          ?.status
      ).toBe(400);
      expect(db.requests).toMatchObject([
        { p_changes: [{ invalid: true }, { ...stop }] },
      ]);
    }
  );

  it.each([
    null,
    {},
    { status: '200', legacy_indices: [], captured: 0, staged: 0 },
    { status: 201, legacy_indices: [], captured: 0, staged: 0 },
    ...[[0, 0], [-1], [1], [0.5], ['0']].map((legacy_indices) => ({
      status: 200,
      legacy_indices,
      captured: 0,
      staged: 0,
    })),
    ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1', null].map((captured) => ({
      status: 200,
      legacy_indices: [],
      captured,
      staged: 0,
    })),
    { status: 200, legacy_indices: [], captured: 0, staged: -1 },
  ])('fails closed on malformed SQL result %j', async (result) => {
    const db = new CaptureDatabase();
    db.result = jsonSchema.parse(result);
    const body = envelope();
    expect(
      (await captureCoexistenceWebhook(body, signed(body), db.client()))?.status
    ).toBe(503);
    expect(db.requests).toHaveLength(1);
  });

  it('sanitizes DB failure and disables automatic retries; the next delivery remains retryable', async () => {
    const db = new CaptureDatabase();
    db.fail = true;
    const body = envelope();

    const response = await captureCoexistenceWebhook(
      body,
      signed(body),
      db.client()
    );

    expect(response).toBeInstanceOf(Response);

    if (!(response instanceof Response))
      throw new Error('Expected error response');
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('secret database error');
    expect(db.requests).toHaveLength(1);
    db.fail = false;
    expect(
      (await captureCoexistenceWebhook(body, signed(body), db.client()))?.status
    ).toBe(200);
    expect(db.requests[0]).toEqual(db.requests[1]);
  });

  it('ACKs an SQL-staged unbound provider read receipt without emitting a connected result', async () => {
    const db = new CaptureDatabase();

    const read = {
      field: 'messages',
      value: {
        metadata: { phone_number_id: '1234' },
        statuses: [{ id: 'wamid.read', status: 'read' }],
      },
    };

    const body = envelope([read]);

    const response = await captureCoexistenceWebhook(
      body,
      signed(body),
      db.client()
    );

    expect(response).toBeInstanceOf(Response);

    if (!(response instanceof Response))
      throw new Error('Expected private ACK');

    expect(await response.json()).toEqual({ status: 'received' });
    expect(db.requests).toMatchObject([{ p_changes: [{ ...read }] }]);
  });

  it('rejects an SQL legacy index that points at a structurally invalid descriptor', async () => {
    const db = new CaptureDatabase();
    db.result = { status: 200, legacy_indices: [0], captured: 0, staged: 0 };

    const body = envelope([{ field: 42, value: { preserved: true } }, stop]);

    expect(
      (await captureCoexistenceWebhook(body, signed(body), db.client()))?.status
    ).toBe(503);
    expect(db.requests).toMatchObject([
      {
        p_changes: [{ invalid: true, value: { preserved: true } }, { ...stop }],
      },
    ]);
  });

  it('accepts 1000 changes across entries with stable original coordinates', async () => {
    const db = new CaptureDatabase();

    const body = JSON.stringify({
      entry: [
        { id: '1', changes: Array.from({ length: 500 }, () => ordinary) },
        { id: '2', changes: Array.from({ length: 500 }, () => ordinary) },
      ],
    });

    expect(
      (await captureCoexistenceWebhook(body, signed(body), db.client()))?.status
    ).toBe(200);
    expect(db.requests).toMatchObject([
      {
        p_changes: expect.arrayContaining([
          expect.objectContaining({
            dedupe_key: `${createHash('sha256').update(body).digest('hex')}:1:499`,
          }),
        ]),
      },
    ]);
  });

  it('accepts empty changes and rejects more than 1000 total changes before HTTP', async () => {
    const db = new CaptureDatabase();
    db.result = { status: 200, legacy_indices: [], captured: 0, staged: 0 };
    expect(
      await captureCoexistenceWebhook(
        envelope([]),
        signed(envelope([])),
        db.client()
      )
    ).toBeNull();

    const body = JSON.stringify({
      entry: [
        { id: '1', changes: Array.from({ length: 500 }, () => ordinary) },
        { id: '2', changes: Array.from({ length: 501 }, () => ordinary) },
      ],
    });

    expect(
      (await captureCoexistenceWebhook(body, signed(body), db.client()))?.status
    ).toBe(400);
    expect(db.requests).toHaveLength(1);
  });

  it.each([
    '{"entry":[],"number":1e999}',
    '{',
    'x'.repeat(MAX_WEBHOOK_BODY_BYTES + 1),
  ])(
    'rejects invalid, nonfinite or oversized JSON before HTTP',
    async (body) => {
      const db = new CaptureDatabase();
      expect(
        (await captureCoexistenceWebhook(body, signed(body), db.client()))
          ?.status
      ).toBe(body.length > MAX_WEBHOOK_BODY_BYTES ? 413 : 400);
      expect(db.requests).toEqual([]);
    }
  );
});
