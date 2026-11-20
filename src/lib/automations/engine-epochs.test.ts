import { createServer, type Server } from 'node:http';
import { listenForFetch } from '@/test/http-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const rowSchema = z.record(z.string(), z.json());

type Row = z.infer<typeof rowSchema>;

const tablesSchema = z.record(z.string(), z.array(rowSchema));

type Tables = z.infer<typeof tablesSchema>;

type FixtureResponse = Row | Row[] | null;

const accountId = 'account-1';
const generation = 'generation-1';
const configId = 'config-1';
const epoch = { send_config_id: configId, send_generation: generation };
let tables: Tables;
let server: Server;
let origin: string;
let posts: Row[];
let sequence: number;
let failFlowClosure = false;
let failConnectionLookup = false;

function matches(row: Row, url: URL) {
  return [...url.searchParams].every(([key, value]) => {
    if (['select', 'order', 'limit', 'offset'].includes(key)) return true;
    const dot = value.indexOf('.');
    const op = value.slice(0, dot);
    const expected = value.slice(dot + 1);
    const actual = row[key] ?? null;

    if (op === 'eq') return String(actual) === expected;

    if (op === 'is') return actual === null && expected === 'null';

    if (op === 'gte') return String(actual) >= expected;

    if (op === 'gt') return String(actual) > expected;

    if (op === 'lte') return actual !== null && String(actual) <= expected;

    if (op === 'lt') return actual !== null && String(actual) < expected;

    if (op === 'in')
      return expected.slice(1, -1).split(',').includes(String(actual));
    throw new Error(`Unsupported fixture filter: ${key}=${value}`);
  });
}

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('ENCRYPTION_KEY', 'ab'.repeat(32));
  vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
  vi.stubEnv('WHATSAPP_COEXISTENCE_APP_ID', '9999');
  vi.stubEnv('WHATSAPP_COEXISTENCE_APP_SECRET', 'test-app-secret');
  vi.stubEnv('WHATSAPP_COEXISTENCE_PARTNER_BUSINESS_ID', '8888');
  posts = [];
  sequence = 0;
  failFlowClosure = false;
  failConnectionLookup = false;
  const { encrypt } = await import('@/lib/whatsapp/encryption');
  tables = tablesSchema.parse({
    whatsapp_config: [
      {
        id: configId,
        account_id: accountId,
        phone_number_id: 'phone-1',
        access_token: encrypt('token-1'),
        status: 'connected',
        coexistence_app_id: '9999',
        coexistence_generation: generation,
        coexistence_verified_at: new Date().toISOString(),
      },
    ],
    contacts: [
      {
        id: 'contact-1',
        account_id: accountId,
        phone: '15551234567',
        wa_user_id: null,
      },
    ],
    conversations: [
      { id: 'conversation-1', account_id: accountId, contact_id: 'contact-1' },
    ],
    automations: [
      {
        id: 'automation-1',
        account_id: accountId,
        user_id: 'user-1',
        trigger_type: 'new_message_received',
        trigger_config: {},
        is_active: true,
      },
    ],
    automation_steps: [],
  });
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, origin);
      let raw = '';

      for await (const chunk of request) raw += chunk;
      const body = raw ? rowSchema.parse(JSON.parse(raw)) : {};
      let result: FixtureResponse;

      if (url.pathname === '/meta/messages') {
        posts.push(body);
        result = { messages: [{ id: `wamid.${posts.length}` }] };
      } else if (url.pathname === '/rest/v1/rpc/persist_outbound_message') {
        const message = rowSchema.parse(body.p_message);
        const id = `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
        (tables.messages ??= []).push({ id, ...message });
        result = { id, message_id: message.message_id ?? null, status: 'sent' };
      } else if (url.pathname.startsWith('/rest/v1/rpc/')) {
        result = null;
      } else {
        const table = url.pathname.replace('/rest/v1/', '');

        if (failConnectionLookup && table === 'whatsapp_config') {
          response.writeHead(403, { 'Content-Type': 'application/json' });
          response.end(
            JSON.stringify({ message: 'Fixture connection lookup denied' })
          );

          return;
        }

        if (
          failFlowClosure &&
          table === 'flow_runs' &&
          request.method === 'PATCH' &&
          body.end_reason === 'connection_changed'
        ) {
          response.writeHead(403, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ message: 'Fixture closure denied' }));

          return;
        }

        const rows = (tables[table] ??= []);
        let selected = rows.filter((row) => matches(row, url));

        if (request.method === 'POST') {
          const row = {
            id: `row-${++sequence}`,
            created_at: new Date().toISOString(),
            vars: {},
            reprompt_count: 0,
            transition_seq: 0,
            ...body,
          };

          rows.push(row);
          selected = [row];
        } else if (request.method === 'PATCH') {
          selected.forEach((row) => Object.assign(row, body));
        }

        const limit = url.searchParams.get('limit');

        if (limit) selected = selected.slice(0, Number(limit));
        result = request.headers.accept?.includes('vnd.pgrst.object')
          ? (selected[0] ?? null)
          : selected;
      }

      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ message: String(error) }));
    }
  });
  origin = await listenForFetch(server);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', origin);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-key');
  const fetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));

    if (url.hostname === 'graph.facebook.com')
      return fetch(`${origin}/meta/messages`, init);

    if (url.origin !== origin) throw new Error('Unexpected external request');

    return fetch(input, init);
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});

function step(id: string, type: string, position: number, config: Row) {
  return {
    id,
    automation_id: 'automation-1',
    step_type: type,
    position,
    step_config: config,
    parent_step_id: null,
    branch: null,
  };
}

async function trigger() {
  const { runAutomationsForTrigger } = await import('./engine');

  return runAutomationsForTrigger({
    accountId,
    triggerType: 'new_message_received',
    contactId: 'contact-1',
    context: { conversation_id: 'conversation-1', message_text: 'Hi' },
  });
}

async function cron() {
  vi.stubEnv('AUTOMATION_CRON_SECRET', 'cron-test-secret');
  const { GET } = await import('@/app/api/automations/cron/route');

  const response = await GET(
    new Request(`${origin}/api/automations/cron`, {
      headers: { 'x-cron-secret': 'cron-test-secret' },
    })
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ processed: 1 });
}

describe('queued engine epochs through HTTP boundaries', () => {
  it.each([
    { incomingGeneration: null, failLookup: false },
    { incomingGeneration: 'generation-old', failLookup: false },
    { incomingGeneration: 'generation-old', failLookup: true },
  ])(
    'stale incoming authority cannot retire the current active flow: %j',
    async ({ incomingGeneration, failLookup }) => {
      tables.flow_runs = [
        {
          id: 'current-run',
          flow_id: 'current-flow',
          account_id: accountId,
          user_id: 'user-1',
          contact_id: 'contact-1',
          conversation_id: 'conversation-1',
          status: 'active',
          current_node_key: 'menu',
          transition_seq: 1,
          last_advanced_at: new Date().toISOString(),
          vars: {},
          reprompt_count: 0,
          ...epoch,
        },
      ];
      const before = structuredClone(tables.flow_runs);
      failConnectionLookup = failLookup;

      const { withSendConnection } =
        await import('@/lib/whatsapp/coexistence/send-guard');

      const { dispatchInboundToFlows } = await import('@/lib/flows/engine');

      const result = await withSendConnection(
        {
          accountId,
          configId: incomingGeneration === null ? null : configId,
          generation: incomingGeneration,
        },
        () =>
          dispatchInboundToFlows({
            accountId,
            userId: 'user-1',
            contactId: 'contact-1',
            conversationId: 'conversation-1',
            isFirstInboundMessage: false,
            message: {
              kind: 'text',
              text: 'hi',
              meta_message_id: 'stale-inbound',
            },
          })
      );

      expect(result).toMatchObject({
        consumed: true,
        flow_run_id: 'current-run',
        outcome: 'run_error',
      });
      expect(tables.flow_runs).toEqual(before);
      expect(tables.flow_run_events ?? []).toEqual([]);
      expect(posts).toEqual([]);
    }
  );

  it('does not adopt a reconnect when a resumed run parks at another wait', async () => {
    tables.automation_steps = [
      step('wait-1', 'wait', 0, { amount: 1, unit: 'minutes' }),
      step('wait-2', 'wait', 1, { amount: 1, unit: 'minutes' }),
      step('say-1', 'send_message', 2, { text: 'After both waits' }),
    ];

    expect(await trigger()).toBe('completed');
    tables.whatsapp_config[0].coexistence_generation = 'generation-2';
    tables.automation_pending_executions[0].run_at = new Date(
      Date.now() - 60_000
    ).toISOString();
    await cron();
    expect(tables.automation_pending_executions).toEqual([
      expect.objectContaining({ ...epoch, status: 'done' }),
      expect.objectContaining({ ...epoch, status: 'pending' }),
    ]);
    tables.automation_pending_executions[1].run_at = new Date(
      Date.now() - 60_000
    ).toISOString();
    await cron();
    expect(tables.automation_pending_executions[1]).toMatchObject({
      ...epoch,
      status: 'failed',
    });
    expect(posts).toHaveLength(0);
  });

  it.each([false, true])(
    'legacy NULL continuation cannot adopt a newly managed connection=%s',
    async (bind) => {
      tables.whatsapp_config[0].coexistence_app_id = null;
      tables.automation_steps = [
        step('wait-1', 'wait', 0, { amount: 1, unit: 'minutes' }),
        step('say-1', 'send_message', 1, { text: 'Legacy wait' }),
      ];

      expect(await trigger()).toBe('completed');
      expect(tables.automation_pending_executions[0]).toMatchObject({
        send_config_id: null,
        send_generation: null,
      });

      if (bind) tables.whatsapp_config[0].coexistence_app_id = '9999';
      tables.automation_pending_executions[0].run_at = new Date(
        Date.now() - 60_000
      ).toISOString();
      await cron();
      expect(posts).toHaveLength(bind ? 0 : 1);
      expect(tables.automation_pending_executions[0].status).toBe(
        bind ? 'failed' : 'done'
      );
    }
  );
  it.each([false, true])(
    'cron continuation retains its origin after reconnect=%s',
    async (reconnect) => {
      tables.automation_steps = [
        step('wait-1', 'wait', 0, { amount: 1, unit: 'minutes' }),
        step('say-1', 'send_message', 1, { text: 'After wait' }),
      ];
      expect(await trigger()).toBe('completed');
      expect(tables.automation_logs[0]).toMatchObject(epoch);

      expect(tables.automation_pending_executions[0]).toMatchObject(epoch);

      if (reconnect)
        tables.whatsapp_config[0].coexistence_generation = 'generation-2';
      tables.automation_pending_executions[0].run_at = new Date(
        Date.now() - 60_000
      ).toISOString();
      await cron();
      expect(posts).toHaveLength(reconnect ? 0 : 1);
      expect(tables.automation_pending_executions[0]).toMatchObject({
        ...epoch,
        status: reconnect ? 'failed' : 'done',
      });
    }
  );

  it.each([false, true])(
    'reply continuation retains its menu epoch after reconnect=%s',
    async (reconnect) => {
      tables.automation_steps = [
        step('menu-1', 'send_buttons', 0, {
          kind: 'buttons',
          body: 'Choose',
          buttons: [{ id: 'yes', title: 'Yes' }],
          wait_for_reply: true,
        }),
        step('say-1', 'send_message', 1, { text: 'After reply' }),
      ];
      expect(await trigger()).toBe('completed');
      expect(posts).toHaveLength(1);
      expect(tables.automation_pending_executions[0]).toMatchObject(epoch);

      if (reconnect)
        tables.whatsapp_config[0].coexistence_generation = 'generation-2';

      const { withAccountSendConnection } =
        await import('@/lib/whatsapp/coexistence/send-guard');

      const { createClient } = await import('@supabase/supabase-js');
      const { resumeAwaitingReplyWithOutcome } = await import('./engine');

      const outcome = await withAccountSendConnection(
        createClient(origin, 'test-service-key'),
        accountId,
        () =>
          resumeAwaitingReplyWithOutcome({
            accountId,
            contactId: 'contact-1',
            context: { conversation_id: 'conversation-1', message_text: 'Yes' },
          })
      );

      expect(outcome).toEqual({
        status: reconnect ? 'ambiguous' : 'completed',
        consumed: true,
      });
      expect(posts).toHaveLength(reconnect ? 1 : 2);
      expect(tables.automation_pending_executions[0]).toMatchObject({
        ...epoch,
        status: reconnect ? 'failed' : 'done',
      });
    }
  );

  it.each([
    { reconnect: false, failClosure: false },
    { reconnect: true, failClosure: false },
    { reconnect: true, failClosure: true },
  ])(
    'flow reprompts or retires stale work without swallowing later messages: %j',
    async ({ reconnect, failClosure }) => {
      tables.flows = [
        {
          id: 'flow-1',
          account_id: accountId,
          user_id: 'user-1',
          status: 'active',
          trigger_type: 'keyword',
          trigger_config: { keywords: ['hi'] },
          entry_node_id: 'menu',
          fallback_policy: {
            on_unknown_reply: 'reprompt',
            max_reprompts: 2,
            on_timeout_hours: 24,
            on_exhaust: 'end',
          },
        },
      ];
      tables.flow_nodes = [
        {
          id: 'node-1',
          flow_id: 'flow-1',
          node_key: 'menu',
          node_type: 'send_buttons',
          config: {
            text: 'Choose',
            buttons: [{ reply_id: 'yes', title: 'Yes', next_node_key: 'done' }],
          },
        },
        {
          id: 'node-2',
          flow_id: 'flow-1',
          node_key: 'done',
          node_type: 'end',
          config: {},
        },
      ];
      const { dispatchInboundToFlows } = await import('@/lib/flows/engine');

      const input = {
        accountId,
        userId: 'user-1',
        contactId: 'contact-1',
        conversationId: 'conversation-1',
        isFirstInboundMessage: false,
      };

      const first = await dispatchInboundToFlows({
        ...input,
        message: { kind: 'text', text: 'hi', meta_message_id: 'inbound-1' },
      });

      expect(first.consumed).toBe(true);
      expect(posts).toHaveLength(1);
      expect(tables.flow_runs[0]).toMatchObject(epoch);

      if (reconnect)
        tables.whatsapp_config[0].coexistence_generation = 'generation-2';

      failFlowClosure = failClosure;

      const unknownReply = {
        ...input,
        message: {
          kind: 'text',
          text: 'unknown',
          meta_message_id: 'inbound-2',
        },
      } satisfies Parameters<typeof dispatchInboundToFlows>[0];

      let reply = await dispatchInboundToFlows(unknownReply);

      if (failClosure) {
        expect(reply).toMatchObject({ consumed: true, outcome: 'run_error' });
        expect(tables.flow_runs[0].status).toBe('active');
        expect(posts).toHaveLength(1);
        failFlowClosure = false;
        reply = await dispatchInboundToFlows(unknownReply);
      }

      expect(reply.consumed).toBe(!reconnect);
      expect(posts).toHaveLength(reconnect ? 1 : 2);
      expect(tables.flow_runs[0]).toMatchObject(epoch);

      if (reconnect) {
        expect(reply.outcome).toBe('no_match');
        expect(tables.flow_runs[0]).toMatchObject({
          status: 'cancelled',
          end_reason: 'connection_changed',
        });

        const next = await dispatchInboundToFlows({
          ...input,
          message: { kind: 'text', text: 'hi', meta_message_id: 'inbound-3' },
        });

        expect(next.consumed).toBe(true);
        expect(posts).toHaveLength(2);
        expect(tables.flow_runs[1]).toMatchObject({
          send_config_id: configId,
          send_generation: 'generation-2',
          status: 'active',
        });

        const reprompt = await dispatchInboundToFlows({
          ...input,
          message: {
            kind: 'text',
            text: 'unknown',
            meta_message_id: 'inbound-4',
          },
        });

        expect(reprompt.consumed).toBe(true);
        expect(posts).toHaveLength(3);
        expect(tables.flow_runs[0]).toMatchObject({
          ...epoch,
          status: 'cancelled',
        });
      }
    }
  );
});
