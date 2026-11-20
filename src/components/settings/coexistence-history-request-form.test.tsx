import { IntlProvider } from '@/i18n/intl-provider';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import messages from '../../../messages/en.json';
import { HistoryRequestForm } from './coexistence-history-request-form';

const review = {
  context: 'ab'.repeat(32),
  decision_id: 'f03b95e0-1b95-4efe-9794-3909533a6fc8',
  request_id: '68553d9e-78aa-46a0-969b-809c4abb5ff9',
  phone_id_suffix: '0008',
  deadline_at: '2030-11-18T10:25:14+00:00',
};

function render(role: 'owner' | 'admin' | 'member', scope: typeof review | null) {
  return renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <HistoryRequestForm role={role} review={scope} />
    </IntlProvider>
  );
}

describe('HistoryRequestForm', () => {
  it('renders a passive, initially closed review for the supplied phone and deadline', () => {
    const markup = render('owner', review);
    expect(markup).toContain('<details><summary>Review history request</summary>');
    expect(markup).toContain('Linked WhatsApp phone ID ending in 0008');
    expect(markup).toContain(`<time dateTime="${review.deadline_at}">`);
    expect(markup).toContain('eligible one-to-one chats, including other chats');
    expect(markup).toContain('does not sync your phone’s address book');
    expect(markup).toContain('does not mean the import is complete');
    expect(markup).toContain('If the outcome is unknown, do not retry.');
    expect(markup).not.toMatch(/<(?:script|link|iframe|img)\b|\son\w+=/);
    expect(render('owner', review)).toBe(markup);
  });

  it('posts only the reviewed scope and explicit, initially unchecked confirmation', () => {
    const markup = render('owner', review);
    const form = markup.match(/<form\b[^>]*>/)?.[0];
    expect(form).toContain('action="/history-request"');
    expect(form).toContain('method="post"');
    expect(markup).toContain('<button type="submit">Request history now</button>');
    expect(markup).not.toMatch(/\s(?:checked|novalidate|formnovalidate|formaction)\b/i);
    expect(
      Array.from(markup.matchAll(/\sname="([^"]+)"/g), ([, name]) => name)
    ).toEqual(['context', 'decision_id', 'request_id', 'confirmation']);
    expect(markup.match(/<input\b[^>]*>/g)).toEqual([
      `<input type="hidden" name="context" value="${review.context}"/>`,
      `<input type="hidden" name="decision_id" value="${review.decision_id}"/>`,
      `<input type="hidden" name="request_id" value="${review.request_id}"/>`,
      '<input type="checkbox" required="" name="confirmation" value="history-now-v1"/>',
    ]);
  });

  it.each(['admin', 'member'] as const)('renders nothing for %s', (role) => {
    expect(render(role, review)).toBe('');
  });

  it.each([
    ['missing review', null],
    ['invalid context', { ...review, context: 'ab'.repeat(31) }],
    ['invalid decision ID', { ...review, decision_id: '' }],
    ['invalid request ID', { ...review, request_id: 'not-a-uuid' }],
    ['full phone ID', { ...review, phone_id_suffix: '880008' }],
    ['invalid deadline', { ...review, deadline_at: '2030-02-30T10:25:14Z' }],
    ['missing timezone', { ...review, deadline_at: '2030-11-18T10:25:14' }],
    ['extra scope field', { ...review, action: '/different-action' }],
  ] as const)('renders nothing for %s', (_label, scope) => {
    expect(render('owner', scope)).toBe('');
  });
});
