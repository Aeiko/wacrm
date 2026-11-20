import { z } from 'zod';
import { signupCodeSchema } from './signup-contract';

const id = z.string().regex(/^[1-9]\d{0,31}$/);

const receipt = z.object({
  authResponse: z.object({ code: signupCodeSchema }),
});

export type DiscoverySdk = {
  init(options: { appId: string; version: 'v27.0' }): void;
  login(
    callback: (value: z.input<typeof receipt> | null) => void,
    options: {
      config_id: string;
      response_type: 'code';
      override_default_response_type: true;
      extras: { version: 'v5' };
    }
  ): void;
};

/** Accept only an already loaded SDK supplied by the private host; never listen for FINISH. */
export function createDiscoveryProvider(
  sdk: DiscoverySdk,
  appId: string,
  configId: string
) {
  const config_id = id.parse(configId);
  sdk.init({ appId: id.parse(appId), version: 'v27.0' });
  let opened = false;

  return async () => {
    if (opened) throw new Error('Signup already opened');

    opened = true;

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Signup outcome unknown')),
        15 * 60_000
      );

      try {
        sdk.login(
          (raw) => {
            clearTimeout(timer);

            const result = receipt.safeParse(raw);

            if (result.success) resolve(result.data.authResponse.code);
            else reject(new Error('Signup code unavailable'));
          },
          {
            config_id,
            response_type: 'code',
            override_default_response_type: true,
            extras: { version: 'v5' },
          }
        );
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  };
}
