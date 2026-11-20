'use client';

import { useCallback, useState } from 'react';
import {
  Download,
  FileText,
  ImageOff,
  Loader2,
  Maximize2,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'use-intl';
import { cn } from '@/lib/utils';
import type { Message } from '@/types';
import { downloadMediaMessage } from '@/lib/media/download';
import { shouldDownloadDocumentClick } from '@/lib/media/document-click';
import { useMediaBlobUrl } from '@/hooks/use-media-blob-url';
import { isPrivateMediaUrl } from '@/lib/media/blob-cache';

/**
 * The media renderers behind `<MessageBubble>`'s image / video / audio /
 * document cases. Split out of message-bubble.tsx so that file stays a
 * thin content switch — everything here is about the two affordances
 * issue #373 asked for: open it full-size, and save it.
 *
 * Both are less trivial than they look, because the two flavours of
 * `media_url` behave differently in the browser. See
 * `@/lib/media/blob-cache` for the proxy-vs-bucket split and
 * `@/lib/media/download` for why `<a download>` alone isn't enough.
 */

type Translator = ReturnType<typeof useTranslations>;

/** Inline media size cap, shared so the four bubbles can't drift apart. */
const MEDIA_BOX = 'max-h-64 max-w-60';

export function MediaUnavailable({
  label,
  t,
}: {
  label: string;
  t: Translator;
}) {
  return (
    <div
      role="status"
      className="bg-muted/40 text-muted-foreground flex items-center gap-2 rounded-lg px-3 py-2 text-xs"
    >
      <ImageOff className="text-muted-foreground h-4 w-4 shrink-0" />
      <span>{t('unavailable', { label })}</span>
    </div>
  );
}

/**
 * Kicks off a download and reports failure as a toast. Kept as a hook so
 * each bubble owns its own in-flight state — a slow 16 MB video shouldn't
 * put a spinner on every other attachment in the thread.
 */
function useMediaDownload(message: Message, t: Translator) {
  const [downloading, setDownloading] = useState(false);
  const [failed, setFailed] = useState(false);

  const download = useCallback(async () => {
    if (downloading) return;
    setDownloading(true);
    setFailed(false);

    try {
      await downloadMediaMessage(message);
    } catch {
      setFailed(true);
      toast.error(t('downloadFailed'));
    } finally {
      setDownloading(false);
    }
  }, [downloading, message, t]);

  return { downloading, download, failed };
}

function MediaActionButton({
  icon: Icon,
  label,
  onClick,
  busy = false,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-label={label}
      title={label}
      // Own surface rather than inheriting the bubble's, so the same button
      // reads on the muted inbound fill, the primary outbound fill, and on
      // top of an arbitrary photo.
      className="border-border/60 bg-background/85 text-foreground hover:bg-background flex h-7 w-7 items-center justify-center rounded-full border shadow-sm backdrop-blur-sm transition-colors disabled:opacity-60"
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Icon className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

export function MediaRetryButton({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('AccountAccess');

  return (
    <button
      type="button"
      onClick={onRetry}
      className="text-foreground rounded px-2 py-1 text-sm underline"
    >
      {t('retry')}
    </button>
  );
}

function MediaPlaceholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-muted flex h-40 w-60 items-center justify-center rounded-lg">
      {children}
    </div>
  );
}

export function MediaImageBubble(props: {
  message: Message;
  onOpen?: () => void;
  t: Translator;
}) {
  return <MediaImageContent key={props.message.media_url} {...props} />;
}

function MediaImageContent({
  message,
  onOpen,
  t,
}: {
  message: Message;
  /** Opens the thread's lightbox on this message. Omitted ⇒ not clickable. */
  onOpen?: () => void;
  t: Translator;
}) {
  const { src, status, retry } = useMediaBlobUrl(message.media_url);
  // The fetch can succeed and the bytes still not be a decodable image.
  const [broken, setBroken] = useState(false);
  const { downloading, download } = useMediaDownload(message, t);

  if (status === 'error' || broken) {
    return (
      <MediaPlaceholder>
        <div>
          <MediaUnavailable label={t('photo')} t={t} />
          {message.media_url && isPrivateMediaUrl(message.media_url) && (
            <MediaRetryButton
              onRetry={() => {
                setBroken(false);
                retry();
              }}
            />
          )}
        </div>
      </MediaPlaceholder>
    );
  }

  if (status !== 'ready' || !src) {
    return (
      <MediaPlaceholder>
        <div
          role="status"
          aria-busy="true"
          aria-label={t('imageAlt')}
          className="border-primary h-5 w-5 animate-spin rounded-full border-2 border-t-transparent"
        />
      </MediaPlaceholder>
    );
  }

  const image = (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={t('imageAlt')}
      className={cn(MEDIA_BOX, 'rounded-lg object-contain')}
      onError={() => setBroken(true)}
    />
  );

  return (
    <div className="group/media relative w-fit">
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={t('viewImage')}
          className="focus-visible:ring-ring block cursor-zoom-in rounded-lg ring-offset-2 ring-offset-transparent outline-none focus-visible:ring-2"
        >
          {image}
        </button>
      ) : (
        image
      )}
      {/* Hover-only: on touch there is no hover, but tapping the image opens
          the viewer, which carries a full-size Download button. */}
      <div className="absolute right-2 bottom-2 opacity-0 transition-opacity group-focus-within/media:opacity-100 group-hover/media:opacity-100">
        <MediaActionButton
          icon={Download}
          label={t('download')}
          onClick={download}
          busy={downloading}
        />
      </div>
    </div>
  );
}

