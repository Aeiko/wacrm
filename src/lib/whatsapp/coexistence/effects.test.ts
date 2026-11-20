import { createServer, type Server } from 'node:http';
import { isFetchPort, listenForFetch } from '@/test/http-server';
import { createClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const messageId = '11111111-1111-4111-8111-111111111111';
const token = '22222222-2222-4222-8222-222222222222';
const actionId = '33333333-3333-4333-8333-333333333333';
const accountId = '44444444-4444-4444-8444-444444444444';
const userId = '55555555-5555-4555-8555-555555555555';
const contactId = '66666666-6666-4666-8666-666666666666';
const conversationId = '77777777-7777-4777-8777-777777777777';

class EffectDatabase {
  stage = 9;
  pending = true;
  wasNewConversation = false;
  wasNewContact = false;
  wasFirstInbound = false;
  triggerTypes: string[] = [];
  consumed = false;
  replyId: string | null = null;
  contentText = 'Hello';
  failedTable = '';
  automationEnabled = false;
  contactName = 'Original';
  contactWrites = 0;
  pauseContactWrite = false;
  contactWriteGate = Promise.withResolvers<void>();
  contactWriteStarted = Promise.withResolvers<void>();
  failLogAfterWrite = false;
  failSettlement = false;
  beginStatus: 'running' | 'stale' = 'running';
  requests: string[] = [];
  settlements: unknown[] = [];
  logInserts: unknown[] = [];

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace('/rest/v1/', '');
    this.requests.push(`${request.method} ${path}`);

    if (path === 'rpc/coexistence_effect_claim') {
      return Response.json(
        this.pending ? [{ message_id: messageId, lease_token: token }] : []
      );
    }

    if (path === 'rpc/coexistence_effect_begin') {
      if (this.beginStatus !== 'running') {
        this.pending = false;

        return Response.json({ status: this.beginStatus });
      }

      return Response.json({
        status: 'running',
        stage: this.stage,
        action_id: actionId,
        content_consumed: this.consumed,
        account_id: accountId,
        config_id: token,
        generation: actionId,
        config_owner_user_id: userId,
        conversation_id: conversationId,
        contact_id: contactId,
        whatsapp_message_id: 'wamid.live',
        content_type: 'text',
        content_text: this.contentText,
        interactive_reply_id: this.replyId,
        was_new_contact: this.wasNewContact,
        was_new_conversation: this.wasNewConversation,
        was_first_inbound: this.wasFirstInbound,
        occurred_at: '2026-11-17T00:00:00Z',
      });
    }

    if (path === 'rpc/coexistence_effect_settle') {
      const body = z
        .object({ p_status: z.enum(['completed', 'ambiguous']) })
        .passthrough()
        .parse(await request.json());

      this.settlements.push(body);
      this.pending = false;

      if (this.failSettlement)
        return Response.json(
          { message: 'Lost settlement response' },
          { status: 503 }
        );

      return Response.json(
        body.p_status === 'ambiguous'
          ? 'ambiguous'
          : this.stage === 9
            ? 'completed'
            : 'pending'
      );
    }

    if (path === this.failedTable)
      return Response.json(
        { message: 'Fixture lookup failed' },
        { status: 403 }
      );

    if (path === 'contacts' && request.method === 'PATCH') {
      this.contactName = z
        .object({ name: z.string() })
        .parse(await request.json()).name;
      this.contactWrites++;
      this.contactWriteStarted.resolve();

      if (this.pauseContactWrite) await this.contactWriteGate.promise;

      return Response.json(null);
    }

    if (this.automationEnabled && path === 'automations')
      return Response.json([
        {
          id: actionId,
          account_id: accountId,
          user_id: userId,
          trigger_type: 'new_message_received',
          trigger_config: {},
          is_active: true,
        },
      ]);

    if (path === 'automation_steps')
      return Response.json([
        {
          id: token,
          automation_id: actionId,
          parent_step_id: null,
          branch: null,
          position: 0,
          step_type: 'update_contact_field',
          step_config: { field: 'name', value: 'Qualified {{ message.text }}' },
        },
      ]);

    if (path === 'automation_logs') {
      if (request.method === 'POST') this.logInserts.push(await request.json());

      if (this.failLogAfterWrite && this.contactWrites > 0)
        return Response.json(
          { message: 'Fixture log write failed' },
          { status: 403 }
        );

      return Response.json({
        id: actionId,
        steps_executed: [],
        status: 'failed',
      });
    }

    if (path === 'rpc/increment_automation_execution_count')
      return Response.json(null);

    if (path === 'contacts') return Response.json({ id: contactId });

    if (path === 'conversations') return Response.json({ id: conversationId });

    if (path === 'ai_configs') return Response.json(null);

    if (path === 'automations')
      this.triggerTypes.push(url.searchParams.get('trigger_type') ?? '');

    if (
      [
        'webhook_endpoints',
        'flow_runs',
        'flows',
        'automations',
        'automation_pending_executions',
      ].includes(path)
    )
      return Response.json([]);

    return Response.json(
      { message: 'Unexpected fixture request' },
      { status: 500 }
    );
  }
}

