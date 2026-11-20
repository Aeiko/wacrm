import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import {
  advanceDiscovery,
  DiscoveryPanel,
  SupervisedDiscoveryScreen,
} from './supervised-discovery-screen';

afterEach(() => vi.unstubAllGlobals());

const code = 'synthetic-sdk-code';
const number = '+15555550102';

const launch = {
  status: 'launch_authorized',
  state: 'one-use-state',
  workspace: 'Current workspace (fixture-id)',
} as const;

const authorizedView = { ...launch, intendedPhone: number };

const verified = {
  status: 'verified',
  workspace: launch.workspace,
  preview: {
    waba_id: '2468',
    phone_number_id: '1357',
    normalized_phone_number: number,
  },
};

function mockServer(...replies: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();

  for (const reply of replies) fetch.mockResolvedValueOnce(reply);

  vi.stubGlobal('fetch', fetch);

  return fetch;
}

function render(view: Awaited<ReturnType<typeof advanceDiscovery>>) {
  return renderToStaticMarkup(
    <DiscoveryPanel view={view} busy={false} act={vi.fn()} />
  );
}

it('does not launch or open the provider on initial render', () => {
  const fetch = mockServer();
  const openProvider = vi.fn();

  const html = renderToStaticMarkup(
    <SupervisedDiscoveryScreen
      workspace={launch.workspace}
      openProvider={openProvider}
    />
  );

  expect(html.match(/<button\b/g)).toHaveLength(1);
  expect(html).toContain('Authorize launch');
  expect(html).toContain('WhatsApp Business phone number');
  expect(html).toContain('name="intended_phone"');
  expect(fetch).not.toHaveBeenCalled();
  expect(openProvider).not.toHaveBeenCalled();
});

it('opens, verifies and confirms in separate steps with only the code and server-issued values', async () => {
  const fetch = mockServer(
    Response.json(launch),
    Response.json(verified),
    Response.json({ status: 'confirmed' })
  );

  const signal = new AbortController().signal;
  const openProvider = vi.fn().mockResolvedValue(code);

  const authorized = await advanceDiscovery(
    { status: 'idle', workspace: launch.workspace },
    openProvider,
    signal,
    number
  );

  expect(render(authorized)).toContain('Open WhatsApp signup');
  expect(render(authorized)).not.toContain(launch.state);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(openProvider).not.toHaveBeenCalled();

  const opening = advanceDiscovery(authorized, openProvider, signal);
  expect(openProvider).toHaveBeenCalledTimes(1);

  const codeReady = await opening;
  expect(render(codeReady)).toContain('Verify selected number');
  expect(render(codeReady)).not.toContain(code);
  expect(fetch).toHaveBeenCalledTimes(1);

  const preview = await advanceDiscovery(codeReady, openProvider, signal);
  const html = render(preview);

  expect(html).not.toContain(launch.state);
  expect(html).toContain(`Verified WhatsApp number: ${number}`);
  expect(html).toContain('Confirm verified number');
  expect(fetch).toHaveBeenCalledTimes(2);

  const confirmed = await advanceDiscovery(preview, openProvider, signal);
  expect(render(confirmed)).toContain('Number confirmed.');
  expect(render(confirmed)).not.toContain('<button');
  expect(fetch.mock.calls).toEqual(
    [
      { action: 'launch', intended_phone: number },
      { action: 'finish', state: launch.state, code },
      {
        action: 'confirm',
        state: launch.state,
        waba_id: '2468',
        phone_number_id: '1357',
      },
    ].map((command) => [
      '/supervised-discovery',
      expect.objectContaining({
        method: 'POST',
        mode: 'same-origin',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        body: JSON.stringify(command),
      }),
    ])
  );
});

it('does not authorize an invalid phone number', async () => {
  const fetch = mockServer();
  const openProvider = vi.fn();
  const view = { status: 'idle', workspace: launch.workspace } as const;

  expect(
    await advanceDiscovery(
      view,
      openProvider,
      new AbortController().signal,
      '555-0102'
    )
  ).toBe(view);
  expect(fetch).not.toHaveBeenCalled();
});

it('does not open WhatsApp after the workspace changes on launch', async () => {
  mockServer(Response.json({ ...launch, workspace: 'Another workspace' }));
  const openProvider = vi.fn();

  const signal = new AbortController().signal;

  const stopped = await advanceDiscovery(
    { status: 'idle', workspace: launch.workspace },
    openProvider,
    signal,
    number
  );

  expect(render(stopped)).not.toContain('<button');
  expect(await advanceDiscovery(stopped, openProvider, signal)).toBe(stopped);
  expect(openProvider).not.toHaveBeenCalled();
});

it.each([null, { code, finish: { phone_number_id: '999' } }])(
  'does not submit or reopen after a cancellation or non-code adapter result (%j)',
  async (result) => {
    const fetch = mockServer();

    const openProvider = vi.fn().mockResolvedValue(result);
    const signal = new AbortController().signal;

    const terminal = await advanceDiscovery(
      authorizedView,
      openProvider,
      signal
    );

    expect(render(terminal)).not.toContain('<button');
    expect(await advanceDiscovery(terminal, openProvider, signal)).toBe(
      terminal
    );
    expect(openProvider).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  }
);

it.each([
  Response.json(verified, { status: 409 }),
  Response.json({ ...verified, workspace: 'Another workspace' }),
  Response.json({
    ...verified,
    preview: { ...verified.preview, normalized_phone_number: '+15555550103' },
  }),
  Response.json({
    ...verified,
    preview: { ...verified.preview, normalized_phone_number: '0102' },
  }),
])(
  'stops without offering confirmation after a failed or invalid verification',
  async (reply) => {
    const fetch = mockServer(reply);
    const openProvider = vi.fn();

    const stopped = await advanceDiscovery(
      { ...authorizedView, status: 'code_ready', code },
      openProvider,
      new AbortController().signal
    );

    expect(render(stopped)).toContain('Discovery stopped. Do not retry.');
    expect(render(stopped)).not.toContain('<button');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(openProvider).not.toHaveBeenCalled();
  }
);
