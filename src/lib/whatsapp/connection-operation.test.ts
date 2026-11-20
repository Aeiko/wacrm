import { createServer } from 'node:http';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { listenForFetch } from '@/test/http-server';
import { deadlineFetch, withRequestDeadline } from '@/lib/request-deadline';
import { ConnectionOperation } from './connection-operation';

const id = '10000000-0000-4000-8000-000000000001';
let origin: string;
let calls: string[] = [];

interface StartReply {
  status: string;
  dispatch: boolean;
  step_status?: string;
}

let start: StartReply;
let failRecord = false;
let failStart = false;
let hangStart = false;
let finishAttempts = 0;
let loseFinishAck = false;

const server = createServer(async (req, res) => {
  for await (const chunk of req) {
    Buffer.byteLength(chunk);
  }

  const name = req.url!.split('/').at(-1)!;
  calls.push(name);
  res.setHeader('Content-Type', 'application/json');

  if (name === 'connection_operation_start_step' && hangStart) return;

  if (name === 'connection_operation_start_step' && failStart) {
    res.statusCode = 503;
    res.end(JSON.stringify({ message: 'secret database error' }));
  } else if (name === 'connection_operation_start_step')
    res.end(JSON.stringify(start));
  else if (name === 'connection_operation_record_step' && failRecord) {
    res.statusCode = 503;
    res.end(JSON.stringify({ message: 'private error' }));
  } else if (name === 'connection_operation_finish') {
    finishAttempts++;

    if (loseFinishAck && finishAttempts === 1) {
      req.socket.destroy();

      return;
    }

    res.end(
      JSON.stringify({
        status: 'completed',
        operation_id: id,
        config_id: id,
        revision: id,
        saved: true,
        registered: true,
        registration_rejected: false,
      })
    );
  } else
    res.end(
      JSON.stringify({
        status: name.endsWith('cancel_unstarted') ? 'cancelled' : 'recorded',
        step_status: 'success',
      })
    );
});

beforeAll(async () => {
  origin = await listenForFetch(server);
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  calls = [];
  start = { status: 'started', dispatch: true };
  failRecord = false;
  failStart = false;
  hangStart = false;
  finishAttempts = 0;
  loseFinishAck = false;
});

function operation() {
  return new ConnectionOperation(
    createClient(origin, 'fixture', {
      global: { fetch: deadlineFetch },
      auth: { persistSession: false },
    }),
    id,
    { operation_id: id, token: id }
  );
}

it('never dispatches a duplicate step and never cancels a possibly started operation', async () => {
  start = { status: 'duplicate', dispatch: false, step_status: 'started' };
  const gate = operation();
  expect(gate.requiresReconciliation).toBe(false);
  await expect(gate.start('register')).rejects.toThrow();
  expect(gate.requiresReconciliation).toBe(true);
  await gate.cancelUnstarted();
  expect(calls).toEqual(['connection_operation_start_step']);
});

it('does not retry a lost start acknowledgement or dispatch remote HTTP', async () => {
  failStart = true;
  const gate = operation();
  await expect(
    (async () => {
      await gate.start('register');
      await fetch(`${origin}/remote`);
    })()
  ).rejects.toMatchObject({ code: 'connection_blocked' });
  await gate.cancelUnstarted();
  expect(calls).toEqual(['connection_operation_start_step']);
});

it('bounds database-only settlement retries and retains started claims', async () => {
  failRecord = true;
  const gate = operation();
  await gate.start('register');
  await expect(gate.record('register', 'success')).rejects.toMatchObject({
    code: 'connection_blocked',
  });
  await gate.cancelUnstarted();
  expect(calls).toEqual([
    'connection_operation_start_step',
    'connection_operation_record_step',
    'connection_operation_record_step',
  ]);
});

it('recovers a lost finish acknowledgement without repeating a remote mutation', async () => {
  loseFinishAck = true;
  const gate = operation();
  await gate.start('register');
  await fetch(`${origin}/remote`, { method: 'POST' });
  await gate.record('register', 'success');

  const receipt = await gate.finish({
    access_token: 'encrypted-fixture',
    verify_token: null,
    connected_at: '2026-11-17T12:00:00Z',
    registered_at: '2026-11-17T12:00:00Z',
    subscribed_apps_at: null,
  });

  await gate.cancelUnstarted();
  expect(receipt.saved).toBe(true);
  expect(gate.requiresReconciliation).toBe(false);
  expect(calls).toEqual([
    'connection_operation_start_step',
    'remote',
    'connection_operation_record_step',
    'connection_operation_finish',
    'connection_operation_finish',
  ]);
});

it('cancels an unstarted reservation only', async () => {
  await operation().cancelUnstarted();
  expect(calls).toEqual(['connection_operation_cancel_unstarted']);
});

it('aborts a real pending SDK start fetch at the inherited deadline, without a retry', async () => {
  hangStart = true;
  const gate = operation();
  await expect(
    withRequestDeadline(Date.now() + 100, () => gate.start('register'))
  ).rejects.toMatchObject({ code: 'connection_blocked' });
  await gate.cancelUnstarted();
  expect(calls).toEqual(['connection_operation_start_step']);
});
