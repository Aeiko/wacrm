import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { createClient, type RealtimeChannel } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { drainCoexistenceJobs } from './worker';

const uuidSchema = z.object({ id: z.uuid() });

const jobSchema = z.object({
  id: z.uuid(),
  status: z.string(),
  attempts: z.number(),
});

function subscribe(channel: RealtimeChannel): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Local Realtime subscription timed out')),
      10_000
    );

    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        clearTimeout(timer);
        resolve();
      } else if (
        status === 'CHANNEL_ERROR' ||
        status === 'TIMED_OUT' ||
        status === 'CLOSED'
      ) {
        clearTimeout(timer);
        reject(new Error('Local Realtime subscription failed'));
      }
    });
  });
}

// Explicit opt-in only; no local secrets are read by the ordinary test suite.
describe.skipIf(process.env.COEXISTENCE_INTEGRATION !== '1')(
  'real local Coexistence ingestion',
  () => {
    it('captures before ACK, recovers a lost lease/retry, replays quietly, and isolates inbox tenants', async () => {
      const endpoint =
        process.env.COEXISTENCE_INTEGRATION_URL ?? 'http://127.0.0.1:8000';

      const url = URL.parse(endpoint);

      if (
        !url ||
        url.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost'].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      ) {
        throw new Error(
          'Integration requires an HTTP loopback Supabase origin'
        );
      }

      const suppliedService =
        process.env.COEXISTENCE_INTEGRATION_SERVICE_ROLE_KEY;

      const suppliedAnon = process.env.COEXISTENCE_INTEGRATION_ANON_KEY;

      const local =
        suppliedService && suppliedAnon
          ? { SERVICE_ROLE_KEY: suppliedService, ANON_KEY: suppliedAnon }
          : parseEnv(readFileSync('deploy/supabase/.env', 'utf8'));

      const serviceKey = suppliedService ?? local.SERVICE_ROLE_KEY;
      const anonKey = suppliedAnon ?? local.ANON_KEY;

      if (!serviceKey || !anonKey)
        throw new Error('Local integration keys are required');

      const options = {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      };

      const freshWorker = () => createClient(url.origin, serviceKey, options);
      const db = freshWorker();
      const owner = createClient(url.origin, anonKey, options);
      const outsider = createClient(url.origin, anonKey, options);
      const teammate = createClient(url.origin, anonKey, options);
      const gateOwner = createClient(url.origin, anonKey, options);
      const signupOwner = createClient(url.origin, anonKey, options);
      const signupOtherSession = createClient(url.origin, anonKey, options);
      const signupSecondOwner = createClient(url.origin, anonKey, options);
      const users: string[] = [];
      const accounts: string[] = [];
      const fixture = `99${randomInt(1_000_000, 9_999_999)}`;
      const appId = `${fixture}01`;
      const wabaId = `${fixture}02`;
      const phoneId = `${fixture}03`;
      const partnerBusinessId = `${fixture}04`;
      const localToken = `local-integration-not-a-meta-token-${randomUUID()}`;
      const secret = randomBytes(32).toString('hex');
      const runId = randomUUID();
      const historyId = `wamid.integration.history.${runId}`;
      const echoId = `wamid.integration.echo.${runId}`;
      const mediaId = `wamid.integration.media.${runId}`;
      const liveId = `wamid.integration.live.${runId}`;
      const promotedId = `wamid.integration.promoted.${runId}`;
      const newerEchoId = `wamid.integration.newer-echo.${runId}`;
      const effectMessageIds: string[] = [];
      const lifecycleConfigIds: string[] = [];
      const updateParentIds: string[] = [];

      const providerMediaIds = Array.from({ length: 9 }, () =>
        BigInt(`0x${randomBytes(12).toString('hex')}`).toString()
      );

      let privateMediaRecorded = false;
      const gateOperationIds: string[] = [];
      const signupAttemptIds: string[] = [];
      const stagedIdentities: Array<{ appId: string; dedupeKey: string }> = [];
      const storagePaths: string[] = [];

      const psql = (sql: string) => {
        if (
          process.env.COEXISTENCE_INTEGRATION !== '1' ||
          !['127.0.0.1', 'localhost'].includes(url.hostname)
        ) {
          throw new Error(
            'Direct fixture SQL requires explicit local integration'
          );
        }

        try {
          return execFileSync(
            'docker',
            [
              'exec',
              '-i',
              'wacrm-supabase-db-1',
              'psql',
              '-U',
              'postgres',
              '-d',
              'postgres',
              '-v',
              'ON_ERROR_STOP=1',
              '-Atq',
            ],
            { encoding: 'utf8', input: sql, stdio: ['pipe', 'pipe', 'pipe'] }
          ).trim();
        } catch {
          throw new Error('Isolated fixture SQL failed');
        }
      };

      const receiptScopeSql = () =>
        stagedIdentities.length
          ? `(app_id,dedupe_key) IN (VALUES ${stagedIdentities.map((identity) => `('${identity.appId}','${identity.dedupeKey}')`).join(',')})`
          : 'false';

      const fixtureIds = (ids: string[]) =>
        ids.map((id) => `'${z.uuid().parse(id)}'`).join(',');

      const fixtureSql = (sql: string) => {
        if (!accounts.length || !users.length)
          throw new Error('Fixture identity required before SQL writes');
        const expected = accounts.length;

        return psql(
          `BEGIN; DO $fixture$ BEGIN IF (SELECT count(*) FROM public.accounts WHERE id IN (${fixtureIds(accounts)}) AND owner_user_id IN (${fixtureIds(users)})) <> ${expected} THEN RAISE EXCEPTION 'fixture_database_mismatch'; END IF; END $fixture$; ${sql}; COMMIT;`
        );
      };

      const fixtureRowsSchema = z.array(
        z.object({
          id: z.uuid(),
          waba_id: z.string(),
          coexistence_generation: z.uuid(),
        })
      );

      const fixtureInsert = (
        rows: Array<{
          user_id: string;
          account_id: string;
          phone_number_id: string;
          waba_id: string;
          access_token: string;
          status: string;
          coexistence_app_id: string;
          coexistence_verified_at: string;
        }>
      ) => {
        if (
          rows.some(
            (row) =>
              !users.includes(row.user_id) || !accounts.includes(row.account_id)
          )
        )
          throw new Error('Config fixture owner mismatch');
        const json = JSON.stringify(rows).replaceAll("'", "''");

        const output = fixtureSql(
          `WITH written AS (INSERT INTO public.whatsapp_config(user_id,account_id,phone_number_id,waba_id,access_token,status,coexistence_app_id,coexistence_verified_at) SELECT user_id,account_id,phone_number_id,waba_id,access_token,status,coexistence_app_id,coexistence_verified_at FROM jsonb_to_recordset('${json}'::jsonb) AS x(user_id uuid,account_id uuid,phone_number_id text,waba_id text,access_token text,status text,coexistence_app_id text,coexistence_verified_at timestamptz) RETURNING id,waba_id,coexistence_generation) SELECT coalesce(jsonb_agg(written),'[]'::jsonb) FROM written`
        );

        return {
          data: fixtureRowsSchema.parse(JSON.parse(output)),
          error: null,
        };
      };

      const fixtureUpdate = (
        ids: string[],
        changes: Record<string, string>
      ) => {
        if (!ids.length || ids.some((id) => !lifecycleConfigIds.includes(id)))
          throw new Error('Unknown config fixture');

        const assignments = Object.entries(changes)
          .map(([key, value]) => {
            const column = z
              .enum([
                'access_token',
                'status',
                'coexistence_app_id',
                'coexistence_verified_at',
              ])
              .parse(key);

            return `${column}='${value.replaceAll("'", "''")}'::${column === 'coexistence_verified_at' ? 'timestamptz' : 'text'}`;
          })
          .join(',');

        const output = fixtureSql(
          `WITH written AS (UPDATE public.whatsapp_config SET ${assignments} WHERE id IN (${fixtureIds(ids)}) AND account_id IN (${fixtureIds(accounts)}) RETURNING id,waba_id,coexistence_generation) SELECT coalesce(jsonb_agg(written),'[]'::jsonb) FROM written`
        );

        const data = fixtureRowsSchema.parse(JSON.parse(output));

        expect(data).toHaveLength(ids.length);

        return { data, error: null };
      };

      const metadata = {
        display_phone_number: '+1 555 000 1234',
        phone_number_id: phoneId,
      };

      const customer = '15550005678';
      const business = '15550001234';

      // The worker claims globally, so refuse an occupied queue rather than touching somebody else's jobs.
      const empty = await db
        .from('coexistence_jobs')
        .select('id', { head: true, count: 'exact' });

      expect(
        empty.error === null,
        'Migration 060 must be applied locally'
      ).toBe(true);
      expect(
        empty.count,
        'Use an isolated local stack with no existing Coexistence jobs'
      ).toBe(0);

      const emptyEffects = await db
        .from('coexistence_live_effects')
        .select('message_id', { head: true, count: 'exact' });

      expect(
        emptyEffects.error === null,
        'Migration 063 must be applied locally'
      ).toBe(true);
      expect(
        emptyEffects.count,
        'Use an isolated local stack with no existing effects'
      ).toBe(0);

      for (const table of [
        'coexistence_updates',
        'coexistence_status_events',
      ]) {
        const emptyQueue = await db
          .from(table)
          .select('id', { head: true, count: 'exact' });

        expect(
          emptyQueue.error === null,
          'Migrations 066–069 must be applied locally'
        ).toBe(true);
        expect(
          emptyQueue.count,
          'Use an isolated local stack with no existing update/status work'
        ).toBe(0);
      }

      const bindings = await db
        .from('whatsapp_config')
        .select('id', { head: true, count: 'exact' })
        .not('coexistence_verified_at', 'is', null);

      expect(bindings.error === null).toBe(true);
      expect(
        bindings.count,
        'Do not run alongside another verified Coexistence binding'
      ).toBe(0);

      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', url.origin);
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', anonKey);
      vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', serviceKey);
      vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
      vi.stubEnv('WHATSAPP_COEXISTENCE_APP_ID', appId);
      vi.stubEnv('WHATSAPP_COEXISTENCE_APP_SECRET', secret);
      vi.stubEnv('WHATSAPP_COEXISTENCE_PARTNER_BUSINESS_ID', partnerBusinessId);
      vi.stubEnv('ENCRYPTION_KEY', randomBytes(32).toString('hex'));

      try {
        const recoveryContract = await db.rpc(
          'coexistence_signup_recovery_status',
          {
            p_actor_id: randomUUID(),
            p_account_id: randomUUID(),
            p_session_id: randomUUID(),
          }
        );

        expect(
          recoveryContract.error?.code,
          'Migration 076 recovery RPC must exist before fixture writes'
        ).toBeUndefined();
        expect(recoveryContract.data).toEqual({ status: 'forbidden' });

        const ingressContract = await db.rpc('coexistence_ingress', {
          p_app_id: null,
          p_partner_business_id: null,
          p_enabled: false,
          p_authorized: false,
          p_changes: [],
        });

        expect(
          ingressContract.error?.code,
          'Migration 075 ingress RPC must exist before fixture writes'
        ).toBeUndefined();
        expect(ingressContract.data).toEqual({
          status: 200,
          legacy_indices: [],
          captured: 0,
          staged: 0,
        });

        const signupContract = await db.rpc('coexistence_signup_status', {
          p_actor_id: randomUUID(),
          p_account_id: randomUUID(),
          p_session_id: randomUUID(),
        });

        expect(
          signupContract.error?.code,
          'Migration 074 signup RPC must exist before fixture writes'
        ).toBeUndefined();
        expect(signupContract.data).toEqual({ status: 'forbidden' });

        const gateContract = await db.rpc(
          'connection_operation_account_status',
          { p_actor_id: randomUUID(), p_account_id: randomUUID() }
        );

        expect(
          gateContract.error?.code,
          'Migration 073 gate RPC must exist before fixture writes'
        ).toBeUndefined();
        expect(gateContract.data).toEqual({ status: 'forbidden' });

        const operatorContract = await db.rpc(
          'coexistence_operator_inventory',
          {
            p_actor_id: randomUUID(),
            p_account_id: randomUUID(),
            p_app_id: appId,
            p_kind: 'jobs',
            p_before_created_at: null,
            p_before_id: null,
            p_limit: 1,
          }
        );

        expect(
          operatorContract.error?.code,
          'Migration 072 operator RPC must exist and reject an unknown actor before fixture writes'
        ).toBe('42501');

        for (const providerId of providerMediaIds) {
          const mediaContract = await db.rpc('coexistence_is_private_media', {
            p_media_id: providerId,
          });

          expect(
            mediaContract.error?.code,
            'Migration 071 private-media RPC must exist before integration'
          ).toBeUndefined();
          expect(
            mediaContract.data,
            'Fixture media IDs must not reuse existing deny proofs'
          ).toBe(false);
        }

        const { encrypt } = await import('../encryption');

        for (const client of [owner, outsider]) {
          const email = `coexistence-integration-${randomUUID()}@example.invalid`;
          const password = randomBytes(32).toString('hex');

          const created = await db.auth.admin.createUser({
            email,
            password,
            email_confirm: true,
          });

          expect(created.error === null, 'Create temporary auth user').toBe(
            true
          );

          if (!created.data.user)
            throw new Error('Temporary auth user was not created');

          const userId = created.data.user.id;
          users.push(userId);

          const account = await db
            .from('accounts')
            .select('id')
            .eq('owner_user_id', userId)
            .single();

          expect(
            account.error === null,
            'Signup must create a personal account'
          ).toBe(true);
          accounts.push(uuidSchema.parse(account.data).id);

          const login = await client.auth.signInWithPassword({
            email,
            password,
          });

          expect(login.error === null, 'Sign in temporary tenant').toBe(true);
        }

        const seededConfig = fixtureInsert([
          {
            user_id: users[0],
            account_id: accounts[0],
            phone_number_id: phoneId,
            waba_id: wabaId,
            access_token: encrypt(localToken),
            status: 'connected',
            coexistence_app_id: appId,
            coexistence_verified_at: new Date().toISOString(),
          },
        ]);

        const config = {
          data: seededConfig.data[0],
          error: seededConfig.error,
        };

        expect(
          config.error === null,
          'Create service-verified local binding'
        ).toBe(true);
        const configId = uuidSchema.parse(config.data).id;
        lifecycleConfigIds.push(configId);

        const recordHistoryChoice = async (generation: string) => {
          const claims = await owner.auth.getClaims();

          expect(
            claims.error === null,
            'Read authenticated owner session'
          ).toBe(true);

          const identity = z
            .object({ sub: z.uuid(), session_id: z.uuid() })
            .parse(claims.data?.claims);

          expect(identity.sub).toBe(users[0]);

          const choice = await db.rpc('coexistence_import_consent', {
            p_actor_id: identity.sub,
            p_account_id: accounts[0],
            p_session_id: identity.session_id,
            p_config_id: configId,
            p_generation: generation,
            p_app_id: appId,
            p_waba_id: wabaId,
            p_phone_number_id: phoneId,
            p_request_id: randomUUID(),
            p_history: true,
            p_contacts: false,
          });

          expect(choice.error === null, 'Record fixture history choice').toBe(
            true
          );
          expect(
            z.object({ status: z.string() }).parse(choice.data).status
          ).toBe('recorded');
        };

        await recordHistoryChoice(
          fixtureRowsSchema.element.parse(config.data).coexistence_generation
        );
        vi.stubGlobal('AsyncLocalStorage', AsyncLocalStorage);
        const { POST } = await import('@/app/api/whatsapp/webhook/route');

        const send = async (
          body: string,
          validSignature = true,
          signingSecret = secret
        ) => {
          const sourceApp = process.env.WHATSAPP_COEXISTENCE_APP_ID;

          if (
            validSignature &&
            sourceApp &&
            [appId, `${fixture}32`].includes(sourceApp)
          ) {
            const identityEnvelope = z.object({
              entry: z.array(
                z
                  .object({ changes: z.array(z.unknown()) })
                  .catch({ changes: [] })
              ),
            });

            let identities = identityEnvelope.safeParse(null);

            try {
              identities = identityEnvelope.safeParse(JSON.parse(body));
            } catch {
              /* Malformed JSON still reaches the real route unchanged. */
            }

            if (identities.success) {
              const hash = createHash('sha256').update(body).digest('hex');
              identities.data.entry.forEach((entry, entryIndex) =>
                entry.changes.forEach((_, changeIndex) => {
                  const dedupeKey = `${hash}:${entryIndex}:${changeIndex}`;

                  if (
                    !stagedIdentities.some(
                      (identity) =>
                        identity.appId === sourceApp &&
                        identity.dedupeKey === dedupeKey
                    )
                  )
                    stagedIdentities.push({ appId: sourceApp, dedupeKey });
                })
              );
            }
          }

          const signature = createHmac(
            'sha256',
            validSignature ? signingSecret : 'wrong-secret'
          )
            .update(body)
            .digest('hex');

          return POST(
            new Request('http://127.0.0.1/api/whatsapp/webhook', {
              method: 'POST',
              body,
              headers: {
                'Content-Type': 'application/json',
                'x-hub-signature-256': `sha256=${signature}`,
              },
            })
          );
        };

        const payload = {
          object: 'whatsapp_business_account',
          entry: [
            {
              id: wabaId,
              changes: [
                {
                  field: 'history',
                  value: {
                    metadata,
                    history: [
                      {
                        metadata: { phase: 0, chunk_order: 1, progress: 100 },
                        threads: [
                          {
                            id: customer,
                            messages: [
                              {
                                from: customer,
                                id: historyId,
                                timestamp: '1700000000',
                                type: 'text',
                                text: { body: 'Archived customer text' },
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                },
                {
                  field: 'smb_message_echoes',
                  value: {
                    metadata,
                    message_echoes: [
                      {
                        from: business,
                        to: customer,
                        id: echoId,
                        timestamp: '1700000001',
                        type: 'text',
                        text: { body: 'Business app reply' },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        };

        const body = JSON.stringify(payload);
        expect((await send(body, false)).status).toBe(401);
        expect((await send(body)).status).toBe(200);

        const captured = await db
          .from('coexistence_jobs')
          .select('id,status,attempts,payload')
          .eq('config_id', configId);

        expect(captured.error === null).toBe(true);
        const jobs = z.array(jobSchema).parse(captured.data);
        expect(jobs).toHaveLength(2);
        expect(
          jobs.every((job) => job.status === 'pending' && job.attempts === 0)
        ).toBe(true);

        const before = await db
          .from('conversations')
          .select('id')
          .eq('account_id', accounts[0]);

        expect(before.error === null).toBe(true);
        expect(before.data).toEqual([]);

        // Simulate a process dying after claiming work, before committing inbox rows.
        const abandoned = await freshWorker().rpc('coexistence_claim', {
          p_limit: 5,
        });

        expect(abandoned.error === null).toBe(true);
        expect(z.array(uuidSchema).parse(abandoned.data)).toHaveLength(2);
        expect(
          JSON.stringify(abandoned.data).includes('"import_consent_id"'),
          'Worker claim must not expose original import authority'
        ).toBe(false);

        fixtureSql(
          `UPDATE public.coexistence_jobs SET lease_until='2000-01-01T00:00:00Z'
           WHERE config_id='${configId}' AND status='processing'`
        );
        expect(await drainCoexistenceJobs(freshWorker())).toEqual({
          completed: 2,
          retried: 0,
          quarantined: 0,
          stale: 0,
        });

        const inbox = await owner
          .from('conversations')
          .select('id,unread_count,last_inbound_at,last_message_text')
          .eq('account_id', accounts[0])
          .single();

        expect(inbox.error === null, 'Owner can read the persisted inbox').toBe(
          true
        );
        const conversationId = uuidSchema.parse(inbox.data).id;
        expect(inbox.data).toMatchObject({
          unread_count: 0,
          last_inbound_at: null,
          last_message_text: 'Business app reply',
        });

        const messages = await owner
          .from('messages')
          .select(
            'id,message_id,message_source,sender_type,content_text,created_at'
          )
          .eq('conversation_id', conversationId)
          .order('created_at');

        expect(messages.error === null).toBe(true);
        expect(messages.data).toMatchObject([
          {
            message_id: historyId,
            message_source: 'history',
            sender_type: 'customer',
            content_text: 'Archived customer text',
            created_at: '2023-11-14T22:13:20+00:00',
          },
          {
            message_id: echoId,
            message_source: 'phone_app',
            sender_type: 'agent',
            content_text: 'Business app reply',
            created_at: '2023-11-14T22:13:21+00:00',
          },
        ]);

        // Exact replay dedupes capture; re-encoded replay exercises inbox-level WAMID dedupe too.
        expect((await send(body)).status).toBe(200);
        expect(await drainCoexistenceJobs(freshWorker())).toEqual({
          completed: 0,
          retried: 0,
          quarantined: 0,
          stale: 0,
        });
        expect((await send(JSON.stringify(payload, null, 2))).status).toBe(200);
        expect(await drainCoexistenceJobs(freshWorker())).toEqual({
          completed: 2,
          retried: 0,
          quarantined: 0,
          stale: 0,
        });

        const replayed = await owner
          .from('messages')
          .select('id')
          .eq('conversation_id', conversationId);

        expect(replayed.error === null).toBe(true);
        expect(replayed.data).toHaveLength(2);

        const quiet = await owner
          .from('conversations')
          .select('unread_count,last_inbound_at')
          .eq('id', conversationId)
          .single();

        expect(quiet.error === null).toBe(true);
        expect(quiet.data).toEqual({ unread_count: 0, last_inbound_at: null });

        // Hydration arriving before its parent must persist a retry, not acknowledge lost work.
        const hydrationBody = JSON.stringify({
          object: 'whatsapp_business_account',
          entry: [
            {
              id: wabaId,
              changes: [
                {
                  field: 'history',
                  value: {
                    metadata,
                    messages: [
                      {
                        id: mediaId,
                        timestamp: '1700000002',
                        type: 'image',
                        image: {
                          id: providerMediaIds[0],
                          mime_type: 'image/jpeg',
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        });

        expect((await send(hydrationBody)).status).toBe(200);
        expect(await drainCoexistenceJobs(freshWorker())).toEqual({
          completed: 0,
          retried: 1,
          quarantined: 0,
          stale: 0,
        });

        const retry = await db
          .from('coexistence_jobs')
          .select('id,status,attempts')
          .eq('config_id', configId)
          .eq('status', 'pending')
          .single();

        expect(retry.error === null).toBe(true);
        expect(jobSchema.parse(retry.data)).toMatchObject({
          status: 'pending',
          attempts: 1,
        });
        const retryId = uuidSchema.parse(retry.data).id;

        const parentBody = JSON.stringify({
          object: 'whatsapp_business_account',
          entry: [
            {
              id: wabaId,
              changes: [
                {
                  field: 'history',
                  value: {
                    metadata,
                    history: [
                      {
                        threads: [
                          {
                            id: customer,
                            messages: [
                              {
                                from: customer,
                                id: mediaId,
                                timestamp: '1700000002',
                                type: 'media_placeholder',
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                },
              ],
            },
          ],
        });

        expect((await send(parentBody)).status).toBe(200);
        expect(await drainCoexistenceJobs(freshWorker())).toEqual({
          completed: 1,
          retried: 0,
          quarantined: 0,
          stale: 0,
        });

        fixtureSql(
          `UPDATE public.coexistence_jobs SET available_at='2000-01-01T00:00:00Z'
           WHERE id='${retryId}' AND config_id='${configId}' AND status='pending'`
        );
        expect(await drainCoexistenceJobs(freshWorker())).toEqual({
          completed: 1,
          retried: 0,
          quarantined: 0,
          stale: 0,
        });

        const hydrated = await owner
          .from('messages')
          .select('id,content_type,message_source')
          .eq('conversation_id', conversationId)
          .eq('message_id', mediaId)
          .single();

        expect(hydrated.error === null).toBe(true);
        expect(hydrated.data).toMatchObject({
          content_type: 'image',
          message_source: 'history',
        });

        const hiddenMessages = await outsider
          .from('messages')
          .select('id')
          .eq('conversation_id', conversationId);

        expect(hiddenMessages.error === null).toBe(true);
        expect(hiddenMessages.data).toEqual([]);

        const hiddenInbox = await outsider
          .from('conversations')
          .select('id')
          .eq('id', conversationId);

        expect(hiddenInbox.error === null).toBe(true);
        expect(hiddenInbox.data).toEqual([]);

        const hiddenDecision = await db
          .from('coexistence_import_decisions')
          .select('id')
          .eq('account_id', accounts[0]);

        expect(hiddenDecision.error?.code).toBe('42501');

        const hiddenJobs = await outsider
          .from('coexistence_jobs')
          .select('id')
          .eq('config_id', configId);

        expect(hiddenJobs.data).toBeNull();
        expect(hiddenJobs.error?.code).toBe('42501');

        const envelope = (changes: { field: string; value: unknown }[]) =>
          JSON.stringify({
            object: 'whatsapp_business_account',
            entry: [{ id: wabaId, changes }],
          });

        const liveCustomer = '15550007890';

        const liveChange = {
          field: 'messages',
          value: {
            metadata,
            contacts: [
              { wa_id: liveCustomer, profile: { name: 'Live customer' } },
            ],
            messages: [
              {
                from: liveCustomer,
                id: liveId,
                timestamp: '1700000005',
                type: 'text',
                text: { body: 'Durable live text' },
              },
            ],
          },
        };

        const promotionHistory = {
          field: 'history',
          value: {
            metadata,
            history: [
              {
                threads: [
                  {
                    id: customer,
                    messages: [
                      {
                        from: customer,
                        id: promotedId,
                        timestamp: '1700000000',
                        type: 'text',
                        text: { body: 'Before live promotion' },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        };

        const mixedBody = envelope([
          liveChange,
          promotionHistory,
          {
            field: 'smb_message_echoes',
            value: {
              metadata,
              message_echoes: [
                {
                  from: business,
                  to: customer,
                  id: newerEchoId,
                  timestamp: '1700000100',
                  type: 'text',
                  text: { body: 'Newer business app preview' },
                },
              ],
            },
          },
        ]);

        expect((await send(mixedBody, false)).status).toBe(401);
        expect((await send(mixedBody)).status).toBe(200);

        const beforeLive = await db
          .from('messages')
          .select('id')
          .in('message_id', [liveId, promotedId]);

        expect(beforeLive.error === null).toBe(true);
        expect(beforeLive.data).toEqual([]);

        const pendingLive = await db
          .from('coexistence_jobs')
          .select('id,status,attempts')
          .eq('config_id', configId)
          .eq('status', 'pending');

        expect(pendingLive.error === null).toBe(true);
        expect(z.array(jobSchema).parse(pendingLive.data)).toHaveLength(3);

        const lostLiveLease = await freshWorker().rpc('coexistence_claim', {
          p_limit: 5,
        });

        expect(lostLiveLease.error === null).toBe(true);
        expect(z.array(uuidSchema).parse(lostLiveLease.data)).toHaveLength(3);

        fixtureSql(
          `UPDATE public.coexistence_jobs SET lease_until='2000-01-01T00:00:00Z'
           WHERE config_id='${configId}' AND status='processing'`
        );

        const drains = await Promise.all([
          drainCoexistenceJobs(freshWorker()),
          drainCoexistenceJobs(freshWorker()),
        ]);

        expect(
          drains.reduce((total, result) => total + result.completed, 0)
        ).toBe(3);
        expect(
          drains.every(
            (result) =>
              result.retried === 0 &&
              result.quarantined === 0 &&
              result.stale === 0
          )
        ).toBe(true);

        const acceptedLive = await owner
          .from('messages')
          .select('id,conversation_id,message_source,content_text,created_at')
          .eq('message_id', liveId)
          .single();

        expect(acceptedLive.error === null).toBe(true);

        const liveRow = z
          .object({ id: z.uuid(), conversation_id: z.uuid() })
          .parse(acceptedLive.data);

        expect(acceptedLive.data).toMatchObject({
          message_source: 'cloud_api',
          content_text: 'Durable live text',
          created_at: '2023-11-14T22:13:25+00:00',
        });

        const liveInbox = await owner
          .from('conversations')
          .select('unread_count,status,first_inbound_at,last_inbound_at')
          .eq('id', liveRow.conversation_id)
          .single();

        expect(liveInbox.error === null).toBe(true);
        expect(liveInbox.data).toMatchObject({
          unread_count: 1,
          status: 'open',
          first_inbound_at: '2023-11-14T22:13:25+00:00',
          last_inbound_at: '2023-11-14T22:13:25+00:00',
        });

        const firstIntent = await db
          .from('coexistence_live_effects')
          .select('*')
          .eq('message_id', liveRow.id)
          .single();

        expect(
          firstIntent.error === null,
          'Migration 062 must persist a pending live intent'
        ).toBe(true);
        expect(firstIntent.data).toMatchObject({
          config_id: configId,
          generation: z
            .object({ coexistence_generation: z.uuid() })
            .parse(config.data).coexistence_generation,
          state: 'pending',
          was_new_contact: true,
          was_new_conversation: true,
          was_first_inbound: true,
        });

        // A live-only repackaging must stay durable, never enter legacy after()/bots.
        expect((await send(envelope([liveChange]))).status).toBe(200);
        expect(await drainCoexistenceJobs(freshWorker())).toEqual({
          completed: 1,
          retried: 0,
          quarantined: 0,
          stale: 0,
        });

        const closeAndRead = await owner
          .from('conversations')
          .update({ status: 'closed', unread_count: 0 })
          .eq('id', liveRow.conversation_id);

        expect(closeAndRead.error === null).toBe(true);
        expect(
          (await send(JSON.stringify(JSON.parse(mixedBody), null, 2))).status
        ).toBe(200);
        expect(await drainCoexistenceJobs(freshWorker())).toEqual({
          completed: 3,
          retried: 0,
          quarantined: 0,
          stale: 0,
        });

        const afterReadReplay = await owner
          .from('conversations')
          .select('unread_count,status,first_inbound_at')
          .eq('id', liveRow.conversation_id)
          .single();

        expect(afterReadReplay.error === null).toBe(true);
        expect(afterReadReplay.data).toEqual({
          unread_count: 0,
          status: 'closed',
          first_inbound_at: '2023-11-14T22:13:25+00:00',
        });

        const sameIntent = await db
          .from('coexistence_live_effects')
          .select('*')
          .eq('message_id', liveRow.id)
          .single();

        expect(sameIntent.error === null).toBe(true);
        expect(sameIntent.data).toEqual(firstIntent.data);

        const previewBeforePromotion = await owner
          .from('conversations')
          .select('last_message_at,last_message_text')
          .eq('id', conversationId)
          .single();

        expect(previewBeforePromotion.error === null).toBe(true);
        expect(previewBeforePromotion.data).toEqual({
          last_message_at: '2023-11-14T22:15:00+00:00',
          last_message_text: 'Newer business app preview',
        });

        const closeHistoryThread = await owner
          .from('conversations')
          .update({ status: 'closed' })
          .eq('id', conversationId);

        expect(closeHistoryThread.error === null).toBe(true);

        const promotionChange = {
          field: 'messages',
          value: {
            metadata,
            contacts: [
              { wa_id: customer, profile: { name: 'Existing customer' } },
            ],
            messages: [
              {
                from: customer,
                id: promotedId,
                timestamp: '1700000001',
                type: 'interactive',
                interactive: {
                  type: 'button_reply',
                  button_reply: { id: 'approved', title: 'Live choice' },
                },
              },
            ],
          },
        };

        const promotionBody = envelope([promotionChange]);
        expect((await send(promotionBody)).status).toBe(200);
        expect(await drainCoexistenceJobs(freshWorker())).toEqual({
          completed: 1,
          retried: 0,
          quarantined: 0,
          stale: 0,
        });

        const promoted = await owner
          .from('messages')
          .select(
            'id,message_source,content_text,content_type,interactive_reply_id,created_at'
          )
          .eq('conversation_id', conversationId)
          .eq('message_id', promotedId)
          .single();

        expect(promoted.error === null).toBe(true);
        const promotedRow = uuidSchema.parse(promoted.data);
        expect(promoted.data).toMatchObject({
          message_source: 'cloud_api',
          content_text: 'Live choice',
          content_type: 'interactive',
          interactive_reply_id: 'approved',
          created_at: '2023-11-14T22:13:21+00:00',
        });

        const promotedInbox = await owner
          .from('conversations')
          .select(
            'unread_count,status,first_inbound_at,last_inbound_at,last_message_at,last_message_text'
          )
          .eq('id', conversationId)
          .single();

        expect(promotedInbox.error === null).toBe(true);
        expect(promotedInbox.data).toMatchObject({
          unread_count: 1,
          status: 'open',
          first_inbound_at: '2023-11-14T22:13:21+00:00',
          last_inbound_at: '2023-11-14T22:13:21+00:00',
          ...previewBeforePromotion.data,
        });

        const promotionIntent = await db
          .from('coexistence_live_effects')
          .select('*')
          .eq('message_id', promotedRow.id)
          .single();

        expect(promotionIntent.error === null).toBe(true);
        expect(promotionIntent.data).toMatchObject({
          state: 'pending',
          was_new_contact: false,
          was_new_conversation: false,
          was_first_inbound: true,
        });
        expect(
          (await send(envelope([promotionHistory, promotionChange]))).status
        ).toBe(200);
        expect(await drainCoexistenceJobs(freshWorker())).toEqual({
          completed: 2,
          retried: 0,
          quarantined: 0,
          stale: 0,
        });

        const promotedAgain = await owner
          .from('messages')
          .select(
            'id,message_source,content_text,content_type,interactive_reply_id,created_at'
          )
          .eq('id', promotedRow.id)
          .single();

        expect(promotedAgain.error === null).toBe(true);
        expect(promotedAgain.data).toEqual(promoted.data);

        const stillOnce = await owner
          .from('conversations')
          .select(
            'unread_count,status,first_inbound_at,last_inbound_at,last_message_at,last_message_text'
          )
          .eq('id', conversationId)
          .single();

        expect(stillOnce.error === null).toBe(true);
        expect(stillOnce.data).toEqual(promotedInbox.data);

        const intents = await freshWorker()
          .from('coexistence_live_effects')
          .select('*')
          .eq('config_id', configId);

        expect(intents.error === null).toBe(true);
        expect(intents.data).toHaveLength(2);
        expect(intents.data).toEqual(
          expect.arrayContaining([firstIntent.data, promotionIntent.data])
        );

        for (const client of [owner, outsider]) {
          const hiddenEffects = await client
            .from('coexistence_live_effects')
            .select('message_id')
            .eq('config_id', configId);

          expect(hiddenEffects.data).toBeNull();
          expect(hiddenEffects.error?.code).toBe('42501');

          const deniedCommit = await client.rpc('coexistence_claim', {
            p_limit: 5,
          });

          expect(deniedCommit.error?.code).toBe('42501');
        }

        for (const table of ['automation_logs', 'flow_runs', 'ai_usage_log']) {
          const effects = await db
            .from(table)
            .select('id')
            .eq('account_id', accounts[0]);

          expect(effects.error === null).toBe(true);
          expect(effects.data).toEqual([]);
        }

        // Use fresh signed live input: the earlier 2023 fixtures must expire, not execute.
        const { drainCoexistenceEffects } = await import('./effects');

        const idleEffects = {
          advanced: 0,
          completed: 0,
          ambiguous: 0,
          stale: 0,
        };

        const completedEffects = { ...idleEffects, advanced: 9, completed: 1 };

        const claimSchema = z.object({
          message_id: z.uuid(),
          lease_token: z.uuid(),
        });

        const effectSchema = z.object({
          state: z.string(),
          stage: z.number(),
          action_id: z.uuid(),
          outcomes: z.array(
            z.object({
              stage: z.number(),
              action_id: z.uuid(),
              status: z.string(),
            })
          ),
        });

        const readEffect = async (messageId: string) => {
          const result = await db
            .from('coexistence_live_effects')
            .select('*')
            .eq('message_id', messageId)
            .single();

          expect(result.error === null).toBe(true);

          return effectSchema.parse(result.data);
        };

        const freshLive = async (phone: string) => {
          const messageId = `wamid.integration.effect.${randomUUID()}`;
          effectMessageIds.push(messageId);
          expect(
            (
              await send(
                envelope([
                  {
                    field: 'messages',
                    value: {
                      metadata,
                      contacts: [
                        { wa_id: phone, profile: { name: 'Effect fixture' } },
                      ],
                      messages: [
                        {
                          from: phone,
                          id: messageId,
                          timestamp: `${Math.floor(Date.now() / 1000)}`,
                          type: 'text',
                          text: { body: 'Fresh effect fixture' },
                        },
                      ],
                    },
                  },
                ])
              )
            ).status
          ).toBe(200);
          expect(await drainCoexistenceJobs(freshWorker())).toEqual({
            completed: 1,
            retried: 0,
            quarantined: 0,
            stale: 0,
          });

          const message = await owner
            .from('messages')
            .select('id,conversation_id')
            .eq('message_id', messageId)
            .single();

          expect(message.error === null).toBe(true);

          return z
            .object({ id: z.uuid(), conversation_id: z.uuid() })
            .parse(message.data);
        };

        const claimEffect = async (messageId: string) => {
          const result = await freshWorker().rpc('coexistence_effect_claim', {
            p_app_id: appId,
            p_limit: 1,
          });

          expect(result.error === null).toBe(true);
          const claims = z.array(claimSchema).parse(result.data);
          expect(claims).toHaveLength(1);
          expect(claims[0].message_id).toBe(messageId);

          return claims[0];
        };

        const beginEffect = async (claim: z.infer<typeof claimSchema>) => {
          const result = await freshWorker().rpc('coexistence_effect_begin', {
            p_message_id: claim.message_id,
            p_lease_token: claim.lease_token,
            p_app_id: appId,
          });

          expect(result.error === null).toBe(true);

          return result.data;
        };

        const expireEffect = async (messageId: string) => {
          const result = await db
            .from('coexistence_live_effects')
            .update({ lease_until: '2000-01-01T00:00:00Z' })
            .eq('message_id', messageId)
            .eq('config_id', configId);

          expect(result.error === null).toBe(true);
        };

        // Block accidental external traffic while retaining real local HTTP for every engine.
        const fetch = globalThis.fetch;
        const externalRequests: string[] = [];
        let simulateGraph = false;
        let simulatedGraphRequests = 0;
        let simulatedGraphWamid = `wamid.integration.simulated.${runId}`;
        let onGraphAcceptance: (() => Promise<void>) | undefined;
        let lastOutboundPersistence: unknown;
        let simulatePrivateMedia = false;
        let privateMediaToken = '';
        let privateMediaExpired = false;
        let privateGraphRequests = 0;
        let privateCdnRequests = 0;
        let storageRequests = 0;
        let loseGateFinishAck = false;
        let gateFinishCalls = 0;
        let simulateSignup = false;
        let signupExchangeCalls = 0;
        let signupReadCalls = 0;
        let loseSignupTokenAck = false;
        let signupTokenStoreCalls = 0;
        let signupRetryCiphertext: string | undefined;
        const signupCode = `local-signup-code-${randomUUID()}`;
        const signupBusinessToken = `local-signup-token-${randomUUID()}`;
        const signupExpiry = Math.floor(Date.now() / 1000) + 3600;
        let captureRequests = 0;

        const guardedFetch = vi
          .spyOn(globalThis, 'fetch')
          .mockImplementation(async (input, init) => {
            const target = new URL(
              input instanceof Request ? input.url : input.toString()
            );

            if (
              simulateSignup &&
              target.origin === 'https://graph.facebook.com' &&
              init?.method === 'GET'
            ) {
              if (target.pathname === '/v27.0/oauth/access_token') {
                signupExchangeCalls++;
                expect(target.searchParams.get('client_id')).toBe(appId);
                expect(target.searchParams.get('client_secret')).toBe(secret);
                expect(target.searchParams.get('code')).toBe(signupCode);

                return Response.json({
                  access_token: signupBusinessToken,
                  token_type: 'bearer',
                });
              }

              if (target.pathname === '/v27.0/debug_token') {
                signupReadCalls++;
                expect(target.searchParams.get('input_token')).toBe(
                  signupBusinessToken
                );
                expect(new Headers(init.headers).get('Authorization')).toBe(
                  `Bearer ${appId}|${secret}`
                );

                return Response.json({
                  data: {
                    app_id: appId,
                    is_valid: true,
                    expires_at: signupExpiry,
                    scopes: [
                      'whatsapp_business_management',
                      'whatsapp_business_messaging',
                    ],
                    granular_scopes: [
                      {
                        scope: 'whatsapp_business_management',
                        target_ids: [`${fixture}26`],
                      },
                    ],
                  },
                });
              }

              if (target.pathname === `/v27.0/${fixture}26/phone_numbers`) {
                signupReadCalls++;
                expect(new Headers(init.headers).get('Authorization')).toBe(
                  `Bearer ${signupBusinessToken}`
                );

                return Response.json({ data: [{ id: `${fixture}25` }] });
              }

              if (target.pathname === `/v27.0/${fixture}25`) {
                signupReadCalls++;
                expect(new Headers(init.headers).get('Authorization')).toBe(
                  `Bearer ${signupBusinessToken}`
                );

                return Response.json({
                  id: `${fixture}25`,
                  display_phone_number: '+1 555 000 1234',
                  is_on_biz_app: true,
                  platform_type: 'CLOUD_API',
                });
              }
            }

            if (simulatePrivateMedia && init?.method === 'GET') {
              const providerId = target.pathname.split('/').at(-1);

              if (
                target.origin === 'https://graph.facebook.com' &&
                providerMediaIds.includes(providerId ?? '')
              ) {
                privateGraphRequests++;
                expect(target.searchParams.get('phone_number_id')).toBe(
                  phoneId
                );
                expect(init.body).toBeUndefined();
                expect(new Headers(init.headers).get('Authorization')).toBe(
                  `Bearer ${privateMediaToken}`
                );

                if (privateMediaExpired)
                  return Response.json(
                    { error: { message: 'Expired fixture' } },
                    { status: 404 }
                  );

                return Response.json({
                  id: providerId,
                  mime_type: 'image/jpeg',
                  file_size: 4,
                  url: `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=${providerId}`,
                });
              }

              if (
                target.origin === 'https://lookaside.fbsbx.com' &&
                target.pathname === '/whatsapp_business/attachments/' &&
                providerMediaIds.includes(target.searchParams.get('mid') ?? '')
              ) {
                privateCdnRequests++;
                expect(init.body).toBeUndefined();
                expect(new Headers(init.headers).get('Authorization')).toBe(
                  `Bearer ${privateMediaToken}`
                );

                return new Response(new Uint8Array([255, 216, 255, 217]), {
                  headers: { 'Content-Type': 'image/jpeg' },
                });
              }
            }

            if (
              simulateGraph &&
              target.origin === 'https://graph.facebook.com' &&
              target.pathname.endsWith(`/${phoneId}/messages`) &&
              init?.method === 'POST'
            ) {
              simulatedGraphRequests++;

              await onGraphAcceptance?.();

              return Response.json({ messages: [{ id: simulatedGraphWamid }] });
            }

            if (target.origin !== url.origin) {
              externalRequests.push(target.origin);

              return Promise.reject(
                new Error('Integration forbids external HTTP')
              );
            }

            if (target.pathname.startsWith('/storage/v1/')) storageRequests++;

            if (target.pathname === '/rest/v1/rpc/coexistence_ingress') {
              captureRequests++;
            }

            if (target.pathname === '/rest/v1/rpc/persist_outbound_message') {
              lastOutboundPersistence = JSON.parse(
                z.string().parse(init?.body)
              );
            }

            if (
              target.pathname === '/rest/v1/rpc/coexistence_signup_store_token'
            ) {
              signupTokenStoreCalls++;

              const ciphertext = z
                .object({ p_access_token: z.string() })
                .parse(JSON.parse(z.string().parse(init?.body))).p_access_token;

              expect(ciphertext).not.toBe(signupBusinessToken);

              if (loseSignupTokenAck) signupRetryCiphertext = ciphertext;
              else if (signupRetryCiphertext !== undefined) {
                expect(ciphertext).toBe(signupRetryCiphertext);
                signupRetryCiphertext = undefined;
              }
            }

            const response = await fetch(input, init);

            if (
              target.pathname ===
                '/rest/v1/rpc/coexistence_signup_store_token' &&
              loseSignupTokenAck &&
              response.ok
            ) {
              loseSignupTokenAck = false;
              await response.arrayBuffer();
              throw new Error('Simulated lost signup token receipt');
            }

            if (
              target.pathname === '/rest/v1/rpc/connection_operation_finish'
            ) {
              gateFinishCalls++;

              if (loseGateFinishAck && response.ok) {
                loseGateFinishAck = false;
                await response.arrayBuffer();
                throw new Error(
                  'Simulated lost connection finish acknowledgement'
                );
              }
            }

            return response;
          });

        try {
          const healthy = await freshLive('15550008101');
          expect(await drainCoexistenceEffects(freshWorker(), appId)).toEqual(
            completedEffects
          );
          const healthyEffect = await readEffect(healthy.id);
          expect(healthyEffect).toMatchObject({ state: 'completed', stage: 9 });
          expect(
            healthyEffect.outcomes.map((outcome) => outcome.stage)
          ).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
          expect(
            healthyEffect.outcomes.every(
              (outcome) => outcome.status === 'completed'
            )
          ).toBe(true);
          expect(
            new Set(healthyEffect.outcomes.map((outcome) => outcome.action_id))
              .size
          ).toBe(10);
          // Claim also fences out the intentionally old ingestion fixtures.
          expect((await readEffect(liveRow.id)).state).toBe('stale');
          expect((await readEffect(promotedRow.id)).state).toBe('stale');

          const resumed = await freshLive('15550008102');
          const checkpointClaim = await claimEffect(resumed.id);
          expect(await beginEffect(checkpointClaim)).toMatchObject({
            status: 'running',
            stage: 0,
            config_id: configId,
            generation: z
              .object({ coexistence_generation: z.uuid() })
              .parse(config.data).coexistence_generation,
          });

          const checkpoint = await freshWorker().rpc(
            'coexistence_effect_settle',
            {
              p_message_id: resumed.id,
              p_lease_token: checkpointClaim.lease_token,
              p_stage: 0,
              p_status: 'completed',
              p_consumed: false,
            }
          );

          expect(checkpoint.error === null).toBe(true);
          expect(checkpoint.data).toBe('pending');
          const saved = await readEffect(resumed.id);
          expect(saved).toMatchObject({ state: 'pending', stage: 1 });
          expect(await drainCoexistenceEffects(freshWorker(), appId)).toEqual({
            ...completedEffects,
            advanced: 8,
          });
          const restarted = await readEffect(resumed.id);
          expect(restarted.outcomes).toHaveLength(10);
          expect(restarted.outcomes[0]).toEqual(saved.outcomes[0]);
          expect(restarted.outcomes[1].action_id).toBe(saved.action_id);
          expect(await drainCoexistenceEffects(freshWorker(), appId)).toEqual(
            idleEffects
          );
          expect(await readEffect(resumed.id)).toEqual(restarted);

          const unstarted = await freshLive('15550008103');
          const abandonedClaim = await claimEffect(unstarted.id);
          await expireEffect(unstarted.id);
          expect(await drainCoexistenceEffects(freshWorker(), appId)).toEqual(
            completedEffects
          );
          expect(await beginEffect(abandonedClaim)).toEqual({
            status: 'stale',
          });
          expect((await readEffect(unstarted.id)).outcomes).toHaveLength(10);

          const uncertain = await freshLive('15550008104');
          const uncertainClaim = await claimEffect(uncertain.id);
          expect(await beginEffect(uncertainClaim)).toMatchObject({
            status: 'running',
            stage: 0,
          });
          await expireEffect(uncertain.id);
          const blocked = await freshLive('15550008104');
          expect(blocked.conversation_id).toBe(uncertain.conversation_id);
          const unrelated = await freshLive('15550008105');
          expect(await drainCoexistenceEffects(freshWorker(), appId)).toEqual(
            completedEffects
          );
          expect(await readEffect(uncertain.id)).toMatchObject({
            state: 'ambiguous',
            stage: 0,
            outcomes: [],
          });
          expect(await readEffect(blocked.id)).toMatchObject({
            state: 'pending',
            stage: 0,
            outcomes: [],
          });
          expect((await readEffect(unrelated.id)).state).toBe('completed');
          expect(await drainCoexistenceEffects(freshWorker(), appId)).toEqual(
            idleEffects
          );
          expect(await beginEffect(uncertainClaim)).toEqual({
            status: 'ambiguous',
          });

          const fenced = await freshLive('15550008106');
          const fencedClaim = await claimEffect(fenced.id);

          const rotatedConfig = fixtureUpdate([configId], {
            access_token: encrypt('local-integration-rotated-not-a-meta-token'),
          });

          const rotate = {
            data: rotatedConfig.data[0],
            error: rotatedConfig.error,
          };

          expect(rotate.error === null).toBe(true);
          expect(
            z.object({ coexistence_generation: z.uuid() }).parse(rotate.data)
              .coexistence_generation
          ).not.toBe(
            z.object({ coexistence_generation: z.uuid() }).parse(config.data)
              .coexistence_generation
          );
          expect(await beginEffect(fencedClaim)).toEqual({ status: 'stale' });
          expect(await readEffect(fenced.id)).toMatchObject({
            state: 'stale',
            stage: 0,
            outcomes: [],
          });

          for (const client of [owner, outsider]) {
            const denied = await Promise.all([
              client.rpc('coexistence_effect_claim', {
                p_app_id: appId,
                p_limit: 1,
              }),
              client.rpc('coexistence_effect_begin', {
                p_message_id: fenced.id,
                p_lease_token: fencedClaim.lease_token,
                p_app_id: appId,
              }),
              client.rpc('coexistence_effect_settle', {
                p_message_id: fenced.id,
                p_lease_token: fencedClaim.lease_token,
                p_stage: 0,
                p_status: 'completed',
                p_consumed: false,
              }),
            ]);

            expect(denied.map((result) => result.error?.code)).toEqual([
              '42501',
              '42501',
              '42501',
            ]);
          }

          for (const table of [
            'automation_logs',
            'flow_runs',
            'ai_usage_log',
          ]) {
            const actions = await db
              .from(table)
              .select('id')
              .eq('account_id', accounts[0]);

            expect(actions.error === null).toBe(true);
            expect(actions.data).toEqual([]);
          }

          const bindingSchema = z.object({
            status: z.string(),
            coexistence_app_id: z.string(),
            coexistence_verified_at: z.string().nullable(),
            coexistence_generation: z.uuid(),
          });

          const readBinding = async () => {
            const result = await db
              .from('whatsapp_config')
              .select(
                'status,coexistence_app_id,coexistence_verified_at,coexistence_generation'
              )
              .eq('id', configId)
              .single();

            expect(result.error === null).toBe(true);

            return bindingSchema.parse(result.data);
          };

          // TEST ONLY: emulate explicit service-side verification, never a reconnect webhook.
          const reverify = async (token: string) => {
            const result = fixtureUpdate([configId], {
              access_token: encrypt(token),
              status: 'connected',
              coexistence_app_id: appId,
              coexistence_verified_at: new Date().toISOString(),
            });

            expect(result.error === null).toBe(true);

            return readBinding();
          };

          const lifecycle = (
            event: string,
            entryId: string,
            info?: { waba_id: string; partner_app_id?: string }
          ) =>
            JSON.stringify({
              object: 'whatsapp_business_account',
              entry: [
                {
                  id: entryId,
                  time: Math.floor(Date.now() / 1000),
                  changes: [
                    {
                      field: 'account_update',
                      value: { event, waba_info: info },
                    },
                  ],
                },
              ],
            });

          const readEvidence = async () => {
            const result = await db
              .from('coexistence_lifecycle_evidence')
              .select('dedupe_key,event,action')
              .eq('config_id', configId)
              .order('dedupe_key');

            expect(
              result.error === null,
              'Migration 064 must be applied locally'
            ).toBe(true);

            return z
              .array(
                z.object({
                  dedupe_key: z.string(),
                  event: z.string(),
                  action: z.string(),
                })
              )
              .parse(result.data);
          };

          const {
            withSendConnection,
            withStoredSendConnection,
            assertOutboundSendAllowed,
          } = await import('./send-guard');

          const { sendTextMessage } = await import('../meta-api');

          const scope = (generation: string) => ({
            accountId: accounts[0],
            configId,
            generation,
          });

          const sendSimulated = (token: string) =>
            sendTextMessage({
              phoneNumberId: phoneId,
              accessToken: token,
              to: customer,
              text: 'Strictly simulated integration send',
            });

          simulateGraph = true;

          const verified = await reverify(localToken);
          const oldScope = scope(verified.coexistence_generation);

          const disconnect = lifecycle('PARTNER_REMOVED', partnerBusinessId, {
            waba_id: wabaId,
          });

          const evidenceBefore = await readEvidence();

          expect((await send(disconnect, false)).status).toBe(401);
          expect(await readBinding()).toEqual(verified);
          expect(await readEvidence()).toEqual(evidenceBefore);

          for (const unrelated of [
            lifecycle('PARTNER_REMOVED', `${fixture}99`, { waba_id: wabaId }),
            lifecycle('PARTNER_APP_UNINSTALLED', partnerBusinessId, {
              waba_id: wabaId,
              partner_app_id: `${fixture}98`,
            }),
            lifecycle('FUTURE_UNKNOWN_EVENT', wabaId),
          ]) {
            expect((await send(unrelated)).status).toBe(200);
            expect(await readBinding()).toEqual(verified);
          }

          expect(await readEvidence()).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                event: 'PARTNER_REMOVED',
                action: 'ignored',
              }),
              expect.objectContaining({
                event: 'PARTNER_APP_UNINSTALLED',
                action: 'ignored',
              }),
              expect.objectContaining({
                event: 'unknown',
                action: 'quarantined',
              }),
            ])
          );

          // Persist queued origins before disconnect; NULL must not adopt a later managed binding.
          const automation = await db
            .from('automations')
            .insert({
              account_id: accounts[0],
              user_id: users[0],
              name: 'Lifecycle queue fixture',
              trigger_type: 'message_received',
              is_active: false,
            })
            .select('id')
            .single();

          expect(automation.error === null).toBe(true);
          const automationId = uuidSchema.parse(automation.data).id;

          const queued = await db
            .from('automation_pending_executions')
            .insert(
              [
                { send_config_id: null, send_generation: null },
                {
                  send_config_id: configId,
                  send_generation: oldScope.generation,
                },
              ].map((origin) => ({
                ...origin,
                automation_id: automationId,
                account_id: accounts[0],
                user_id: users[0],
                next_step_position: 0,
                run_at: '2100-01-01T00:00:00Z',
              }))
            )
            .select('id,send_config_id,send_generation');

          expect(queued.error === null).toBe(true);

          const queuedRows = z
            .array(
              z.object({
                id: z.uuid(),
                send_config_id: z.uuid().nullable(),
                send_generation: z.uuid().nullable(),
              })
            )
            .length(2)
            .parse(queued.data);

          expect(queuedRows).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                send_config_id: null,
                send_generation: null,
              }),
              expect.objectContaining({
                send_config_id: configId,
                send_generation: oldScope.generation,
              }),
            ])
          );
          expect((await send(disconnect)).status).toBe(200);
          // Observe stop immediately after ACK, without running either worker.
          const stopped = await readBinding();
          expect(stopped).toMatchObject({
            status: 'disconnected',
            coexistence_verified_at: null,
          });
          expect(stopped.coexistence_generation).not.toBe(oldScope.generation);
          expect(await readEvidence()).toContainEqual(
            expect.objectContaining({
              event: 'PARTNER_REMOVED',
              action: 'stop',
            })
          );
          await expect(
            withSendConnection(oldScope, () => sendSimulated(localToken))
          ).rejects.toThrow('Outbound send denied');
          expect(simulatedGraphRequests).toBe(0);

          const stoppedEvidence = await readEvidence();
          expect((await send(disconnect)).status).toBe(200);
          expect(await readBinding()).toEqual(stopped);
          expect(await readEvidence()).toEqual(stoppedEvidence);
          expect(
            (await send(lifecycle('ACCOUNT_RECONNECTED', wabaId))).status
          ).toBe(200);
          expect(await readBinding()).toEqual(stopped);

          const newToken = `local-integration-reverified-${randomUUID()}`;
          const reverified = await reverify(newToken);
          expect(reverified.coexistence_generation).not.toBe(
            stopped.coexistence_generation
          );
          const newScope = scope(reverified.coexistence_generation);
          await expect(
            withSendConnection(oldScope, () =>
              assertOutboundSendAllowed(phoneId, newToken)
            )
          ).rejects.toThrow('Outbound send denied');
          await expect(
            withSendConnection(newScope, () =>
              assertOutboundSendAllowed(phoneId, localToken)
            )
          ).rejects.toThrow('Outbound send denied');
          await expect(
            assertOutboundSendAllowed(phoneId, newToken)
          ).rejects.toThrow('Outbound send denied');

          for (const queuedRow of queuedRows) {
            await expect(
              withStoredSendConnection(accounts[0], queuedRow, () =>
                sendSimulated(newToken)
              )
            ).rejects.toThrow('Outbound send denied');
          }

          expect(simulatedGraphRequests).toBe(0);

          // Exact signed replay remains a tombstone across generations, not another stop.
          const evidenceBeforeReplay = await readEvidence();
          expect((await send(disconnect)).status).toBe(200);
          expect(await readBinding()).toEqual(reverified);
          expect(await readEvidence()).toEqual(evidenceBeforeReplay);
          await expect(
            withSendConnection(newScope, () => sendSimulated(newToken))
          ).resolves.toEqual({
            messageId: `wamid.integration.simulated.${runId}`,
          });
          expect(simulatedGraphRequests).toBe(1);

          // Other authoritative negatives and positive notifications also use event-specific routing.
          for (const event of [
            'PARTNER_APP_UNINSTALLED',
            'ACCOUNT_OFFBOARDED',
          ]) {
            const beforeStop = await reverify(newToken);

            const stop =
              event === 'ACCOUNT_OFFBOARDED'
                ? lifecycle(event, wabaId)
                : lifecycle(event, partnerBusinessId, {
                    waba_id: wabaId,
                    partner_app_id: appId,
                  });

            expect((await send(stop)).status).toBe(200);
            const afterStop = await readBinding();
            expect(afterStop).toMatchObject({
              status: 'disconnected',
              coexistence_verified_at: null,
            });
            expect(afterStop.coexistence_generation).not.toBe(
              beforeStop.coexistence_generation
            );
          }

          for (const event of ['PARTNER_ADDED', 'PARTNER_APP_INSTALLED']) {
            const beforePositive = await reverify(newToken);
            expect(
              (
                await send(
                  lifecycle(event, partnerBusinessId, {
                    waba_id: wabaId,
                    partner_app_id:
                      event === 'PARTNER_APP_INSTALLED' ? appId : undefined,
                  })
                )
              ).status
            ).toBe(200);
            const afterPositive = await readBinding();
            expect(afterPositive.coexistence_verified_at).toBeNull();
            expect(afterPositive.coexistence_generation).not.toBe(
              beforePositive.coexistence_generation
            );
            await expect(
              withSendConnection(
                scope(afterPositive.coexistence_generation),
                () => sendSimulated(newToken)
              )
            ).rejects.toThrow('Outbound send denied');
          }

          // A phone-less lifecycle targets every binding for this app/WABA, not one tenant.
          const thirdUser = await db.auth.admin.createUser({
            email: `coexistence-integration-${randomUUID()}@example.invalid`,
            password: randomBytes(32).toString('hex'),
            email_confirm: true,
          });

          expect(thirdUser.error === null).toBe(true);

          if (!thirdUser.data.user)
            throw new Error('Third fixture user was not created');
          users.push(thirdUser.data.user.id);

          const thirdAccount = await db
            .from('accounts')
            .select('id')
            .eq('owner_user_id', thirdUser.data.user.id)
            .single();

          expect(thirdAccount.error === null).toBe(true);
          const thirdAccountId = uuidSchema.parse(thirdAccount.data).id;
          accounts.push(thirdAccountId);

          const additionalConfigs = fixtureInsert(
            [
              {
                user_id: users[1],
                account_id: accounts[1],
                phone_number_id: `${fixture}05`,
                waba_id: wabaId,
              },
              {
                user_id: users[2],
                account_id: thirdAccountId,
                phone_number_id: `${fixture}06`,
                waba_id: `${fixture}07`,
              },
            ].map((binding) => ({
              ...binding,
              access_token: encrypt(newToken),
              status: 'connected',
              coexistence_app_id: appId,
              coexistence_verified_at: new Date().toISOString(),
            }))
          );

          expect(additionalConfigs.error === null).toBe(true);

          const addedConfigs = z
            .array(z.object({ id: z.uuid(), waba_id: z.string() }))
            .length(2)
            .parse(additionalConfigs.data);

          lifecycleConfigIds.push(...addedConfigs.map((row) => row.id));

          const sharedConfig = addedConfigs.find(
            (row) => row.waba_id === wabaId
          );

          const unrelatedConfig = addedConfigs.find(
            (row) => row.waba_id !== wabaId
          );

          if (!sharedConfig || !unrelatedConfig)
            throw new Error('Missing lifecycle fixture bindings');
          const affectedIds = [configId, sharedConfig.id];

          const readLifecycleBindings = async () => {
            const result = await db
              .from('whatsapp_config')
              .select(
                'id,status,coexistence_app_id,coexistence_verified_at,coexistence_generation'
              )
              .in('id', lifecycleConfigIds)
              .order('id');

            expect(result.error === null).toBe(true);

            return z
              .array(bindingSchema.extend({ id: z.uuid() }))
              .length(3)
              .parse(result.data);
          };

          await reverify(newToken);
          const beforeMixed = await readLifecycleBindings();
          const mixedMessageId = `wamid.integration.mixed-lifecycle.${runId}`;
          effectMessageIds.push(mixedMessageId);

          const mixedBody = JSON.stringify({
            object: 'whatsapp_business_account',
            entry: [
              {
                id: wabaId,
                changes: [
                  {
                    field: 'messages',
                    value: {
                      metadata,
                      contacts: [
                        {
                          wa_id: customer,
                          profile: { name: 'Mixed lifecycle fixture' },
                        },
                      ],
                      messages: [
                        {
                          from: customer,
                          id: mixedMessageId,
                          timestamp: `${Math.floor(Date.now() / 1000)}`,
                          type: 'text',
                          text: {
                            body: 'Must never become a new-generation inbound effect',
                          },
                        },
                      ],
                    },
                  },
                ],
              },
              {
                id: partnerBusinessId,
                changes: [
                  {
                    field: 'account_update',
                    value: {
                      event: 'PARTNER_REMOVED',
                      waba_info: { waba_id: wabaId },
                    },
                  },
                ],
              },
            ],
          });

          const effectsBeforeMixed = await db
            .from('coexistence_live_effects')
            .select('message_id', { head: true, count: 'exact' })
            .eq('config_id', configId);

          expect(effectsBeforeMixed.error === null).toBe(true);
          const capturesBeforeMixed = captureRequests;

          expect((await send(mixedBody)).status).toBe(200);
          expect(captureRequests - capturesBeforeMixed).toBe(1);
          const afterMixed = await readLifecycleBindings();

          for (const previous of beforeMixed) {
            const current = afterMixed.find((row) => row.id === previous.id);

            if (affectedIds.includes(previous.id)) {
              expect(current).toMatchObject({
                status: 'disconnected',
                coexistence_verified_at: null,
              });
              expect(current?.coexistence_generation).not.toBe(
                previous.coexistence_generation
              );
            } else {
              expect(current).toEqual(previous);
            }
          }

          const fanoutEvidence = await db
            .from('coexistence_lifecycle_evidence')
            .select('config_id')
            .in('config_id', affectedIds)
            .eq('event', 'PARTNER_REMOVED')
            .eq('action', 'stop');

          expect(fanoutEvidence.error === null).toBe(true);
          expect(
            z
              .array(z.object({ config_id: z.uuid() }))
              .parse(fanoutEvidence.data)
              .map((row) => row.config_id)
          ).toEqual(expect.arrayContaining(affectedIds));

          const readMixedJobs = async () => {
            const result = await db
              .from('coexistence_jobs')
              .select('id,generation,status')
              .eq('config_id', configId)
              .contains('payload', {
                deliveries: [
                  {
                    field: 'messages',
                    value: { messages: [{ id: mixedMessageId }] },
                  },
                ],
              });

            expect(result.error === null).toBe(true);

            return z
              .array(
                z.object({
                  id: z.uuid(),
                  generation: z.uuid(),
                  status: z.string(),
                })
              )
              .parse(result.data);
          };

          const mixedJobs = await readMixedJobs();

          expect(mixedJobs).toEqual([
            expect.objectContaining({
              generation: beforeMixed.find((row) => row.id === configId)
                ?.coexistence_generation,
              status: 'pending',
            }),
          ]);

          // TEST ONLY: explicitly reverify both affected bindings before replaying the original signed body.
          const reverifyAffected = fixtureUpdate(affectedIds, {
            status: 'connected',
            coexistence_app_id: appId,
            coexistence_verified_at: new Date().toISOString(),
          });

          expect(reverifyAffected.error === null).toBe(true);
          const beforeMixedReplay = await readLifecycleBindings();

          expect((await send(mixedBody)).status).toBe(200);
          expect(await readLifecycleBindings()).toEqual(beforeMixedReplay);
          expect(await readMixedJobs()).toEqual(mixedJobs);
          await drainCoexistenceJobs(freshWorker());
          expect(await readMixedJobs()).toEqual([
            expect.objectContaining({
              id: mixedJobs[0].id,
              status: 'quarantined',
            }),
          ]);

          const mixedMessages = await db
            .from('messages')
            .select('id')
            .eq('message_id', mixedMessageId);

          expect(mixedMessages.error === null).toBe(true);
          expect(mixedMessages.data).toEqual([]);

          const effectsAfterReplay = await db
            .from('coexistence_live_effects')
            .select('message_id', { head: true, count: 'exact' })
            .eq('config_id', configId);

          expect(effectsAfterReplay.error === null).toBe(true);
          expect(effectsAfterReplay.count).toBe(effectsBeforeMixed.count);

          // Even supplied phone metadata cannot narrow an authoritative WABA-wide stop.
          const metadataStop = JSON.stringify({
            object: 'whatsapp_business_account',
            entry: [
              {
                id: wabaId,
                changes: [
                  {
                    field: 'account_update',
                    value: { event: 'ACCOUNT_OFFBOARDED', metadata },
                  },
                ],
              },
            ],
          });

          expect((await send(metadataStop)).status).toBe(200);
          const afterMetadataStop = await readLifecycleBindings();

          for (const previous of beforeMixedReplay) {
            const current = afterMetadataStop.find(
              (row) => row.id === previous.id
            );

            if (affectedIds.includes(previous.id)) {
              expect(current).toMatchObject({
                status: 'disconnected',
                coexistence_verified_at: null,
              });
              expect(current?.coexistence_generation).not.toBe(
                previous.coexistence_generation
              );
            } else {
              expect(current).toEqual(previous);
            }
          }

          // Statuses and reactions are updates, including when their outbound parent has not arrived yet.
          await reverify(newToken);
          const { drainCoexistenceUpdates } = await import('./worker');

          const { drainCoexistenceStatusEvents } =
            await import('./status-events');

          const updateWamid = `wamid.integration.update-parent.${runId}`;
          const staleUpdateWamid = `wamid.integration.update-stale.${runId}`;
          effectMessageIds.push(updateWamid, staleUpdateWamid);
          const updateTime = Math.floor(Date.now() / 1000) - 60;

          const statusUpdate = (
            id: string,
            status: string,
            time: number,
            recipient = customer
          ) => ({
            id,
            status,
            timestamp: `${time}`,
            recipient_id: recipient,
            errors:
              status === 'failed'
                ? [
                    {
                      code: 131026,
                      title: 'Undeliverable fixture',
                      error_data: { details: 'Simulated failure detail' },
                    },
                  ]
                : undefined,
          });

          const reactionUpdate = (
            target: string,
            emoji: string,
            time: number
          ) => ({
            id: `wamid.integration.reaction.${randomUUID()}`,
            from: customer,
            timestamp: `${time}`,
            type: 'reaction',
            reaction: { message_id: target, emoji },
          });

          const updateBody = (statuses: unknown[], reactions: unknown[]) =>
            envelope([
              {
                field: 'messages',
                value: {
                  metadata,
                  statuses: statuses.length ? statuses : undefined,
                  messages: reactions.length ? reactions : undefined,
                },
              },
            ]);

          const captureUpdates = async (
            statuses: unknown[],
            reactions: unknown[]
          ) => {
            const raw = updateBody(statuses, reactions);

            expect((await send(raw)).status).toBe(200);
            await drainCoexistenceJobs(freshWorker());

            return raw;
          };

          const readReactions = async (messageId: string) => {
            const result = await owner
              .from('message_reactions')
              .select('id,emoji,actor_type')
              .eq('message_id', messageId)
              .order('id');

            expect(result.error === null).toBe(true);

            return z
              .array(
                z.object({
                  id: z.uuid(),
                  emoji: z.string(),
                  actor_type: z.string(),
                })
              )
              .parse(result.data);
          };

          const readUpdateMessage = async (messageId: string) => {
            const result = await owner
              .from('messages')
              .select('id,status,error_code,error_title,error_details')
              .eq('id', messageId)
              .single();

            expect(result.error === null).toBe(true);

            return z
              .object({
                id: z.uuid(),
                status: z.string(),
                error_code: z.number().nullable(),
                error_title: z.string().nullable(),
                error_details: z.string().nullable(),
              })
              .parse(result.data);
          };

          const quietUpdateSnapshot = async () => {
            const counts = await Promise.all([
              db
                .from('contacts')
                .select('id', { head: true, count: 'exact' })
                .eq('account_id', accounts[0]),
              db
                .from('conversations')
                .select('id', { head: true, count: 'exact' })
                .eq('account_id', accounts[0]),
              db
                .from('messages')
                .select('id', { head: true, count: 'exact' })
                .eq('conversation_id', conversationId),
              db
                .from('coexistence_live_effects')
                .select('message_id', { head: true, count: 'exact' })
                .eq('config_id', configId),
            ]);

            const conversation = await owner
              .from('conversations')
              .select('unread_count,first_inbound_at,last_inbound_at')
              .eq('id', conversationId)
              .single();

            expect(counts.every((result) => result.error === null)).toBe(true);
            expect(conversation.error === null).toBe(true);

            return {
              counts: counts.map((result) => result.count),
              conversation: conversation.data,
            };
          };

          // A different tenant already has the same Meta ID; neither its status nor reactions may change.
          const otherContact = await db
            .from('contacts')
            .insert({
              account_id: accounts[1],
              user_id: users[1],
              phone: customer,
            })
            .select('id')
            .single();

          expect(otherContact.error === null).toBe(true);

          const otherConversation = await db
            .from('conversations')
            .insert({
              account_id: accounts[1],
              user_id: users[1],
              contact_id: uuidSchema.parse(otherContact.data).id,
            })
            .select('id')
            .single();

          expect(otherConversation.error === null).toBe(true);

          const otherConversationId = uuidSchema.parse(
            otherConversation.data
          ).id;

          const collision = await db
            .from('messages')
            .insert({
              conversation_id: otherConversationId,
              sender_type: 'agent',
              content_type: 'text',
              content_text: 'Other tenant outbound fixture',
              message_id: updateWamid,
              status: 'sent',
            })
            .select('id')
            .single();

          expect(collision.error === null).toBe(true);
          const collisionId = uuidSchema.parse(collision.data).id;
          const quietBeforeEarly = await quietUpdateSnapshot();
          const earlyStatus = statusUpdate(updateWamid, 'read', updateTime);
          const earlyReaction = reactionUpdate(updateWamid, '👍', updateTime);

          const earlyBody = await captureUpdates(
            [earlyStatus],
            [earlyReaction]
          );

          const earlyQueue = await db
            .from('coexistence_updates')
            .select('id', { head: true, count: 'exact' })
            .eq('config_id', configId)
            .eq('state', 'pending');

          expect(
            earlyQueue.error === null,
            'Migration 066 must be applied locally'
          ).toBe(true);
          expect(earlyQueue.count).toBe(2);
          expect(await quietUpdateSnapshot()).toEqual(quietBeforeEarly);
          expect(await drainCoexistenceUpdates(freshWorker())).toMatchObject({
            applied: 0,
          });
          expect(await quietUpdateSnapshot()).toEqual(quietBeforeEarly);

          const collisionAfterEarly = await outsider
            .from('messages')
            .select('status')
            .eq('id', collisionId)
            .single();

          expect(collisionAfterEarly.error === null).toBe(true);
          expect(collisionAfterEarly.data).toEqual({ status: 'sent' });

          const otherReactions = await outsider
            .from('message_reactions')
            .select('id')
            .eq('message_id', collisionId);

          expect(otherReactions.error === null).toBe(true);
          expect(otherReactions.data).toEqual([]);

          const parentConversation = await owner
            .from('conversations')
            .select('contact_id')
            .eq('id', conversationId)
            .single();

          expect(parentConversation.error === null).toBe(true);

          const campaign = await db
            .from('broadcasts')
            .insert({
              account_id: accounts[0],
              user_id: users[0],
              name: 'Update mirror fixture',
              template_name: 'integration_never_sent',
              status: 'draft',
              total_recipients: 1,
            })
            .select('id')
            .single();

          expect(campaign.error === null).toBe(true);
          const campaignId = uuidSchema.parse(campaign.data).id;

          const recipient = await db.from('broadcast_recipients').insert({
            broadcast_id: campaignId,
            contact_id: z
              .object({ contact_id: z.uuid() })
              .parse(parentConversation.data).contact_id,
            whatsapp_message_id: updateWamid,
            status: 'sent',
          });

          expect(recipient.error === null).toBe(true);

          const readCampaign = async () => {
            const result = await owner
              .from('broadcasts')
              .select('sent_count,delivered_count,read_count,failed_count')
              .eq('id', campaignId)
              .single();

            expect(result.error === null).toBe(true);

            return result.data;
          };

          // Simulate a completed manual send by inserting only its local row; never call Meta.
          const parent = await db
            .from('messages')
            .insert({
              conversation_id: conversationId,
              sender_type: 'agent',
              content_type: 'text',
              content_text: 'Local outbound parent fixture',
              message_id: updateWamid,
              status: 'sent',
            })
            .select('id')
            .single();

          expect(parent.error === null).toBe(true);
          const parentId = uuidSchema.parse(parent.data).id;
          updateParentIds.push(parentId);

          expect(await drainCoexistenceUpdates(freshWorker())).toMatchObject({
            applied: 2,
          });
          expect((await readUpdateMessage(parentId)).status).toBe('read');
          expect(await readCampaign()).toEqual({
            sent_count: 1,
            delivered_count: 1,
            read_count: 1,
            failed_count: 0,
          });
          const firstReactions = await readReactions(parentId);

          expect(firstReactions).toEqual([
            expect.objectContaining({ actor_type: 'customer', emoji: '👍' }),
          ]);
          expect(
            await drainCoexistenceStatusEvents(freshWorker(), appId)
          ).toEqual({ completed: 1, ambiguous: 0, stale: 0 });

          const statusEvent = await db
            .from('coexistence_status_events')
            .select('state,status,message_id')
            .eq('message_id', parentId);

          expect(statusEvent.error).toBeNull();
          expect(statusEvent.data).toEqual([
            { state: 'completed', status: 'read', message_id: parentId },
          ]);
          expect(
            await drainCoexistenceStatusEvents(freshWorker(), appId)
          ).toEqual({ completed: 0, ambiguous: 0, stale: 0 });

          const quietAfterParent = await quietUpdateSnapshot();

          expect((await send(earlyBody)).status).toBe(200);
          await drainCoexistenceJobs(freshWorker());
          await captureUpdates([earlyStatus], []);
          await captureUpdates([], [earlyReaction]);
          expect(await drainCoexistenceUpdates(freshWorker())).toMatchObject({
            applied: 0,
          });
          expect(await readReactions(parentId)).toEqual(firstReactions);
          expect(await quietUpdateSnapshot()).toEqual(quietAfterParent);

          await captureUpdates(
            [],
            [reactionUpdate(updateWamid, '', updateTime + 10)]
          );
          await drainCoexistenceUpdates(freshWorker());
          expect(await readReactions(parentId)).toEqual([]);
          await captureUpdates(
            [],
            [reactionUpdate(updateWamid, '👍', updateTime + 5)]
          );
          await drainCoexistenceUpdates(freshWorker());
          expect(await readReactions(parentId)).toEqual([]);
          await captureUpdates(
            [],
            [reactionUpdate(updateWamid, '❤️', updateTime + 20)]
          );
          await drainCoexistenceUpdates(freshWorker());
          expect(await readReactions(parentId)).toEqual([
            expect.objectContaining({ emoji: '❤️' }),
          ]);

          await captureUpdates(
            [
              statusUpdate(updateWamid, 'failed', updateTime + 30),
              statusUpdate(updateWamid, 'delivered', updateTime - 5),
            ],
            []
          );
          await drainCoexistenceUpdates(freshWorker());
          expect(await readUpdateMessage(parentId)).toMatchObject({
            status: 'read',
            error_code: null,
            error_title: null,
            error_details: null,
          });

          const failureEvidence = await db
            .from('coexistence_updates')
            .select('operation')
            .eq('config_id', configId)
            .eq('target_wamid', updateWamid)
            .eq('operation->>status', 'failed');

          expect(failureEvidence.error).toBeNull();
          expect(failureEvidence.data).toEqual([
            expect.objectContaining({
              operation: expect.objectContaining({
                error_code: 131026,
                error_details: 'Simulated failure detail',
              }),
            }),
          ]);
          await captureUpdates(
            [statusUpdate(liveId, 'read', updateTime + 30)],
            []
          );
          await drainCoexistenceUpdates(freshWorker());
          expect((await readUpdateMessage(liveRow.id)).status).toBe(
            'delivered'
          );
          const beforeConflict = await readUpdateMessage(parentId);

          await captureUpdates(
            [
              statusUpdate(
                updateWamid,
                'failed',
                updateTime + 40,
                '15559999999'
              ),
            ],
            []
          );
          await drainCoexistenceUpdates(freshWorker());
          expect(await readUpdateMessage(parentId)).toEqual(beforeConflict);
          expect(await readCampaign()).toEqual({
            sent_count: 1,
            delivered_count: 1,
            read_count: 1,
            failed_count: 0,
          });
          expect(await quietUpdateSnapshot()).toEqual(quietAfterParent);

          if (process.env.COEXISTENCE_INTEGRATION_REALTIME === '1') {
            await captureUpdates(
              [],
              [reactionUpdate(updateWamid, '', updateTime + 21)]
            );
            await drainCoexistenceUpdates(freshWorker());
            expect(await readReactions(parentId)).toEqual([]);

            const reactionRealtimeRow = z.object({
              id: z.uuid(),
              message_id: z.uuid(),
              conversation_id: z.uuid(),
              emoji: z.string(),
            });

            const inserted =
              Promise.withResolvers<z.infer<typeof reactionRealtimeRow>>();

            const updated =
              Promise.withResolvers<z.infer<typeof reactionRealtimeRow>>();

            const deleted = Promise.withResolvers<z.infer<typeof uuidSchema>>();
            let observedReactionId: string | null = null;

            const reactionChannel = owner
              .channel(`coexistence-reaction-${runId}`, {
                config: {
                  postgres_changes_options: { wait: true, timeout: 8000 },
                },
              })
              .on(
                'postgres_changes',
                {
                  event: '*',
                  schema: 'public',
                  table: 'message_reactions',
                  filter: `conversation_id=eq.${conversationId}`,
                },
                (event) => {
                  if (event.eventType === 'DELETE') {
                    const previous = uuidSchema.safeParse(event.old);

                    // The UI removes by old.id only; a primary-key DELETE payload is sufficient.
                    if (
                      previous.success &&
                      previous.data.id === observedReactionId
                    )
                      deleted.resolve(previous.data);

                    return;
                  }

                  const row = reactionRealtimeRow.safeParse(event.new);

                  if (!row.success || row.data.message_id !== parentId) return;

                  if (event.eventType === 'INSERT') {
                    observedReactionId = row.data.id;
                    inserted.resolve(row.data);
                  } else if (
                    event.eventType === 'UPDATE' &&
                    row.data.id === observedReactionId
                  ) {
                    updated.resolve(row.data);
                  }
                }
              );

            const awaitReaction = async <T>(
              event: string,
              observed: Promise<T>
            ): Promise<T> => {
              let timer: ReturnType<typeof setTimeout> | undefined;

              try {
                return await Promise.race([
                  observed,
                  new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(
                      () =>
                        reject(
                          new Error(
                            `Authenticated reaction ${event} was not delivered`
                          )
                        ),
                      10_000
                    );
                  }),
                ]);
              } finally {
                clearTimeout(timer);
              }
            };

            try {
              await subscribe(reactionChannel);
              await captureUpdates(
                [],
                [reactionUpdate(updateWamid, '👍', updateTime + 22)]
              );
              await drainCoexistenceUpdates(freshWorker());

              const realtimeInsert = await awaitReaction(
                'INSERT',
                inserted.promise
              );

              expect(realtimeInsert).toMatchObject({
                message_id: parentId,
                conversation_id: conversationId,
                emoji: '👍',
              });
              await captureUpdates(
                [],
                [reactionUpdate(updateWamid, '❤️', updateTime + 23)]
              );
              await drainCoexistenceUpdates(freshWorker());

              const realtimeUpdate = await awaitReaction(
                'UPDATE',
                updated.promise
              );

              expect(realtimeUpdate).toMatchObject({
                id: realtimeInsert.id,
                emoji: '❤️',
              });
              await captureUpdates(
                [],
                [reactionUpdate(updateWamid, '', updateTime + 24)]
              );
              await drainCoexistenceUpdates(freshWorker());
              expect(
                await awaitReaction('DELETE old.id', deleted.promise)
              ).toEqual({ id: realtimeInsert.id });
              expect(await readReactions(parentId)).toEqual([]);
            } finally {
              await owner.removeChannel(reactionChannel);
            }
          }

          // Recovery rows remain private even to the owning browser session.
          for (const client of [owner, outsider]) {
            const privateRows = await client
              .from('coexistence_updates')
              .select('id');

            const privateStatusEvents = await client
              .from('coexistence_status_events')
              .select('id');

            const privateWrite = await client
              .from('coexistence_updates')
              .delete()
              .eq('config_id', configId);

            const deniedRecovery = await client.rpc(
              'coexistence_recover_updates',
              { p_limit: 100 }
            );

            expect(privateRows.error?.code).toBe('42501');
            expect(privateStatusEvents.error?.code).toBe('42501');
            expect(privateWrite.error?.code).toBe('42501');
            expect(deniedRecovery.error?.code).toBe('42501');
          }

          const invisibleReaction = await outsider
            .from('message_reactions')
            .select('id')
            .eq('message_id', parentId);

          expect(invisibleReaction.error === null).toBe(true);
          expect(invisibleReaction.data).toEqual([]);

          const deniedReaction = await outsider
            .from('message_reactions')
            .insert({
              message_id: parentId,
              conversation_id: conversationId,
              actor_type: 'agent',
              actor_id: users[1],
              emoji: '👎',
            });

          expect(deniedReaction.error?.code).toBe('42501');
          await captureUpdates(
            [statusUpdate(staleUpdateWamid, 'read', updateTime)],
            []
          );
          await reverify(newToken);

          const staleParent = await db
            .from('messages')
            .insert({
              conversation_id: conversationId,
              sender_type: 'bot',
              content_type: 'text',
              content_text: 'New epoch outbound fixture',
              message_id: staleUpdateWamid,
              status: 'sent',
            })
            .select('id')
            .single();

          expect(staleParent.error === null).toBe(true);
          await drainCoexistenceUpdates(freshWorker());
          expect(
            (await readUpdateMessage(uuidSchema.parse(staleParent.data).id))
              .status
          ).toBe('sent');
          expect(simulatedGraphRequests).toBe(1);

          // The accepted Meta boundary is simulated; both persistence orders use the real CRM writer/RPC.
          await reverify(newToken);
          const { sendMessageToConversation } = await import('../send-message');

          const canonicalSchema = z.object({
            id: z.uuid(),
            message_id: z.string(),
            conversation_id: z.uuid(),
            message_source: z.string(),
            sender_type: z.string(),
            sender_id: z.string().nullable(),
            ai_generated: z.boolean(),
            content_type: z.string(),
            content_text: z.string().nullable(),
            created_at: z.string(),
            status: z.string(),
          });

          const persistenceSchema = z.object({
            p_account_id: z.uuid(),
            p_contact_id: z.uuid(),
            p_config_id: z.uuid().nullable(),
            p_generation: z.uuid().nullable(),
            p_recipient: z.object({
              phone: z.string().nullable(),
              wa_user_id: z.string().nullable(),
            }),
            p_message: z
              .object({
                conversation_id: z.uuid(),
                message_id: z.string(),
                created_at: z.string(),
              })
              .passthrough(),
            p_preview: z.string(),
          });

          const readCanonical = async (wamid: string) => {
            const result = await owner
              .from('messages')
              .select(
                'id,message_id,conversation_id,message_source,sender_type,sender_id,ai_generated,content_type,content_text,created_at,status'
              )
              .eq('conversation_id', conversationId)
              .eq('message_id', wamid)
              .single();

            expect(
              result.error === null,
              'The inbox must expose exactly one canonical outbound row'
            ).toBe(true);

            return canonicalSchema.parse(result.data);
          };

          const statusEventsFor = async (messageId: string) => {
            const result = await db
              .from('coexistence_status_events')
              .select('id,status')
              .eq('message_id', messageId)
              .order('id');

            expect(result.error === null).toBe(true);

            return z
              .array(z.object({ id: z.uuid(), status: z.string() }))
              .parse(result.data);
          };

          const echoFor = (wamid: string, status = 'read') =>
            envelope([
              {
                field: 'smb_message_echoes',
                value: {
                  metadata,
                  message_echoes: [
                    {
                      from: business,
                      to: customer,
                      id: wamid,
                      timestamp: `${updateTime - 100}`,
                      type: 'text',
                      text: {
                        body: 'Quiet echo must not replace authored content',
                      },
                      history_context: { status },
                    },
                  ],
                },
              },
            ]);

          const importEcho = async (raw: string) => {
            expect((await send(raw)).status).toBe(200);
            await drainCoexistenceJobs(freshWorker());
          };

          const retryPersistence = async (
            expected: z.infer<typeof canonicalSchema>,
            client = owner
          ) => {
            const args = persistenceSchema.parse(lastOutboundPersistence);

            expect(args.p_message.message_id).toBe(expected.message_id);

            const provenance = await db
              .from('coexistence_message_metadata')
              .select('source_config_id,source_generation,outbound_created_at')
              .eq('message_id', expected.id)
              .single();

            expect(provenance.error === null).toBe(true);

            const proof = z
              .object({
                source_config_id: z.uuid(),
                source_generation: z.uuid(),
                outbound_created_at: z.string(),
              })
              .parse(provenance.data);

            expect(proof).toMatchObject({
              source_config_id: args.p_config_id,
              source_generation: args.p_generation,
            });
            expect(Date.parse(proof.outbound_created_at)).toBe(
              Date.parse(args.p_message.created_at)
            );
            expect(Number.isFinite(Date.parse(args.p_message.created_at))).toBe(
              true
            );
            const callsBefore = simulatedGraphRequests;

            const retry = await client.rpc('persist_outbound_message', {
              ...args,
              p_message: {
                ...args.p_message,
                created_at: new Date(
                  Date.parse(args.p_message.created_at) + 1000
                ).toISOString(),
              },
            });

            expect(
              retry.error === null,
              'Persistence-only retry must not send to Meta again'
            ).toBe(true);
            expect(retry.data).toMatchObject({
              id: expected.id,
              message_id: expected.message_id,
              status: expected.status,
            });
            expect(simulatedGraphRequests).toBe(callsBefore);
            expect(await readCanonical(expected.message_id)).toEqual(expected);
          };

          const effectsBeforeReconciliation = await quietUpdateSnapshot();

          const engineRowsBefore = await Promise.all(
            ['automation_logs', 'flow_runs'].map(async (table) => {
              const result = await db
                .from(table)
                .select('id', { head: true, count: 'exact' })
                .eq('account_id', accounts[0]);

              expect(result.error === null).toBe(true);

              return result.count;
            })
          );

          simulatedGraphWamid = `wamid.integration.send-first.${runId}`;
          effectMessageIds.push(simulatedGraphWamid);

          const sendFirst = await sendMessageToConversation(
            owner,
            accounts[0],
            {
              conversationId,
              messageType: 'text',
              contentText: 'Authored send-first text',
              senderId: users[0],
            }
          );

          await captureUpdates(
            [statusUpdate(simulatedGraphWamid, 'read', updateTime + 44)],
            []
          );
          await drainCoexistenceUpdates(freshWorker());
          const beforeEcho = await readCanonical(simulatedGraphWamid);
          const sendFirstEvents = await statusEventsFor(beforeEcho.id);
          expect(sendFirstEvents).toEqual([
            expect.objectContaining({ status: 'read' }),
          ]);
          updateParentIds.push(beforeEcho.id);

          expect(sendFirst).toEqual({
            messageId: beforeEcho.id,
            whatsappMessageId: simulatedGraphWamid,
          });
          const sendFirstEcho = echoFor(simulatedGraphWamid);

          await importEcho(sendFirstEcho);
          const afterEcho = await readCanonical(simulatedGraphWamid);

          expect(afterEcho).toMatchObject({
            id: beforeEcho.id,
            message_source: 'cloud_api',
            sender_type: 'agent',
            sender_id: users[0],
            content_text: 'Authored send-first text',
            created_at: beforeEcho.created_at,
            status: 'read',
          });
          expect(await statusEventsFor(afterEcho.id)).toEqual(sendFirstEvents);
          await retryPersistence(afterEcho);
          await importEcho(sendFirstEcho);
          expect(await readCanonical(simulatedGraphWamid)).toEqual(afterEcho);

          simulatedGraphWamid = `wamid.integration.echo-first.${runId}`;
          effectMessageIds.push(simulatedGraphWamid);
          const echoFirstBody = echoFor(simulatedGraphWamid, 'sent');
          let quietRow: z.infer<typeof canonicalSchema> | undefined;

          const promotedRealtime = Promise.withResolvers<{
            old: { id: string; message_source: string };
            new: z.infer<typeof canonicalSchema>;
          }>();

          let promotionChannel: RealtimeChannel | undefined;
          let promotionTimer: ReturnType<typeof setTimeout> | undefined;

          try {
            if (process.env.COEXISTENCE_INTEGRATION_REALTIME === '1') {
              promotionChannel = owner
                .channel(`coexistence-outbound-promotion-${runId}`, {
                  config: {
                    postgres_changes_options: { wait: true, timeout: 8000 },
                  },
                })
                .on(
                  'postgres_changes',
                  {
                    event: 'UPDATE',
                    schema: 'public',
                    table: 'messages',
                    filter: `conversation_id=eq.${conversationId}`,
                  },
                  (event) => {
                    const previous = z
                      .object({ id: z.uuid(), message_source: z.string() })
                      .safeParse(event.old);

                    const current = canonicalSchema.safeParse(event.new);

                    if (
                      previous.success &&
                      current.success &&
                      current.data.message_id === simulatedGraphWamid &&
                      previous.data.message_source === 'phone_app' &&
                      current.data.message_source === 'cloud_api'
                    ) {
                      promotedRealtime.resolve({
                        old: previous.data,
                        new: current.data,
                      });
                    }
                  }
                );
              await subscribe(promotionChannel);
            }

            onGraphAcceptance = async () => {
              await importEcho(echoFirstBody);
              quietRow = await readCanonical(simulatedGraphWamid);
              updateParentIds.push(quietRow.id);
              expect(quietRow).toMatchObject({
                message_source: 'phone_app',
                status: 'sent',
              });
              expect(await statusEventsFor(quietRow.id)).toEqual([]);
              await captureUpdates(
                [statusUpdate(simulatedGraphWamid, 'read', updateTime + 45)],
                []
              );
              await drainCoexistenceUpdates(freshWorker());
              expect(await statusEventsFor(quietRow.id)).toEqual([]);
            };

            const echoFirst = await sendMessageToConversation(
              owner,
              accounts[0],
              {
                conversationId,
                messageType: 'text',
                contentText: 'Authored echo-first text',
                senderId: users[0],
              }
            );

            onGraphAcceptance = undefined;
            const promoted = await readCanonical(simulatedGraphWamid);

            expect(quietRow).toBeDefined();
            expect(promoted).toMatchObject({
              id: quietRow?.id,
              created_at: quietRow?.created_at,
              message_source: 'cloud_api',
              sender_type: 'agent',
              sender_id: users[0],
              content_type: 'text',
              content_text: 'Authored echo-first text',
              ai_generated: false,
              status: 'read',
            });
            expect(echoFirst.messageId).toBe(promoted.id);
            const promotionEvents = await statusEventsFor(promoted.id);

            expect(promotionEvents).toEqual([
              expect.objectContaining({ status: 'read' }),
            ]);

            if (promotionChannel) {
              const observed = await Promise.race([
                promotedRealtime.promise,
                new Promise<never>((_resolve, reject) => {
                  promotionTimer = setTimeout(
                    () =>
                      reject(
                        new Error(
                          'Authenticated outbound promotion UPDATE was not delivered'
                        )
                      ),
                    10_000
                  );
                }),
              ]);

              expect(observed.old).toMatchObject({
                id: promoted.id,
                message_source: 'phone_app',
              });
              expect(observed.new).toMatchObject({
                id: promoted.id,
                message_source: 'cloud_api',
                sender_id: users[0],
              });
            }

            await retryPersistence(promoted);
            await importEcho(echoFirstBody);
            await captureUpdates(
              [statusUpdate(simulatedGraphWamid, 'read', updateTime + 45)],
              []
            );
            await drainCoexistenceUpdates(freshWorker());
            expect(await readCanonical(simulatedGraphWamid)).toEqual(promoted);
            expect(await statusEventsFor(promoted.id)).toEqual(promotionEvents);
          } finally {
            onGraphAcceptance = undefined;
            clearTimeout(promotionTimer);

            if (promotionChannel) await owner.removeChannel(promotionChannel);
          }

          // Exercise the actual Flow/AI text writer, not a test-only messages INSERT.
          simulatedGraphWamid = `wamid.integration.ai-echo-first.${runId}`;
          effectMessageIds.push(simulatedGraphWamid);
          const botEcho = echoFor(simulatedGraphWamid);
          onGraphAcceptance = () => importEcho(botEcho);
          const { engineSendText } = await import('@/lib/flows/meta-send');
          const bindingBeforeBot = await readBinding();

          const contactForBot = await owner
            .from('conversations')
            .select('contact_id')
            .eq('id', conversationId)
            .single();

          expect(contactForBot.error === null).toBe(true);

          try {
            await withSendConnection(
              scope(bindingBeforeBot.coexistence_generation),
              () =>
                engineSendText({
                  accountId: accounts[0],
                  userId: users[0],
                  conversationId,
                  contactId: z
                    .object({ contact_id: z.uuid() })
                    .parse(contactForBot.data).contact_id,
                  text: 'Authored AI text',
                  aiGenerated: true,
                })
            );
          } finally {
            onGraphAcceptance = undefined;
          }

          const botCanonical = await readCanonical(simulatedGraphWamid);
          updateParentIds.push(botCanonical.id);

          expect(botCanonical).toMatchObject({
            message_source: 'cloud_api',
            sender_type: 'bot',
            ai_generated: true,
            content_text: 'Authored AI text',
            status: 'read',
          });
          expect(await statusEventsFor(botCanonical.id)).toEqual([]);
          await retryPersistence(botCanonical, db);
          await importEcho(botEcho);
          expect(await readCanonical(simulatedGraphWamid)).toEqual(
            botCanonical
          );
          const effectsAfterReconciliation = await quietUpdateSnapshot();

          expect(effectsAfterReconciliation.conversation).toEqual(
            effectsBeforeReconciliation.conversation
          );

          for (const index of [0, 1, 3]) {
            expect(effectsAfterReconciliation.counts[index]).toBe(
              effectsBeforeReconciliation.counts[index]
            );
          }

          expect(
            await Promise.all(
              ['automation_logs', 'flow_runs'].map(async (table) => {
                const result = await db
                  .from(table)
                  .select('id', { head: true, count: 'exact' })
                  .eq('account_id', accounts[0]);

                expect(result.error === null).toBe(true);

                return result.count;
              })
            )
          ).toEqual(engineRowsBefore);
          expect(simulatedGraphRequests).toBe(4);

          // Private media is projected from signed intake; only controlled Graph/CDN responses are permitted.
          const verifiedMediaBinding = await reverify(newToken);

          await recordHistoryChoice(
            verifiedMediaBinding.coexistence_generation
          );
          privateMediaToken = newToken;
          simulatePrivateMedia = true;
          const { privateMedia } = await import('./media');
          const mediaWamid = `wamid.integration.private-media.${runId}`;
          effectMessageIds.push(mediaWamid);

          const placeholder = envelope([
            {
              field: 'history',
              value: {
                metadata,
                history: [
                  {
                    threads: [
                      {
                        id: customer,
                        messages: [
                          {
                            from: customer,
                            id: mediaWamid,
                            timestamp: `${updateTime}`,
                            type: 'media_placeholder',
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          ]);

          await importEcho(placeholder);

          const mediaParent = await owner
            .from('messages')
            .select('id,media_url')
            .eq('conversation_id', conversationId)
            .eq('message_id', mediaWamid)
            .single();

          expect(mediaParent.error === null).toBe(true);
          expect(mediaParent.data?.media_url).toBeNull();
          const mediaMessageId = uuidSchema.parse(mediaParent.data).id;
          updateParentIds.push(mediaMessageId);

          const hydrateMedia = (providerId: string) =>
            importEcho(
              envelope([
                {
                  field: 'history',
                  value: {
                    metadata,
                    messages: [
                      {
                        id: mediaWamid,
                        timestamp: `${updateTime}`,
                        type: 'image',
                        image: { id: providerId, mime_type: 'image/jpeg' },
                      },
                    ],
                  },
                },
              ])
            );

          const mediaProjection = async () => {
            const result = await owner
              .from('messages')
              .select('id,media_url')
              .eq('id', mediaMessageId)
              .single();

            expect(result.error === null).toBe(true);

            const row = z
              .object({ id: z.uuid(), media_url: z.string() })
              .parse(result.data);

            const projected = new URL(row.media_url, 'http://127.0.0.1');

            expect(projected.pathname).toBe(
              `/api/whatsapp/coexistence/media/${mediaMessageId}`
            );
            expect(
              z.uuid().safeParse(projected.searchParams.get('v')).success
            ).toBe(true);
            expect([...projected.searchParams.keys()]).toEqual(['v']);
            expect(
              providerMediaIds.every((id) => !row.media_url.includes(id))
            ).toBe(true);
            expect(row.media_url).not.toMatch(
              /graph\.facebook|fbcdn|lookaside|storage\/v1/
            );

            return row.media_url;
          };

          let mediaChannel: RealtimeChannel | undefined;
          let mediaTimer: ReturnType<typeof setTimeout> | undefined;
          const hydratedRealtime = Promise.withResolvers<string>();

          try {
            if (process.env.COEXISTENCE_INTEGRATION_REALTIME === '1') {
              mediaChannel = owner
                .channel(`coexistence-private-media-${runId}`, {
                  config: {
                    postgres_changes_options: { wait: true, timeout: 8000 },
                  },
                })
                .on(
                  'postgres_changes',
                  {
                    event: 'UPDATE',
                    schema: 'public',
                    table: 'messages',
                    filter: `conversation_id=eq.${conversationId}`,
                  },
                  (event) => {
                    const row = z
                      .object({ id: z.uuid(), media_url: z.string() })
                      .safeParse(event.new);

                    if (row.success && row.data.id === mediaMessageId)
                      hydratedRealtime.resolve(row.data.media_url);
                  }
                );
              await subscribe(mediaChannel);
            }

            await hydrateMedia(providerMediaIds[1]);
            const firstMediaUrl = await mediaProjection();
            privateMediaRecorded = true;

            if (mediaChannel) {
              const observed = await Promise.race([
                hydratedRealtime.promise,
                new Promise<never>((_resolve, reject) => {
                  mediaTimer = setTimeout(
                    () =>
                      reject(
                        new Error(
                          'Authenticated private media hydration UPDATE was not delivered'
                        )
                      ),
                    10_000
                  );
                }),
              ]);

              expect(observed).toBe(firstMediaUrl);
            }

            const requestMedia = (client = owner) =>
              privateMedia(
                new Request(`http://127.0.0.1${firstMediaUrl}`),
                mediaMessageId,
                client
              );

            const download = await requestMedia();

            expect(download.status).toBe(200);
            expect(download.headers.get('Cache-Control')).toBe(
              'private, no-store'
            );
            expect(download.headers.get('Content-Type')).toMatch(
              /^image\/jpeg/
            );
            expect([...download.headers.values()].join(' ')).not.toMatch(
              /graph\.facebook|lookaside|storage\/v1/
            );
            expect([...download.headers.values()].join(' ')).not.toContain(
              providerMediaIds[1]
            );
            expect(new Uint8Array(await download.arrayBuffer())).toEqual(
              new Uint8Array([255, 216, 255, 217])
            );
            expect(privateGraphRequests).toBe(1);
            expect(privateCdnRequests).toBe(1);
            const forbidden = await requestMedia(outsider);

            expect(forbidden.status).toBe(404);
            expect(await forbidden.text()).not.toContain(providerMediaIds[1]);
            expect(privateGraphRequests).toBe(1);

            const teammatePassword = randomBytes(32).toString('hex');
            const teammateEmail = `coexistence-integration-${randomUUID()}@example.invalid`;

            const teammateUser = await db.auth.admin.createUser({
              email: teammateEmail,
              password: teammatePassword,
              email_confirm: true,
            });

            expect(teammateUser.error === null).toBe(true);

            if (!teammateUser.data.user)
              throw new Error('Temporary media teammate was not created');
            users.push(teammateUser.data.user.id);

            const teammateAccount = await db
              .from('accounts')
              .select('id')
              .eq('owner_user_id', teammateUser.data.user.id)
              .single();

            expect(teammateAccount.error === null).toBe(true);
            accounts.push(uuidSchema.parse(teammateAccount.data).id);

            const moveTeammate = await db
              .from('profiles')
              .update({ account_id: accounts[0], account_role: 'agent' })
              .eq('user_id', teammateUser.data.user.id);

            expect(moveTeammate.error === null).toBe(true);
            expect(
              (
                await teammate.auth.signInWithPassword({
                  email: teammateEmail,
                  password: teammatePassword,
                })
              ).error === null
            ).toBe(true);
            const teammateDownload = await requestMedia(teammate);

            expect(teammateDownload.status).toBe(200);
            await teammateDownload.arrayBuffer();
            expect(privateGraphRequests).toBe(2);
            const callsBeforeDenied = privateGraphRequests;
            vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'false');

            try {
              expect((await requestMedia()).status).toBe(404);
            } finally {
              vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
            }

            expect(privateGraphRequests).toBe(callsBeforeDenied);
            privateMediaExpired = true;

            try {
              expect((await requestMedia()).status).toBe(410);
            } finally {
              privateMediaExpired = false;
            }

            expect(privateGraphRequests).toBe(callsBeforeDenied + 1);
            await hydrateMedia(providerMediaIds[2]);
            const replacedMediaUrl = await mediaProjection();

            expect(replacedMediaUrl).not.toBe(firstMediaUrl);
            const beforeStale = privateGraphRequests;
            await reverify(newToken);
            expect((await requestMedia()).status).toBe(404);
            expect(privateGraphRequests).toBe(beforeStale);

            const missingProof = await db
              .from('coexistence_message_metadata')
              .update({ source_config_id: null, source_generation: null })
              .eq('message_id', mediaMessageId);

            expect(missingProof.error === null).toBe(true);
            expect((await requestMedia()).status).toBe(404);
            expect(privateGraphRequests).toBe(beforeStale);

            const clearMedia = await db
              .from('coexistence_message_metadata')
              .update({ media_id: null, media_type: null })
              .eq('message_id', mediaMessageId);

            expect(clearMedia.error === null).toBe(true);

            const clearedMessage = await owner
              .from('messages')
              .select('media_url')
              .eq('id', mediaMessageId)
              .single();

            expect(clearedMessage.error === null).toBe(true);
            expect(clearedMessage.data).toEqual({ media_url: null });
            expect((await requestMedia()).status).toBe(404);
            expect(privateGraphRequests).toBe(beforeStale);

            const hiddenContext = await owner.rpc('coexistence_media_context', {
              p_account_id: accounts[0],
              p_message_id: mediaMessageId,
              p_app_id: appId,
            });

            const hiddenHashes = await db
              .from('coexistence_private_media_ids')
              .select('media_id_hash');

            expect(hiddenContext.error?.code).toBe('42501');
            expect(hiddenHashes.error?.code).toBe('42501');
          } finally {
            clearTimeout(mediaTimer);

            if (mediaChannel) await owner.removeChannel(mediaChannel);
          }

          // A real accepted CRM send supersedes the private projection, including an intentional NULL URL.
          for (const { index, publicUrl } of [
            { index: 3, publicUrl: 'https://crm.example.invalid/owned.jpg' },
            { index: 4, publicUrl: null },
          ]) {
            simulatedGraphWamid = `wamid.integration.private-promotion.${index}.${runId}`;
            effectMessageIds.push(simulatedGraphWamid);

            const privateEcho = envelope([
              {
                field: 'smb_message_echoes',
                value: {
                  metadata,
                  message_echoes: [
                    {
                      from: business,
                      to: customer,
                      id: simulatedGraphWamid,
                      timestamp: `${updateTime}`,
                      type: 'image',
                      image: {
                        id: providerMediaIds[index],
                        mime_type: 'image/jpeg',
                      },
                    },
                  ],
                },
              },
            ]);

            onGraphAcceptance = () => importEcho(privateEcho);

            try {
              const accepted = await sendMessageToConversation(
                owner,
                accounts[0],
                {
                  conversationId,
                  messageType: publicUrl ? 'image' : 'text',
                  mediaUrl: publicUrl,
                  contentText: 'CRM-owned media representation',
                  senderId: users[0],
                }
              );

              updateParentIds.push(accepted.messageId);

              const ownUrl = await owner
                .from('messages')
                .select('media_url,message_source')
                .eq('id', accepted.messageId)
                .single();

              expect(ownUrl.error === null).toBe(true);
              expect(ownUrl.data).toEqual({
                media_url: publicUrl,
                message_source: 'cloud_api',
              });
              await importEcho(privateEcho);

              const replayUrl = await owner
                .from('messages')
                .select('media_url')
                .eq('id', accepted.messageId)
                .single();

              expect(replayUrl.error === null).toBe(true);
              expect(replayUrl.data).toEqual({ media_url: publicUrl });
              const beforePrivate = privateGraphRequests;

              expect(
                (
                  await privateMedia(
                    new Request(
                      `http://127.0.0.1/api/whatsapp/coexistence/media/${accepted.messageId}`
                    ),
                    accepted.messageId,
                    owner
                  )
                ).status
              ).toBe(404);
              expect(privateGraphRequests).toBe(beforePrivate);
            } finally {
              onGraphAcceptance = undefined;
            }
          }

          // Operator recovery is a one-time queue reset, never an inline replay or a send.
          const { operatorInventory, operatorRetry } =
            await import('./operator');

          const { operatorInventorySchema, operatorQueuedSchema } =
            await import('./operator-contract');

          const operatorOrigin = 'http://127.0.0.1';
          const retryRequestId = randomUUID();
          const recoveredWamid = `wamid.integration.operator-recovery.${runId}`;
          const unsupportedWamid = `wamid.integration.operator-unsupported.${runId}`;
          const recoveryText = `Private operator customer text ${runId}`;
          effectMessageIds.push(recoveredWamid, unsupportedWamid);

          const assertOperatorRedaction = (raw: string) => {
            expect(raw).not.toMatch(
              /"(?:payload|operation|lease_token|access_token|media_id|fingerprint|dedupe_key)"\s*:/
            );

            for (const value of [
              secret,
              newToken,
              recoveryText,
              recoveredWamid,
              ...providerMediaIds,
            ]) {
              expect(raw).not.toContain(value);
            }
          };

          const inventory = async (kind: string, client = owner) => {
            const response = await operatorInventory(
              new Request(
                `${operatorOrigin}/api/whatsapp/coexistence/operator?kind=${kind}&limit=50`
              ),
              client
            );

            expect(response.status).toBe(200);
            expect(response.headers.get('Cache-Control')).toBe(
              'private, no-store'
            );
            const raw = await response.text();
            assertOperatorRedaction(raw);

            return operatorInventorySchema.parse(JSON.parse(raw));
          };

          const retryRequest = (
            requestId = retryRequestId,
            origin = operatorOrigin,
            contentType = 'application/json'
          ) =>
            new Request(
              `${operatorOrigin}/api/whatsapp/coexistence/operator/retry`,
              {
                method: 'POST',
                headers: {
                  origin,
                  'content-type': contentType,
                  'sec-fetch-site': 'same-origin',
                },
                body: JSON.stringify({ request_id: requestId }),
              }
            );

          const recoveryBody = envelope([
            {
              field: 'messages',
              value: {
                metadata,
                contacts: [
                  { wa_id: customer, profile: { name: 'Operator fixture' } },
                ],
                messages: [
                  {
                    from: customer,
                    id: recoveredWamid,
                    timestamp: `${Math.floor(Date.now() / 1000)}`,
                    type: 'text',
                    text: { body: recoveryText },
                  },
                ],
              },
            },
          ]);

          const beforeRecovery = await quietUpdateSnapshot();

          expect((await send(recoveryBody)).status).toBe(200);

          const capturedRecovery = await db
            .from('coexistence_jobs')
            .select('id')
            .eq('config_id', configId)
            .contains('payload', {
              deliveries: [
                {
                  field: 'messages',
                  value: { messages: [{ id: recoveredWamid }] },
                },
              ],
            })
            .single();

          expect(capturedRecovery.error === null).toBe(true);
          const recoveryJobId = uuidSchema.parse(capturedRecovery.data).id;

          const recoveryClaims = await freshWorker().rpc('coexistence_claim', {
            p_limit: 5,
          });

          expect(recoveryClaims.error === null).toBe(true);

          const recoveryClaim = z
            .array(z.object({ id: z.uuid(), lease_token: z.uuid() }))
            .length(1)
            .parse(recoveryClaims.data)[0];

          expect(recoveryClaim.id).toBe(recoveryJobId);

          const quarantineRecovery = await freshWorker().rpc(
            'coexistence_fail',
            {
              p_job_id: recoveryJobId,
              p_lease_token: recoveryClaim.lease_token,
              p_code: 'commit_failed',
              p_quarantine: true,
            }
          );

          expect(quarantineRecovery.error === null).toBe(true);
          expect(quarantineRecovery.data).toBe('quarantined');

          const auditSchema = z.object({
            id: z.uuid(),
            status: z.string(),
            attempts: z.number(),
            last_error: z.string().nullable(),
            lease_token: z.string().nullable(),
            operator_request_id: z.string().nullable(),
            operator_requested_at: z.string().nullable(),
            operator_actor_id: z.string().nullable(),
            operator_previous_attempts: z.number().nullable(),
            operator_previous_error: z.string().nullable(),
          });

          const readRecoveryAudit = async (jobId = recoveryJobId) => {
            const result = await db
              .from('coexistence_jobs')
              .select(
                'id,status,attempts,last_error,lease_token,operator_request_id,operator_requested_at,operator_actor_id,operator_previous_attempts,operator_previous_error'
              )
              .eq('id', jobId)
              .single();

            expect(result.error === null).toBe(true);

            return auditSchema.parse(result.data);
          };

          const quarantinedAudit = await readRecoveryAudit();

          expect(quarantinedAudit).toMatchObject({
            status: 'quarantined',
            attempts: 1,
            last_error: 'commit_failed',
            operator_request_id: null,
          });
          expect((await inventory('jobs')).items).toContainEqual(
            expect.objectContaining({
              id: recoveryJobId,
              state: 'quarantined',
              reason: 'commit_failed',
              retry_eligible: true,
            })
          );
          expect(await quietUpdateSnapshot()).toEqual(beforeRecovery);
          const foreignInventory = await inventory('jobs', outsider);

          expect(
            foreignInventory.items.some((item) => item.id === recoveryJobId)
          ).toBe(false);

          const foreignRetry = await operatorRetry(
            retryRequest(),
            recoveryJobId,
            outsider
          );

          const missingRetry = await operatorRetry(
            retryRequest(),
            randomUUID(),
            owner
          );

          expect(foreignRetry.status).toBe(409);
          expect(missingRetry.status).toBe(409);
          expect(await foreignRetry.text()).toBe(await missingRetry.text());
          expect(
            (
              await operatorRetry(
                retryRequest(retryRequestId, 'https://foreign.example.invalid'),
                recoveryJobId,
                owner
              )
            ).status
          ).toBe(403);
          expect(
            (
              await operatorRetry(
                retryRequest(retryRequestId, operatorOrigin, 'text/plain'),
                recoveryJobId,
                owner
              )
            ).status
          ).toBe(400);
          expect(
            (
              await operatorInventory(
                new Request(
                  `${operatorOrigin}/api/whatsapp/coexistence/operator`
                ),
                teammate
              )
            ).status
          ).toBe(403);
          expect(
            (await operatorRetry(retryRequest(), recoveryJobId, teammate))
              .status
          ).toBe(403);
          const adminUser = await teammate.auth.getUser();

          expect(adminUser.error === null).toBe(true);
          const adminUserId = uuidSchema.parse(adminUser.data.user).id;

          const setOperatorRole = async (role: string) => {
            const result = await db
              .from('profiles')
              .update({ account_role: role })
              .eq('user_id', adminUserId);

            expect(result.error === null).toBe(true);
          };

          await setOperatorRole('admin');
          expect(
            (await inventory('jobs', teammate)).items.some(
              (item) => item.id === recoveryJobId
            )
          ).toBe(true);
          await setOperatorRole('agent');
          expect(
            (await operatorRetry(retryRequest(), recoveryJobId, teammate))
              .status
          ).toBe(403);
          await setOperatorRole('admin');
          vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'false');

          try {
            const disabledInventory = await inventory('jobs');

            expect(disabledInventory.enabled).toBe(false);
            expect(disabledInventory.items).toContainEqual(
              expect.objectContaining({
                id: recoveryJobId,
                retry_eligible: false,
              })
            );
            expect(
              (await operatorRetry(retryRequest(), recoveryJobId, owner)).status
            ).toBe(409);
          } finally {
            vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
          }

          expect(await readRecoveryAudit()).toEqual(quarantinedAudit);

          const queuedRecovery = await operatorRetry(
            retryRequest(),
            recoveryJobId,
            teammate
          );

          expect(queuedRecovery.status).toBe(202);
          const queuedRecoveryRaw = await queuedRecovery.text();
          assertOperatorRedaction(queuedRecoveryRaw);

          const queuedRecoveryBody = operatorQueuedSchema.parse(
            JSON.parse(queuedRecoveryRaw)
          );

          const pendingAudit = await readRecoveryAudit();

          expect(pendingAudit).toMatchObject({
            status: 'pending',
            attempts: 0,
            last_error: null,
            lease_token: null,
            operator_request_id: retryRequestId,
            operator_actor_id: adminUserId,
            operator_previous_attempts: 1,
            operator_previous_error: 'commit_failed',
            operator_requested_at: queuedRecoveryBody.requested_at,
          });

          const staleLease = await freshWorker().rpc('coexistence_commit', {
            p_job_id: recoveryJobId,
            p_lease_token: recoveryClaim.lease_token,
            p_operations: [],
          });

          expect(staleLease.error === null).toBe(true);
          expect(staleLease.data).toBe('stale');
          expect(await quietUpdateSnapshot()).toEqual(beforeRecovery);
          let recoveryChannel: RealtimeChannel | undefined;
          let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
          const recoveredRealtime = Promise.withResolvers<string>();

          try {
            if (process.env.COEXISTENCE_INTEGRATION_REALTIME === '1') {
              recoveryChannel = owner
                .channel(`coexistence-operator-recovery-${runId}`, {
                  config: {
                    postgres_changes_options: { wait: true, timeout: 8000 },
                  },
                })
                .on(
                  'postgres_changes',
                  {
                    event: 'INSERT',
                    schema: 'public',
                    table: 'messages',
                    filter: `conversation_id=eq.${conversationId}`,
                  },
                  (event) => {
                    const row = z
                      .object({ id: z.uuid(), message_id: z.string() })
                      .safeParse(event.new);

                    if (row.success && row.data.message_id === recoveredWamid)
                      recoveredRealtime.resolve(row.data.id);
                  }
                );
              await subscribe(recoveryChannel);
            }

            expect(await drainCoexistenceJobs(freshWorker())).toEqual({
              completed: 1,
              retried: 0,
              quarantined: 0,
              stale: 0,
            });

            const recoveredMessage = await owner
              .from('messages')
              .select('id,message_source,content_text')
              .eq('conversation_id', conversationId)
              .eq('message_id', recoveredWamid)
              .single();

            expect(recoveredMessage.error === null).toBe(true);
            const recoveredId = uuidSchema.parse(recoveredMessage.data).id;
            updateParentIds.push(recoveredId);

            expect(recoveredMessage.data).toMatchObject({
              message_source: 'cloud_api',
              content_text: recoveryText,
            });

            if (recoveryChannel) {
              expect(
                await Promise.race([
                  recoveredRealtime.promise,
                  new Promise<never>((_resolve, reject) => {
                    recoveryTimer = setTimeout(
                      () =>
                        reject(
                          new Error(
                            'Authenticated operator recovery INSERT was not delivered'
                          )
                        ),
                      10_000
                    );
                  }),
                ])
              ).toBe(recoveredId);
            }

            const afterRecovery = await quietUpdateSnapshot();

            expect(afterRecovery.counts[2]).toBe(
              z.number().parse(beforeRecovery.counts[2]) + 1
            );
            expect(afterRecovery.counts[3]).toBe(
              z.number().parse(beforeRecovery.counts[3]) + 1
            );
            expect(afterRecovery.conversation).toMatchObject({
              unread_count:
                z
                  .object({ unread_count: z.number() })
                  .parse(beforeRecovery.conversation).unread_count + 1,
            });
            const completedAudit = await readRecoveryAudit();

            const effectIntents = await db
              .from('coexistence_live_effects')
              .select('message_id,state')
              .eq('message_id', recoveredId);

            expect(effectIntents.error === null).toBe(true);
            expect(effectIntents.data).toEqual([
              { message_id: recoveredId, state: 'pending' },
            ]);
            expect(completedAudit).toMatchObject({
              status: 'completed',
              attempts: 1,
              operator_request_id: retryRequestId,
              operator_requested_at: queuedRecoveryBody.requested_at,
              operator_actor_id: adminUserId,
              operator_previous_attempts: 1,
              operator_previous_error: 'commit_failed',
            });

            const repeatedRecovery = await operatorRetry(
              retryRequest(),
              recoveryJobId,
              teammate
            );

            expect(repeatedRecovery.status).toBe(202);
            expect(await repeatedRecovery.json()).toEqual(queuedRecoveryBody);
            expect(
              (
                await operatorRetry(
                  retryRequest(randomUUID()),
                  recoveryJobId,
                  owner
                )
              ).status
            ).toBe(409);
            expect((await send(recoveryBody)).status).toBe(200);
            expect(await drainCoexistenceJobs(freshWorker())).toEqual({
              completed: 0,
              retried: 0,
              quarantined: 0,
              stale: 0,
            });
            expect(await readRecoveryAudit()).toEqual(completedAudit);
            expect(await quietUpdateSnapshot()).toEqual(afterRecovery);

            const duplicateEffects = await db
              .from('coexistence_live_effects')
              .select('message_id,state')
              .eq('message_id', recoveredId);

            expect(duplicateEffects.error === null).toBe(true);
            expect(duplicateEffects.data).toEqual(effectIntents.data);
          } finally {
            clearTimeout(recoveryTimer);

            if (recoveryChannel) await owner.removeChannel(recoveryChannel);
          }

          // Unsupported input remains private/quarantined even if its transient error vocabulary is retryable.
          const unsupportedBody = envelope([
            {
              field: 'messages',
              value: {
                metadata,
                messages: [
                  {
                    from: customer,
                    id: unsupportedWamid,
                    timestamp: `${Math.floor(Date.now() / 1000)}`,
                    type: 'unsupported',
                  },
                ],
              },
            },
          ]);

          expect((await send(unsupportedBody)).status).toBe(200);
          expect((await drainCoexistenceJobs(freshWorker())).quarantined).toBe(
            1
          );

          const unsupportedJob = await db
            .from('coexistence_jobs')
            .select('id')
            .eq('config_id', configId)
            .contains('payload', {
              deliveries: [
                {
                  field: 'messages',
                  value: { messages: [{ id: unsupportedWamid }] },
                },
              ],
            })
            .single();

          expect(unsupportedJob.error === null).toBe(true);
          const unsupportedJobId = uuidSchema.parse(unsupportedJob.data).id;
          const unsupportedAudit = await readRecoveryAudit(unsupportedJobId);

          expect(
            (
              await operatorRetry(
                retryRequest(randomUUID()),
                unsupportedJobId,
                owner
              )
            ).status
          ).toBe(409);
          expect(await readRecoveryAudit(unsupportedJobId)).toEqual(
            unsupportedAudit
          );
          expect(unsupportedAudit).toMatchObject({
            status: 'quarantined',
            operator_request_id: null,
          });
          const ambiguousStatusRows = await statusEventsFor(parentId);

          expect(ambiguousStatusRows).toHaveLength(1);
          const ambiguousStatusId = ambiguousStatusRows[0].id;

          const ambiguousStatus = await db
            .from('coexistence_status_events')
            .update({
              state: 'ambiguous',
              last_error: 'execution_uncertain',
              lease_token: null,
              lease_until: null,
            })
            .eq('id', ambiguousStatusId);

          expect(ambiguousStatus.error === null).toBe(true);
          const effectInventory = await inventory('effects');
          const statusInventory = await inventory('status_events');
          const updateInventory = await inventory('updates');

          expect(effectInventory.items).toContainEqual(
            expect.objectContaining({
              id: uncertain.id,
              state: 'ambiguous',
              retry_eligible: false,
            })
          );
          expect(statusInventory.items).toContainEqual(
            expect.objectContaining({
              id: ambiguousStatusId,
              state: 'ambiguous',
              retry_eligible: false,
            })
          );
          expect(
            [
              ...effectInventory.items,
              ...statusInventory.items,
              ...updateInventory.items,
            ].every((item) => !item.retry_eligible)
          ).toBe(true);

          for (const actionId of [uncertain.id, ambiguousStatusId]) {
            expect(
              (await operatorRetry(retryRequest(randomUUID()), actionId, owner))
                .status
            ).toBe(409);
          }

          expect((await readEffect(uncertain.id)).state).toBe('ambiguous');

          const statusAfterOperator = await db
            .from('coexistence_status_events')
            .select('state')
            .eq('id', ambiguousStatusId)
            .single();

          expect(statusAfterOperator.error === null).toBe(true);
          expect(statusAfterOperator.data).toEqual({ state: 'ambiguous' });

          for (const client of [owner, teammate, outsider]) {
            const directInspect = await client.rpc(
              'coexistence_operator_inspect',
              {
                p_actor_id: users[0],
                p_account_id: accounts[0],
                p_job_id: recoveryJobId,
                p_app_id: appId,
                p_request_id: retryRequestId,
              }
            );

            expect(directInspect.error?.code).toBe('42501');
          }

          expect(
            await Promise.all(
              ['automation_logs', 'flow_runs'].map(async (table) => {
                const result = await db
                  .from(table)
                  .select('id', { head: true, count: 'exact' })
                  .eq('account_id', accounts[0]);

                expect(result.error === null).toBe(true);

                return result.count;
              })
            )
          ).toEqual(engineRowsBefore);

          // SQL073 is a shared local-mode protocol: authorize before any dispatch, then retry only DB receipts.
          const {
            ConnectionOperation,
            connectionAccountStatus,
            connectionServiceClient,
          } = await import('../connection-operation');

          const gateService = connectionServiceClient();
          const gatePassword = randomBytes(32).toString('hex');
          const gateEmail = `coexistence-integration-${randomUUID()}@example.invalid`;

          const gateUser = await db.auth.admin.createUser({
            email: gateEmail,
            password: gatePassword,
            email_confirm: true,
          });

          expect(gateUser.error === null).toBe(true);

          if (!gateUser.data.user)
            throw new Error('Temporary connection-gate owner was not created');
          const gateUserId = gateUser.data.user.id;
          users.push(gateUserId);

          const gateAccount = await db
            .from('accounts')
            .select('id,connection_revision')
            .eq('owner_user_id', gateUserId)
            .single();

          expect(gateAccount.error === null).toBe(true);

          const gateAccountRow = z
            .object({ id: z.uuid(), connection_revision: z.uuid() })
            .parse(gateAccount.data);

          const gateAccountId = gateAccountRow.id;
          accounts.push(gateAccountId);
          expect(
            (
              await gateOwner.auth.signInWithPassword({
                email: gateEmail,
                password: gatePassword,
              })
            ).error === null
          ).toBe(true);

          for (const [userId, role] of [
            [adminUserId, 'admin'],
            [users[1], 'viewer'],
          ]) {
            const moved = await db
              .from('profiles')
              .update({ account_id: gateAccountId, account_role: role })
              .eq('user_id', userId);

            expect(moved.error === null).toBe(true);
          }

          const gateRpc = async (
            name: string,
            args: Record<string, string | boolean | null>
          ) => {
            const result = await gateService.rpc(name, args).retry(false);

            expect(
              result.error === null,
              'Connection protocol RPC must not fail transport'
            ).toBe(true);

            return z.record(z.string(), z.unknown()).parse(result.data);
          };

          const reservationSchema = z.object({
            status: z.literal('acquired'),
            operation_id: z.uuid(),
            token: z.uuid(),
          });

          const gateIntent = {
            p_actor_id: gateUserId,
            p_account_id: gateAccountId,
            p_request_id: randomUUID(),
            p_kind: 'manual_save',
            p_expected_revision: gateAccountRow.connection_revision,
            p_expected_config_id: null,
            p_expected_generation: null,
            p_phone_number_id: `${fixture}11`,
            p_waba_id: `${fixture}12`,
            p_register: true,
            p_subscribe: true,
          };

          vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'false');

          try {
            expect(
              await connectionAccountStatus(
                gateService,
                gateUserId,
                gateAccountId
              )
            ).toBe('idle');
            expect(
              await connectionAccountStatus(
                gateService,
                users[1],
                gateAccountId
              )
            ).toBe('idle');
            expect(
              await gateRpc('connection_operation_account_status', {
                p_actor_id: users[0],
                p_account_id: gateAccountId,
              })
            ).toEqual({ status: 'forbidden' });
            expect(
              await gateRpc('connection_operation_acquire', {
                ...gateIntent,
                p_request_id: randomUUID(),
                p_waba_id: wabaId,
              })
            ).toEqual({ status: 'conflict' });
            expect(
              await gateRpc('connection_operation_acquire', {
                ...gateIntent,
                p_actor_id: users[0],
              })
            ).toEqual({ status: 'forbidden' });
            expect(
              await gateRpc('connection_operation_acquire', {
                ...gateIntent,
                p_actor_id: users[1],
              })
            ).toEqual({ status: 'forbidden' });

            for (const client of [gateOwner, teammate, outsider]) {
              const bypass = await client.rpc(
                'connection_operation_acquire',
                gateIntent
              );

              const privateOperations = await client
                .from('connection_operations')
                .select('id');

              expect(bypass.error?.code).toBe('42501');
              expect(privateOperations.error?.code).toBe('42501');
            }

            const directInsert = await gateOwner
              .from('whatsapp_config')
              .insert({
                user_id: gateUserId,
                account_id: gateAccountId,
                phone_number_id: `${fixture}11`,
                access_token: encrypt('fixture-not-provider-token'),
              });

            const serviceInsert = await gateService
              .from('whatsapp_config')
              .insert({
                user_id: gateUserId,
                account_id: gateAccountId,
                phone_number_id: `${fixture}11`,
                access_token: encrypt('fixture-not-provider-token'),
              });

            const directDelete = await gateOwner
              .from('whatsapp_config')
              .delete()
              .eq('account_id', gateAccountId);

            expect(directInsert.error?.code).toBe('42501');
            expect(serviceInsert.error?.code).toBe('42501');
            expect(directDelete.error?.code).toBe('42501');

            const adminIntent = {
              ...gateIntent,
              p_actor_id: adminUserId,
              p_request_id: randomUUID(),
              p_register: false,
              p_subscribe: false,
            };

            const adminReservation = reservationSchema.parse(
              await gateRpc('connection_operation_acquire', adminIntent)
            );

            gateOperationIds.push(adminReservation.operation_id);

            const adminTransition = {
              p_actor_id: adminUserId,
              p_operation_id: adminReservation.operation_id,
              p_token: adminReservation.token,
            };

            expect(
              await connectionAccountStatus(
                gateService,
                gateUserId,
                gateAccountId
              )
            ).toBe('busy');
            expect(
              await gateRpc('connection_operation_account_status', {
                p_actor_id: users[1],
                p_account_id: gateAccountId,
              })
            ).toEqual({ status: 'busy' });

            const noConfigDelete = await db
              .from('accounts')
              .delete()
              .eq('id', gateAccountId);

            expect(noConfigDelete.error?.code).toBe('23503');

            const demotedAdmin = await db
              .from('profiles')
              .update({ account_role: 'viewer' })
              .eq('user_id', adminUserId);

            expect(demotedAdmin.error === null).toBe(true);
            expect(
              await gateRpc('connection_operation_start_step', {
                ...adminTransition,
                p_step: 'register',
              })
            ).toEqual({ status: 'forbidden' });
            expect(
              await gateRpc(
                'connection_operation_cancel_unstarted',
                adminTransition
              )
            ).toEqual({ status: 'forbidden' });

            const restoredAdmin = await db
              .from('profiles')
              .update({ account_role: 'admin' })
              .eq('user_id', adminUserId);

            expect(restoredAdmin.error === null).toBe(true);
            expect(
              await gateRpc(
                'connection_operation_cancel_unstarted',
                adminTransition
              )
            ).toEqual({ status: 'cancelled' });

            const operation = await ConnectionOperation.acquire(gateService, {
              ...gateIntent,
              p_kind: 'manual_save',
            });

            const acquired = reservationSchema.parse(
              await gateRpc('connection_operation_acquire', gateIntent)
            );

            gateOperationIds.push(acquired.operation_id);

            const transition = {
              p_actor_id: gateUserId,
              p_operation_id: acquired.operation_id,
              p_token: acquired.token,
            };

            expect(
              await gateRpc('connection_operation_acquire', gateIntent)
            ).toMatchObject({
              operation_id: acquired.operation_id,
              token: acquired.token,
            });
            let simulatedConnectionDispatches = 0;
            await operation.start('register');
            simulatedConnectionDispatches++;
            await expect(operation.start('register')).rejects.toThrow(
              'connection_blocked'
            );
            expect(
              await gateRpc('connection_operation_start_step', {
                ...transition,
                p_step: 'register',
              })
            ).toMatchObject({ status: 'duplicate', dispatch: false });
            expect(simulatedConnectionDispatches).toBe(1);
            await operation.record('register', 'rejected');
            await operation.start('subscribe');
            simulatedConnectionDispatches++;
            await operation.record('subscribe', 'success');

            const gateConfig = {
              access_token: encrypt('gate-local-not-provider-token'),
              verify_token: null,
              connected_at: null,
              registered_at: null,
              subscribed_apps_at: new Date().toISOString(),
            };

            const finishCallsBefore = gateFinishCalls;
            loseGateFinishAck = true;
            const saved = await operation.finish(gateConfig);

            expect(gateFinishCalls - finishCallsBefore).toBe(2);
            expect(saved).toMatchObject({
              status: 'completed',
              saved: true,
              registered: false,
              registration_rejected: true,
            });
            expect(await operation.finish(gateConfig)).toEqual(saved);
            expect(simulatedConnectionDispatches).toBe(2);

            const savedConfig = await gateOwner
              .from('whatsapp_config')
              .select(
                'id,status,coexistence_generation,last_registration_error'
              )
              .eq('account_id', gateAccountId)
              .single();

            expect(savedConfig.error === null).toBe(true);
            expect(savedConfig.data).toMatchObject({
              id: saved.config_id,
              status: 'disconnected',
              last_registration_error: 'registration_rejected',
            });

            const savedSnapshot = z
              .object({ id: z.uuid(), coexistence_generation: z.uuid() })
              .parse(savedConfig.data);

            const revisionAfterReplay = await gateOwner
              .from('accounts')
              .select('connection_revision')
              .eq('id', gateAccountId)
              .single();

            expect(revisionAfterReplay.error === null).toBe(true);
            expect(revisionAfterReplay.data).toEqual({
              connection_revision: saved.revision,
            });

            const forbiddenControl = await gateOwner
              .from('whatsapp_config')
              .update({ status: 'connected' })
              .eq('id', savedSnapshot.id);

            const forbiddenServiceControl = await gateService
              .from('whatsapp_config')
              .update({ status: 'connected' })
              .eq('id', savedSnapshot.id);

            const forbiddenRevision = await gateService
              .from('accounts')
              .update({ connection_revision: randomUUID() })
              .eq('id', gateAccountId);

            const mirrorOnly = await gateOwner
              .from('whatsapp_config')
              .update({ mirror_inbound_media: true })
              .eq('id', savedSnapshot.id)
              .select('mirror_inbound_media')
              .single();

            expect(forbiddenControl.error?.code).toBe('42501');
            expect(forbiddenServiceControl.error?.code).toBe('42501');
            expect(forbiddenRevision.error?.code).toBe('42501');
            expect(mirrorOnly.error === null).toBe(true);
            expect(mirrorOnly.data).toEqual({ mirror_inbound_media: true });

            expect(storageRequests).toBe(0);

            const ordinaryConnection = await ConnectionOperation.acquire(
              gateService,
              {
                ...gateIntent,
                p_kind: 'manual_save',
                p_request_id: randomUUID(),
                p_expected_revision: saved.revision,
                p_expected_config_id: savedSnapshot.id,
                p_expected_generation: savedSnapshot.coexistence_generation,
                p_register: false,
                p_subscribe: false,
              }
            );

            const ordinaryReceipt = await ordinaryConnection.finish({
              ...gateConfig,
              connected_at: new Date().toISOString(),
              subscribed_apps_at: null,
            });

            const ordinaryConfig = await gateOwner
              .from('whatsapp_config')
              .select('id,status,coexistence_generation')
              .eq('account_id', gateAccountId)
              .single();

            expect(ordinaryConfig.error === null).toBe(true);
            expect(ordinaryConfig.data).toMatchObject({ status: 'connected' });

            const ordinarySnapshot = z
              .object({ id: z.uuid(), coexistence_generation: z.uuid() })
              .parse(ordinaryConfig.data);

            const originalPublicationProof = {
              connection_config_id: ordinarySnapshot.id,
              connection_generation: ordinarySnapshot.coexistence_generation,
            };

            const ordinaryMediaId = BigInt(
              `0x${randomBytes(12).toString('hex')}`
            ).toString();

            const ordinaryInbound = `account-${gateAccountId}/inbound/${ordinaryMediaId}-image.png`;
            const blockedInbound = `account-${gateAccountId}/inbound/${ordinaryMediaId}-image2.png`;
            const missingProofInbound = `account-${gateAccountId}/inbound/${ordinaryMediaId}-image3.png`;
            const ordinaryOutbound = `account-${gateAccountId}/outbound/${randomUUID()}.png`;
            storagePaths.push(
              ordinaryInbound,
              blockedInbound,
              missingProofInbound,
              ordinaryOutbound
            );

            // Two valid 1x1 PNGs with different pixel data and CRCs; no image dependency or remote media.
            const originalPng = Buffer.from(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
              'base64'
            );

            const replacementPng = Buffer.from(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP4/x8AAwAB/2+Bq7YAAAAASUVORK5CYII=',
              'base64'
            );

            const storage = gateService.storage.from('chat-media');

            const initialUpload = await storage.upload(
              ordinaryInbound,
              originalPng,
              {
                contentType: 'image/png',
                upsert: true,
                metadata: originalPublicationProof,
              }
            );

            expect(initialUpload.error === null).toBe(true);

            const readOrdinaryBytes = async () => {
              const publicUrl = new URL(
                storage.getPublicUrl(ordinaryInbound).data.publicUrl
              );

              expect(publicUrl.origin).toBe(url.origin);
              expect(publicUrl.pathname).toContain(
                `/storage/v1/object/public/chat-media/account-${gateAccountId}/inbound/`
              );

              const response = await globalThis.fetch(publicUrl, {
                cache: 'no-store',
              });

              expect(response.status).toBe(200);

              return Buffer.from(await response.arrayBuffer());
            };

            expect(await readOrdinaryBytes()).toEqual(originalPng);

            const publicationIntent = {
              ...gateIntent,
              p_request_id: randomUUID(),
              p_kind: 'onboarding',
              p_expected_revision: ordinaryReceipt.revision,
              p_expected_config_id: ordinarySnapshot.id,
              p_expected_generation: ordinarySnapshot.coexistence_generation,
              p_register: false,
              p_subscribe: false,
            };

            const publicationReservation = reservationSchema.parse(
              await gateRpc('connection_operation_acquire', publicationIntent)
            );

            gateOperationIds.push(publicationReservation.operation_id);

            const blockedUpload = await storage.upload(
              blockedInbound,
              replacementPng,
              {
                contentType: 'image/png',
                upsert: false,
                metadata: originalPublicationProof,
              }
            );

            const blockedUpsert = await storage.upload(
              ordinaryInbound,
              replacementPng,
              {
                contentType: 'image/png',
                upsert: true,
                metadata: originalPublicationProof,
              }
            );

            expect(blockedUpload.error !== null).toBe(true);
            expect(blockedUpsert.error !== null).toBe(true);
            // Pinned Storage publishes metadata after staging a fresh version; the existing public object stays intact.
            expect(await readOrdinaryBytes()).toEqual(originalPng);

            const outboundUpload = await storage.upload(
              ordinaryOutbound,
              replacementPng,
              { contentType: 'image/png', upsert: false }
            );

            expect(outboundUpload.error === null).toBe(true);
            expect(
              await gateRpc('connection_operation_cancel_unstarted', {
                p_actor_id: gateUserId,
                p_operation_id: publicationReservation.operation_id,
                p_token: publicationReservation.token,
              })
            ).toEqual({ status: 'cancelled' });

            const resumedUpsert = await storage.upload(
              ordinaryInbound,
              replacementPng,
              {
                contentType: 'image/png',
                upsert: true,
                metadata: originalPublicationProof,
              }
            );

            const resumedUpload = await storage.upload(
              blockedInbound,
              replacementPng,
              {
                contentType: 'image/png',
                upsert: false,
                metadata: originalPublicationProof,
              }
            );

            expect(resumedUpsert.error === null).toBe(true);
            expect(resumedUpload.error === null).toBe(true);
            expect(await readOrdinaryBytes()).toEqual(replacementPng);

            const missingOriginUpload = await storage.upload(
              missingProofInbound,
              originalPng,
              { contentType: 'image/png', upsert: false }
            );

            expect(missingOriginUpload.error !== null).toBe(true);

            // Simulate a completed ordinary connection change after the old download started; no live reservation remains.
            const rotatedStorageToken = encrypt(
              'ordinary-storage-generation-two-not-a-provider-token'
            ).replaceAll("'", "''");

            fixtureSql(
              `UPDATE public.whatsapp_config SET access_token='${rotatedStorageToken}' WHERE id='${z.uuid().parse(ordinarySnapshot.id)}' AND account_id='${gateAccountId}'`
            );

            const freshStorageConfig = await gateOwner
              .from('whatsapp_config')
              .select('id,status,coexistence_generation')
              .eq('id', ordinarySnapshot.id)
              .eq('account_id', gateAccountId)
              .single();

            expect(freshStorageConfig.error === null).toBe(true);
            expect(freshStorageConfig.data).toMatchObject({
              status: 'connected',
            });

            const freshStorageSnapshot = z
              .object({ id: z.uuid(), coexistence_generation: z.uuid() })
              .parse(freshStorageConfig.data);

            expect(freshStorageSnapshot.coexistence_generation).not.toBe(
              ordinarySnapshot.coexistence_generation
            );
            expect(
              await connectionAccountStatus(
                gateService,
                gateUserId,
                gateAccountId
              )
            ).toBe('idle');

            const staleOriginUpload = await storage.upload(
              ordinaryInbound,
              originalPng,
              {
                contentType: 'image/png',
                upsert: true,
                metadata: originalPublicationProof,
              }
            );

            expect(staleOriginUpload.error !== null).toBe(true);
            expect(await readOrdinaryBytes()).toEqual(replacementPng);

            const freshOriginUpload = await storage.upload(
              ordinaryInbound,
              originalPng,
              {
                contentType: 'image/png',
                upsert: true,
                metadata: {
                  connection_config_id: freshStorageSnapshot.id,
                  connection_generation:
                    freshStorageSnapshot.coexistence_generation,
                },
              }
            );

            // OLD object metadata still identifies generation one; only the NEW publication proof may authorize overwrite.
            expect(freshOriginUpload.error === null).toBe(true);
            expect(await readOrdinaryBytes()).toEqual(originalPng);

            const deletion = await ConnectionOperation.acquire(gateService, {
              ...gateIntent,
              p_kind: 'manual_delete',
              p_request_id: randomUUID(),
              p_expected_revision: ordinaryReceipt.revision,
              p_expected_config_id: freshStorageSnapshot.id,
              p_expected_generation:
                freshStorageSnapshot.coexistence_generation,
              p_phone_number_id: null,
              p_waba_id: null,
              p_register: false,
              p_subscribe: false,
            });

            const deleted = await deletion.finish(null);

            expect(deleted).toMatchObject({ saved: false, config_id: null });
            expect(deleted.revision).not.toBe(ordinaryReceipt.revision);

            const absentAfterDelete = await gateOwner
              .from('whatsapp_config')
              .select('id')
              .eq('account_id', gateAccountId);

            const revisionAfterDelete = await gateOwner
              .from('accounts')
              .select('connection_revision')
              .eq('id', gateAccountId)
              .single();

            expect(absentAfterDelete.error === null).toBe(true);
            expect(absentAfterDelete.data).toEqual([]);
            expect(revisionAfterDelete.error === null).toBe(true);
            expect(revisionAfterDelete.data).toEqual({
              connection_revision: deleted.revision,
            });

            const onboardingIntent = {
              ...gateIntent,
              p_kind: 'onboarding',
              p_expected_revision: deleted.revision,
              p_request_id: randomUUID(),
              p_register: false,
              p_subscribe: false,
            };

            expect(
              await gateRpc('connection_operation_acquire', {
                ...onboardingIntent,
                p_actor_id: adminUserId,
              })
            ).toEqual({ status: 'forbidden' });

            const onboarding = reservationSchema.parse(
              await gateRpc('connection_operation_acquire', onboardingIntent)
            );

            gateOperationIds.push(onboarding.operation_id);

            const onboardingTransition = {
              p_actor_id: gateUserId,
              p_operation_id: onboarding.operation_id,
              p_token: onboarding.token,
            };

            expect(
              await gateRpc('connection_operation_start_step', {
                ...onboardingTransition,
                p_step: 'register',
              })
            ).toEqual({ status: 'unsupported' });
            expect(
              await gateRpc(
                'connection_operation_cancel_unstarted',
                onboardingTransition
              )
            ).toEqual({ status: 'cancelled' });

            const unknownIntent = {
              ...gateIntent,
              p_request_id: randomUUID(),
              p_expected_revision: deleted.revision,
            };

            const unknownOperation = await ConnectionOperation.acquire(
              gateService,
              { ...unknownIntent, p_kind: 'manual_save' }
            );

            const unknownReservation = reservationSchema.parse(
              await gateRpc('connection_operation_acquire', unknownIntent)
            );

            gateOperationIds.push(unknownReservation.operation_id);

            const unknownTransition = {
              p_actor_id: gateUserId,
              p_operation_id: unknownReservation.operation_id,
              p_token: unknownReservation.token,
            };

            await unknownOperation.start('register');
            simulatedConnectionDispatches++;
            await unknownOperation.record('register', 'unknown');
            fixtureSql(
              `UPDATE public.connection_operations SET lease_until='2000-01-01T00:00:00Z' WHERE id='${z.uuid().parse(unknownReservation.operation_id)}' AND original_account_id='${gateAccountId}'`
            );
            expect(
              await connectionAccountStatus(
                gateService,
                gateUserId,
                gateAccountId
              )
            ).toBe('blocked');
            expect(
              await gateRpc(
                'connection_operation_cancel_unstarted',
                unknownTransition
              )
            ).toEqual({ status: 'blocked' });
            expect(
              await gateRpc('connection_operation_acquire', {
                ...unknownIntent,
                p_request_id: randomUUID(),
              })
            ).toEqual({ status: 'blocked' });
            await expect(unknownOperation.start('subscribe')).rejects.toThrow();
            expect(
              Number(
                fixtureSql(
                  `SELECT count(*) FROM public.connection_operation_resources WHERE operation_id='${z.uuid().parse(unknownReservation.operation_id)}'`
                )
              )
            ).toBe(2);

            const blockedDelete = await db
              .from('accounts')
              .delete()
              .eq('id', gateAccountId);

            expect(blockedDelete.error?.code).toBe('23503');
            await expect(unknownOperation.finish(gateConfig)).rejects.toThrow(
              'connection_blocked'
            );
            expect(simulatedConnectionDispatches).toBe(3);
          } finally {
            loseGateFinishAck = false;
            vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
          }

          // Supervised signup is a held, session-bound local protocol; public launch stays unavailable.
          const { signupProtocol, signupStatus, signupPost } =
            await import('./signup');

          const {
            signupStatusSchema,
            signupPrepareSchema,
            signupActionSchema,
          } = await import('./signup-contract');

          const signupRequestBodySchema = z.union([
            signupPrepareSchema,
            signupActionSchema,
          ]);

          type SignupRequestBody = z.input<typeof signupRequestBodySchema>;

          const { decrypt } = await import('../encryption');
          const signupLoginId = `${fixture}31`;
          vi.stubEnv('WHATSAPP_COEXISTENCE_LOGIN_CONFIG_ID', signupLoginId);
          simulateSignup = true;

          const signupFixtures: Array<{
            client: typeof signupOwner;
            actorId: string;
            accountId: string;
            sessionId: string;
            configId: string;
            generation: string;
            revision: string;
            phoneId: string;
            wabaId: string;
          }> = [];

          const claimsSchema = z.object({
            sub: z.uuid(),
            session_id: z.uuid(),
          });

          for (const { client, phoneSuffix, wabaSuffix } of [
            { client: signupOwner, phoneSuffix: '21', wabaSuffix: '22' },
            { client: signupSecondOwner, phoneSuffix: '23', wabaSuffix: '24' },
          ]) {
            const email = `coexistence-integration-${randomUUID()}@example.invalid`;
            const password = randomBytes(32).toString('hex');

            const created = await db.auth.admin.createUser({
              email,
              password,
              email_confirm: true,
            });

            expect(created.error === null).toBe(true);

            if (!created.data.user)
              throw new Error('Temporary signup owner was not created');
            const actorId = created.data.user.id;
            users.push(actorId);

            const account = await db
              .from('accounts')
              .select('id,connection_revision')
              .eq('owner_user_id', actorId)
              .single();

            expect(account.error === null).toBe(true);

            const accountRow = z
              .object({ id: z.uuid(), connection_revision: z.uuid() })
              .parse(account.data);

            accounts.push(accountRow.id);
            expect(
              (await client.auth.signInWithPassword({ email, password }))
                .error === null
            ).toBe(true);
            const claims = await client.auth.getClaims();

            expect(claims.error === null).toBe(true);
            const identity = claimsSchema.parse(claims.data?.claims);

            expect(identity.sub).toBe(actorId);

            if (client === signupOwner)
              expect(
                (
                  await signupOtherSession.auth.signInWithPassword({
                    email,
                    password,
                  })
                ).error === null
              ).toBe(true);

            const connection = await ConnectionOperation.acquire(gateService, {
              p_actor_id: actorId,
              p_account_id: accountRow.id,
              p_request_id: randomUUID(),
              p_kind: 'manual_save',
              p_expected_revision: accountRow.connection_revision,
              p_expected_config_id: null,
              p_expected_generation: null,
              p_phone_number_id: `${fixture}${phoneSuffix}`,
              p_waba_id: `${fixture}${wabaSuffix}`,
              p_register: false,
              p_subscribe: false,
            });

            const receipt = await connection.finish({
              access_token: encrypt('signup-ordinary-stub-token'),
              verify_token: null,
              connected_at: new Date().toISOString(),
              registered_at: null,
              subscribed_apps_at: null,
            });

            const config = await client
              .from('whatsapp_config')
              .select('id,coexistence_generation')
              .eq('account_id', accountRow.id)
              .single();

            expect(config.error === null).toBe(true);

            const configRow = z
              .object({ id: z.uuid(), coexistence_generation: z.uuid() })
              .parse(config.data);

            lifecycleConfigIds.push(configRow.id);
            signupFixtures.push({
              client,
              actorId,
              accountId: accountRow.id,
              sessionId: identity.session_id,
              configId: configRow.id,
              generation: configRow.coexistence_generation,
              revision: receipt.revision,
              phoneId: `${fixture}${phoneSuffix}`,
              wabaId: `${fixture}${wabaSuffix}`,
            });
          }

          const [signupA, signupB] = signupFixtures;
          const stagedWaba = `${fixture}41`;
          const stagedPhone = `${fixture}42`;

          const stagedWamids = ['live', 'history', 'echo', 'unknown'].map(
            (kind) => `wamid.integration.staged.${kind}.${runId}`
          );

          effectMessageIds.push(...stagedWamids);
          const stagedText = `Unassigned private customer text ${runId}`;

          const stageBody = JSON.stringify({
            object: 'whatsapp_business_account',
            entry: [
              {
                id: stagedWaba,
                changes: [
                  {
                    field: 'messages',
                    value: {
                      metadata: { phone_number_id: stagedPhone },
                      contacts: [{ wa_id: customer, id: providerMediaIds[8] }],
                      messages: [
                        {
                          from: customer,
                          id: stagedWamids[0],
                          timestamp: `${updateTime}`,
                          type: 'image',
                          image: {
                            id: providerMediaIds[6],
                            mime_type: 'image/jpeg',
                            caption: stagedText,
                          },
                        },
                      ],
                    },
                  },
                  {
                    field: 'history',
                    value: {
                      metadata: { phone_number_id: stagedPhone },
                      history: [
                        {
                          threads: [
                            {
                              id: customer,
                              messages: [
                                {
                                  from: customer,
                                  id: stagedWamids[1],
                                  timestamp: `${updateTime}`,
                                  type: 'image',
                                  image: {
                                    id: providerMediaIds[5],
                                    mime_type: 'image/jpeg',
                                  },
                                },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  },
                  {
                    field: 'smb_message_echoes',
                    value: {
                      metadata: { phone_number_id: stagedPhone },
                      message_echoes: [
                        {
                          from: business,
                          to: customer,
                          id: stagedWamids[2],
                          timestamp: `${updateTime}`,
                          type: 'image',
                          image: {
                            id: providerMediaIds[7],
                            mime_type: 'image/jpeg',
                          },
                        },
                      ],
                    },
                  },
                  {
                    field: 'smb_future_messages',
                    value: {
                      metadata: { phone_number_id: stagedPhone },
                      messages: [
                        {
                          from: customer,
                          id: stagedWamids[3],
                          timestamp: `${updateTime}`,
                          type: 'text',
                          text: { body: stagedText },
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          });

          const stageBodyHash = createHash('sha256')
            .update(stageBody)
            .digest('hex');

          const stagedMessageKey = `${stageBodyHash}:0:0`;
          const stagedHistoryKey = `${stageBodyHash}:0:1`;

          const stageRowSchema = z.object({
            waba_id: z.string().nullable(),
            app_id: z.string(),
            dedupe_key: z.string(),
            captured_at: z.string(),
            raw_expires_at: z.string(),
            tombstone_until: z.string(),
            payload_hash: z.string().regex(/^[a-f0-9]{64}$/),
            payload: z.unknown(),
          });

          const readStagedRows = () =>
            z
              .array(stageRowSchema)
              .parse(
                JSON.parse(
                  fixtureSql(
                    `SELECT coalesce(jsonb_agg(s ORDER BY s.dedupe_key),'[]'::jsonb) FROM public.coexistence_staged_receipts s WHERE ${receiptScopeSql()}`
                  )
                )
              );

          const readNegativeRows = () =>
            z
              .array(
                z.strictObject({
                  app_id: z.string(),
                  waba_id: z.string(),
                  dedupe_key: z.string(),
                  kind: z.string(),
                  observed_at: z.string(),
                })
              )
              .parse(
                JSON.parse(
                  fixtureSql(
                    `SELECT coalesce(jsonb_agg(e ORDER BY e.app_id,e.dedupe_key),'[]'::jsonb) FROM public.coexistence_negative_evidence e WHERE ${receiptScopeSql()}`
                  )
                )
              );

          const beforeStage = await quietUpdateSnapshot();

          expect((await send(stageBody, false)).status).toBe(401);
          vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'false');

          try {
            expect((await send(stageBody)).status).toBe(503);
          } finally {
            vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
          }

          expect(readStagedRows()).toEqual([]);
          expect((await send(stageBody)).status).toBe(200);
          const privateRows = readStagedRows();

          expect(privateRows).toHaveLength(4);

          for (const receipt of privateRows) {
            expect(receipt.payload).not.toBeNull();
            expect(
              stagedWamids.filter((wamid) =>
                JSON.stringify(receipt.payload).includes(wamid)
              )
            ).toHaveLength(1);
          }

          expect(await drainCoexistenceJobs(freshWorker())).toEqual({
            completed: 0,
            retried: 0,
            quarantined: 0,
            stale: 0,
          });
          expect(await quietUpdateSnapshot()).toEqual(beforeStage);

          const noStagedInbox = await db
            .from('messages')
            .select('id')
            .in('message_id', stagedWamids);

          const noStagedMetadata = await db
            .from('coexistence_message_metadata')
            .select('message_id')
            .in('media_id', providerMediaIds.slice(5, 8));

          expect(noStagedInbox.error === null).toBe(true);
          expect(noStagedInbox.data).toEqual([]);
          expect(noStagedMetadata.error === null).toBe(true);
          expect(noStagedMetadata.data).toEqual([]);

          for (const media of providerMediaIds.slice(5, 8)) {
            const deniedMedia = await gateService.rpc(
              'coexistence_is_private_media',
              { p_media_id: media }
            );

            expect(deniedMedia.error === null).toBe(true);
            expect(deniedMedia.data).toBe(true);
          }

          const notMedia = await gateService.rpc(
            'coexistence_is_private_media',
            { p_media_id: providerMediaIds[8] }
          );

          expect(notMedia.error === null).toBe(true);
          expect(notMedia.data).toBe(false);

          const adoptNothing = await ConnectionOperation.acquire(gateService, {
            p_actor_id: signupB.actorId,
            p_account_id: signupB.accountId,
            p_request_id: randomUUID(),
            p_kind: 'manual_save',
            p_expected_revision: signupB.revision,
            p_expected_config_id: signupB.configId,
            p_expected_generation: signupB.generation,
            p_phone_number_id: stagedPhone,
            p_waba_id: stagedWaba,
            p_register: false,
            p_subscribe: false,
          });

          const legacyRebind = await adoptNothing.finish({
            access_token: encrypt('signup-ordinary-stub-token'),
            verify_token: null,
            connected_at: new Date().toISOString(),
            registered_at: null,
            subscribed_apps_at: null,
          });

          const reboundConfig = await signupSecondOwner
            .from('whatsapp_config')
            .select('id,coexistence_generation')
            .eq('account_id', signupB.accountId)
            .single();

          expect(reboundConfig.error === null).toBe(true);

          const rebound = z
            .object({ id: z.uuid(), coexistence_generation: z.uuid() })
            .parse(reboundConfig.data);

          signupB.configId = rebound.id;
          signupB.generation = rebound.coexistence_generation;
          signupB.revision = legacyRebind.revision;
          signupB.phoneId = stagedPhone;
          signupB.wabaId = stagedWaba;
          expect((await send(stageBody)).status).toBe(200);
          expect(readStagedRows()).toEqual(privateRows);
          expect(await drainCoexistenceJobs(freshWorker())).toEqual({
            completed: 0,
            retried: 0,
            quarantined: 0,
            stale: 0,
          });
          expect(await quietUpdateSnapshot()).toEqual(beforeStage);

          const afterBindingInbox = await db
            .from('messages')
            .select('id')
            .in('message_id', stagedWamids);

          expect(afterBindingInbox.error === null).toBe(true);
          expect(afterBindingInbox.data).toEqual([]);
          expect((await send(stageBody, false)).status).toBe(401);
          vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'false');

          try {
            expect((await send(stageBody)).status).toBe(503);
          } finally {
            vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
          }

          const previousLegacySecret = process.env.META_APP_SECRET;
          vi.stubEnv('META_APP_SECRET', secret);
          vi.stubEnv('WHATSAPP_COEXISTENCE_APP_ID', '');

          try {
            expect((await send(stageBody)).status).toBe(503);
          } finally {
            vi.stubEnv('WHATSAPP_COEXISTENCE_APP_ID', appId);
            vi.stubEnv('META_APP_SECRET', previousLegacySecret);
          }

          const { assertLegacyMediaAccess } =
            await import('../legacy-media-access');

          const legacyLookup = await gateService
            .from('whatsapp_config')
            .select(
              'id,account_id,user_id,phone_number_id,access_token,status,coexistence_app_id,coexistence_generation'
            )
            .eq('id', signupB.configId)
            .single();

          expect(legacyLookup.error === null).toBe(true);

          const legacySnapshot = z
            .object({
              id: z.string(),
              account_id: z.string(),
              user_id: z.string(),
              phone_number_id: z.string(),
              access_token: z.string(),
              status: z.literal('connected'),
              coexistence_app_id: z.null(),
              coexistence_generation: z.string(),
            })
            .parse(legacyLookup.data);

          await expect(
            assertLegacyMediaAccess(
              gateService,
              legacySnapshot,
              'signup-ordinary-stub-token',
              providerMediaIds[5]
            )
          ).rejects.toThrow('Legacy media unavailable');
          await expect(
            assertLegacyMediaAccess(
              gateService,
              legacySnapshot,
              'signup-ordinary-stub-token',
              providerMediaIds[8]
            )
          ).resolves.toBe(stagedPhone);

          for (const client of [owner, signupOwner, gateService]) {
            const privateStaging = await client
              .from('coexistence_staged_receipts')
              .select('dedupe_key');

            expect(privateStaging.error?.code).toBe('42501');

            const privateNegative = await client
              .from('coexistence_negative_evidence')
              .select('dedupe_key');

            expect(privateNegative.error?.code).toBe('42501');
          }

          // Keep the unsafe integer literal in the signed raw bytes; JavaScript must not manufacture a trusted target.
          const numericWabaBody = `{"object":"whatsapp_business_account","entry":[{"id":"${partnerBusinessId}","changes":[{"field":"account_update","value":{"event":"PARTNER_REMOVED","waba_info":{"waba_id":9007199254740993}}}]}]}`;
          const numericWabaKey = `${createHash('sha256').update(numericWabaBody).digest('hex')}:0:0`;
          const numericWabaResponse = await send(numericWabaBody);

          expect([200, 400]).toContain(numericWabaResponse.status);

          const numericWabaReceipt = readStagedRows().find(
            (row) => row.app_id === appId && row.dedupe_key === numericWabaKey
          );

          if (numericWabaResponse.status === 200)
            expect(numericWabaReceipt).toBeDefined();

          if (numericWabaReceipt) expect(numericWabaReceipt.waba_id).toBeNull();
          expect(
            readNegativeRows().some(
              (row) => row.app_id === appId && row.dedupe_key === numericWabaKey
            )
          ).toBe(false);
          expect(
            readNegativeRows().some((row) =>
              ['9007199254740992', '9007199254740993'].includes(row.waba_id)
            )
          ).toBe(false);

          // This isolated managed fixture has no fanout into the deliberately moved-member fixtures.
          const numericAppConfig = async () => {
            const result = await db
              .from('whatsapp_config')
              .select(
                'status,coexistence_app_id,coexistence_verified_at,coexistence_generation'
              )
              .eq('id', unrelatedConfig.id)
              .single();

            expect(result.error === null).toBe(true);

            return bindingSchema.parse(result.data);
          };

          const beforeNumericApp = await numericAppConfig();

          expect(beforeNumericApp.status).toBe('connected');
          expect(beforeNumericApp.coexistence_verified_at).not.toBeNull();
          const numericAppBody = `{"object":"whatsapp_business_account","entry":[{"id":"${partnerBusinessId}","changes":[{"field":"account_update","value":{"event":"PARTNER_APP_UNINSTALLED","waba_info":{"waba_id":"${unrelatedConfig.waba_id}","partner_app_id":${appId}}}}]}]}`;
          const numericAppKey = `${createHash('sha256').update(numericAppBody).digest('hex')}:0:0`;

          expect([200, 400]).toContain((await send(numericAppBody)).status);
          expect(await numericAppConfig()).toEqual(beforeNumericApp);
          expect(
            readNegativeRows().some(
              (row) => row.app_id === appId && row.dedupe_key === numericAppKey
            )
          ).toBe(false);

          const preLaunchNegativeA = JSON.stringify({
            object: 'whatsapp_business_account',
            entry: [
              {
                id: `${fixture}26`,
                time: 0,
                changes: [
                  {
                    field: 'account_update',
                    value: { event: 'ACCOUNT_OFFBOARDED' },
                  },
                ],
              },
            ],
          });

          const preLaunchNegativeAKey = `${createHash('sha256').update(preLaunchNegativeA).digest('hex')}:0:0`;

          expect((await send(preLaunchNegativeA)).status).toBe(200);

          const oldNegativeA = readNegativeRows().find(
            (row) =>
              row.app_id === appId && row.dedupe_key === preLaunchNegativeAKey
          );

          expect(oldNegativeA).toMatchObject({
            waba_id: `${fixture}26`,
            kind: 'ACCOUNT_OFFBOARDED',
          });
          const signupOrigin = 'http://127.0.0.1';

          const signupRequest = (body: SignupRequestBody) =>
            new Request(`${signupOrigin}/api/whatsapp/coexistence/signup`, {
              method: 'POST',
              headers: {
                origin: signupOrigin,
                'content-type': 'application/json',
                'sec-fetch-site': 'same-origin',
              },
              body: JSON.stringify(signupRequestBodySchema.parse(body)),
            });

          const signupGet = () =>
            new Request(`${signupOrigin}/api/whatsapp/coexistence/signup`);

          const controlledSignupTransport = (target: URL, init: RequestInit) =>
            globalThis.fetch(target, init);

          const signupRpc = async (
            name: string,
            args: Record<string, string | null>
          ) => {
            const result = await gateService
              .rpc(`coexistence_signup_${name}`, args)
              .retry(false);

            expect(
              result.error === null,
              'Supervised signup protocol RPC transport failed'
            ).toBe(true);

            return z.record(z.string(), z.unknown()).parse(result.data);
          };

          const assertSignupPrivate = (raw: string) => {
            expect(raw).not.toMatch(
              /"(?:access_token|nonce|nonce_hash|code|code_hash|operation_id|token|session_id|actor_id)"\s*:/
            );

            for (const value of [secret, signupCode, signupBusinessToken])
              expect(raw).not.toContain(value);
          };

          const readSignup = async (client = signupOwner) => {
            const response = await signupStatus(signupGet(), client);

            expect(response.status).toBe(200);
            expect(response.headers.get('Cache-Control')).toBe(
              'private, no-store'
            );
            const raw = await response.text();
            assertSignupPrivate(raw);

            return signupStatusSchema.parse(JSON.parse(raw));
          };

          const nonceA = randomUUID();
          const nonceB = randomUUID();
          const intendedPhone = '+15550001234';

          const prepareA = {
            request_id: randomUUID(),
            nonce: nonceA,
            intended_phone: intendedPhone,
            supervised: true,
          } satisfies SignupRequestBody;

          const prepareB = {
            request_id: randomUUID(),
            nonce: nonceB,
            intended_phone: intendedPhone,
            supervised: true,
          } satisfies SignupRequestBody;

          expect((await readSignup()).attempt).toBeNull();

          const publicPrepare = await signupPost(
            signupRequest(prepareA),
            signupOwner
          );

          expect(publicPrepare.status).toBe(409);
          expect(await publicPrepare.json()).toEqual({
            error: 'launch_prerequisites_incomplete',
          });
          expect((await readSignup()).attempt).toBeNull();

          const preparedAResponse = await signupProtocol(
            signupRequest(prepareA),
            signupOwner,
            prepareA,
            controlledSignupTransport
          );

          expect(preparedAResponse.status).toBe(200);

          const preparedSchema = z.object({
            status: z.literal('prepared'),
            attempt_id: z.uuid(),
          });

          const preparedA = preparedSchema.parse(
            await preparedAResponse.json()
          );

          signupAttemptIds.push(preparedA.attempt_id);

          const boundA = {
            p_actor_id: signupA.actorId,
            p_account_id: signupA.accountId,
            p_session_id: signupA.sessionId,
            p_attempt_id: preparedA.attempt_id,
            p_nonce_hash: createHash('sha256').update(nonceA).digest('hex'),
          };

          const publicLaunch = await signupPost(
            signupRequest({ action: 'launch', nonce: nonceA }),
            signupOwner,
            preparedA.attempt_id
          );

          expect(publicLaunch.status).toBe(409);
          expect(await publicLaunch.json()).toEqual({
            error: 'launch_prerequisites_incomplete',
          });
          expect(
            (await signupStatus(signupGet(), signupOtherSession)).status
          ).toBe(403);
          expect(
            await signupRpc('launch', { ...boundA, p_session_id: randomUUID() })
          ).toEqual({ status: 'forbidden' });
          expect(
            await signupRpc('launch', {
              ...boundA,
              p_nonce_hash: createHash('sha256')
                .update(randomUUID())
                .digest('hex'),
            })
          ).toEqual({ status: 'forbidden' });
          expect((await readSignup(owner)).attempt).toBeNull();
          expect(signupExchangeCalls).toBe(0);
          expect(
            await signupRpc('launch', {
              ...boundA,
              p_account_id: signupB.accountId,
            })
          ).toEqual({ status: 'forbidden' });

          const demoteSignupOwner = await db
            .from('profiles')
            .update({ account_role: 'admin' })
            .eq('user_id', signupA.actorId);

          expect(demoteSignupOwner.error === null).toBe(true);
          expect((await signupStatus(signupGet(), signupOwner)).status).toBe(
            403
          );
          expect(await signupRpc('launch', boundA)).toEqual({
            status: 'forbidden',
          });

          const restoreSignupOwner = await db
            .from('profiles')
            .update({ account_role: 'owner' })
            .eq('user_id', signupA.actorId);

          expect(restoreSignupOwner.error === null).toBe(true);

          const saveDuringSignup = await gateRpc(
            'connection_operation_acquire',
            {
              p_actor_id: signupA.actorId,
              p_account_id: signupA.accountId,
              p_request_id: randomUUID(),
              p_kind: 'manual_delete',
              p_expected_revision: signupA.revision,
              p_expected_config_id: signupA.configId,
              p_expected_generation: signupA.generation,
              p_phone_number_id: null,
              p_waba_id: null,
              p_register: false,
              p_subscribe: false,
            }
          );

          expect(saveDuringSignup).toEqual({ status: 'busy' });

          const launchA = {
            action: 'launch',
            nonce: nonceA,
          } satisfies SignupRequestBody;

          expect(
            (
              await signupProtocol(
                signupRequest(launchA),
                signupOwner,
                launchA,
                controlledSignupTransport,
                preparedA.attempt_id
              )
            ).status
          ).toBe(200);
          expect(await signupRpc('launch', boundA)).toMatchObject({
            status: 'duplicate',
            dispatch: false,
          });

          const mediaAllowed = async (fixture: typeof signupA) => {
            const result = await gateService.rpc(
              'coexistence_signup_media_allowed',
              {
                p_account_id: fixture.accountId,
                p_config_id: fixture.configId,
                p_generation: fixture.generation,
              }
            );

            expect(result.error === null).toBe(true);

            return z.boolean().parse(result.data);
          };

          expect(await mediaAllowed(signupA)).toBe(false);
          expect(await mediaAllowed(signupB)).toBe(true);

          const signupPng = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
            'base64'
          );

          for (const fixture of [signupA, signupB]) {
            const path = `account-${fixture.accountId}/inbound/${BigInt(`0x${randomBytes(12).toString('hex')}`).toString()}-image.png`;
            storagePaths.push(path);

            const upload = await gateService.storage
              .from('chat-media')
              .upload(path, signupPng, {
                contentType: 'image/png',
                metadata: {
                  connection_config_id: fixture.configId,
                  connection_generation: fixture.generation,
                },
              });

            expect(upload.error === null).toBe(fixture === signupB);
          }

          const preparedBResponse = await signupProtocol(
            signupRequest(prepareB),
            signupSecondOwner,
            prepareB,
            controlledSignupTransport
          );

          expect(preparedBResponse.status).toBe(200);

          const preparedB = preparedSchema.parse(
            await preparedBResponse.json()
          );

          signupAttemptIds.push(preparedB.attempt_id);

          const boundB = {
            p_actor_id: signupB.actorId,
            p_account_id: signupB.accountId,
            p_session_id: signupB.sessionId,
            p_attempt_id: preparedB.attempt_id,
            p_nonce_hash: createHash('sha256').update(nonceB).digest('hex'),
          };

          expect((await readSignup()).attempt?.id).toBe(preparedA.attempt_id);
          expect((await readSignup(signupSecondOwner)).attempt?.id).toBe(
            preparedB.attempt_id
          );

          const exchangeA = {
            action: 'exchange',
            nonce: nonceA,
            code: signupCode,
          } satisfies SignupRequestBody;

          loseSignupTokenAck = true;

          const exchangeAResponse = await signupProtocol(
            signupRequest(exchangeA),
            signupOwner,
            exchangeA,
            controlledSignupTransport,
            preparedA.attempt_id
          );

          expect(exchangeAResponse.status).toBe(200);
          expect(await exchangeAResponse.json()).toEqual({
            status: 'recorded',
          });
          expect(signupExchangeCalls).toBe(1);
          expect(signupTokenStoreCalls).toBe(2);
          expect(
            (
              await signupProtocol(
                signupRequest(exchangeA),
                signupOwner,
                exchangeA,
                controlledSignupTransport,
                preparedA.attempt_id
              )
            ).status
          ).not.toBe(200);
          expect(signupExchangeCalls).toBe(1);
          const privateToken = await signupRpc('token', boundA);

          const ciphertext = z
            .object({ status: z.literal('token'), access_token: z.string() })
            .parse(privateToken).access_token;

          expect(ciphertext).not.toBe(signupBusinessToken);
          expect(decrypt(ciphertext)).toBe(signupBusinessToken);
          expect(privateToken).toMatchObject({
            app_id: appId,
            login_config_id: signupLoginId,
            intended_phone: intendedPhone,
          });

          const publicExchange = await signupPost(
            signupRequest(exchangeA),
            signupOwner,
            preparedA.attempt_id
          );

          expect(publicExchange.status).toBe(409);
          expect(signupExchangeCalls).toBe(1);

          const wrongPartnerStage = lifecycle(
            'PARTNER_REMOVED',
            `${fixture}99`,
            { waba_id: `${fixture}26` }
          );

          const wrongAppStage = lifecycle(
            'PARTNER_APP_UNINSTALLED',
            partnerBusinessId,
            { waba_id: `${fixture}26`, partner_app_id: `${fixture}99` }
          );

          expect((await send(wrongPartnerStage)).status).toBe(200);
          expect((await send(wrongAppStage)).status).toBe(200);

          const otherAppNegative = lifecycle(
            'ACCOUNT_OFFBOARDED',
            `${fixture}26`
          );

          vi.stubEnv('WHATSAPP_COEXISTENCE_APP_ID', `${fixture}32`);

          try {
            expect((await send(otherAppNegative)).status).toBe(200);
          } finally {
            vi.stubEnv('WHATSAPP_COEXISTENCE_APP_ID', appId);
          }

          const positiveStageA = lifecycle('PARTNER_ADDED', partnerBusinessId, {
            waba_id: `${fixture}26`,
          });

          expect((await send(positiveStageA)).status).toBe(200);
          expect((await send(positiveStageA)).status).toBe(200);
          expect(
            readNegativeRows().find(
              (row) =>
                row.app_id === appId && row.dedupe_key === preLaunchNegativeAKey
            )
          ).toEqual(oldNegativeA);

          const verifyA = {
            action: 'verify',
            nonce: nonceA,
            finish: {
              type: 'WA_EMBEDDED_SIGNUP',
              event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
              data: {
                phone_number_id: `${fixture}25`,
                is_on_biz_app: true,
                messaging_account_ids: [`${fixture}26`],
                primary_waac_ids: [],
                page_ids: [],
                catalog_ids: [],
                dataset_ids: [],
                instagram_account_ids: [],
                business_id: `${fixture}27`,
              },
            },
          } satisfies SignupRequestBody;

          const verifiedA = await signupProtocol(
            signupRequest(verifyA),
            signupOwner,
            verifyA,
            controlledSignupTransport,
            preparedA.attempt_id
          );

          expect(verifiedA.status).toBe(200);
          expect(await verifiedA.json()).toEqual({ status: 'verified' });
          expect(signupReadCalls).toBe(3);
          const previewA = await readSignup();

          expect(previewA).toMatchObject({
            launch_available: false,
            reason: 'launch_prerequisites_incomplete',
            attempt: {
              id: preparedA.attempt_id,
              state: 'verified',
              intended_phone: intendedPhone,
              preview: {
                phone_number_id: `${fixture}25`,
                waba_id: `${fixture}26`,
                normalized_phone_number: intendedPhone,
              },
            },
          });
          vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'false');

          try {
            expect((await readSignup()).enabled).toBe(false);
          } finally {
            vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
          }

          const confirmA = {
            action: 'confirm',
            nonce: nonceA,
          } satisfies SignupRequestBody;

          expect(
            (
              await signupProtocol(
                signupRequest(confirmA),
                signupOwner,
                confirmA,
                controlledSignupTransport,
                preparedA.attempt_id
              )
            ).status
          ).toBe(200);
          expect((await readSignup()).attempt?.state).toBe('confirmed');

          const unchangedA = await signupOwner
            .from('whatsapp_config')
            .select(
              'id,phone_number_id,waba_id,coexistence_generation,coexistence_app_id,coexistence_verified_at,status'
            )
            .eq('account_id', signupA.accountId)
            .single();

          expect(unchangedA.error === null).toBe(true);
          expect(unchangedA.data).toEqual({
            id: signupA.configId,
            phone_number_id: signupA.phoneId,
            waba_id: signupA.wabaId,
            coexistence_generation: signupA.generation,
            coexistence_app_id: null,
            coexistence_verified_at: null,
            status: 'connected',
          });
          expect(await signupRpc('launch', boundB)).toMatchObject({
            status: 'started',
            dispatch: true,
          });
          expect(
            await signupRpc('exchange_start', {
              ...boundB,
              p_code_hash: createHash('sha256')
                .update(signupCode)
                .digest('hex'),
            })
          ).toEqual({ status: 'conflict' });
          expect(
            await signupRpc('exchange_start', {
              ...boundB,
              p_code_hash: createHash('sha256')
                .update(`independent-${runId}`)
                .digest('hex'),
            })
          ).toMatchObject({ status: 'started', dispatch: true });
          const lateCiphertext = encrypt('independent-signup-observed-token');

          expect(
            await signupRpc('store_token', {
              ...boundB,
              p_access_token: lateCiphertext,
            })
          ).toEqual({ status: 'recorded' });

          const foreignSelection = await signupRpc('verify', {
            ...boundB,
            p_phone_number_id: `${fixture}25`,
            p_waba_id: `${fixture}26`,
            p_display_phone_number: '+1 555 000 1234',
            p_normalized_phone_number: intendedPhone,
            p_token_expires_at: new Date(signupExpiry * 1000).toISOString(),
          });

          expect(foreignSelection).toEqual({ status: 'conflict' });
          expect(
            await signupRpc('verify', {
              ...boundB,
              p_phone_number_id: signupA.phoneId,
              p_waba_id: signupA.wabaId,
              p_display_phone_number: '+1 555 000 1234',
              p_normalized_phone_number: intendedPhone,
              p_token_expires_at: new Date(signupExpiry * 1000).toISOString(),
            })
          ).toEqual({ status: 'conflict' });

          const heldA = z
            .object({ operation_id: z.uuid(), token: z.uuid() })
            .parse(
              JSON.parse(
                fixtureSql(
                  `SELECT jsonb_build_object('operation_id',id,'token',token) FROM public.connection_operations WHERE account_id='${signupA.accountId}' AND state IN ('active','blocked')`
                )
              )
            );

          const heldB = z
            .object({ operation_id: z.uuid() })
            .parse(
              JSON.parse(
                fixtureSql(
                  `SELECT jsonb_build_object('operation_id',id) FROM public.connection_operations WHERE account_id='${signupB.accountId}' AND state IN ('active','blocked')`
                )
              )
            );

          expect(
            Number(
              fixtureSql(
                `SELECT count(*) FROM public.connection_operation_resources WHERE operation_id='${heldA.operation_id}'`
              )
            )
          ).toBe(4);
          expect(
            Number(
              fixtureSql(
                `SELECT count(*) FROM public.connection_operation_resources WHERE operation_id='${heldB.operation_id}'`
              )
            )
          ).toBe(2);
          expect(
            await signupRpc('verify', {
              ...boundB,
              p_phone_number_id: `${fixture}29`,
              p_waba_id: `${fixture}30`,
              p_display_phone_number: '+1 555 000 9999',
              p_normalized_phone_number: '+15550009999',
              p_token_expires_at: new Date(signupExpiry * 1000).toISOString(),
            })
          ).toEqual({ status: 'invalid' });

          // Provider time is deliberately old: first DB observation after launch, not provider clock, fences this candidate.
          const stagedNegativeB = JSON.stringify({
            object: 'whatsapp_business_account',
            entry: [
              {
                id: `${fixture}30`,
                time: 1,
                changes: [
                  {
                    field: 'account_update',
                    value: { event: 'ACCOUNT_OFFBOARDED' },
                  },
                ],
              },
            ],
          });

          const stagedNegativeBKey = `${createHash('sha256').update(stagedNegativeB).digest('hex')}:0:0`;
          const foreignSigningSecret = randomBytes(32).toString('hex');
          vi.stubEnv('WHATSAPP_COEXISTENCE_APP_ID', `${fixture}32`);
          vi.stubEnv('WHATSAPP_COEXISTENCE_APP_SECRET', foreignSigningSecret);

          try {
            expect(
              (await send(stagedNegativeB, true, foreignSigningSecret)).status
            ).toBe(200);
          } finally {
            vi.stubEnv('WHATSAPP_COEXISTENCE_APP_ID', appId);
            vi.stubEnv('WHATSAPP_COEXISTENCE_APP_SECRET', secret);
          }

          expect(readNegativeRows()).toContainEqual(
            expect.objectContaining({
              app_id: `${fixture}32`,
              dedupe_key: stagedNegativeBKey,
              waba_id: `${fixture}30`,
              kind: 'ACCOUNT_OFFBOARDED',
            })
          );
          expect(
            readNegativeRows().some(
              (row) =>
                row.app_id === appId && row.dedupe_key === stagedNegativeBKey
            )
          ).toBe(false);
          expect(await signupRpc('token', boundB)).toMatchObject({
            status: 'token',
          });
          expect((await send(stagedNegativeB)).status).toBe(200);
          expect(
            readNegativeRows()
              .filter((row) => row.dedupe_key === stagedNegativeBKey)
              .map((row) => row.app_id)
              .sort()
          ).toEqual([appId, `${fixture}32`].sort());

          const negativeBeforeReplay = readNegativeRows().find(
            (row) =>
              row.app_id === appId && row.dedupe_key === stagedNegativeBKey
          );

          expect(negativeBeforeReplay).toMatchObject({
            waba_id: `${fixture}30`,
            kind: 'ACCOUNT_OFFBOARDED',
          });

          const blockedFutureSelection = await signupRpc('verify', {
            ...boundB,
            p_phone_number_id: `${fixture}29`,
            p_waba_id: `${fixture}30`,
            p_display_phone_number: '+1 555 000 1234',
            p_normalized_phone_number: intendedPhone,
            p_token_expires_at: new Date(signupExpiry * 1000).toISOString(),
          });

          expect(blockedFutureSelection).toEqual({ status: 'blocked' });
          expect(await signupRpc('token', boundB)).toEqual({
            status: 'expired',
          });
          expect(await signupRpc('confirm', boundB)).toEqual({
            status: 'blocked',
          });
          expect((await readSignup(signupSecondOwner)).attempt).toMatchObject({
            state: 'review_required',
            reason: 'verification_failed',
          });
          expect((await readSignup()).attempt?.state).toBe('confirmed');

          const stagedPositiveB = lifecycle(
            'ACCOUNT_RECONNECTED',
            `${fixture}30`
          );

          expect((await send(stagedPositiveB)).status).toBe(200);
          expect((await send(stagedPositiveB)).status).toBe(200);
          expect((await send(stagedNegativeB)).status).toBe(200);
          expect(
            readNegativeRows().find(
              (row) =>
                row.app_id === appId && row.dedupe_key === stagedNegativeBKey
            )
          ).toEqual(negativeBeforeReplay);
          expect(await signupRpc('confirm', boundB)).toEqual({
            status: 'blocked',
          });
          expect(
            (await signupSecondOwner.auth.signOut({ scope: 'local' })).error ===
              null
          ).toBe(true);
          expect(
            await signupRpc('store_token', {
              ...boundB,
              p_access_token: lateCiphertext,
            })
          ).toEqual({ status: 'recorded' });
          expect(await signupRpc('token', boundB)).toEqual({
            status: 'forbidden',
          });
          expect(await signupRpc('confirm', boundB)).toEqual({
            status: 'forbidden',
          });

          // Maintenance physically scrubs a demoted owner's live ciphertext without releasing claims.
          const revokeForMaintenance = await db
            .from('profiles')
            .update({ account_role: 'admin' })
            .eq('user_id', signupA.actorId);

          expect(revokeForMaintenance.error === null).toBe(true);
          vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'false');

          try {
            const revokedMaintenance = await gateService.rpc(
              'coexistence_staged_maintenance',
              { p_limit: 100 }
            );

            expect(revokedMaintenance.error === null).toBe(true);
            expect(
              z
                .object({ signup_tokens_scrubbed: z.number() })
                .parse(revokedMaintenance.data).signup_tokens_scrubbed
            ).toBeGreaterThanOrEqual(1);
            expect(
              fixtureSql(
                `SELECT access_token IS NULL FROM public.coexistence_signup_attempts WHERE id='${preparedA.attempt_id}' AND operation_id='${heldA.operation_id}'`
              )
            ).toBe('t');
          } finally {
            vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
          }

          const restoreAfterMaintenance = await db
            .from('profiles')
            .update({ account_role: 'owner' })
            .eq('user_id', signupA.actorId);

          expect(restoreAfterMaintenance.error === null).toBe(true);
          expect(
            await signupRpc('store_token', {
              ...boundA,
              p_access_token: ciphertext,
            })
          ).toEqual({ status: 'recorded' });
          // Age only this run's receipt identities; the second pass proves actual expiry scrubbing too.
          fixtureSql(
            `UPDATE public.coexistence_staged_receipts SET captured_at=clock_timestamp()-interval '8 days', raw_expires_at=clock_timestamp()-interval '1 day', tombstone_until=clock_timestamp()+interval '22 days' WHERE app_id='${appId}' AND dedupe_key='${stagedMessageKey}'; UPDATE public.coexistence_staged_receipts SET captured_at=clock_timestamp()-interval '31 days', raw_expires_at=clock_timestamp()-interval '24 days', tombstone_until=clock_timestamp()-interval '1 day' WHERE app_id='${appId}' AND dedupe_key IN ('${stagedHistoryKey}','${stagedNegativeBKey}'); UPDATE public.coexistence_signup_attempts SET token_expires_at='2000-01-01T00:00:00Z' WHERE id='${preparedA.attempt_id}' AND operation_id='${heldA.operation_id}'`
          );

          const agedMessage = readStagedRows().find(
            (row) => row.app_id === appId && row.dedupe_key === stagedMessageKey
          );

          vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'false');

          try {
            const maintenance = await gateService.rpc(
              'coexistence_staged_maintenance',
              { p_limit: 100 }
            );

            expect(maintenance.error === null).toBe(true);

            const result = z
              .object({
                scrubbed: z.number().int().nonnegative(),
                deleted: z.number().int().nonnegative(),
                signup_tokens_scrubbed: z.number().int().nonnegative(),
              })
              .parse(maintenance.data);

            expect(result.scrubbed).toBeGreaterThanOrEqual(1);
            expect(result.deleted).toBeGreaterThanOrEqual(1);
            expect(result.signup_tokens_scrubbed).toBeGreaterThanOrEqual(1);
          } finally {
            vi.stubEnv('WHATSAPP_COEXISTENCE_ENABLED', 'true');
          }

          const retainedMessage = readStagedRows().find(
            (row) => row.app_id === appId && row.dedupe_key === stagedMessageKey
          );

          expect(retainedMessage).toEqual({ ...agedMessage, payload: {} });

          const retainedNegative = readStagedRows().find(
            (row) =>
              row.app_id === appId && row.dedupe_key === stagedNegativeBKey
          );

          expect(retainedNegative?.payload).toEqual({});
          expect(
            readStagedRows().some(
              (row) =>
                row.app_id === appId && row.dedupe_key === stagedHistoryKey
            )
          ).toBe(false);
          expect(
            readNegativeRows().find(
              (row) =>
                row.app_id === appId && row.dedupe_key === stagedNegativeBKey
            )
          ).toEqual(negativeBeforeReplay);
          expect(
            readNegativeRows().some(
              (row) =>
                row.app_id === `${fixture}32` && row.waba_id === `${fixture}26`
            )
          ).toBe(true);
          expect((await send(stageBody)).status).toBe(200);
          expect((await send(stagedNegativeB)).status).toBe(200);
          expect(
            readStagedRows().find(
              (row) =>
                row.app_id === appId && row.dedupe_key === stagedMessageKey
            )
          ).toEqual(retainedMessage);
          expect(
            readNegativeRows().find(
              (row) =>
                row.app_id === appId && row.dedupe_key === stagedNegativeBKey
            )
          ).toEqual(negativeBeforeReplay);

          expect(
            readStagedRows().find(
              (row) =>
                row.app_id === appId && row.dedupe_key === stagedNegativeBKey
            )
          ).toEqual(retainedNegative);

          const erasedTokens = Number(
            fixtureSql(
              `SELECT count(*) FROM public.coexistence_signup_attempts WHERE id IN ('${preparedA.attempt_id}','${preparedB.attempt_id}') AND access_token IS NULL`
            )
          );

          expect(erasedTokens).toBe(2);

          for (const media of providerMediaIds.slice(5, 8)) {
            const retainedDeny = await gateService.rpc(
              'coexistence_is_private_media',
              { p_media_id: media }
            );

            expect(retainedDeny.error === null).toBe(true);
            expect(retainedDeny.data).toBe(true);
          }

          expect(await drainCoexistenceJobs(freshWorker())).toEqual({
            completed: 0,
            retried: 0,
            quarantined: 0,
            stale: 0,
          });

          const stillNoInbox = await db
            .from('messages')
            .select('id')
            .in('message_id', stagedWamids);

          expect(stillNoInbox.error === null).toBe(true);
          expect(stillNoInbox.data).toEqual([]);
          expect(
            await signupRpc('review', {
              ...boundB,
              p_reason: 'provider_cancelled',
            })
          ).toEqual({ status: 'recorded' });
          expect(
            Number(
              fixtureSql(
                `SELECT count(*) FROM public.connection_operation_resources WHERE operation_id='${heldB.operation_id}'`
              )
            )
          ).toBe(2);
          expect(await mediaAllowed(signupB)).toBe(false);
          expect(await signupRpc('token', boundA)).toEqual({
            status: 'expired',
          });
          expect(await signupRpc('confirm', boundA)).toEqual({
            status: 'blocked',
          });
          fixtureSql(
            `UPDATE public.connection_operations SET lease_until='2000-01-01T00:00:00Z' WHERE id='${heldA.operation_id}' AND account_id='${signupA.accountId}'`
          );
          expect(
            await gateRpc('connection_operation_cancel_unstarted', {
              p_actor_id: signupA.actorId,
              p_operation_id: heldA.operation_id,
              p_token: heldA.token,
            })
          ).toEqual({ status: 'blocked' });
          expect(
            await connectionAccountStatus(
              gateService,
              signupA.actorId,
              signupA.accountId
            )
          ).toBe('blocked');
          expect(await mediaAllowed(signupA)).toBe(false);
          expect(
            Number(
              fixtureSql(
                `SELECT count(*) FROM public.connection_operation_resources WHERE operation_id='${heldA.operation_id}'`
              )
            )
          ).toBe(4);

          const deleteHeldSignup = await db
            .from('accounts')
            .delete()
            .eq('id', signupA.accountId);

          expect(deleteHeldSignup.error?.code).toBe('23503');

          // Real Next cookie context, using sessions issued by the same local Auth instance as SQL.
          const { GET: recoveryGet, POST: recoveryPost } =
            await import('@/app/api/whatsapp/coexistence/operator/signup-recovery/route');

          const { createWorkStore } =
            await import('next/dist/server/async-storage/work-store');

          const { createRequestStoreForAPI } =
            await import('next/dist/server/async-storage/request-store');

          const { workAsyncStorage } =
            await import('next/dist/server/app-render/work-async-storage.external');

          const { workUnitAsyncStorage } =
            await import('next/dist/server/app-render/work-unit-async-storage.external');

          const { NextRequest } = await import('next/server');

          const recoveryPath =
            '/api/whatsapp/coexistence/operator/signup-recovery';

          const sessionCookie = async (client: typeof signupOwner) => {
            const { data, error } = await client.auth.getSession();

            if (error || !data.session)
              throw new Error('Recovery fixture session unavailable');

            const cookie = Buffer.from(JSON.stringify(data.session)).toString(
              'base64url'
            );

            return `sb-${url.hostname.split('.')[0]}-auth-token=base64-${cookie}`;
          };

          const recoveryRequest = (
            cookie: string,
            body?: {
              attempt_id: string;
              request_id: string;
              action: 'close_unstarted' | 'record_hold';
            }
          ) => {
            const headers = new Headers({ cookie });
            const init: RequestInit = { headers };

            if (body) {
              init.method = 'POST';
              init.body = JSON.stringify(body);
              headers.set('origin', 'http://localhost');
              headers.set('content-type', 'application/json');
            }

            // NextRequest canonicalizes loopback IPs to localhost; send the same Origin.
            const request = new NextRequest(`http://localhost${recoveryPath}`, {
              ...init,
              signal: undefined,
            });

            const work = createWorkStore({
              page: `${recoveryPath}/route`,
              buildId: 'test',
              deploymentId: '',
              previouslyRevalidatedTags: [],
              renderOpts: {
                cacheLifeProfiles: {
                  default: { stale: 300, revalidate: 900, expire: 3600 },
                },
                staticPageGenerationTimeout: 60,
                cacheComponents: false,
                validationLevel: 'warning',
                experimental: {
                  authInterrupts: false,
                  useCacheTimeout: 5000,
                  durableUseCacheEntries: false,
                },
                isBuildTimePrerendering: false,
                waitUntil: undefined,
                onClose: () => {},
                onAfterTaskError: undefined,
              },
            });

            const store = createRequestStoreForAPI(
              request,
              request.nextUrl,
              { tags: [], expirationsByCacheKind: new Map() },
              undefined,
              undefined,
              undefined
            );

            return workAsyncStorage.run(work, () =>
              workUnitAsyncStorage.run(store, () =>
                (body ? recoveryPost : recoveryGet)(request)
              )
            );
          };

          const initiatingCookie = await sessionCookie(signupOwner);
          const recoveryCookie = await sessionCookie(signupOtherSession);

          const distinctRecoverySession =
            await signupOtherSession.auth.getClaims();

          expect(distinctRecoverySession.error === null).toBe(true);
          expect(
            claimsSchema.parse(distinctRecoverySession.data?.claims).session_id
          ).not.toBe(signupA.sessionId);
          expect(
            (await signupOwner.auth.signOut({ scope: 'local' })).error === null
          ).toBe(true);

          const hold = {
            attempt_id: preparedA.attempt_id,
            request_id: randomUUID(),
            action: 'record_hold',
          } satisfies NonNullable<Parameters<typeof recoveryRequest>[1]>;

          const heldStatus = await recoveryRequest(recoveryCookie);

          expect(heldStatus.status).toBe(200);
          expect(heldStatus.headers.get('cache-control')).toBe(
            'private, no-store'
          );
          const inspection = await heldStatus.text();
          assertSignupPrivate(inspection);
          expect(inspection).not.toContain(intendedPhone);
          expect(JSON.parse(inspection)).toMatchObject({
            status: 'ok',
            attempt: {
              id: preparedA.attempt_id,
              state: 'review_required',
              exchange_started: true,
              known_claims: 4,
              disposition: null,
              reviewed_at: null,
            },
          });
          expect(
            (await recoveryRequest(await sessionCookie(outsider))).status
          ).toBe(403);
          expect([401, 403]).toContain(
            (await recoveryRequest(initiatingCookie, hold)).status
          );
          expect((await recoveryRequest('', hold)).status).toBe(401);

          const foreignHold = await recoveryRequest(
            await sessionCookie(owner),
            hold
          );

          expect(foreignHold.status).toBe(404);
          assertSignupPrivate(await foreignHold.text());
          expect(
            (
              await recoveryRequest(recoveryCookie, {
                ...hold,
                action: 'close_unstarted',
              })
            ).status
          ).toBe(409);
          // Discard the first successful response (client lost ACK); repeat the same request, not a new decision.
          const firstHold = await recoveryRequest(recoveryCookie, hold);

          expect(firstHold.status).toBe(200);
          await firstHold.body?.cancel();
          const replayHold = await recoveryRequest(recoveryCookie, hold);

          expect(replayHold.status).toBe(firstHold.status);
          const receiptRaw = await replayHold.text();
          assertSignupPrivate(receiptRaw);

          const recoveryReceipt = z
            .strictObject({
              status: z.literal('recorded'),
              attempt_id: z.uuid(),
              request_id: z.uuid(),
              disposition: z.literal('held_uncertain'),
              reviewed_at: z.iso.datetime({ offset: true }),
            })
            .parse(JSON.parse(receiptRaw));

          expect(recoveryReceipt).toMatchObject({
            attempt_id: hold.attempt_id,
            request_id: hold.request_id,
          });
          expect(
            await (await recoveryRequest(recoveryCookie, hold)).json()
          ).toEqual(recoveryReceipt);
          const afterHold = await recoveryRequest(recoveryCookie);

          expect(afterHold.status).toBe(200);
          expect(await afterHold.json()).toMatchObject({
            status: 'ok',
            attempt: {
              id: hold.attempt_id,
              state: 'review_required',
              known_claims: 4,
              disposition: 'held_uncertain',
              reviewed_at: recoveryReceipt.reviewed_at,
            },
          });
          expect(
            (
              await signupPost(
                signupRequest(launchA),
                signupOtherSession,
                preparedA.attempt_id
              )
            ).status
          ).toBe(403);
          expect(
            (await signupPost(signupRequest(prepareA), owner)).status
          ).toBe(409);

          const servicePrivateSignup = await gateService
            .from('coexistence_signup_attempts')
            .select('id');

          expect(servicePrivateSignup.error?.code).toBe('42501');

          for (const client of [signupOtherSession, owner]) {
            const privateRead = await client
              .from('coexistence_signup_attempts')
              .select('id');

            const privateTokenRead = await client.rpc(
              'coexistence_signup_token',
              boundA
            );

            expect(privateRead.error?.code).toBe('42501');
            expect(privateTokenRead.error?.code).toBe('42501');
          }

          expect(signupExchangeCalls).toBe(1);
          expect(signupReadCalls).toBe(3);
          expect(simulatedGraphRequests).toBe(6);
          expect(privateGraphRequests).toBe(3);
          expect(privateCdnRequests).toBe(2);
          expect(storageRequests).toBeGreaterThanOrEqual(16);
          expect(externalRequests).toEqual([]);
        } finally {
          guardedFetch.mockRestore();
        }

        // Optional because this assertion also requires a functioning local Realtime service/publication.
        if (process.env.COEXISTENCE_INTEGRATION_REALTIME === '1') {
          const historyRow = z.array(uuidSchema).parse(messages.data)[0];

          const updateSchema = z.object({
            old: z.object({ message_source: z.string().optional() }),
            new: z.object({ message_source: z.string() }),
          });

          const update = Promise.withResolvers<z.infer<typeof updateSchema>>();
          let eventsSeen = 0;

          // A channel join alone can precede the database subscription becoming active.
          const channel = owner
            .channel(`coexistence-integration-${runId}`, {
              config: {
                postgres_changes_options: { wait: true, timeout: 8000 },
              },
            })
            .on(
              'postgres_changes',
              {
                event: 'UPDATE',
                schema: 'public',
                table: 'messages',
                filter: `id=eq.${historyRow.id}`,
              },
              (event) => {
                eventsSeen++;
                const parsed = updateSchema.safeParse(event);

                if (parsed.success) update.resolve(parsed.data);
              }
            );

          let timer: ReturnType<typeof setTimeout> | undefined;

          try {
            await subscribe(channel);

            const changed = await db
              .from('messages')
              .update({ status: 'delivered' })
              .eq('id', historyRow.id)
              .eq('conversation_id', conversationId);

            expect(changed.error === null).toBe(true);

            const timeout = new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error(
                      eventsSeen
                        ? 'Local Realtime UPDATE shape was invalid'
                        : 'Local Realtime UPDATE was not delivered'
                    )
                  ),
                10_000
              );
            });

            const observed = await Promise.race([update.promise, timeout]);
            expect(observed.new.message_source).toBe('history');
            expect(
              observed.old.message_source,
              'Authenticated Realtime UPDATE needs the previous message source'
            ).toBe('history');
          } finally {
            clearTimeout(timer);
            await owner.removeChannel(channel);
          }
        }
      } finally {
        await Promise.all([
          owner.auth.signOut({ scope: 'local' }),
          outsider.auth.signOut({ scope: 'local' }),
          teammate.auth.signOut({ scope: 'local' }),
          gateOwner.auth.signOut({ scope: 'local' }),
          signupOwner.auth.signOut({ scope: 'local' }),
          signupOtherSession.auth.signOut({ scope: 'local' }),
          signupSecondOwner.auth.signOut({ scope: 'local' }),
        ]);
        const cleanupErrors: string[] = [];

        if (storagePaths.length) {
          if (
            storagePaths.some(
              (path) =>
                !accounts.some((accountId) =>
                  path.startsWith(`account-${accountId}/`)
                )
            )
          ) {
            cleanupErrors.push('unexpected storage fixture path');
          } else {
            const removedStorage = await db.storage
              .from('chat-media')
              .remove(storagePaths);

            if (removedStorage.error)
              cleanupErrors.push('temporary Storage object cleanup failed');

            for (const folder of new Set(
              storagePaths.map((path) => path.slice(0, path.lastIndexOf('/')))
            )) {
              const remainingStorage = await db.storage
                .from('chat-media')
                .list(folder, { limit: 10 });

              if (remainingStorage.error || remainingStorage.data?.length !== 0)
                cleanupErrors.push(
                  'temporary Storage fixture folder is not empty'
                );
            }
          }
        }

        let dockerFixtureVerified = false;

        if (accounts.length) {
          try {
            const accountIds = accounts
              .map((id) => `'${z.uuid().parse(id)}'`)
              .join(',');

            dockerFixtureVerified =
              Number(
                psql(
                  `SELECT count(*) FROM public.accounts WHERE id IN (${accountIds})`
                )
              ) === accounts.length;

            if (!dockerFixtureVerified)
              cleanupErrors.push(
                'Docker database does not contain this API fixture'
              );
          } catch {
            cleanupErrors.push(
              'isolated local Docker fixture database verification failed'
            );
          }
        }

        if (dockerFixtureVerified) {
          try {
            const operationIds = fixtureSql(
              `SELECT coalesce(jsonb_agg(id),'[]'::jsonb) FROM public.connection_operations WHERE original_account_id IN (${fixtureIds(accounts)})`
            );

            gateOperationIds.push(
              ...z.array(z.uuid()).parse(JSON.parse(operationIds))
            );

            const attemptIds = fixtureSql(
              `SELECT coalesce(jsonb_agg(id),'[]'::jsonb) FROM public.coexistence_signup_attempts WHERE operation_id IN (SELECT id FROM public.connection_operations WHERE original_account_id IN (${fixtureIds(accounts)}))`
            );

            signupAttemptIds.push(
              ...z.array(z.uuid()).parse(JSON.parse(attemptIds))
            );
            fixtureSql(
              `DELETE FROM public.coexistence_staged_receipts WHERE ${receiptScopeSql()}; DELETE FROM public.coexistence_negative_evidence WHERE ${receiptScopeSql()}; DELETE FROM public.coexistence_signup_attempts WHERE operation_id IN (SELECT id FROM public.connection_operations WHERE original_account_id IN (${fixtureIds(accounts)})); DELETE FROM public.connection_operation_resources WHERE operation_id IN (SELECT id FROM public.connection_operations WHERE original_account_id IN (${fixtureIds(accounts)})); DELETE FROM public.connection_operations WHERE original_account_id IN (${fixtureIds(accounts)}); DELETE FROM public.accounts WHERE id IN (${fixtureIds(accounts)}) AND owner_user_id IN (${fixtureIds(users)})`
            );

            expect(
              psql(
                `SELECT count(*) FROM public.coexistence_staged_receipts WHERE ${receiptScopeSql()}`
              )
            ).toBe('0');
            expect(
              psql(
                `SELECT count(*) FROM public.coexistence_negative_evidence WHERE ${receiptScopeSql()}`
              )
            ).toBe('0');

            if (signupAttemptIds.length)
              expect(
                psql(
                  `SELECT count(*) FROM public.coexistence_signup_attempts WHERE id IN (${fixtureIds(signupAttemptIds)})`
                )
              ).toBe('0');
            expect(
              psql(
                `SELECT count(*) FROM public.connection_operations WHERE original_account_id IN (${fixtureIds(accounts)})`
              )
            ).toBe('0');

            if (gateOperationIds.length)
              expect(
                psql(
                  `SELECT count(*) FROM public.connection_operation_resources WHERE operation_id IN (${fixtureIds(gateOperationIds)})`
                )
              ).toBe('0');
          } catch {
            cleanupErrors.push(
              'temporary gated connection/account cleanup failed'
            );
          }
        }

        for (const userId of users) {
          const removed = await db.auth.admin.deleteUser(userId);

          if (removed.error)
            cleanupErrors.push('temporary auth cleanup failed');
        }

        // These deny hashes deliberately outlive account cascades and have no service-role DELETE grant.
        try {
          const tableExists = dockerFixtureVerified
            ? psql(
                "SELECT to_regclass('public.coexistence_private_media_ids') IS NOT NULL"
              )
            : 'f';

          if (tableExists === 't') {
            const hashes = providerMediaIds
              .map(
                (id) =>
                  `decode('${createHash('sha256').update(id).digest('hex')}','hex')`
              )
              .join(',');

            const removed = Number(
              psql(
                `WITH removed AS (DELETE FROM public.coexistence_private_media_ids WHERE media_id_hash IN (${hashes}) RETURNING 1) SELECT count(*) FROM removed`
              )
            );

            if (privateMediaRecorded && removed === 0)
              cleanupErrors.push(
                'private media deny proof did not survive account deletion'
              );

            if (
              psql(
                `SELECT count(*) FROM public.coexistence_private_media_ids WHERE media_id_hash IN (${hashes})`
              ) !== '0'
            )
              cleanupErrors.push('fixture media hash cleanup failed');
          } else if (privateMediaRecorded)
            cleanupErrors.push('private media deny table is missing');
        } catch {
          cleanupErrors.push(
            'isolated local Docker fixture media hash cleanup failed'
          );
        }

        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        expect(cleanupErrors).toEqual([]);

        const leftovers = await db
          .from('coexistence_jobs')
          .select('id', { head: true, count: 'exact' });

        expect(leftovers.error === null).toBe(true);
        expect(leftovers.count).toBe(0);

        for (const table of [
          'coexistence_updates',
          'coexistence_status_events',
        ]) {
          const remaining = await db
            .from(table)
            .select('id', { head: true, count: 'exact' })
            .in('config_id', lifecycleConfigIds);

          expect(remaining.error === null).toBe(true);
          expect(remaining.count).toBe(0);
        }

        for (const table of [
          'coexistence_reaction_order',
          'message_reactions',
          'coexistence_message_metadata',
        ]) {
          const remaining = await db
            .from(table)
            .select('message_id', { head: true, count: 'exact' })
            .in('message_id', updateParentIds);

          expect(remaining.error === null).toBe(true);
          expect(remaining.count).toBe(0);
        }

        const leftoverLifecycle = await db
          .from('coexistence_lifecycle_evidence')
          .select('config_id', { head: true, count: 'exact' })
          .in('config_id', lifecycleConfigIds);

        expect(leftoverLifecycle.error === null).toBe(true);
        expect(leftoverLifecycle.count).toBe(0);

        const leftoverEffects = await db
          .from('coexistence_live_effects')
          .select('message_id', { head: true, count: 'exact' });

        expect(leftoverEffects.error === null).toBe(true);
        expect(leftoverEffects.count).toBe(0);

        const remainingAccounts = await db
          .from('accounts')
          .select('id', { head: true, count: 'exact' })
          .in('owner_user_id', users);

        expect(remainingAccounts.error === null).toBe(true);
        expect(remainingAccounts.count).toBe(0);

        const remainingMessages = await db
          .from('messages')
          .select('id', { head: true, count: 'exact' })
          .in('message_id', [
            historyId,
            echoId,
            mediaId,
            liveId,
            promotedId,
            newerEchoId,
            ...effectMessageIds,
          ]);

        expect(remainingMessages.error === null).toBe(true);
        expect(remainingMessages.count).toBe(0);

        for (const userId of users) {
          const removed = await db.auth.admin.getUserById(userId);
          expect(
            removed.error?.status,
            'Temporary auth user must be gone'
          ).toBe(404);
        }
      }
    }, 120_000);
  }
);
