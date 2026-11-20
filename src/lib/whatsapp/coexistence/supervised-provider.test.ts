import { expect, it, vi } from 'vitest';
import { createSupervisedProvider } from './supervised-provider';

const finish = {
  type: 'WA_EMBEDDED_SIGNUP',
  event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
  data: {
    phone_number_id: '9201',
    messaging_account_ids: ['9202'],
    is_on_biz_app: true,
    primary_waac_ids: [],
    page_ids: [],
    catalog_ids: [],
    dataset_ids: [],
    instagram_account_ids: [],
  },
};

const origin = 'https://www.facebook.com';

function setup() {
  const messages = new EventTarget();

  let code: () => void = () => {
    throw Error('Not launched');
  };

  const login = vi.fn(
    (cb: Parameters<Parameters<typeof createSupervisedProvider>[1]>[0]) => {
      code = () => {
        cb({ authResponse: { code: 'synthetic-code' } });
      };
    }
  );

  const emit = (
    body: typeof finish | { type: string; event: string },
    from = origin
  ) =>
    messages.dispatchEvent(
      new MessageEvent('message', { data: JSON.stringify(body), origin: from })
    );

  const open = createSupervisedProvider('93001', login, messages);

  return { open, login, code: () => code(), emit };
}

it.each(['code first', 'finish first'])(
  'collects the bounded v5 hints once: %s',
  async (order) => {
    const h = setup();
    const result = h.open();
    expect(h.login).toHaveBeenCalledWith(expect.any(Function), {
      config_id: '93001',
      response_type: 'code',
      override_default_response_type: true,
      extras: { version: 'v5' },
    });
    h.emit(
      { type: 'WA_EMBEDDED_SIGNUP', event: 'CANCEL' },
      'https://unrelated.invalid'
    );

    if (order === 'code first') {
      h.code();
      h.emit(finish);
    } else {
      h.emit(finish);
      h.code();
    }

    await expect(result).resolves.toEqual({ code: 'synthetic-code', finish });
    await expect(h.open()).rejects.toThrow();
    expect(h.login).toHaveBeenCalledTimes(1);
  }
);

it('distinguishes provider cancellation from a lost reply and never reopens', async () => {
  const h = setup();
  const result = h.open();
  h.emit({ type: 'WA_EMBEDDED_SIGNUP', event: 'CANCEL' });
  await expect(result).resolves.toBeNull();
  await expect(h.open()).rejects.toThrow();
});

it('stops when the other half of a code callback is missing', async () => {
  vi.useFakeTimers();

  try {
    const h = setup();
    const result = h.open();
    h.code();
    const stopped = expect(result).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(21_000);
    await stopped;
    h.emit(finish);
    await expect(h.open()).rejects.toThrow();
  } finally {
    vi.useRealTimers();
  }
});

it('stops on conflicting provider messages instead of picking an asset', async () => {
  const h = setup();
  const result = h.open();
  h.emit(finish);
  h.emit({ ...finish, data: { ...finish.data, phone_number_id: '9203' } });
  await expect(result).rejects.toThrow();
});
