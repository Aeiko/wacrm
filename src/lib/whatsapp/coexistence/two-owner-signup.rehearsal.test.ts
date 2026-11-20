import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { Session } from '@supabase/supabase-js';
import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  rehearsePrivateSignupBrowser,
  withPrivateSignupHost,
} from '../../../test/private-signup-host';
import { withSignupScopeWorker } from './signup-scope-worker.rehearsal';
import type { SupervisedSignupInvitation } from './supervised-signup';

const signup = '/supervised-signup';
const callsHeader = 'x-fixture-call-count';

const failures = [
  'cancel',
  'lostLaunch',
  'lostExchange',
  'wrongAccount',
] as const;

type Failure = (typeof failures)[number];

type Scenario = 'owner' | 'second' | Failure;

type Login = Scenario | 'foreign' | 'otherLogin';

type Fixture = {
  invites: Record<Scenario, SupervisedSignupInvitation>;
  sessions: Record<Login, Session>;
};

const commandAction = z.object({
  action: z.enum(['launch', 'finish', 'confirm', 'intent', 'cancel']),
});

const denial = z.strictObject({ error: z.string() });
const launch = { action: 'launch' };

function correctedFinish() {
  return {
    action: 'finish',
    code: 'fixture-corrected-code',
    finish: {
      type: 'WA_EMBEDDED_SIGNUP',
      event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
      data: {
        phone_number_id: '888',
        is_on_biz_app: true,
        messaging_account_ids: ['777'],
        primary_waac_ids: [],
        page_ids: [],
        catalog_ids: [],
        dataset_ids: [],
        instagram_account_ids: [],
      },
    },
  };
}

async function json(response: Response) {
  expect(response.headers.get('cache-control')).toContain('no-store');

  // JSON parse errors may include parts of the response body.
  return response.json().catch(() => null);
}

async function state(response: Response, expected: string, suffix: string) {
  expect(response.status, expected).toBe(200);
  expect(
    isDeepStrictEqual(await json(response), {
      state: expected,
      phone_suffix: suffix,
    }),
    expected
  ).toBe(true);
}

async function denied(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(denial.safeParse(await json(response)).success).toBe(true);
}

type ProbeBody =
  | { action: string; accountId?: string; attemptId?: string }
  | ReturnType<typeof correctedFinish>;

