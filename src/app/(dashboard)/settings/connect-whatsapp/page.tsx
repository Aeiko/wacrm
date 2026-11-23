import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DiscoveryClient } from '@/components/settings/discovery-client';
import { LaunchOnlyWhatsApp } from '@/components/settings/launch-only-whatsapp';
import { createClient } from '@/lib/supabase/server';
import { getCurrentAccount } from '@/lib/auth/account';

export default async function ConnectWhatsAppPage() {
  const preview = process.env.WHATSAPP_MEMBER_LAUNCH_PREVIEW === 'true';
  const appId = process.env.WHATSAPP_COEXISTENCE_APP_ID ?? '';
  const configId = process.env.WHATSAPP_COEXISTENCE_LOGIN_CONFIG_ID ?? '';

  if (preview) {
    const db = await createClient();
    const { data, error } = await db.auth.getUser();

    if (error || !data.user?.email_confirmed_at) notFound();

    const account = await getCurrentAccount(db).catch(() => null);

    if (account?.userId !== data.user.id || ![appId, configId].every((value) => /^[1-9]\d{0,31}$/.test(value))) notFound();
  }

  return (
    <div className="max-w-xl space-y-4">
      <Link href="/settings?tab=whatsapp" className="text-sm underline">
        Back to WhatsApp settings
      </Link>
      <h1 className="text-foreground text-2xl font-bold tracking-tight">
        Connect WhatsApp
      </h1>
      {preview ? <LaunchOnlyWhatsApp appId={appId} configId={configId} /> : <DiscoveryClient />}
    </div>
  );
}
