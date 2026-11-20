import { listenForFetch } from '@/test/http-server';
import { createServer, type Server } from 'node:http';
import { createClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { encrypt } from '@/lib/whatsapp/encryption';
import { verifySignatureHeader } from '@/lib/webhooks/sign';
import { deadlineFetch, withRequestDeadline } from '@/lib/request-deadline';
import { drainCoexistenceStatusEvents } from './status-events';

const eventId = '11111111-1111-4111-8111-111111111111';
const leaseToken = '22222222-2222-4222-8222-222222222222';
const accountId = '33333333-3333-4333-8333-333333333333';
const conversationId = '44444444-4444-4444-8444-444444444444';
const occurredAt = '2026-11-17T09:00:00+00:00';

const context = {
  id: eventId,
  lease_token: leaseToken,
  account_id: accountId,
  conversation_id: conversationId,
  whatsapp_message_id: 'wamid.outgoing',
  status: 'delivered',
  occurred_at: occurredAt,
};

class StatusDatabase {
  pending = true;
  claims: unknown[] = [context];
  claimCalls = 0;
  claimError = false;
  claimReplyLost = false;
  settlementError = false;
  settlementStatus: 'completed' | 'ambiguous' | 'stale' | null = null;
  lookupError = false;
  updateError = false;
  settled: unknown[] = [];
  requests: string[] = [];
  endpoints = ['a'];

  async fetch(input: RequestInfo | URL, init?: RequestInit) {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname.replace('/rest/v1/', '');
    this.requests.push(`${request.method} ${path}`);

    if (path === 'rpc/coexistence_status_event_claim') {
      this.claimCalls++;
      expect(await request.json()).toEqual({ p_app_id: '1234', p_limit: 1 });

      if (this.claimError)
        return Response.json(
          { message: 'secret claim error' },
          { status: 503 }
        );

      const claims = this.pending ? this.claims : [];
      this.pending = false; // RUNNING is durable even when the reply is lost.

      if (this.claimReplyLost)
        return Response.json({ message: 'lost claim reply' }, { status: 503 });

      return Response.json(claims);
    }

    if (path === 'rpc/coexistence_status_event_settle') {
      const body = z
        .object({ p_status: z.enum(['completed', 'ambiguous']) })
        .passthrough()
        .parse(await request.json());

      this.settled.push(body);

      if (this.settlementError)
        return Response.json(
          { message: 'secret settlement error' },
          { status: 503 }
        );

      return Response.json(this.settlementStatus ?? body.p_status);
    }

    if (path === 'webhook_endpoints' && request.method === 'GET') {
      expect(new URL(request.url).searchParams.get('account_id')).toBe(
        `eq.${accountId}`
      );
      expect(new URL(request.url).searchParams.get('events')).toContain(
        'message.status_updated'
      );

      if (this.lookupError)
        return Response.json({ message: 'lookup failed' }, { status: 403 });

      return Response.json(
        this.endpoints.map((id) => ({
          id,
          url: `https://8.8.8.8/${id}`,
          secret: encrypt('test-webhook-secret'),
        }))
      );
    }

    if (path === 'webhook_endpoints' && request.method === 'PATCH')
      return this.updateError
        ? Response.json({ message: 'write failed' }, { status: 503 })
        : Response.json(null);

    if (path === 'rpc/record_webhook_failure') return Response.json(null);

    throw new Error(`Unexpected fixture request: ${path}`);
  }

  client() {
    return createClient('http://127.0.0.1:54321', 'test-service-key', {
      global: { fetch: this.fetch.bind(this) },
      auth: { persistSession: false },
    });
  }
}

let db: StatusDatabase;
let server: Server;
let origin: string;
let scenario: 'success' | 'partial' | 'lost reply' | 'stalled';
let received: { body: string; signature: string }[];

beforeEach(async () => {
  db = new StatusDatabase();
  received = [];
  scenario = 'success';
  server = createServer(async (request, response) => {
    let body = '';

    for await (const chunk of request) body += chunk;

    if (request.url?.startsWith('/rest/v1/')) {
      const result = await db.fetch(
        new Request(`${origin}${request.url}`, {
          method: request.method,
          body: body || undefined,
        })
      );

      response.writeHead(result.status, { 'Content-Type': 'application/json' });
      response.end(await result.text());

      return;
    }

    received.push({
      body,
      signature: String(request.headers['x-wacrm-signature']),
    });

    if (scenario === 'stalled') return;

    if (scenario === 'lost reply') {
      request.socket.destroy();

      return;
    }

    response.writeHead(
      scenario === 'partial' && request.url === '/b' ? 503 : 204
    );
    response.end();
  });
  origin = await listenForFetch(server);
  const fetch = globalThis.fetch;
  // Keep real SSRF, encryption, signing and delivery; redirect only the HTTP boundary.
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString()
    );

    if (url.origin === origin) return fetch(input, init);

    expect(url.origin).toBe('https://8.8.8.8');

    return fetch(`${origin}${url.pathname}`, init);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});