// Only the disposable Python runner supplies the fixture, bridge and browser assets.
it.runIf(process.env.WACRM_TWO_OWNER_REHEARSAL === '1')(
  'keeps two owners and their history-only intent handoffs isolated on one private origin',
  async () => {
    const { invites, sessions }: Fixture = JSON.parse(
      readFileSync(process.env.WACRM_SUPERVISED_SIGNUP_INPUT ?? '', 'utf8')
    );

    const cookie = (login: Login) =>
      `sb-127-auth-token=base64-${Buffer.from(JSON.stringify(sessions[login])).toString('base64url')}`;

    const routes = new Map<string, Scenario>(
      (['owner', 'second', ...failures] as const).map((scenario) => [
        cookie(scenario),
        scenario,
      ])
    );

    expect(routes.size).toBe(6);

    await withSignupScopeWorker('first', async (first) => {
      await withSignupScopeWorker('second', async (second) => {
        const counts = { first: 0, second: 0 };

        const trace: { scenario: Scenario; action: string; status: number }[] =
          [];

        async function invoke(
          scope: 'first' | 'second',
          request: Request,
          invite: SupervisedSignupInvitation
        ) {
          const response = await (scope === 'first' ? first : second)(
            request,
            invite
          );

          const count = response.headers.get(callsHeader);
          expect(count !== null && /^\d+$/.test(count)).toBe(true);
          counts[scope] = Math.max(counts[scope], Number(count));

          return response;
        }

        await withPrivateSignupHost(
          async (request) => {
            // The fixture cookie map selects a worker/invitation; it never authenticates the request.
            const scenario =
              routes.get(request.headers.get('cookie') ?? '') ?? 'owner';

            const command =
              request.method === 'POST'
                ? await request
                    .clone()
                    .json()
                    .catch(() => null)
                : null;

            const response = await invoke(
              scenario === 'second' ? 'second' : 'first',
              request,
              invites[scenario]
            );

            if (request.method === 'POST') {
              trace.push({
                scenario,
                action:
                  commandAction.safeParse(command).data?.action ?? 'unexpected',
                status: response.status,
              });
            }

            return response;
          },
          async (origin) => {
            function request(
              login: Login | null,
              body?: ProbeBody,
              path = signup
            ) {
              const headers = new Headers({ 'sec-fetch-site': 'same-origin' });

              if (login !== null) headers.set('cookie', cookie(login));

              if (body) {
                headers.set('origin', origin);
                headers.set('content-type', 'application/json');
              }

              return new Request(origin + path, {
                method: body ? 'POST' : 'GET',
                headers,
                body: body ? JSON.stringify(body) : undefined,
                redirect: 'error',
                signal: AbortSignal.timeout(15_000),
              });
            }

            async function http(
              login: Login | null,
              body?: ProbeBody,
              path = signup
            ) {
              const response = await fetch(request(login, body, path));
              expect(response.headers.has(callsHeader)).toBe(false);

              return response;
            }

            console.log('signup-rehearsal: two-owner-authority');

            for (const login of [null, 'foreign', 'otherLogin'] as const) {
              for (const path of ['/', '/fixture.js', signup])
                await denied(await http(login, undefined, path), 401);
              await denied(await http(login, launch), 401);
            }

            for (const [login, ownScope, opposite, oppositeScope, suffix] of [
              ['owner', 'first', 'second', 'second', '0124'],
              ['second', 'second', 'owner', 'first', '0125'],
            ] as const) {
              const ownInvite = invites[login];
              const otherInvite = invites[opposite];

              for (const body of [undefined, launch]) {
                // Bypass the routing correspondence: the worker sees the actual wrong cookie.
                await denied(
                  await invoke(
                    oppositeScope,
                    request(login, body),
                    otherInvite
                  ),
                  401
                );
                await denied(
                  await invoke(oppositeScope, request(login, body), ownInvite),
                  409
                );
                await denied(
                  await invoke(ownScope, request(login, body), {
                    ...ownInvite,
                    attemptId: otherInvite.attemptId,
                  }),
                  403
                );
              }

              await denied(
                await http(login, {
                  ...launch,
                  accountId: otherInvite.accountId,
                  attemptId: otherInvite.attemptId,
                }),
                400
              );
              await denied(
                await http(
                  login,
                  undefined,
                  `${signup}?attempt=${otherInvite.attemptId}`
                ),
                404
              );
              await state(await http(login), 'prepared', suffix);
            }

            expect(counts).toEqual({ first: 0, second: 0 });

            for (const scenario of failures) {
              trace.length = 0;
              console.log(
                `signup-rehearsal: two-owner-${scenario.toLowerCase()}`
              );
              await rehearsePrivateSignupBrowser(
                origin,
                cookie(scenario),
                scenario
              );

              const expected = {
                cancel: [
                  ['launch', 200],
                  ['cancel', 200],
                ],
                lostLaunch: [['launch', 503]],
                lostExchange: [
                  ['launch', 200],
                  ['finish', 503],
                ],
                wrongAccount: [
                  ['launch', 200],
                  ['finish', 200],
                ],
              }[scenario];

              expect(trace).toEqual(
                expected.map(([action, status]) => ({
                  scenario,
                  action,
                  status,
                }))
              );
              await state(
                await http(scenario),
                scenario === 'cancel' || scenario === 'wrongAccount'
                  ? 'held'
                  : 'pending',
                '0124'
              );

              for (const body of [
                launch,
                // No provider opened on a lost launch ACK; there is no callback to replay.
                ...(scenario === 'lostLaunch' ? [] : [correctedFinish()]),
                { action: 'confirm' },
                { action: 'intent' },
              ])
                await denied(await http(scenario, body), 409);
              expect(counts).toEqual({ first: 0, second: 0 });
            }

            trace.length = 0;
            console.log('signup-rehearsal: two-owner-browser-success');
            const owners = ['owner', 'second'] as const;

            // Wait for both browsers even on failure before disposing their shared host.
            const results = await Promise.allSettled(
              owners.map((scenario) =>
                rehearsePrivateSignupBrowser(origin, cookie(scenario), scenario)
              )
            );

            for (const [i, result] of results.entries()) {
              if (result.status === 'rejected') {
                const last = trace
                  .filter((entry) => entry.scenario === owners[i])
                  .at(-1);

                console.log(
                  `signup-rehearsal: ${owners[i]}-${last?.action ?? 'page'}-${last?.status ?? 0}-calls-${counts[i === 0 ? 'first' : 'second']}`
                );
              }
            }

            expect(
              results.every((result) => result.status === 'fulfilled')
            ).toBe(true);

            for (const scenario of owners) {
              const expected = [
                ['launch', 200],
                ...(scenario === 'second' ? [['launch', 409]] : []),
                ['finish', 200],
                ['confirm', 200],
                ['intent', 200],
              ];

              expect(
                trace.filter((entry) => entry.scenario === scenario)
              ).toEqual(
                expected.map(([action, status]) => ({
                  scenario,
                  action,
                  status,
                }))
              );
              await state(
                await http(scenario),
                'confirmed',
                scenario === 'owner' ? '0124' : '0125'
              );
            }

            expect(counts).toEqual({ first: 4, second: 4 });
          }
        );
      });
    });
  },
  210_000
);
