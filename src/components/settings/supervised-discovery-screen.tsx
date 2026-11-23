'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  signupCodeSchema,
  signupPhoneSchema,
} from '@/lib/whatsapp/coexistence/signup-contract';

const workspace = z.string().refine((label) => label.trim().length > 0);
const metaId = z.string().regex(/^[1-9]\d{0,31}$/);

const launchSchema = z.object({
  status: z.literal('launch_authorized'),
  state: z.string().min(1),
  workspace,
});

const verifiedSchema = z.object({
  status: z.literal('verified'),
  workspace,
  preview: z.object({
    waba_id: metaId,
    phone_number_id: metaId,
    normalized_phone_number: signupPhoneSchema,
  }),
});

const confirmedSchema = z.object({
  status: z.literal('confirmed'),
  activation_available: z.literal(true).optional(),
});

const activatedSchema = z.object({ status: z.literal('activated') });

type View =
  | { status: 'stopped' | 'cancelled' | 'confirmed' | 'activated' }
  | { status: 'idle'; workspace: string }
  | (z.infer<typeof launchSchema> & { intendedPhone: string })
  | {
      status: 'code_ready';
      state: string;
      workspace: string;
      intendedPhone: string;
      code: string;
    }
  | (Omit<z.infer<typeof verifiedSchema>, 'status'> & {
      status: 'verified' | 'activation_available';
      state: string;
    });

type Command =
  | { action: 'launch'; intended_phone: string }
  | { action: 'finish'; state: string; code: string }
  | {
      action: 'confirm';
      state: string;
      waba_id: string;
      phone_number_id: string;
    }
  | {
      action: 'activate';
      state: string;
      waba_id: string;
      phone_number_id: string;
      normalized_phone_number: string;
    };

async function post<T>(
  command: Command,
  schema: z.ZodType<T>,
  signal: AbortSignal
): Promise<T> {
  const response = await fetch('/supervised-discovery', {
    method: 'POST',
    mode: 'same-origin',
    credentials: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });

  if (!response.ok) throw new Error('Discovery request failed');

  return schema.parse(await response.json());
}

type OpenProvider = () => Promise<string | null>;

export async function advanceDiscovery(
  view: View,
  openProvider: OpenProvider,
  signal: AbortSignal,
  phone?: string
): Promise<View> {
  try {
    switch (view.status) {
      case 'idle': {
        const intendedPhone = signupPhoneSchema.safeParse(phone);

        if (!intendedPhone.success) return view;

        const launch = await post(
          { action: 'launch', intended_phone: intendedPhone.data },
          launchSchema,
          signal
        );

        return launch.workspace === view.workspace
          ? { ...launch, intendedPhone: intendedPhone.data }
          : { status: 'stopped' };
      }

      case 'launch_authorized': {
        // Open inside the click stack, before awaiting anything.
        const code = await openProvider();

        return code === null
          ? { status: 'cancelled' }
          : {
              ...view,
              status: 'code_ready',
              code: signupCodeSchema.parse(code),
            };
      }

      case 'code_ready': {
        const verified = await post(
          { action: 'finish', state: view.state, code: view.code },
          verifiedSchema,
          signal
        );

        return verified.workspace === view.workspace &&
          verified.preview.normalized_phone_number === view.intendedPhone
          ? { ...verified, state: view.state }
          : { status: 'stopped' };
      }

      case 'verified': {
        const { waba_id, phone_number_id } = view.preview;

        const receipt = await post(
          { action: 'confirm', state: view.state, waba_id, phone_number_id },
          confirmedSchema,
          signal
        );

        return receipt.activation_available
          ? { ...view, status: 'activation_available' }
          : { status: 'confirmed' };
      }

      case 'activation_available':
        return await post(
          { action: 'activate', state: view.state, ...view.preview },
          activatedSchema,
          signal
        );

      default:
        return view;
    }
  } catch {
    // A failed or uncertain step is terminal for this visit.
    return { status: 'stopped' };
  }
}

const controls: Partial<Record<View['status'], string>> = {
  idle: 'Authorize launch',
  launch_authorized: 'Open WhatsApp signup',
  code_ready: 'Verify selected number',
  verified: 'Confirm verified number',
  activation_available: 'Activate WhatsApp connection',
};

export function SupervisedDiscoveryScreen({
  workspace,
  openProvider,
}: {
  workspace: string;
  openProvider: OpenProvider;
}) {
  const [view, setView] = useState<View>({ status: 'idle', workspace });
  const [busy, setBusy] = useState(false);
  const usedSteps = useRef(new Set<View['status']>());
  const lifetime = useRef<AbortController | null>(null);

  useLayoutEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;

    return () => controller.abort();
  }, []);

  async function act(phone?: string) {
    const signal = lifetime.current?.signal;

    if (
      !controls[view.status] ||
      (view.status === 'idle' && !signupPhoneSchema.safeParse(phone).success) ||
      !signal ||
      signal.aborted ||
      usedSteps.current.has(view.status)
    )
      return;

    usedSteps.current.add(view.status);
    setBusy(true);

    const next = await advanceDiscovery(view, openProvider, signal, phone);

    if (!signal.aborted) {
      setView(next);
      setBusy(false);
    }
  }

  return <DiscoveryPanel view={view} busy={busy} act={act} />;
}

export function DiscoveryPanel({
  view,
  busy,
  act,
}: {
  view: View;
  busy: boolean;
  act: (phone?: string) => Promise<void>;
}) {
  const control = controls[view.status];

  return (
    <div className="space-y-3">
      <p>
        Verify a number from the WhatsApp Business app. This does not activate
        the connection or start an import.
      </p>
      <div role="status">
        {view.status === 'activated' ? (
          <p>
            WhatsApp connection active. No history or contacts import was
            enabled.
          </p>
        ) : null}
        {view.status === 'activation_available' ? (
          <p>Destination workspace: {view.workspace}</p>
        ) : null}
        {view.status === 'verified' ||
        view.status === 'activation_available' ? (
          <p>
            Verified WhatsApp number: {view.preview.normalized_phone_number}
          </p>
        ) : null}
        {busy ? <p>Waiting for this step to finish…</p> : null}
        {view.status === 'confirmed' ? (
          <p>Number confirmed. The connection is pending and is not active.</p>
        ) : null}
        {view.status === 'cancelled' ? (
          <p>WhatsApp signup was cancelled. Contact your operator.</p>
        ) : null}
        {view.status === 'stopped' ? (
          <p>Discovery stopped. Do not retry. Contact your operator.</p>
        ) : null}
      </div>
      {view.status === 'idle' ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();

            const phone = signupPhoneSchema.safeParse(
              new FormData(event.currentTarget).get('intended_phone')
            );

            if (phone.success) void act(phone.data);
          }}
        >
          <label htmlFor="intended-phone">WhatsApp Business phone number</label>
          <Input
            id="intended-phone"
            aria-describedby="intended-phone-hint"
            name="intended_phone"
            type="tel"
            autoComplete="tel"
            required
            pattern="\+[1-9][0-9]{7,14}"
            maxLength={16}
            disabled={busy}
          />
          <p id="intended-phone-hint" className="text-muted-foreground text-sm">
            Include the + and country code, without spaces. Example:
            +12025550123.
          </p>
          <Button type="submit" disabled={busy}>
            {control}
          </Button>
        </form>
      ) : control ? (
        <Button type="button" disabled={busy} onClick={() => void act()}>
          {control}
        </Button>
      ) : null}
    </div>
  );
}
