import Link from 'next/link';
import { DiscoveryClient } from '@/components/settings/discovery-client';

export default function ConnectWhatsAppPage() {
  return (
    <div className="max-w-xl space-y-4">
      <Link href="/settings?tab=whatsapp" className="text-sm underline">
        Back to WhatsApp settings
      </Link>
      <h1 className="text-foreground text-2xl font-bold tracking-tight">
        Connect WhatsApp
      </h1>
      <DiscoveryClient />
    </div>
  );
}
