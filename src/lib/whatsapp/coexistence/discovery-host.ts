import { headers } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import {
  discoveryInvitationSchema,
  discoveryOwner,
  requireDiscoveryReceipt,
} from './discovery-signup';
import { hasSignupCookieCredentials, withSignupOwner } from './signup';
import { discoveryHostTransport } from './discovery-host-transport';

export function loadDiscoveryHost() {
  const raw = process.env.WHATSAPP_COEXISTENCE_DISCOVERY_INVITATION;

  if (
    process.env.WHATSAPP_COEXISTENCE_DISCOVERY_ENABLED !== 'true' ||
    process.env.WHATSAPP_COEXISTENCE_ENABLED !== 'true' ||
    !raw ||
    raw.length > 4096
  )
    return null;

  try {
    const invitation = discoveryInvitationSchema.parse(JSON.parse(raw));

    if (
      invitation.appId !== process.env.WHATSAPP_COEXISTENCE_APP_ID ||
      invitation.loginConfigId !==
        process.env.WHATSAPP_COEXISTENCE_LOGIN_CONFIG_ID
    )
      return null;

    const transport = discoveryHostTransport();

    return transport ? { invitation, transport } : null;
  } catch {
    return null;
  }
}

export async function discoveryPagePins() {
  const host = loadDiscoveryHost();

  if (!host) return null;

  try {
    const request = new Request('https://private.invalid/', {
      headers: await headers(),
    });

    if (!hasSignupCookieCredentials(request)) return null;

    const { invitation } = host;

    const response = await withSignupOwner(
      request,
      await createClient(),
      Date.now() + 10_000,
      async (_identity, service, signal, { attempt }) => {
        if (
          attempt?.id !== invitation.attemptId ||
          attempt.state !== 'prepared' ||
          attempt.intended_phone !== invitation.intendedPhone ||
          Date.parse(attempt.lease_until) <= Date.now()
        )
          return new Response(null, { status: 403 });

        await requireDiscoveryReceipt(service, invitation, signal);

        return new Response(null, { status: 204 });
      },
      discoveryOwner(invitation)
    );

    return response.status === 204
      ? { appId: invitation.appId, loginConfigId: invitation.loginConfigId }
      : null;
  } catch {
    return null;
  }
}
