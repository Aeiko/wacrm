import { onTestFinished, vi } from 'vitest';
import * as permit from './coexistence/history-permit-client';

export function armHistoryPermit() {
  const receipt = {
    dispatch: true as const,
    phone_number_id: '456',
    request_id: '12345678-1234-4234-8234-123456789abc',
    deadline_at: new Date(Date.now() + 60_000).toISOString(),
  };

  let available = true;

  const consume = vi
    .spyOn(permit, 'consumeDispatchPermit')
    .mockImplementation(async (phone, request) => {
      if (
        !available ||
        phone !== receipt.phone_number_id ||
        request !== receipt.request_id
      )
        return false;

      available = false;

      return true;
    });

  onTestFinished(() => {
    consume.mockRestore();
  });

  return receipt;
}
