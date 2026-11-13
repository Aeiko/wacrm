import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Contact } from '@/types';

const auth = vi.hoisted(() => ({ accountId: 'account-a' }));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => auth }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/components/ui/dialog', () => {
  const Part = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  return Object.fromEntries([
    'Dialog', 'DialogContent', 'DialogHeader', 'DialogTitle',
    'DialogDescription', 'DialogFooter',
  ].map((name) => [name, Part]));
});

import { ContactForm } from './contact-form';

const contact = {
  id: 'contact-a', name: 'Ada', phone: '+14155552671',
  email: 'ada@example.com', company: 'Analytical Engines',
} as Contact;
const props = {
  open: true, contact, onOpenChange: vi.fn(), onSaved: vi.fn(),
};

beforeEach(() => {
  auth.accountId = 'account-a';
  vi.stubGlobal('React', React);
});

afterEach(() => vi.unstubAllGlobals());

describe('contact form draft lifecycle', () => {
  it('renders saved fields immediately, without waiting for a reset effect', () => {
    const html = renderToStaticMarkup(<ContactForm {...props} />);
    for (const value of [contact.name, contact.phone, contact.email, contact.company]) {
      expect(html).toContain(`value="${value}"`);
    }
    expect(html).toContain('loadingTags');
  });

  it('unmounts a closed draft and gives contacts and memberships separate identities', () => {
    expect(ContactForm({ ...props, open: false })).toBeNull();
    const first = ContactForm(props);
    expect(ContactForm(props)?.key).toBe(first?.key);
    expect(ContactForm({ ...props, contact: { ...contact, id: 'contact-b' } })?.key)
      .not.toBe(first?.key);
    auth.accountId = 'account-b';
    expect(ContactForm(props)?.key).not.toBe(first?.key);
  });
});