describe('durable public status HTTP boundary', () => {
  it('delivers the stable identity/time and existing public keys with real signing', async () => {
    await expect(
      drainCoexistenceStatusEvents(db.client(), '1234')
    ).resolves.toEqual({ completed: 1, ambiguous: 0, stale: 0 });
    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0].body)).toEqual({
      id: eventId,
      event: 'message.status_updated',
      occurred_at: occurredAt,
      account_id: accountId,
      data: {
        whatsapp_message_id: 'wamid.outgoing',
        conversation_id: conversationId,
        status: 'delivered',
      },
    });
    expect(
      verifySignatureHeader(
        received[0].signature,
        received[0].body,
        'test-webhook-secret',
        Math.floor(Date.now() / 1000)
      )
    ).toBe(true);
    expect(db.settled).toEqual([
      { p_event_id: eventId, p_lease_token: leaseToken, p_status: 'completed' },
    ]);
  });

  it.each(['partial', 'lost reply'] as const)(
    'never replays %s fanout, including from a fresh client',
    async (failure) => {
      scenario = failure;
      db.endpoints = ['a', 'b'];
      await expect(
        drainCoexistenceStatusEvents(db.client(), '1234')
      ).resolves.toEqual({ completed: 0, ambiguous: 1, stale: 0 });
      expect(received).toHaveLength(2);
      expect(received[0].body).toBe(received[1].body);
      await drainCoexistenceStatusEvents(db.client(), '1234');
      expect(received).toHaveLength(2);
      expect(db.settled).toEqual([
        {
          p_event_id: eventId,
          p_lease_token: leaseToken,
          p_status: 'ambiguous',
        },
      ]);
    }
  );

  it('does not resend after a successful HTTP delivery with a lost settlement reply', async () => {
    db.settlementError = true;
    await expect(
      drainCoexistenceStatusEvents(db.client(), '1234')
    ).rejects.toThrow('Coexistence status event settlement failed');
    db.settlementError = false;
    await drainCoexistenceStatusEvents(db.client(), '1234');
    expect(received).toHaveLength(1);
  });

  it.each(['sent', 'read', 'failed'])(
    'retains the stored %s status',
    async (status) => {
      db.claims = [{ ...context, status }];
      await drainCoexistenceStatusEvents(db.client(), '1234');
      expect(JSON.parse(received[0].body).data.status).toBe(status);
    }
  );

  it('surfaces claim errors without leaking database error details', async () => {
    db.claimError = true;
    await expect(
      drainCoexistenceStatusEvents(db.client(), '1234')
    ).rejects.toThrow(/^Coexistence status event claim failed$/);
    expect(received).toHaveLength(0);
    expect(db.settled).toHaveLength(0);
  });

  it('rejects an oversized claim batch without authorizing any dispatch', async () => {
    db.claims = [context, context];
    await expect(
      drainCoexistenceStatusEvents(db.client(), '1234')
    ).rejects.toThrow('Invalid coexistence status event claim');
    expect(received).toHaveLength(0);
  });

  it('never dispatches after a lost claim reply', async () => {
    db.claimReplyLost = true;
    await expect(
      drainCoexistenceStatusEvents(db.client(), '1234')
    ).rejects.toThrow('Coexistence status event claim failed');
    db.claimReplyLost = false;
    await drainCoexistenceStatusEvents(db.client(), '1234');
    expect(received).toHaveLength(0);
  });

  it.each(['lookupError', 'updateError'] as const)(
    'settles ambiguous on %s',
    async (failure) => {
      db[failure] = true;
      await expect(
        drainCoexistenceStatusEvents(db.client(), '1234')
      ).resolves.toEqual({ completed: 0, ambiguous: 1, stale: 0 });
      expect(received).toHaveLength(failure === 'lookupError' ? 0 : 1);
    }
  );

  it('counts stale settlement without replay', async () => {
    db.settlementStatus = 'stale';
    await expect(
      drainCoexistenceStatusEvents(db.client(), '1234')
    ).resolves.toEqual({ completed: 0, ambiguous: 0, stale: 1 });
    expect(received).toHaveLength(1);
  });

  it('completes an event with no subscribed endpoints', async () => {
    db.endpoints = [];
    await expect(
      drainCoexistenceStatusEvents(db.client(), '1234')
    ).resolves.toEqual({ completed: 1, ambiguous: 0, stale: 0 });
    expect(received).toHaveLength(0);
  });

  it.each([
    { status: 'not-a-status' },
    { account_id: 'invalid' },
    { conversation_id: 'invalid' },
    { whatsapp_message_id: '' },
    { occurred_at: 'not-a-date' },
  ])('fails closed on malformed claim context %j', async (fields) => {
    db.claims = [{ ...context, ...fields }];
    await expect(
      drainCoexistenceStatusEvents(db.client(), '1234')
    ).resolves.toEqual({ completed: 0, ambiguous: 1, stale: 0 });
    expect(received).toHaveLength(0);
  });

  it('rejects malformed claim identity without echoing database secrets', async () => {
    db.claims = [{ ...context, id: 'secret-bad-id' }];
    await expect(
      drainCoexistenceStatusEvents(db.client(), '1234')
    ).rejects.toThrow('Invalid coexistence status event claim');
    expect(db.settled).toHaveLength(0);
    expect(received).toHaveLength(0);
  });

  it('claims only one event at a time and stops after five', async () => {
    const fetch = db.fetch.bind(db);
    vi.spyOn(db, 'fetch').mockImplementation((input, init) => {
      if (
        new URL(
          input instanceof Request ? input.url : input.toString()
        ).pathname.endsWith('_claim')
      )
        db.pending = true;

      return fetch(input, init);
    });
    await expect(
      drainCoexistenceStatusEvents(db.client(), '1234')
    ).resolves.toEqual({ completed: 5, ambiguous: 0, stale: 0 });
    expect(db.claimCalls).toBe(5);
    expect(received).toHaveLength(5);
  });

  it('does not claim with an exhausted deadline', async () => {
    await expect(
      drainCoexistenceStatusEvents(db.client(), '1234', Date.now() - 1)
    ).resolves.toEqual({ completed: 0, ambiguous: 0, stale: 0 });
    expect(db.requests).toHaveLength(0);
  });

  it('persists ambiguity under the outer budget after a stalled POST exhausts the action deadline', async () => {
    scenario = 'stalled';

    const client = createClient(origin, 'test-service-key', {
      global: { fetch: deadlineFetch },
      auth: { persistSession: false },
    });

    const now = Date.now();
    const actionDeadline = now + 1000;

    await expect(
      withRequestDeadline(now + 10_000, () =>
        drainCoexistenceStatusEvents(client, '1234', actionDeadline)
      )
    ).resolves.toEqual({ completed: 0, ambiguous: 1, stale: 0 });
    expect(Date.now()).toBeGreaterThanOrEqual(actionDeadline);
    expect(received).toHaveLength(1);
    expect(db.claimCalls).toBe(1);
    expect(db.settled).toEqual([
      { p_event_id: eventId, p_lease_token: leaseToken, p_status: 'ambiguous' },
    ]);
    expect(db.requests.at(-1)).toBe('POST rpc/coexistence_status_event_settle');
    await drainCoexistenceStatusEvents(client, '1234');
    expect(received).toHaveLength(1);
    expect(db.settled).toHaveLength(1);
  });

  it('does not dispatch if the deadline expires while claiming', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const fetch = db.fetch.bind(db);
    vi.spyOn(db, 'fetch').mockImplementation(async (input, init) => {
      const result = await fetch(input, init);
      vi.mocked(Date.now).mockReturnValue(now + 1000);

      return result;
    });
    await expect(
      drainCoexistenceStatusEvents(db.client(), '1234', now + 100)
    ).resolves.toEqual({ completed: 0, ambiguous: 1, stale: 0 });
    expect(received).toHaveLength(0);
  });

  it('rejects invalid app scope before accessing the database', async () => {
    await expect(
      drainCoexistenceStatusEvents(db.client(), 'invalid')
    ).rejects.toThrow();
    expect(db.requests).toHaveLength(0);
  });
});
