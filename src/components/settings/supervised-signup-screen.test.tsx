import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { SupervisedSignupScreen } from './supervised-signup-screen';

afterEach(() => vi.unstubAllGlobals());

it('renders only a deliberate read-only inspection control on a fresh visit', () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const openProvider = vi.fn();

  const html = renderToStaticMarkup(
    <SupervisedSignupScreen openProvider={openProvider} />
  );

  expect(html).toContain('Supervised WhatsApp signup');
  expect(html.match(/<button\b/g)).toHaveLength(1);
  expect(html).toMatch(
    /<button\b[^>]*\btype="button"[^>]*>Inspect signup<\/button>/
  );
  expect(fetch).not.toHaveBeenCalled();
  expect(openProvider).not.toHaveBeenCalled();
});
