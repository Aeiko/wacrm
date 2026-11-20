import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { jsonSchema, type JsonValue } from './payload';
import { drainCoexistenceJobs, drainCoexistenceUpdates } from './worker';

const jobId = '44444444-4444-4444-8444-444444444444';
const token = '55555555-5555-4555-8555-555555555555';

const job = {
  id: jobId,
  lease_token: token,
  payload: {
    legacy: { entry: [] },
    deliveries: [
      {
        waba_id: '5678',
        field: 'smb_message_echoes',
        value: {
          metadata: {
            phone_number_id: '1234',
            display_phone_number: '15550001234',
          },
          message_echoes: [
            {
              id: 'wamid.echo',
              from: '15550001234',
              to: '15550005678',
              timestamp: '1700000000',
              type: 'text',
              text: { body: 'From the app' },
            },
          ],
        },
      },
    ],
  },
};

class WorkerDatabase {
  failCommit = true;
  pending = true;
  jobs: unknown[] = [job];
  commitStatus: 'completed' | 'quarantined' | 'stale' = 'completed';
  commits: JsonValue[] = [];
  retries: JsonValue[] = [];
  recovery: JsonValue = { applied: 0, quarantined: 0, stale: 0, expired: 0 };
  recoveryStatus = 200;

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const body = jsonSchema.parse(await request.json());

    if (path.endsWith('/coexistence_recover_updates')) {
      expect(body).toEqual({ p_limit: 100 });

      return Response.json(this.recovery, { status: this.recoveryStatus });
    }

    if (path.endsWith('/coexistence_claim'))
      return Response.json(this.pending ? this.jobs : []);

    if (path.endsWith('/coexistence_commit')) {
      this.commits.push(body);

      if (this.failCommit)
        return Response.json(
          { message: 'temporary database failure' },
          { status: 503 }
        );

      this.pending = false;

      return Response.json(this.commitStatus);
    }

    if (path.endsWith('/coexistence_fail')) {
      this.retries.push(body);

      return Response.json(
        z.object({ p_quarantine: z.boolean() }).parse(body).p_quarantine
          ? 'quarantined'
          : 'pending'
      );
    }

    throw new Error('Unexpected database request');
  }

  client() {
    return createClient('http://127.0.0.1:54321', 'test-service-key', {
      global: { fetch: this.fetch.bind(this) },
      auth: { persistSession: false },
    });
  }
}

const liveDelivery = {
  waba_id: '5678',
  field: 'messages',
  value: {
    metadata: job.payload.deliveries[0].value.metadata,
    messages: [
      {
        id: 'wamid.live',
        from: '15550005678',
        timestamp: '1700000000',
        type: 'text',
        text: { body: 'Live' },
      },
    ],
  },
};

