import { writeFileSync } from 'node:fs';
import { IntlProvider } from '@/i18n/intl-provider';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import messages from '../../../messages/en.json';
import { HistoryRequestForm } from './coexistence-history-request-form';

// Set these only from the isolated rehearsal runner, with synthetic review data
// and a destination in its disposable directory.
const reviewJson = process.env.WACRM_OWNER_REVIEW;
const formPath = process.env.WACRM_OWNER_FORM_PATH;

if (reviewJson && formPath) {
  it('exports static owner form markup for the isolated browser rehearsal', () => {
    const markup = renderToStaticMarkup(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <HistoryRequestForm role="owner" review={JSON.parse(reviewJson)} />
      </IntlProvider>
    );

    expect(markup).toMatch(/<form\b[^>]*\baction="\/history-request"/);
    writeFileSync(formPath, markup, 'utf8');
  });
} else {
  it.skip('exports static owner form markup for the isolated browser rehearsal');
}
