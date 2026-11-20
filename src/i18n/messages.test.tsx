import { renderToStaticMarkup } from 'react-dom/server';
import { useFormatter, useTimeZone, useTranslations } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import { getServerIntlConfig } from './config';
import { IntlProvider } from './intl-provider';

afterEach(() => vi.unstubAllEnvs());

const timestamp = new Date('2026-06-15T01:30:00Z');

function EnglishContent() {
  const templates = useTranslations('Settings.templates');
  const members = useTranslations('Settings.members');
  const format = useFormatter();
  const timeZone = useTimeZone();

  return (
    <>
      <p>{templates.raw('bodyPlaceholder')}</p>
      <p>{members.rich('noPendingDesc', { bold: (text) => <b>{text}</b> })}</p>
      <time data-zone={timeZone}>
        {format.dateTime(timestamp, { hour: '2-digit', minute: '2-digit' })}
      </time>
    </>
  );
}

it('renders the English UI using the server default time zone', () => {
  vi.stubEnv('NEXT_PUBLIC_APP_LOCALE', 'es');

  const config = getServerIntlConfig();

  const html = renderToStaticMarkup(
    <IntlProvider {...config}>
      <EnglishContent />
    </IntlProvider>
  );

  expect(config.locale).toBe('en');
  expect(html).toContain('Hello {{1}}, your order {{2}} is confirmed.');
  expect(html).toContain('Click <b>Invite member</b> above to generate a shareable link.');

  const serverFormatter = Intl.DateTimeFormat('en', {
    hour: '2-digit',
    minute: '2-digit',
  });

  const { timeZone } = serverFormatter.resolvedOptions();

  expect(html).toContain(
    `<time data-zone="${timeZone}">${serverFormatter.format(timestamp)}</time>`
  );
});
