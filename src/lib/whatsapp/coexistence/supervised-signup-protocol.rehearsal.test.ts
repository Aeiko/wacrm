import { readFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { createServerClient, parseCookieHeader } from '@supabase/ssr';
import type { Session } from '@supabase/supabase-js';
import { expect, it, vi } from 'vitest';
import { deadlineFetch } from '@/lib/request-deadline';
import type { CoexistenceFetch } from '../coexistence-meta';
import type { SupervisedSignupInvitation } from './supervised-signup';

type Scenario =
  'owner' | 'cancel' | 'lostLaunch' | 'lostExchange' | 'wrongAccount';

type Login = Scenario | 'foreign' | 'otherLogin';

type Fixture = {
  invites: Record<Scenario, SupervisedSignupInvitation>;
  sessions: Record<Login, Session> & { rotated?: Session };
};

const suffix = '0124';

const graphPaths = [
  '/v27.0/oauth/access_token',
  '/v27.0/debug_token',
  '/v27.0/777/phone_numbers',
  '/v27.0/888',
];

function submittedFinish(code: string, waba = '777') {
  return {
    action: 'finish',
    code,
    finish: {
      type: 'WA_EMBEDDED_SIGNUP',
      event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
      data: {
        phone_number_id: '888',
        is_on_biz_app: true,
        messaging_account_ids: [waba],
        primary_waac_ids: [],
        page_ids: [],
        catalog_ids: [],
        dataset_ids: [],
        instagram_account_ids: [],
      },
    },
  };
}

// Only the Python runner opts in, with envDir disabled and its owned loopback bridge.
it.runIf(process.env.WACRM_SUPERVISED_SIGNUP_REHEARSAL === '1')(
  'uses real GoTrue and durable SQL074–077 receipts for a single private handoff',
  async () => {
    const origin = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/);
    expect(new URL(origin).origin).toBe(origin);

    const { invites, sessions }: Fixture = JSON.parse(
      readFileSync(process.env.WACRM_SUPERVISED_SIGNUP_INPUT ?? '', 'utf8')
    );

    const nativeFetch = globalThis.fetch;
    const graph: string[] = [];
    let rejectedWire = false;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, { ...init, redirect: 'error' });
      const url = new URL(request.url);

      if (
        url.origin !== origin ||
        !/^\/(auth\/v1\/user|rest\/v1\/(accounts|profiles|whatsapp_config|rpc\/[a-z_]+))$/.test(
          url.pathname
        )
      ) {
        rejectedWire = true;
        throw new Error('Only fixture bridge requests are allowed');
      }

      return nativeFetch(request, {
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
      });
    });

    for (const [key, value] of Object.entries({
      WHATSAPP_COEXISTENCE_ENABLED: 'true',
      WHATSAPP_COEXISTENCE_APP_ID: '123',
      WHATSAPP_COEXISTENCE_LOGIN_CONFIG_ID: '456',
      WHATSAPP_COEXISTENCE_PARTNER_BUSINESS_ID: '789',
      WHATSAPP_COEXISTENCE_APP_SECRET: 'fixture-app-secret',
      WHATSAPP_COEXISTENCE_RELAY_WABA_ID: '777',
      WHATSAPP_COEXISTENCE_RELAY_PHONE_ID: '888',
      ENCRYPTION_KEY: 'a'.repeat(64),
    }))
      vi.stubEnv(key, value);

    const { supervisedSignup } = await import('./supervised-signup');

    const provider: CoexistenceFetch = async (url, init) => {
      expect(url.origin).toBe('https://graph.facebook.com');
      expect(init.signal).toBeInstanceOf(AbortSignal);
      init.signal?.throwIfAborted();
      graph.push(url.pathname);

      const response = {
        '/v27.0/oauth/access_token': {
          access_token: 'fixture-business-token',
          token_type: 'bearer',
        },
        '/v27.0/debug_token': {
          data: {
            app_id: '123',
            is_valid: true,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            scopes: [
              'whatsapp_business_management',
              'whatsapp_business_messaging',
            ],
            granular_scopes: [
              { scope: 'whatsapp_business_management', target_ids: ['777'] },
            ],
          },
        },
        '/v27.0/777/phone_numbers': { data: [{ id: '888' }] },
        '/v27.0/888': {
          id: '888',
          display_phone_number: '+1 202 555 0124',
          is_on_biz_app: true,
          platform_type: 'CLOUD_API',
        },
      }[url.pathname];

      if (!response) throw new Error('Unexpected provider operation');

      return Response.json(response);
    };

    function call(
      scenario: Scenario,
      command?: { action: string } | ReturnType<typeof submittedFinish>,
      login: Login | null = scenario
    ) {
      const headers = new Headers();
      const cookieName = 'sb-127-auth-token';

      const value =
        login === null
          ? ''
          : `base64-${Buffer.from(JSON.stringify(sessions[login])).toString('base64url')}`;

      if (login !== null) headers.set('cookie', `${cookieName}=${value}`);

      if (command) {
        headers.set('origin', origin);
        headers.set('content-type', 'application/json');
      }

      const request = new Request(`${origin}/supervised-signup`, {
        method: command ? 'POST' : 'GET',
        headers,
        body: command ? JSON.stringify(command) : undefined,
      });

      const db = createServerClient(
        origin,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
        {
          cookies: {
            getAll: () =>
              request.headers.has('cookie')
                ? [{ name: cookieName, value }]
                : [],
            setAll: () => {},
          },
        }
      );

      return supervisedSignup(request, db, invites[scenario], provider);
    }

    async function state(response: Response, expected: string) {
      expect(response.status, expected).toBe(200);
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(await response.json()).toEqual({
        state: expected,
        phone_suffix: suffix,
      });
    }

    async function denied(response: Response) {
      expect(response.ok).toBe(false);
      const data = await response.json();
      expect(data).not.toHaveProperty('state');
      expect(data).not.toHaveProperty('phone_suffix');
    }

    async function neverReopens(
      scenario: Scenario,
      finish?: ReturnType<typeof submittedFinish>
    ) {
      const refreshed = await call(scenario);

      if (refreshed.ok) {
        expect(['held', 'pending']).toContain((await refreshed.json()).state);
      } else {
        await denied(refreshed);
      }

      await denied(await call(scenario, { action: 'launch' }));

      if (finish) await denied(await call(scenario, finish));
      await denied(await call(scenario, { action: 'confirm' }));
      expect(graph).toEqual([]);
    }

    try {
      if (process.env.WACRM_SUPERVISED_BROWSER_HOST === '1') {
        const { withPrivateSignupHost, rehearsePrivateSignupBrowser } =
          await import('../../../test/private-signup-host');

        const issued = process.env.WACRM_ISSUED_INVITATION === '1';

        const handleIssued = issued
          ? (await import('./issued-signup')).issuedSignup
          : undefined;

        const issuedInvites = Object.values(invites);
        const commands: { action: string; status: number }[] = [];
        const actions = ['launch', 'finish', 'confirm', 'intent'];
        const signup = '/supervised-signup';

        const cookieName = 'sb-127-auth-token';

        const encodeSession = (session: Session) =>
          `base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}`;

        const cookie = (login: Login) =>
          `${cookieName}=${encodeSession(sessions[login])}`;

        const ownerCookie = cookie('owner');

        console.log('signup-rehearsal: private-host-authority');
        await withPrivateSignupHost(
          async (request) => {
            // Fresh sessions are already installed as HttpOnly cookies; never echo them.
            const db = createServerClient(
              origin,
              process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
              {
                global: issued ? { fetch: deadlineFetch } : undefined,
                cookies: {
                  getAll: () =>
                    parseCookieHeader(request.headers.get('cookie') ?? ''),
                  setAll: () => {},
                },
              }
            );

            const command =
              request.method === 'POST'
                ? await request
                    .clone()
                    .json()
                    .catch(() => null)
                : null;

            const entry =
              request.method === 'POST'
                ? {
                    action: actions.includes(command?.action)
                      ? command.action
                      : 'unexpected',
                    status: 0,
                  }
                : null;

            if (entry) commands.push(entry);

            const response = handleIssued
              ? await handleIssued(request, db, issuedInvites, provider)
              : await supervisedSignup(request, db, invites.owner, provider);

            if (entry) entry.status = response.status;

            return response;
          },
          async (uiOrigin) => {
            function get(path: string, headers: Record<string, string> = {}) {
              // Fetch owns Host and Sec-Fetch-Mode; use HTTP to exercise raw headers.
              return new Promise<Response>((resolve, reject) => {
                httpGet(
                  uiOrigin + path,
                  {
                    headers: { 'sec-fetch-site': 'same-origin', ...headers },
                    signal: AbortSignal.timeout(10_000),
                  },
                  async (incoming) => {
                    try {
                      const chunks: Buffer[] = [];

                      for await (const chunk of incoming) chunks.push(chunk);
                      resolve(
                        new Response(Buffer.concat(chunks), {
                          status: incoming.statusCode,
                          headers: {
                            'cache-control':
                              incoming.headers['cache-control'] ?? '',
                          },
                        })
                      );
                    } catch {
                      reject(new Error('Private signup HTTP read failed'));
                    }
                  }
                ).once('error', () =>
                  reject(new Error('Private signup HTTP request failed'))
                );
              });
            }

            function post(
              body: { action: string; accountId?: string; padding?: string },
              headers: Record<string, string> = {}
            ) {
              return nativeFetch(uiOrigin + signup, {
                method: 'POST',
                headers: {
                  origin: uiOrigin,
                  'content-type': 'application/json',
                  'sec-fetch-site': 'same-origin',
                  ...headers,
                },
                body: JSON.stringify(body),
                redirect: 'error',
                signal: AbortSignal.timeout(10_000),
              });
            }

            async function reject(response: Response, status: number) {
              expect(response.status).toBe(status);
              expect(response.headers.get('cache-control')).toBe('no-store');
              const data = await response.json();
              expect(Object.keys(data)).toEqual(['error']);
            }

            for (const login of [null, 'foreign', 'otherLogin'] as const) {
              const headers: Record<string, string> =
                login === null ? {} : { cookie: cookie(login) };

              for (const path of ['/', '/fixture.js', signup])
                await reject(await get(path, headers), 401);
              await reject(await post({ action: 'launch' }, headers), 401);
            }

            const auth = { cookie: ownerCookie };

            if (issued) {
              // The same session must work after reserialization or token rotation.
              const value = encodeSession(sessions.rotated ?? sessions.owner);
              const middle = Math.floor(value.length / 2);

              const alternate = {
                cookie: `${cookieName}.0=${value.slice(0, middle)}; ${cookieName}.1=${value.slice(middle)}`,
              };

              expect((await get('/', alternate)).status).toBe(200);
              expect((await get('/fixture.js', alternate)).status).toBe(200);
              await state(await get(signup, alternate), 'prepared');
            }

            const direct = {
              'sec-fetch-site': 'none',
              'sec-fetch-dest': 'document',
              'sec-fetch-mode': 'navigate',
            };

            await reject(
              await get('/', { ...auth, host: 'foreign.invalid' }),
              403
            );
            await reject(
              await get('/', {
                ...auth,
                'x-forwarded-host': new URL(uiOrigin).host,
              }),
              403
            );
            await reject(
              await get('/fixture.js', {
                ...auth,
                'sec-fetch-site': 'cross-site',
              }),
              403
            );
            await reject(
              await get('/', {
                ...auth,
                ...direct,
                referer: 'http://foreign.invalid/',
              }),
              403
            );
            await reject(
              await get('/', {
                ...auth,
                ...direct,
                origin: 'http://foreign.invalid',
              }),
              403
            );
            await reject(
              await post(
                { action: 'launch' },
                { ...auth, origin: 'http://foreign.invalid' }
              ),
              403
            );
            await reject(
              await post({ action: 'launch' }, { ...auth, ...direct }),
              403
            );
            await reject(
              await post(
                { action: 'launch', accountId: invites.owner.accountId },
                auth
              ),
              400
            );
            await reject(
              await post(
                { action: 'launch', padding: 'x'.repeat(40 * 1024) },
                auth
              ),
              413
            );
            await reject(await get(`${signup}?action=launch`, auth), 404);
            await state(await get(signup, auth), 'prepared');
            expect(graph).toEqual([]);
            commands.length = 0;

            console.log('signup-rehearsal: private-host-browser');
            await rehearsePrivateSignupBrowser(uiOrigin, ownerCookie);
            expect(commands).toEqual(
              actions.map((action) => ({ action, status: 200 }))
            );
            expect(graph).toEqual(graphPaths);
            await state(await get(signup, auth), 'confirmed');
            expect(rejectedWire).toBe(false);
          }
        );

        return;
      }

      console.log('signup-rehearsal: owner-authority');

      for (const login of [null, 'foreign', 'otherLogin'] as const) {
        await denied(await call('owner', undefined, login));
        await denied(await call('owner', { action: 'launch' }, login));
      }

      await state(await call('owner'), 'prepared');
      await denied(await call('owner', { action: 'confirm' }));
      await denied(await call('owner', { action: 'intent' }));
      expect(graph).toEqual([]);

      console.log('signup-rehearsal: owner-launch');
      const launch = { action: 'launch' };

      const racedLaunches = await Promise.all([
        call('owner', launch),
        call('owner', launch),
      ]);

      expect(racedLaunches.filter((result) => result.ok)).toHaveLength(1);

      for (const result of racedLaunches) {
        if (result.ok) await state(result, 'launch_authorized');
        else await denied(result);
      }

      await state(await call('owner'), 'pending');
      expect(graph).toEqual([]);

      console.log('signup-rehearsal: owner-finish');
      const finish = submittedFinish('fixture-owner-code');
      await state(await call('owner', finish), 'verified');
      await state(await call('owner'), 'verified');
      expect(graph).toEqual(graphPaths);
      await denied(await call('owner', finish));
      await denied(await call('owner', { action: 'intent' }));

      console.log('signup-rehearsal: owner-confirm-intent');
      await state(await call('owner', { action: 'confirm' }), 'confirmed');
      await state(await call('owner'), 'confirmed');
      await state(await call('owner', { action: 'intent' }), 'intent_recorded');
      // SQL077 can return the original idempotent receipt; there must never be a second row.
      const replay = await call('owner', { action: 'intent' });

      if (replay.ok) await state(replay, 'intent_recorded');
      else await denied(replay);
      expect(graph).toEqual(graphPaths);
      graph.length = 0;

      console.log('signup-rehearsal: cancel');
      await state(await call('cancel', launch), 'launch_authorized');
      await state(await call('cancel', { action: 'cancel' }), 'held');
      await neverReopens('cancel', submittedFinish('fixture-cancel-code'));

      console.log('signup-rehearsal: wrong-account');
      await state(await call('wrongAccount', launch), 'launch_authorized');

      const wrong = await call(
        'wrongAccount',
        submittedFinish('fixture-wrong-code', '778')
      );

      if (wrong.ok) await state(wrong, 'held');
      else await denied(wrong);
      await neverReopens(
        'wrongAccount',
        submittedFinish('fixture-corrected-code')
      );

      console.log('signup-rehearsal: lost-launch');
      await denied(await call('lostLaunch', launch));
      await neverReopens('lostLaunch');

      console.log('signup-rehearsal: lost-exchange');
      await state(await call('lostExchange', launch), 'launch_authorized');
      const lost = submittedFinish('fixture-lost-code');
      await denied(await call('lostExchange', lost));
      await neverReopens('lostExchange', lost);
      expect(rejectedWire).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  },
  90_000
);