describe('Coexistence restart/retry database boundary', () => {
  it('recovers deferred updates independently of new webhook jobs', async () => {
    const database = new WorkerDatabase();
    database.pending = false;
    expect(await drainCoexistenceUpdates(database.client())).toEqual({
      applied: 0,
      quarantined: 0,
      stale: 0,
      expired: 0,
    });
    database.recovery = { applied: 2, quarantined: 1, stale: 3, expired: 4 };
    expect(await drainCoexistenceUpdates(database.client())).toEqual(
      database.recovery
    );
  });

  it.each([403, 200])(
    'does not report successful recovery on an error or malformed outcome (%i)',
    async (status) => {
      const database = new WorkerDatabase();
      database.recoveryStatus = status;
      database.recovery =
        status === 200
          ? { applied: -1, quarantined: 0, stale: 0, expired: 0 }
          : { message: 'fixture database failure' };
      await expect(
        drainCoexistenceUpdates(database.client())
      ).rejects.toThrow();
    }
  );

  it('quarantines malformed captured payloads individually and continues valid siblings', async () => {
    const database = new WorkerDatabase();
    database.failCommit = false;
    database.jobs = [
      { ...job, payload: null },
      { ...job, payload: { deliveries: [], legacy: { entry: 'broken' } } },
      job,
    ];
    expect(await drainCoexistenceJobs(database.client())).toEqual({
      completed: 1,
      quarantined: 2,
      retried: 0,
      stale: 0,
    });
    expect(database.retries).toEqual(
      Array.from({ length: 2 }, () => ({
        p_job_id: jobId,
        p_lease_token: token,
        p_code: 'decode_failed',
        p_quarantine: true,
      }))
    );
    expect(database.commits).toHaveLength(1);
  });

  it('bounds and validates claim identities before processing', async () => {
    const database = new WorkerDatabase();
    database.jobs = Array.from({ length: 6 }, () => job);
    await expect(drainCoexistenceJobs(database.client())).rejects.toThrow();
    database.jobs = [{ ...job, lease_token: 'invalid' }];
    await expect(drainCoexistenceJobs(database.client())).rejects.toThrow();
    expect(database.commits).toHaveLength(0);
  });

  it('retries mixed live/history with fresh clients and converts historical legacy envelopes into fenced operations', async () => {
    const database = new WorkerDatabase();
    database.jobs = [
      {
        ...job,
        payload: {
          deliveries: job.payload.deliveries,
          legacy: {
            entry: [
              {
                id: liveDelivery.waba_id,
                changes: [
                  { field: liveDelivery.field, value: liveDelivery.value },
                ],
              },
            ],
          },
        },
      },
    ];
    expect((await drainCoexistenceJobs(database.client())).retried).toBe(1);
    database.failCommit = false;
    expect((await drainCoexistenceJobs(database.client())).completed).toBe(1);
    expect(database.commits[1]).toMatchObject({
      p_operations: [
        { kind: 'message', source: 'phone_app' },
        { kind: 'live_message', source: 'cloud_api', content_text: 'Live' },
      ],
    });
  });

  it('commits freshly captured messages and history in one fenced batch', async () => {
    const database = new WorkerDatabase();
    database.failCommit = false;
    database.jobs = [
      {
        ...job,
        payload: {
          legacy: { entry: [] },
          deliveries: [
            liveDelivery,
            {
              waba_id: '5678',
              field: 'history',
              value: { history: [{ errors: [{ code: 2593109 }] }] },
            },
          ],
        },
      },
    ];
    expect((await drainCoexistenceJobs(database.client())).completed).toBe(1);
    expect(database.commits[0]).toMatchObject({
      p_job_id: jobId,
      p_lease_token: token,
      p_operations: [
        { kind: 'live_message', source: 'cloud_api' },
        { kind: 'progress', error_code: 2593109 },
      ],
    });
  });

  it('quarantines live statuses together with messages, never committing a partial change', async () => {
    const database = new WorkerDatabase();
    database.jobs = [
      {
        ...job,
        payload: {
          legacy: { entry: [] },
          deliveries: [
            { ...liveDelivery, value: { ...liveDelivery.value, statuses: [] } },
          ],
        },
      },
    ];
    expect((await drainCoexistenceJobs(database.client())).quarantined).toBe(1);
    expect(database.commits).toHaveLength(0);
    expect(database.retries[0]).toMatchObject({
      p_code: 'unsupported_payload',
      p_quarantine: true,
    });
  });
  it('does not report a rejected stale lease as a completed import', async () => {
    const database = new WorkerDatabase();

    database.failCommit = false;
    database.commitStatus = 'stale';

    expect(await drainCoexistenceJobs(database.client())).toEqual({
      completed: 0,
      retried: 0,
      quarantined: 0,
      stale: 1,
    });
  });

  it('reports SQL identity quarantine rather than success', async () => {
    const database = new WorkerDatabase();

    database.failCommit = false;
    database.commitStatus = 'quarantined';

    expect(await drainCoexistenceJobs(database.client())).toEqual({
      completed: 0,
      retried: 0,
      quarantined: 1,
      stale: 0,
    });
  });

  it('can retry a failed commit with a new worker/client without dropping the accepted message', async () => {
    const database = new WorkerDatabase();

    expect(await drainCoexistenceJobs(database.client())).toEqual({
      completed: 0,
      retried: 1,
      quarantined: 0,
      stale: 0,
    });
    expect(database.retries).toEqual([
      {
        p_job_id: jobId,
        p_lease_token: token,
        p_code: 'commit_failed',
        p_quarantine: false,
      },
    ]);

    database.failCommit = false;

    expect(await drainCoexistenceJobs(database.client())).toEqual({
      completed: 1,
      retried: 0,
      quarantined: 0,
      stale: 0,
    });
    expect(database.commits[1]).toMatchObject({
      p_job_id: jobId,
      p_lease_token: token,
      p_operations: [
        {
          kind: 'message',
          source: 'phone_app',
          sender_type: 'agent',
          wamid: 'wamid.echo',
          content_text: 'From the app',
        },
      ],
    });
    expect(await drainCoexistenceJobs(database.client())).toEqual({
      completed: 0,
      retried: 0,
      quarantined: 0,
      stale: 0,
    });
  });
});
