import { createServerClient, parseCookieHeader } from '@supabase/ssr';
import type { Session } from '@supabase/supabase-js';
import { expect, it, vi } from 'vitest';
import type { CoexistenceFetch } from '../coexistence-meta';
import type { discoverySignup } from './discovery-signup';

type Fixture = {
  invitation: Parameters<typeof discoverySignup>[2];
  sessions: [Session, Session];
};

type Command =
  | { action: 'launch' }
  | {
      action: 'finish';
      state: string;
      code: string;
    }
  | { action: 'confirm'; waba_id: string; phone_number_id: string };

const code = 'fixture-exchange-code';
const token = 'fixture-business-token';

// Opt in only through supabase/ci/rehearse-discovery.py.
const fixture = process.env.WACRM_DISCOVERY_REHEARSAL;

it.runIf(Boolean(fixture))(
  'denies a second password session and privately discovers and confirms the exact provider pair',
  async () => {
    const { invitation, sessions }: Fixture = JSON.parse(fixture ?? '');
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
        throw new Error(
          'Discovery rehearsal permits only its local socket bridge'
        );
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
      ENCRYPTION_KEY: 'a'.repeat(64),
    }))
      vi.stubEnv(key, value);

    const replies = new Map(
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

    const expectedCalls = Array.from(replies.keys(), (path) => `GET ${path}`);
    const providerCalls: string[] = [];

    const provider: CoexistenceFetch = async (url, init) => {
      const reply = replies.get(url.pathname);
      providerCalls.push(`${init.method} ${url.pathname}`);

      if (
        url.origin !== 'https://graph.facebook.com' ||
        init.method !== 'GET' ||
        !reply
      )
        throw new Error('Unexpected synthetic provider operation');

      return Response.json(reply);
    };

    try {
      const { discoverySignup: handler } = await import('./discovery-signup');

      function call(command: Command, login: 0 | 1 = 0) {
        const session = Buffer.from(JSON.stringify(sessions[login])).toString(
          'base64url'
        );

        const request = new Request(`${origin}/supervised-discovery`, {
          method: 'POST',
          headers: {
            origin,
            'content-type': 'application/json',
            cookie: `sb-127-auth-token=base64-${session}`,
          },
          body: JSON.stringify(command),
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

        return handler(request, db, invitation, provider);
      }

      async function result(response: Response, status: number) {
        expect(response.status).toBe(status);
        expect(response.headers.get('cache-control')).toContain('no-store');
        const text = await response.text();

        for (const secret of [
          token,
          code,
          sessions[0].access_token,
          sessions[1].access_token,
        ])
          expect(text).not.toContain(secret);

        return JSON.parse(text);
      }

      const launch: Command = { action: 'launch' };
      const denied = await result(await call(launch, 1), 401);
      expect(JSON.stringify(denied)).not.toContain(invitation.nonce);
      expect(providerCalls).toEqual([]);

      const launched = await result(await call(launch), 200);
      expect(launched).toEqual({
        status: 'launch_authorized',
        state: invitation.nonce,
        workspace: expect.stringContaining(invitation.accountId),
      });

      const completed: Command = {
        action: 'finish',
        state: launched.state,
        code,
      };

      await result(await call(completed, 1), 401);
      expect(providerCalls).toEqual([]);
      await result(
        await call({ ...completed, state: invitation.accountId }),
        409
      );
      expect(providerCalls).toEqual([]);

      const verified = await call(completed);
      expect(providerCalls).toEqual(expectedCalls);
      expect(await result(verified, 200)).toEqual({
        status: 'verified',
        workspace: launched.workspace,
        preview: {
          waba_id: '777',
          phone_number_id: '888',
          normalized_phone_number: '+12025550124',
        },
      });

      const confirm: Command = {
        action: 'confirm',
        waba_id: '777',
        phone_number_id: '888',
      };

      await result(await call(completed), 409);
      await result(await call(confirm, 1), 401);
      await result(await call({ ...confirm, phone_number_id: '889' }), 409);
      expect(await result(await call(confirm), 200)).toEqual({
        status: 'confirmed',
      });
      expect(providerCalls).toEqual(expectedCalls);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      expect(blocked).toEqual([]);
    }
  },
  60_000
);
