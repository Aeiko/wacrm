'use client';

import { useEffect, useState } from 'react';
import { z } from 'zod';
import {
  createDiscoveryProvider,
  type DiscoverySdk,
} from '@/lib/whatsapp/coexistence/discovery-provider';
import { loadDiscoverySdk } from '@/lib/whatsapp/coexistence/discovery-sdk';
import { SupervisedDiscoveryScreen } from './supervised-discovery-screen';

const workspaceLabel = z.string().refine((label) => label.trim().length > 0);
const metaId = z.string().regex(/^[1-9]\d{0,31}$/);

const inspectionSchema = z.union([
  z.object({
    status: z.literal('available'),
    workspace: workspaceLabel,
    appId: metaId,
    loginConfigId: metaId,
  }),
  z.object({
    status: z.enum(['linked', 'pending']),
    workspace: workspaceLabel,
  }),
  z.object({ status: z.literal('unavailable'), workspace: z.string() }),
]);

type Inspection = z.infer<typeof inspectionSchema>;

export async function inspectDiscovery(
  signal: AbortSignal
): Promise<Inspection> {
  try {
    const response = await fetch('/supervised-discovery', {
      method: 'GET',
      mode: 'same-origin',
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      signal,
    });

    if (response.ok) return inspectionSchema.parse(await response.json());
  } catch {
    // Never offer a launch without a valid, current inspection.
  }

  return { status: 'unavailable', workspace: '' };
}

const messages = {
  linked:
    'This workspace already has a WhatsApp connection. It cannot be replaced here.',
  pending:
    'A WhatsApp connection is already pending for this workspace. You cannot start another here.',
  unavailable: 'WhatsApp signup is unavailable for the current workspace.',
};

export function DiscoveryStatus({
  inspection,
  sdk,
}: {
  inspection: Inspection | null;
  sdk: DiscoverySdk | null | undefined;
}) {
  if (!inspection) return <p role="status">Checking the current workspace…</p>;

  return (
    <section className="space-y-3" aria-label="WhatsApp connection">
      {inspection.workspace ? <p>Workspace: {inspection.workspace}</p> : null}
      {inspection.status === 'available' ? (
        sdk ? (
          <SupervisedDiscoveryScreen
            workspace={inspection.workspace}
            openProvider={() =>
              createDiscoveryProvider(
                sdk,
                inspection.appId,
                inspection.loginConfigId
              )()
            }
          />
        ) : (
          <p role="status">
            {sdk === undefined
              ? 'Loading WhatsApp signup…'
              : 'WhatsApp signup is unavailable in this browser.'}
          </p>
        )
      ) : (
        <p role="status">{messages[inspection.status]}</p>
      )}
    </section>
  );
}

export function DiscoveryClient() {
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [sdk, setSdk] = useState<DiscoverySdk | null>();

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    void inspectDiscovery(signal).then(async (result) => {
      if (signal.aborted) return;
      setInspection(result);

      if (result.status !== 'available') return;
      const sdk = await loadDiscoverySdk(signal);

      if (!signal.aborted) setSdk(sdk);
    });

    return () => controller.abort();
  }, []);

  return <DiscoveryStatus inspection={inspection} sdk={sdk} />;
}
