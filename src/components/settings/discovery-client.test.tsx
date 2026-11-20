import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import {
  DiscoveryClient,
  DiscoveryStatus,
  inspectDiscovery,
} from './discovery-client';

afterEach(() => vi.unstubAllGlobals());

const workspace = 'Current workspace (fixture-id)';

const available = {
  status: 'available',
  workspace,
  appId: '123',
  loginConfigId: '456',
} as const;

const sdk = { init: vi.fn(), login: vi.fn() };

it('waits for the server inspection without rendering a launch on the initial page', () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const html = renderToStaticMarkup(<DiscoveryClient />);

  expect(html).toContain('Checking the current workspace');
  expect(html).not.toContain('<button');
  expect(fetch).not.toHaveBeenCalled();
});

it('inspects the authenticated current workspace and requires the preloaded SDK', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json(available));
  vi.stubGlobal('fetch', fetch);
  const signal = new AbortController().signal;
  const inspection = await inspectDiscovery(signal);

  expect(fetch).toHaveBeenCalledExactlyOnceWith('/supervised-discovery', {
    method: 'GET',
    mode: 'same-origin',
    credentials: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
    signal,
  });

  const withoutSdk = renderToStaticMarkup(
    <DiscoveryStatus inspection={inspection} sdk={null} />
  );

  expect(withoutSdk).toContain(
    'WhatsApp signup is unavailable in this browser'
  );
  expect(withoutSdk).not.toContain('<button');

  const ready = renderToStaticMarkup(
    <DiscoveryStatus inspection={inspection} sdk={sdk} />
  );

  expect(ready).toContain(`Workspace: ${workspace}`);
  expect(ready).toContain('Authorize launch');
  expect(sdk.init).not.toHaveBeenCalled();
  expect(sdk.login).not.toHaveBeenCalled();
});

it.each([
  ['linked', 'It cannot be replaced here'],
  ['pending', 'already pending for this workspace'],
  ['unavailable', 'unavailable for the current workspace'],
] as const)('shows %s without a signup action', async (status, message) => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ status, workspace }))
  );

  const inspection = await inspectDiscovery(new AbortController().signal);

  const html = renderToStaticMarkup(
    <DiscoveryStatus inspection={inspection} sdk={sdk} />
  );

  expect(html).toContain(`Workspace: ${workspace}`);
  expect(html).toContain(message);
  expect(html).not.toContain('<button');
});

it.each([
  Response.json(available, { status: 401 }),
  Response.json({ ...available, appId: undefined }),
])('fails closed on failed or invalid inspection', async (response) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

  expect(await inspectDiscovery(new AbortController().signal)).toEqual({
    status: 'unavailable',
    workspace: '',
  });
});
