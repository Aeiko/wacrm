import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { assertLegacyMediaAccess } from '@/lib/whatsapp/legacy-media-access';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { getT } from '@/lib/i18n/translate';
import {
  MEDIA_PROXY_CSP,
  mediaProxyHeaders,
} from '@/lib/media/proxy-response-headers';

const t = getT('Api');

export async function GET(
  request: Request,
  context: { params: Promise<{ mediaId: string }> }
) {
  const response = await handleGet(request, context);
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Content-Security-Policy', MEDIA_PROXY_CSP);

  return response;
}

async function handleGet(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const { mediaId } = await params;

    if (!/^\d+$/.test(mediaId)) {
      return NextResponse.json(
        { error: t('media.idRequired') },
        { status: 400 }
      );
    }

    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: t('common.unauthorized') },
        { status: 401 }
      );
    }

    const limit = checkRateLimit(
      `whatsapp-media:${user.id}`,
      RATE_LIMITS.whatsappMedia
    );

    if (!limit.success) return rateLimitResponse(limit);

    // Resolve the caller's account_id — whatsapp_config is one-per-
    // account post-multi-user, so a teammate fetching media for a
    // conversation in the shared inbox needs the account's config,
    // not their personal (non-existent) row.
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle();

    const accountId = profile?.account_id as string | undefined;

    if (profileError || !accountId) {
      return NextResponse.json(
        { error: t('common.profileNotLinked') },
        { status: 403 }
      );
    }

    // Fetch and decrypt WhatsApp config
    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single();

    if (configError || !config) {
      return NextResponse.json(
        { error: t('common.whatsappNotConfigured') },
        { status: 400 }
      );
    }

    const accessToken = decrypt(config.access_token);

    const admin = supabaseAdmin();
    let phoneNumberId: string;

    try {
      phoneNumberId = await assertLegacyMediaAccess(
        admin,
        config,
        accessToken,
        mediaId
      );
    } catch {
      return NextResponse.json(
        { error: t('media.fetchFailed') },
        { status: 404 }
      );
    }

    const mediaInfo = await getMediaUrl({
      mediaId,
      phoneNumberId,
      accessToken,
    });

    // Download the binary data
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: mediaInfo.url,
      accessToken,
    });

    // Do not release bytes after onboarding, credential rotation, or private classification.
    try {
      const currentProfile = await supabase
        .from('profiles')
        .select('account_id')
        .eq('user_id', user.id)
        .maybeSingle();

      if (currentProfile.error || currentProfile.data?.account_id !== accountId)
        throw new Error();
      await assertLegacyMediaAccess(admin, config, accessToken, mediaId);
    } catch {
      return NextResponse.json(
        { error: t('media.fetchFailed') },
        { status: 404 }
      );
    }

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: mediaProxyHeaders(mediaId, contentType || mediaInfo.mimeType),
    });
  } catch {
    console.error('WhatsApp media GET failed');

    return NextResponse.json(
      { error: t('media.fetchFailed') },
      { status: 500 }
    );
  }
}
