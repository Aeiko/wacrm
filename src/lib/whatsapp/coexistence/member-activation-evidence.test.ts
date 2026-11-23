import { expect, it, vi } from 'vitest';
import type { CoexistenceFetch } from '../coexistence-meta';
import { verifyMemberActivationEvidence } from './member-activation-evidence';

it.each(['ok', 'wrong grant', 'wrong phone', 'missing receiver'])(
  'reviews only the exact activation target: %s',
  async (scenario) => {
    const target = {
      appId: '123',
      loginConfigId: '456',
      partnerId: '456',
      wabaId: '777',
      phoneNumberId: '888',
      intendedPhone: '+12025550124',
    };

    const review = vi.fn(async () => scenario !== 'missing receiver');

    const transport = vi.fn<CoexistenceFetch>(async (url) => {
      if (url.pathname.endsWith('/debug_token'))
        return Response.json({
          data: {
            app_id: '123',
            is_valid: true,
            expires_at: 4102444800,
            scopes: [
              'whatsapp_business_messaging',
              'whatsapp_business_management',
            ],
            granular_scopes: [
              {
                scope: 'whatsapp_business_management',
                target_ids: [scenario === 'wrong grant' ? '999' : '777'],
              },
            ],
          },
        });

      const phone = {
        id: scenario === 'wrong phone' ? '889' : '888',
        display_phone_number: '+1 202 555 0124',
      };

      return Response.json(
        url.pathname.endsWith('/phone_numbers')
          ? { data: [phone] }
          : { ...phone, is_on_biz_app: true, platform_type: 'CLOUD_API' }
      );
    });

    const result = verifyMemberActivationEvidence(
      target,
      'fixture-token',
      'fixture-app-token',
      transport,
      review,
      AbortSignal.timeout(5000)
    );

    if (scenario === 'ok')
      await expect(result).resolves.toBe('2100-01-01T00:00:00.000Z');
    else await expect(result).rejects.toThrow();

    expect(review).toHaveBeenCalledTimes(
      scenario === 'ok' || scenario === 'missing receiver' ? 1 : 0
    );
  }
);