/** Key by URL at each call site so replacement media resets decode failures. */
export function PrivateMediaPlayer({
  url,
  kind,
  className,
  label,
  unavailable,
}: {
  url: string;
  kind: 'audio' | 'video';
  className: string;
  label: string;
  unavailable: string;
}) {
  // The server caps private responses at 16 MiB; local blobs support seeking without Range.
  const { src, status, retry } = useMediaBlobUrl(url);
  const [broken, setBroken] = useState(false);

  if (status === 'error' || broken) {
    return (
      <div role="status" className="text-muted-foreground p-3 text-sm">
        {unavailable}
        <MediaRetryButton
          onRetry={() => {
            setBroken(false);
            retry();
          }}
        />
      </div>
    );
  }

  if (!src || status !== 'ready') {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label={label}
        className="bg-muted flex h-20 min-w-40 items-center justify-center rounded-lg"
      >
        <Loader2 aria-hidden="true" className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  return kind === 'video' ? (
    <video
      src={src}
      controls
      preload="metadata"
      aria-label={label}
      className={className}
      onError={() => setBroken(true)}
    />
  ) : (
    <audio
      src={src}
      controls
      aria-label={label}
      className={className}
      onError={() => setBroken(true)}
    />
  );
}

export function MediaVideoBubble({
  message,
  onOpen,
  t,
}: {
  message: Message;
  onOpen?: () => void;
  t: Translator;
}) {
  const { downloading, download } = useMediaDownload(message, t);

  return (
    <div className="relative w-fit">
      {message.media_url && isPrivateMediaUrl(message.media_url) ? (
        <PrivateMediaPlayer
          key={message.media_url}
          url={message.media_url}
          kind="video"
          label={t('video')}
          unavailable={t('unavailable', { label: t('video') })}
          className={cn(MEDIA_BOX, 'rounded-lg')}
        />
      ) : (
        <video
          src={message.media_url}
          controls
          preload="metadata"
          className={cn(MEDIA_BOX, 'rounded-lg')}
        />
      )}
      {/* Top-right, clear of the native controls — and always visible, since
          expanding is the only way to watch a clip capped at 15rem wide and
          a touch device gets no hover. */}
      <div className="absolute top-2 right-2 flex gap-1">
        {onOpen && (
          <MediaActionButton
            icon={Maximize2}
            label={t('expandVideo')}
            onClick={onOpen}
          />
        )}
        <MediaActionButton
          icon={Download}
          label={t('download')}
          onClick={download}
          busy={downloading}
        />
      </div>
    </div>
  );
}

export function MediaAudioBubble({
  message,
  t,
}: {
  message: Message;
  t: Translator;
}) {
  const { downloading, download } = useMediaDownload(message, t);

  return (
    <div className="flex items-center gap-2">
      {message.media_url && isPrivateMediaUrl(message.media_url) ? (
        <PrivateMediaPlayer
          key={message.media_url}
          url={message.media_url}
          kind="audio"
          label={t('audio')}
          unavailable={t('unavailable', { label: t('audio') })}
          className="max-w-60"
        />
      ) : (
        <audio src={message.media_url} controls className="max-w-60" />
      )}
      <MediaActionButton
        icon={Download}
        label={t('download')}
        onClick={download}
        busy={downloading}
      />
    </div>
  );
}

export function MediaDocumentBubble(props: {
  message: Message;
  t: Translator;
}) {
  return <MediaDocumentContent key={props.message.media_url} {...props} />;
}

function MediaDocumentContent({
  message,
  t,
}: {
  message: Message;
  t: Translator;
}) {
  const { downloading, download, failed } = useMediaDownload(message, t);

  if (failed && message.media_url && isPrivateMediaUrl(message.media_url)) {
    return (
      <div>
        <MediaUnavailable label={t('document')} t={t} />
        <MediaRetryButton onRetry={download} />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <a
        href={message.media_url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => {
          if (!shouldDownloadDocumentClick(message.media_url, event)) return;
          event.preventDefault();
          void download();
        }}
        aria-busy={downloading || undefined}
        className="bg-muted/50 hover:bg-muted flex min-w-0 flex-1 items-center gap-2 rounded-lg px-3 py-2 text-sm"
      >
        <FileText className="text-muted-foreground h-5 w-5 shrink-0" />
        <span className="truncate">
          {message.content_text || t('document')}
        </span>
      </a>
      <MediaActionButton
        icon={Download}
        label={t('download')}
        onClick={download}
        busy={downloading}
      />
    </div>
  );
}
