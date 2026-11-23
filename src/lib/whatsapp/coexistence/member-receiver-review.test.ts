import { expect, it, vi } from 'vitest';
import {
  memberSubscriptionMatches,
  type CoexistenceFetch,
} from '../coexistence-meta';
import { appRoutingMatches } from './member-receiver-review';

const callback = 'https://wacrm.sqkii.land/api/whatsapp/webhook';
const pins = { appId: '123', loginConfigId: '456', partnerId: '789' };
const release = `sha256:${'a'.repeat(64)}`;

const proof = {
  ...pins,
  callback,
  release,
  dashboardEvidence: 'b'.repeat(64),
  lifecycleEvidence: 'c'.repeat(64),
  messagesVersion: 'v26.0',
  accountUpdateVersion: 'v27.0',
  reviewedAt: '2026-11-23T06:00:00Z',
  expiresAt: '2026-11-23T06:15:00Z',
};

const now = Date.parse('2026-11-23T06:01:00Z');

it('requires the reviewed release, exact pins and current bounded evidence', () => {
  const raw = JSON.stringify(proof);

  expect(appRoutingMatches(raw, pins, release, now)).toBe(true);
  expect(appRoutingMatches(raw, pins, undefined, now)).toBe(false);
  expect(
    appRoutingMatches(raw, { ...pins, loginConfigId: '888' }, release, now)
  ).toBe(false);
  expect(
    appRoutingMatches(raw, pins, release, Date.parse(proof.expiresAt))
  ).toBe(false);
  expect(
    appRoutingMatches(
      JSON.stringify({ ...proof, accountUpdateVersion: null }),
      pins,
      release,
      now
    )
  ).toBe(false);
  expect(
    appRoutingMatches(
      JSON.stringify({ ...proof, callback: 'https://wrong.example/' }),
      pins,
      release,
      now
    )
  ).toBe(false);
});

it.each([undefined, callback, 'https://wrong.example/'])(
  'checks the assigned WABA subscription and rejects a different effective callback: %s',
  async (override) => {
    const transport = vi.fn<CoexistenceFetch>(async () =>
      Response.json({
        data: [
          {
            whatsapp_business_api_data: { id: pins.appId },
            override_callback_uri: override,
          },
        ],
      })
    );

    const result = await memberSubscriptionMatches(
      { wabaId: '444', appId: pins.appId, callback },
      'synthetic',
      transport,
      AbortSignal.timeout(5000)
    );

    expect(transport.mock.calls[0]?.[0].pathname).toBe(
      '/v27.0/444/subscribed_apps'
    );
    expect(result).toBe(override === undefined || override === callback);
  }
);

it.each([
  { data: [] },
  { data: [{ whatsapp_business_api_data: { id: '999' } }] },
  {
    data: [{ whatsapp_business_api_data: { id: '123' } }],
    paging: { next: 'not followed' },
  },
])(
  'does not infer a subscription from incomplete or foreign data',
  async (body) => {
    const result = await memberSubscriptionMatches(
      { wabaId: '444', appId: pins.appId, callback },
      'synthetic',
      async () => Response.json(body),
      AbortSignal.timeout(5000)
    );

    expect(result).toBe(false);
  }
);
