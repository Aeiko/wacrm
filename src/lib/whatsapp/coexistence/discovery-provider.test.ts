import { expect, it, vi } from 'vitest';
import {
  createDiscoveryProvider,
  type DiscoverySdk,
} from './discovery-provider';

it('initializes the reviewed v5 launch and accepts only a code callback once', async () => {
  const init = vi.fn();

  const login = vi.fn<DiscoverySdk['login']>((callback) => {
    callback({ authResponse: { code: 'fixture-code' } });
  });

  const open = createDiscoveryProvider({ init, login }, '123', '456');

  await expect(open()).resolves.toBe('fixture-code');
  await expect(open()).rejects.toThrow();
  expect(init).toHaveBeenCalledWith({ appId: '123', version: 'v27.0' });
  expect(login).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
    config_id: '456',
    response_type: 'code',
    override_default_response_type: true,
    extras: { version: 'v5' },
  });
});
