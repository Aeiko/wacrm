'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { signupFinishSchema } from '../../lib/whatsapp/coexistence/signup-contract';

const statusSchema = z.strictObject({
  state: z.enum([
    'prepared',
    'launch_authorized',
    'pending',
    'verified',
    'confirmed',
    'intent_recorded',
    'held',
  ]),
  phone_suffix: z
    .string()
    .length(4)
    .regex(/^[0-9]{4}$/),
});

const providerResultSchema = z.strictObject({
  code: z
    .string()
    .min(1)
    .max(32768)
    .refine((code) => Boolean(code.trim()) && !/[\r\n]/.test(code)),
  finish: signupFinishSchema,
});

type ProviderResult = z.infer<typeof providerResultSchema>;

type Status = z.infer<typeof statusSchema>;

type View =
  | Status
  | { state: 'idle' | 'stopped' | 'cancelled' }
  | { state: 'confirmed_on_inspect'; phone_suffix: string };

type Action = 'inspect' | 'launch' | 'open' | 'confirm' | 'intent';

type Step =
  | { action: 'launch' | 'confirm' | 'intent' | 'cancel' }
  | ({ action: 'finish' } & ProviderResult);

const controls: Partial<Record<View['state'], readonly [Action, string]>> = {
  idle: ['inspect', 'Inspect signup'],
  prepared: ['launch', 'Authorize launch'],
  launch_authorized: ['open', 'Open provider'],
  verified: ['confirm', 'Confirm verified number'],
  confirmed: ['intent', 'Record history-only intent'],
};

const statusMessages: Partial<Record<View['state'], string>> = {
  pending: 'Launch was already recorded. Do not open the provider again.',
  held: 'Signup is on hold. Contact your operator.',
  stopped: 'Signup stopped. Do not retry this step. Contact your operator.',
  cancelled: 'Provider signup was cancelled. Contact your operator.',
  verified:
    'The server verified the selected number. Confirm it separately below.',
  confirmed:
    'Number confirmed. Optionally record intent to import message history only, without contacts. Recording intent does not request an import.',
  confirmed_on_inspect:
    'The number is confirmed. This inspection does not establish whether history intent was recorded.',
  intent_recorded:
    'Message history intent was recorded. No contact import was requested and no import has started.',
};

const nextState = {
  launch: 'launch_authorized',
  confirm: 'confirmed',
  intent: 'intent_recorded',
  cancel: 'held',
  finish: 'verified',
} satisfies Record<Step['action'], Status['state']>;

async function requestStep(signal: AbortSignal, step?: Step) {
  const response = await fetch('/supervised-signup', {
    method: step ? 'POST' : 'GET',
    mode: 'same-origin',
    credentials: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
    signal,
    ...(step && {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(step),
    }),
  });

  if (!response.ok) return null;

  const status = statusSchema.safeParse(await response.json());

  if (!status.success) return null;

  const { state } = status.data;

  if (
    step
      ? state !== nextState[step.action] && state !== 'held'
      : state === 'launch_authorized'
  ) {
    return null;
  }

  return status.data;
}

// Compose from a client parent; the injected provider never crosses the RSC boundary.
export function SupervisedSignupScreen({
  openProvider,
}: {
  openProvider: () => Promise<ProviderResult | null>;
}) {
  const [view, setView] = useState<View>({ state: 'idle' });
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const usedView = useRef<View | null>(null);
  const lifetime = useRef<AbortController | null>(null);

  useLayoutEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;

    return () => controller.abort();
  }, []);

  const control = controls[view.state];
  const message = statusMessages[view.state];
  const disabled = busy || (view.state === 'prepared' && !accepted);

  async function act() {
    const signal = lifetime.current?.signal;

    if (
      !control ||
      disabled ||
      !signal ||
      signal.aborted ||
      usedView.current === view
    )
      return;

    const [action] = control;

    // Disable replay synchronously, before a render or a provider popup.
    usedView.current = view;
    setBusy(true);
    let next: View = { state: 'stopped' };

    try {
      let step: Step | undefined;

      if (action === 'open') {
        // Call in the original click stack to preserve browser user activation.
        const result = await openProvider();

        if (signal.aborted) return;

        step =
          result === null
            ? { action: 'cancel' }
            : { action: 'finish', ...providerResultSchema.parse(result) };
      } else if (action !== 'inspect') {
        step = { action };
      }

      const status = await requestStep(signal, step);

      if (
        status &&
        (!('phone_suffix' in view) || status.phone_suffix === view.phone_suffix)
      ) {
        if (step?.action === 'cancel') {
          next = { state: 'cancelled' };
        } else if (!step && status.state === 'confirmed') {
          // An inspection cannot tell whether the history choice was already recorded.
          next = { ...status, state: 'confirmed_on_inspect' };
        } else {
          next = status;
        }
      }
    } catch {
      // An uncertain outcome is terminal for this visit. Never resend the step.
    } finally {
      if (!signal.aborted) {
        setView(next);
        setBusy(false);
      }
    }
  }

  return (
    <section aria-label="Supervised WhatsApp signup" className="space-y-3">
      <h2>Supervised WhatsApp signup</h2>
      <p>This screen does not activate the connection or start an import.</p>
      <div role="status">
        {busy ? <p>Waiting for this step to finish…</p> : null}
        {'phone_suffix' in view ? (
          <p>WhatsApp number ending in {view.phone_suffix}</p>
        ) : null}
        {message ? <p>{message}</p> : null}
      </div>
      {view.state === 'prepared' ? (
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={accepted}
            disabled={busy}
            onChange={(event) => setAccepted(event.target.checked)}
          />
          I will select the WhatsApp number shown above.
        </label>
      ) : null}
      {control ? (
        <Button
          key={view.state}
          type="button"
          disabled={disabled}
          onClick={() => void act()}
        >
          {control[1]}
        </Button>
      ) : null}
    </section>
  );
}