let database: EffectDatabase;
let server: Server;
let origin: string;

beforeEach(async () => {
  vi.resetModules();
  database = new EffectDatabase();
  server = createServer(async (request, response) => {
    let body = '';

    for await (const chunk of request) body += chunk;

    try {
      const result = await database.handle(
        new Request(`${origin}${request.url}`, {
          method: request.method,
          body: body || undefined,
        })
      );

      response.writeHead(result.status, {
        'Content-Type': 'application/json',
        Connection: 'close',
      });
      response.end(await result.text());
    } catch {
      response.writeHead(500);
      response.end();
    }
  });

  origin = await listenForFetch(server);

  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', origin);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-key');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  database.contactWriteGate.resolve();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});

async function drain(deadline?: number) {
  const { drainCoexistenceEffects } = await import('./effects');

  const db = createClient(origin, 'test-service-key', {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return drainCoexistenceEffects(db, '9999', deadline);
}

describe('durable effect worker HTTP boundary', () => {
  it('excludes fetch-forbidden ports from fixture transport setup', () => {
    expect(isFetchPort(6667)).toBe(false);
    expect(isFetchPort(10080)).toBe(false);
    expect(isFetchPort(80)).toBe(false);
    expect(isFetchPort(49152)).toBe(true);
  });

  it('persists the effect origin on automation logs without refreshing the connection', async () => {
    database.stage = 5;
    database.automationEnabled = true;
    expect((await drain()).advanced).toBe(1);
    expect(database.logInserts).toEqual([
      expect.objectContaining({
        send_config_id: token,
        send_generation: actionId,
      }),
    ]);
    expect(database.requests).not.toContain('GET whatsapp_config');
  });

  it('cancels a stalled handler, persists ambiguity, and starts no later engine request', async () => {
    await import('./effects');
    database.stage = 5;
    database.automationEnabled = true;
    database.pauseContactWrite = true;
    const start = Date.now();
    // Advance the deadline only after the stalled write starts, not during fixture startup.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    const draining = drain(start + 500);

    await database.contactWriteStarted.promise;
    clock.mockReturnValue(start + 501);
    expect((await draining).ambiguous).toBe(1);
    expect(database.contactWrites).toBe(1);
    expect(
      database.requests.slice(database.requests.indexOf('PATCH contacts') + 1)
    ).toEqual(['POST rpc/coexistence_effect_settle']);
    expect(database.settlements).toEqual([
      expect.objectContaining({ p_status: 'ambiguous' }),
    ]);
  });

  it('does not claim another stage after the shared request deadline', async () => {
    expect(await drain(Date.now() - 1)).toEqual({
      advanced: 0,
      completed: 0,
      ambiguous: 0,
      stale: 0,
    });
    expect(database.requests).toEqual([]);
  });

  it.each([false, true])(
    'emits conversation.created only for a newly opened thread (%s)',
    async (created) => {
      database.stage = 0;
      database.wasNewConversation = created;
      expect(await drain()).toEqual({
        advanced: 1,
        completed: 0,
        ambiguous: 0,
        stale: 0,
      });
      expect(database.requests.includes('GET webhook_endpoints')).toBe(created);
      expect(database.settlements).toEqual([
        expect.objectContaining({ p_stage: 0, p_status: 'completed' }),
      ]);
    }
  );

  it('checkpoints a confirmed no-matching-flow decision before allowing later responders', async () => {
    database.stage = 1;
    expect((await drain()).advanced).toBe(1);
    expect(database.requests).toContain('GET flow_runs');
    expect(database.requests).toContain('GET flows');
    expect(database.settlements).toEqual([
      expect.objectContaining({ p_status: 'completed', p_consumed: false }),
    ]);
  });

  it.each([2, 3, 4, 5, 6, 7, 8])(
    'runs the eligible existing handler at stage %i',
    async (stage) => {
      database.stage = stage;
      database.wasNewContact = true;
      database.wasFirstInbound = true;
      database.replyId = stage === 7 ? 'menu-1' : null;
      expect((await drain()).advanced).toBe(1);
      expect(database.requests).toContain(
        stage === 2
          ? 'GET automation_pending_executions'
          : stage === 8
            ? 'GET ai_configs'
            : 'GET automations'
      );

      const triggers = [
        '',
        '',
        '',
        'first_inbound_message',
        'new_contact_created',
        'new_message_received',
        'keyword_match',
        'interactive_reply',
      ];

      if (stage >= 3 && stage <= 7)
        expect(database.triggerTypes).toEqual([`eq.${triggers[stage]}`]);
    }
  );

  it.each([2, 5, 6, 7, 8])(
    'does not run a competing responder after consumption (stage %i)',
    async (stage) => {
      database.stage = stage;
      database.consumed = true;
      expect((await drain()).advanced).toBe(1);
      expect(
        database.requests.filter((request) => !request.includes(' rpc/'))
      ).toEqual([]);
    }
  );

  it.each([3, 4, 7, 8])(
    'checkpoints inapplicable actions without calling an engine (stage %i)',
    async (stage) => {
      database.stage = stage;
      database.contentText = '  ';
      expect((await drain()).advanced).toBe(1);
      expect(
        database.requests.filter((request) => !request.includes(' rpc/'))
      ).toEqual([]);
    }
  );

  it.each([
    [1, 'flow_runs'],
    [1, 'flows'],
    [2, 'automation_pending_executions'],
    [3, 'contacts'],
    [4, 'conversations'],
    [5, 'automations'],
    [8, 'ai_configs'],
  ] as const)(
    'does not confuse failed stage %i lookup (%s) with a confirmed skip',
    async (stage, table) => {
      database.stage = stage;
      database.failedTable = table;
      database.wasNewContact = true;
      database.wasFirstInbound = true;
      expect((await drain()).ambiguous).toBe(1);
      expect(database.requests).toContain(`GET ${table}`);
      expect(database.settlements).toEqual([
        expect.objectContaining({ p_status: 'ambiguous' }),
      ]);
    }
  );

  it.each([false, true])(
    'does not repeat a contact mutation after its handler finishes (log failure: %s)',
    async (failLog) => {
      database.stage = 5;
      database.automationEnabled = true;
      database.failLogAfterWrite = failLog;
      const result = await drain();
      expect(result.ambiguous).toBe(failLog ? 1 : 0);
      expect(result.advanced).toBe(failLog ? 0 : 1);
      expect(database.contactName).toBe('Qualified Hello');
      expect(database.contactWrites).toBe(1);
      await drain();
      expect(database.contactWrites).toBe(1);
      expect(database.settlements).toHaveLength(1);
    }
  );

  it('records failed endpoint discovery as ambiguous without automatically retrying', async () => {
    database.failedTable = 'webhook_endpoints';
    expect((await drain()).ambiguous).toBe(1);
    expect((await drain()).completed).toBe(0);
    expect(
      database.requests.filter((request) => request === 'GET webhook_endpoints')
    ).toHaveLength(1);
    expect(database.settlements).toEqual([
      expect.objectContaining({ p_status: 'ambiguous' }),
    ]);
  });

  it('never executes an action after the database rejects its binding or lease', async () => {
    database.beginStatus = 'stale';
    expect((await drain()).stale).toBe(1);
    expect(database.requests).not.toContain('GET webhook_endpoints');
    expect(database.settlements).toEqual([]);
  });

  it('does not repeat an action after losing its settlement response', async () => {
    database.failSettlement = true;
    await expect(drain()).rejects.toThrow('settlement failed');
    expect((await drain()).completed).toBe(0);
    expect(
      database.requests.filter((request) => request === 'GET webhook_endpoints')
    ).toHaveLength(1);
    expect(database.settlements).toHaveLength(1);
  });

  it('records the final action after it finishes and does not repeat it with a fresh worker', async () => {
    expect(await drain()).toEqual({
      advanced: 0,
      completed: 1,
      ambiguous: 0,
      stale: 0,
    });
    expect(database.requests.slice(0, 4)).toEqual([
      'POST rpc/coexistence_effect_claim',
      'POST rpc/coexistence_effect_begin',
      'GET webhook_endpoints',
      'POST rpc/coexistence_effect_settle',
    ]);
    expect(database.settlements).toEqual([
      {
        p_message_id: messageId,
        p_lease_token: token,
        p_stage: 9,
        p_status: 'completed',
        p_consumed: false,
      },
    ]);
    expect(await drain()).toEqual({
      advanced: 0,
      completed: 0,
      ambiguous: 0,
      stale: 0,
    });
    expect(database.settlements).toHaveLength(1);
  });
});
