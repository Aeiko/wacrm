import { z } from 'zod';
import { signupCodeSchema, signupFinishSchema } from './signup-contract';

const codeReceipt = z.object({
  authResponse: z.object({ code: signupCodeSchema }),
});

const message = z.object({
  type: z.literal('WA_EMBEDDED_SIGNUP'),
  event: z.string(),
});

type Finish = z.infer<typeof signupFinishSchema>;

type Login = (
  callback: (response: z.input<typeof codeReceipt> | null) => void,
  options: {
    config_id: string;
    response_type: 'code';
    override_default_response_type: true;
    extras: { version: 'v5' };
  }
) => void;

// No SDK lookup, loader or network fallback. The controlled host supplies the callback source.
// Origins and shape filter hints; neither proves a code and FINISH came from the same popup.
export function createSupervisedProvider(
  loginConfigId: string,
  login: Login,
  messages: EventTarget
) {
  let opened = false;

  return () =>
    new Promise<{ code: string; finish: Finish } | null>((resolve, reject) => {
      if (opened || !/^[1-9]\d{0,31}$/.test(loginConfigId)) {
        reject(new Error('Provider unavailable'));

        return;
      }

      opened = true;
      let code: string | undefined;
      let finish: Finish | undefined;
      let deadline = Date.now() + 15 * 60_000;
      let timer = setTimeout(uncertain, 15 * 60_000);
      let closed = false;

      function close() {
        closed = true;
        clearTimeout(timer);
        messages.removeEventListener('message', receive);
        code = undefined;
        finish = undefined;
      }

      function uncertain() {
        close();
        reject(new Error('Provider response uncertain'));
      }

      function complete() {
        if (Date.now() >= deadline) {
          uncertain();

          return;
        }

        if (code && finish) {
          resolve({ code, finish });
          close();
        }
      }

      function receive(event: Event) {
        if (
          !(event instanceof MessageEvent) ||
          (event.origin !== 'https://www.facebook.com' &&
            event.origin !== 'https://web.facebook.com')
        )
          return;

        if (
          typeof window !== 'undefined' &&
          messages === window &&
          !event.isTrusted
        )
          return;

        const data = z.string().safeParse(event.data);

        if (!data.success) return;

        if (data.data.length > 16_384 || Date.now() >= deadline) {
          uncertain();

          return;
        }

        let raw;

        try {
          raw = JSON.parse(data.data);
        } catch {
          return;
        }

        const header = message.safeParse(raw);

        if (!header.success) return;

        if (header.data.event === 'CANCEL' && !finish && !code) {
          close();
          resolve(null);

          return;
        }

        const parsed = signupFinishSchema.safeParse(raw);

        if (!parsed.success || finish) {
          uncertain();

          return;
        }

        finish = parsed.data;
        complete();
      }

      messages.addEventListener('message', receive);

      try {
        login(
          (response) => {
            if (closed) return;
            const result = codeReceipt.safeParse(response);

            if (!result.success || code || Date.now() >= deadline) {
              uncertain();

              return;
            }

            code = result.data.authResponse.code;
            deadline = Math.min(deadline, Date.now() + 20_000);
            clearTimeout(timer);
            timer = setTimeout(uncertain, deadline - Date.now());
            complete();
          },
          {
            config_id: loginConfigId,
            response_type: 'code',
            override_default_response_type: true,
            extras: { version: 'v5' },
          }
        );
      } catch {
        uncertain();
      }
    });
}
