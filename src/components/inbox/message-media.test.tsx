import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useTranslations } from 'use-intl';
import { IntlProvider } from '@/i18n/intl-provider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import type { Message } from '@/types';
import {
  MediaAudioBubble,
  MediaRetryButton,
  MediaVideoBubble,
} from './message-media';

function Playback({
  Component,
  message,
}: {
  Component: typeof MediaAudioBubble;
  message: Message;
}) {
  const t = useTranslations('Inbox.bubble');

  return <Component message={message} t={t} />;
}

function markup(Component: typeof MediaAudioBubble, message: Message): string {
  return renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <Playback Component={Component} message={message} />
    </IntlProvider>
  );
}

const message: Message = {
  id: '12345678-1234-4234-8234-123456789abc',
  conversation_id: 'conversation',
  sender_type: 'customer',
  content_type: 'video',
  media_url:
    '/api/whatsapp/coexistence/media/12345678-1234-4234-8234-123456789abc',
  status: 'delivered',
  created_at: '2026-08-04T14:15:30.000Z',
};

beforeEach(() => vi.stubGlobal('React', React));

afterEach(() => vi.unstubAllGlobals());

describe('private playback', () => {
  it('offers a localized manual retry without starting a request during render', () => {
    const retry = vi.fn();

    const html = renderToStaticMarkup(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <MediaRetryButton onRetry={retry} />
      </IntlProvider>
    );

    expect(html).toContain('type="button"');
    expect(html).toContain('>Retry</button>');
    expect(retry).not.toHaveBeenCalled();
  });

  it('loads private video and audio before handing local bytes to a player', () => {
    for (const Component of [MediaAudioBubble, MediaVideoBubble]) {
      const html = markup(Component, message);
      expect(html).not.toContain('src=');
      expect(html).toContain('aria-busy="true"');
      expect(html).toContain('role="status"');
    }
  });

  it('leaves legacy video and audio on their native streaming URLs', () => {
    for (const Component of [MediaAudioBubble, MediaVideoBubble]) {
      const html = markup(Component, {
        ...message,
        media_url: '/api/whatsapp/media/123',
      });

      expect(html).toContain('src="/api/whatsapp/media/123"');
      expect(html).not.toContain('aria-busy="true"');
    }
  });
});
