'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { loadDiscoverySdk } from '@/lib/whatsapp/coexistence/discovery-sdk';
import { openDiscoveryPreview, type DiscoverySdk } from '@/lib/whatsapp/coexistence/discovery-provider';

export function LaunchOnlyWhatsApp({ appId, configId }: { appId: string; configId: string }) {
  const [sdk, setSdk] = useState<DiscoverySdk | null>(null);
  const [opened, setOpened] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void loadDiscoverySdk(controller.signal).then((loaded) => {
      if (!controller.signal.aborted) setSdk(loaded);
    });

    return () => controller.abort();
  }, []);

  return (
    <section className="space-y-3">
      <p className="text-muted-foreground text-sm">Close the Meta window before continuing. This preview won’t connect your account.</p>
      <Button type="button" disabled={!sdk || opened} onClick={() => {
        if (!sdk || opened) return;
        setOpened(true);

        try { openDiscoveryPreview(sdk, appId, configId); }
        catch { setFailed(true); }
      }}>Open Meta</Button>
      {failed ? <p role="status">Meta could not be opened. Reload to try again.</p> : null}
    </section>
  );
}
