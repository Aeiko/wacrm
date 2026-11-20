import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { english } from '@/i18n/config';
import { IntlProvider } from '@/i18n/intl-provider';

vi.mock('@/components/ui/dialog', () => {
  const Container = ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  );

  return {
    Dialog: Container,
    DialogContent: Container,
    DialogHeader: Container,
    DialogTitle: Container,
  };
});

import { QuickReplyPicker } from './quick-reply-picker';

describe('QuickReplyPicker initial loading', () => {
  it('shows loading, not a false empty result, when initially opened', () => {
    const html = renderToStaticMarkup(
      <IntlProvider {...english} timeZone="UTC">
        <QuickReplyPicker open onOpenChange={() => {}} onPick={() => {}} />
      </IntlProvider>
    );

    expect(html).toContain('animate-spin');
    expect(html).not.toContain('No quick replies yet.');
  });
});
