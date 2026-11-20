import { createServerClient, parseCookieHeader } from '@supabase/ssr';
import type { Session } from '@supabase/supabase-js';
import { expect, it, vi } from 'vitest';
import type { CoexistenceFetch } from '../coexistence-meta';

const fixture = process.env.WACRM_MEMBER_REHEARSAL;
const launch = { action: 'launch', intended_phone: '+12025550124' } as const;
const code = 'fixture-member-exchange-code';
const token = 'fixture-member-business-token';

type Command =
  | { action: 'launch'; intended_phone: string }
  | { action: 'finish'; state: string; code: string }
  | {
      action: 'confirm';
      state: string;
      waba_id: string;
      phone_number_id: string;
    };

type Fixture = {
  members: [Session, Session];
  other: Session;
  account: string;
  otherAccount: string;
  ticket: string;
};

// Run with supabase/ci/rehearse-member-signup.py, not a live Supabase project.
it.runIf(Boolean(fixture))(
  'lets a non-owner confirm one pending receipt but denies foreign, second, remapped, revoked and duplicate-phone attempts',
  async () => {
    const { members, other, account, otherAccount, ticket }: Fixture =
      JSON.parse(fixture ?? '');

    const origin = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/);
    expect(new URL(origin).origin).toBe(origin);

    const nativeFetch = globalThis.fetch;
    const blocked: string[] = [];
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, { ...init, redirect: 'error' });
      const url = new URL(request.url);

      if (url.origin !== origin) {
        blocked.push(url.origin);
        throw new Error('Member rehearsal permits only its loopback bridge');
      }

      request.headers.set('X-Fixture-Ticket', ticket);

      return nativeFetch(request, {
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
      });
    });

    for (const [name, value] of Object.entries({
      WHATSAPP_COEXISTENCE_ENABLED: 'true',
      COEXISTENCE_ENABLED: 'true',
      WHATSAPP_COEXISTENCE_MEMBER_SIGNUP_ENABLED: 'true',
      WHATSAPP_COEXISTENCE_APP_ID: '123',
      WHATSAPP_COEXISTENCE_LOGIN_CONFIG_ID: '456',
      WHATSAPP_COEXISTENCE_PARTNER_BUSINESS_ID: '789',
      WHATSAPP_COEXISTENCE_APP_SECRET: 'fixture-app-secret',
      ENCRYPTION_KEY: 'a'.repeat(64),
    }))
      vi.stubEnv(name, value);

    async function change(action: 'remap' | 'restore' | 'revoke') {
      const response = await fetch(`${origin}/fixture/${action}`, {
        method: 'POST',
      });

      expect(response.status, `fixture ${action}`).toBe(204);
    }

    const graph = new Map(
      Object.entries({
        '/v27.0/oauth/access_token': {
          access_token: token,
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
        '/v27.0/777/phone_numbers': {
          data: [{ id: '888', display_phone_number: '+1 202 555 0124' }],
        },
        '/v27.0/888': {
          id: '888',
          display_phone_number: '+1 202 555 0124',
          is_on_biz_app: true,
          platform_type: 'CLOUD_API',
        },
      })
    );

    const graphCalls: string[] = [];
    let revokeDuringExchange = false;

    const provider: CoexistenceFetch = async (url, init) => {
      graphCalls.push(`${init.method} ${url.pathname}`);
      const reply = graph.get(url.pathname);

      if (
        url.origin !== 'https://graph.facebook.com' ||
        init.method !== 'GET' ||
        !reply
      )
        throw new Error('Unexpected synthetic provider operation');

      if (revokeDuringExchange && url.pathname === '/v27.0/oauth/access_token')
        await change('revoke');

      return Response.json(reply);
    };

    try {
      const { memberSignup } = await import('./member-signup');

      async function call(
        session: Session,
        command: Command | null,
        expected: number[]
      ) {
        const cookie = Buffer.from(JSON.stringify(session)).toString(
          'base64url'
        );

        const request = new Request(`${origin}/supervised-discovery`, {
          method: command ? 'POST' : 'GET',
          headers: {
            origin,
            'content-type': 'application/json',
            cookie: `sb-127-auth-token=base64-${cookie}`,
          },
          body: command ? JSON.stringify(command) : undefined,
        });

        const db = createServerClient(
          origin,
          process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
          {
            cookies: {
              getAll: () =>
                parseCookieHeader(request.headers.get('cookie') ?? ''),
              setAll: () => {},
            },
          }
        );

        const response = await memberSignup(request, db, provider);
        expect(expected, command?.action ?? 'inspect').toContain(
          response.status
        );
        expect(response.headers.get('cache-control')).toContain('no-store');
        const raw = await response.text();

        for (const secret of [
          token,
          code,
          session.access_token,
          session.refresh_token,
        ])
          expect(raw.includes(secret)).toBe(false);

        return JSON.parse(raw);
      }

      const [viewer, second] = members;
      expect(await call(viewer, null, [200])).toMatchObject({
        status: 'available',
        workspace: expect.stringContaining(account),
      });
      expect(await call(other, null, [200])).toMatchObject({
        status: 'available',
        workspace: expect.stringContaining(otherAccount),
      });
      const started = await call(viewer, launch, [200]);
      expect(started).toMatchObject({
        status: 'launch_authorized',
        state: expect.any(String),
      });
      const finish: Command = { action: 'finish', state: started.state, code };
      await call(other, finish, [403, 409]);
      await call(second, finish, [403, 409]);
      await change('remap');
      expect(await call(viewer, null, [200])).toMatchObject({
        workspace: expect.stringContaining(otherAccount),
      });
      await call(viewer, finish, [403, 409]);
      await change('restore');
      expect(graphCalls).toEqual([]);

      const preview = {
        waba_id: '777',
        phone_number_id: '888',
        normalized_phone_number: launch.intended_phone,
      };

      expect(await call(viewer, finish, [200])).toEqual({
        status: 'verified',
        workspace: started.workspace,
        preview,
      });
      expect(graphCalls.splice(0)).toEqual(
        [...graph.keys()].map((p) => `GET ${p}`)
      );

      const confirm: Command = {
        action: 'confirm',
        state: started.state,
        waba_id: '777',
        phone_number_id: '888',
      };

      await call(second, confirm, [403, 409]);
      expect(await call(viewer, confirm, [200])).toEqual({
        status: 'confirmed',
      });
      await call(other, launch, [409]);
      expect(graphCalls).toEqual([]);

      // A different number still launches for the other workspace; revoke its exact session mid-exchange.
      const otherLaunch = await call(
        other,
        { ...launch, intended_phone: '+12025550125' },
        [200]
      );

      revokeDuringExchange = true;
      await call(
        other,
        {
          action: 'finish',
          state: otherLaunch.state,
          code: 'fixture-other-exchange-code',
        },
        [409]
      );
      expect(graphCalls).toEqual(['GET /v27.0/oauth/access_token']);
      await call(other, null, [401, 403]);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      expect(blocked).toEqual([]);
    }
  },
  120_000
);
