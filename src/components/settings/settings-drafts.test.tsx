import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlProvider } from '@/i18n/intl-provider';

const hooks = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  effects: [] as (() => void)[],
  changed: false,
  cleanups: new Array<void | (() => void)>(),
}));

const auth = vi.hoisted(() => ({
  user: { id: 'user-a' },
  accountId: 'account-a',
  // SAFETY: starts null; test fixtures supply only the declared profile fields.
  profile: null as {
    full_name: string | null;
    email: string;
    account_role?: string;
    account_id?: string;
  } | null,
  accountRole: 'owner',
  accountStatus: 'ready',
  defaultCurrency: 'USD',
  canEditSettings: true,
  profileLoading: false,
  loading: false,
  refreshProfile: vi.fn(),
}));

const database = vi.hoisted(() => ({
  eq: vi.fn(),
  updateUser: vi.fn(),
  maybeSingle: vi.fn(),
  update: vi.fn(),
}));

// Node-only hook runner: retain state between renders and flush dependency-based
// effects and cleanups. It does not render leaf components or reconcile DOM.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();

  function useState<T>(initial: T | (() => T)) {
    const index = hooks.cursor++;

    if (!(index in hooks.slots)) {
      hooks.slots[index] =
        typeof initial === 'function' ? (initial as () => T)() : initial;
    }

    return [
      hooks.slots[index],
      (next: T | ((previous: T) => T)) => {
        const value =
          typeof next === 'function'
            ? (next as (previous: T) => T)(hooks.slots[index] as T)
            : next;

        hooks.changed ||= !Object.is(value, hooks.slots[index]);
        hooks.slots[index] = value;
      },
    ] as const;
  }

  return {
    ...actual,
    useState,
    useCallback: <T,>(callback: T) => callback,
    useRef: (initial: unknown) => useState({ current: initial })[0],
    useEffect: (
      effect: () => void | (() => void),
      dependencies?: unknown[]
    ) => {
      const index = hooks.cursor++;
      const previous = hooks.slots[index] as unknown[] | undefined;

      if (
        !dependencies ||
        !previous ||
        dependencies.length !== previous.length ||
        dependencies.some((value, i) => !Object.is(value, previous[i]))
      ) {
        hooks.effects.push(() => {
          const cleanup = hooks.cleanups[index];

          if (cleanup) cleanup();
          hooks.cleanups[index] = effect();
        });
      }

      hooks.slots[index] = dependencies;
    },
  };
});

vi.mock('@/hooks/use-auth', () => ({ useAuth: () => auth }));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => ({
      update: database.update,
      select: () => ({ eq: () => ({ maybeSingle: database.maybeSingle }) }),
    }),
    auth: { updateUser: database.updateUser },
  }),
}));

vi.mock('./browser-notifications-card', () => ({
  BrowserNotificationsCard: () => null,
}));

import { ProfileForm } from './profile-form';
import { DealsSettings } from './deals-settings';
import { WhatsAppConfig } from './whatsapp-config';
import { CoexistenceOperatorPanel } from './coexistence-operator-panel';
import { CoexistenceImportPermissionsPanel } from './coexistence-import-permissions-panel';
import { CoexistenceHistoryRequestPanel } from './coexistence-history-request-panel';
import { HistoryRequestForm } from './coexistence-history-request-form';
import type { ImportSettingsStatus } from '@/lib/whatsapp/coexistence/import-settings-contract';
import { CoexistenceSignupPanel } from './coexistence-signup-panel';
import { CoexistenceSignupRecoveryPanel } from './coexistence-signup-recovery-panel';
import { CoexistenceHistoryRehearsal } from './coexistence-history-rehearsal';

const draftMessages = {
  Settings: {
    profile: { emailChangeHint: '{newEmail}' },
    whatsapp: {
      importPermissions: { phoneIdSuffix: 'phoneIdSuffix: •••• {suffix}' },
      historyRehearsal: { target: 'target: •••• {suffix}' },
    },
  },
};

// The draft runner inspects element trees without rendering their descendants.
function readDraft<T>(read: () => T): T {
  const result: T[] = [];

  function ReadDraft() {
    result.push(read());

    return null;
  }

  renderToStaticMarkup(
    <IntlProvider
      locale="en"
      messages={draftMessages}
      timeZone="UTC"
      onError={() => {}}
      getMessageFallback={({ key }) => key}
    >
      <ReadDraft />
    </IntlProvider>
  );

  return result[0];
}

function mountDraft<P>(
  Component: () => ReactElement<P>,
  observeRecovery?: (onClosed: () => void) => void,
  composeWhatsApp = false
) {
  let previousKey: string | null | undefined;

  return () => {
    const child = readDraft(Component);

    if (child.key !== previousKey) {
      hooks.cleanups.forEach((cleanup) => {
        if (cleanup) cleanup();
      });
      hooks.cleanups = [];
      hooks.slots = [];
    }

    previousKey = child.key;
    expect(typeof child.type).toBe('function');

    for (let pass = 0; pass < 10; pass++) {
      hooks.cursor = 0;
      hooks.changed = false;
      hooks.effects = [];
      let panel = child;

      if (Component === WhatsAppConfig || composeWhatsApp) {
        // SAFETY: the assertion above verifies the settings wrapper is a function.
        const compose = child.type as (
          props: P
        ) => ReactElement<{ children: ReactNode }>;

        const composition = readDraft(() => compose(child.props));

        const [gate, recovery] = Children.toArray(composition.props.children);

        if (
          observeRecovery &&
          isValidElement<{ onClosed: () => void }>(recovery)
        )
          observeRecovery(recovery.props.onClosed);

        if (!isValidElement<P>(gate)) throw new Error('Expected mode gate');
        panel = gate;
      }

      // SAFETY: the assertion above verifies that the wrapper returned a function component.
      const render = panel.type as (props: P) => ReactElement;
      const tree = readDraft(() => render(panel.props));

      hooks.effects.forEach((effect) => effect());

      if (!hooks.changed) return tree;
    }

    throw new Error('Draft did not settle after 10 renders');
  };
}

type ControlProps = {
  children?: ReactNode;
  id?: string;
  placeholder?: string;
  value?: string;
  disabled?: boolean;
  type?: string;
  onChange?: (event: { target: { value: string; checked?: boolean } }) => void;
  onSubmit?: (event: {
    preventDefault: () => void;
    currentTarget?: HTMLFormElement;
  }) => Promise<void>;
  onClick?: () => Promise<void>;
  checked?: boolean;
  onCheckedChange?: (value: boolean) => Promise<void>;
  onConnectionGate?: (state: string) => void;
};

function find(
  tree: ReactNode,
  match: (node: ReactElement<ControlProps>) => boolean
): ReactElement<ControlProps> {
  const visit = (node: ReactNode): ReactElement<ControlProps> | undefined => {
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = visit(child);

        if (found) return found;
      }
    } else if (isValidElement<ControlProps>(node)) {
      if (match(node)) return node;

      return visit(node.props.children);
    }
  };

  const result = visit(tree);

  if (!result) throw new Error('Expected draft control not found');

  return result;
}

const field = (tree: ReactNode, id: string) =>
  find(tree, (node) => node.props.id === id);

const currency = (tree: ReactNode) =>
  find(tree, (node) => node.type === 'select');

const profileSave = (tree: ReactNode) =>
  find(tree, (node) => node.props.type === 'submit');

const currencySave = (tree: ReactNode) =>
  find(tree, (node) => node.props.children === 'save');

function change(control: ReactElement<ControlProps>, value: string) {
  expect(control.props.onChange).toBeTypeOf('function');
  control.props.onChange!({ target: { value } });
}

beforeEach(() => {
  hooks.slots = [];
  database.eq.mockReset().mockResolvedValue({ error: null, count: 1 });
  database.update.mockReset().mockImplementation(() => ({ eq: database.eq }));
  database.maybeSingle
    .mockReset()
    .mockResolvedValue({ data: null, error: null });
  database.updateUser.mockReset().mockResolvedValue({ error: null });
  auth.refreshProfile.mockReset();
  Object.assign(auth, {
    user: { id: 'user-a' },
    accountRole: 'owner',
    accountStatus: 'ready',
    accountId: 'account-a',
    profile: null,
    defaultCurrency: 'USD',
    canEditSettings: true,
    profileLoading: false,
    loading: false,
  });
});

afterEach(() => {
  hooks.cleanups.forEach((cleanup) => {
    if (cleanup) cleanup();
  });
  hooks.cleanups = [];
  vi.unstubAllGlobals();
});

describe('Managed owner history request', () => {
  const route = '/history-request';

  const review = {
    context: 'ab'.repeat(32),
    decision_id: 'f03b95e0-1b95-4efe-9794-3909533a6fc8',
    request_id: '68553d9e-78aa-46a0-969b-809c4abb5ff9',
    phone_id_suffix: '0008',
    deadline_at: '2030-11-18T10:25:14+00:00',
  };

  const control = (tree: ReactNode, label: string) =>
    find(tree, (node) => node.props.children === label);

  const form = (tree: ReactNode) =>
    find(tree, (node) => node.type === HistoryRequestForm);

  function mountHistory() {
    const permissions = { revision: 0, saving: false };

    const render = mountDraft(() => {
      const panel = CoexistenceHistoryRequestPanel({ permissions });

      if (!panel) throw new Error('Expected owner history request');

      return panel;
    });

    return { render, permissions };
  }

  beforeEach(() => {
    auth.profile = {
      full_name: null,
      email: '',
      account_id: auth.accountId,
      account_role: 'owner',
    };
  });

  it.each([false, true])(
    'gates history-only permissions and requests by server enablement (%s)',
    (historyRequestEnabled) => {
      const child = readDraft(() => WhatsAppConfig({ historyRequestEnabled }));
      expect(child.type).toBeTypeOf('function');

      // SAFETY: the assertion above verifies that the wrapper is a function component.
      const Settings = child.type as (
        props: typeof child.props
      ) => ReactElement;

      const tree = readDraft(() => Settings(child.props));

      const requestPanel = () =>
        find(tree, (node) => node.type === CoexistenceHistoryRequestPanel);

      const permissionsPanel = () =>
        find(tree, (node) => node.type === CoexistenceImportPermissionsPanel);

      if (historyRequestEnabled) {
        expect(requestPanel()).toBeDefined();
        expect(permissionsPanel()).toMatchObject({
          props: { historyOnly: true },
        });
      } else {
        expect(requestPanel).toThrow();
        expect(permissionsPanel).toThrow();
      }

      expect(
        CoexistenceHistoryRequestPanel({
          permissions: { revision: 0, saving: false },
        })
      ).not.toBeNull();
      auth.accountRole = 'admin';
      expect(
        CoexistenceHistoryRequestPanel({
          permissions: { revision: 0, saving: false },
        })
      ).toBeNull();
    }
  );

  it.each([
    'started',
    'accepted',
    'rejected',
    'ambiguous',
    'not_sent',
    'unavailable',
  ])('inspects %s without exposing a submit form', async (state) => {
    const fetcher = vi.fn(async () => Response.json({ state }));
    vi.stubGlobal('fetch', fetcher);
    const { render } = mountHistory();
    const initial = render();
    expect(fetcher).not.toHaveBeenCalled();
    await control(initial, 'inspect').props.onClick!();
    expect(control(render(), `states.${state}`)).toBeDefined();
    expect(() => form(render())).toThrow();
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      route,
      expect.objectContaining({ cache: 'no-store', redirect: 'error' })
    );
  });

  it.each(['accepted', 'uncertain'])(
    'submits only a checked review, then displays %s without sending again',
    async (result) => {
      const fetcher = vi
        .fn<(url: string, options: RequestInit) => Promise<Response>>()
        .mockImplementationOnce(async () =>
          Response.json({ state: 'ready', review })
        );

      if (result === 'accepted') {
        const redirect = new Response();
        Object.defineProperty(redirect, 'type', { value: 'opaqueredirect' });
        fetcher
          .mockResolvedValueOnce(redirect)
          .mockResolvedValueOnce(Response.json({ state: 'accepted' }));
      } else {
        fetcher.mockRejectedValueOnce(new Error('Lost response'));
      }

      fetcher.mockResolvedValueOnce(Response.json({ state: 'ready', review }));
      vi.stubGlobal('fetch', fetcher);
      const { render } = mountHistory();
      await control(render(), 'inspect').props.onClick!();
      const submit = form(render()).props.onSubmit!;
      const fields = new FormData();
      vi.stubGlobal(
        'FormData',
        vi.fn(function () {
          return fields;
        })
      );
      const preventDefault = vi.fn();
      await submit({ preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(fetcher).toHaveBeenCalledTimes(1);
      fields.set('confirmation', 'history-now-v1');
      await Promise.all([
        submit({ preventDefault }),
        submit({ preventDefault }),
      ]);
      expect(control(render(), `states.${result}`)).toBeDefined();
      expect(() => form(render())).toThrow();
      expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
        method: 'POST',
        redirect: 'manual',
      });
      expect(String(fetcher.mock.calls[1]?.[1].body)).toBe(
        `context=${review.context}&decision_id=${review.decision_id}&request_id=${review.request_id}&confirmation=history-now-v1`
      );
      expect(fetcher.mock.calls).toHaveLength(result === 'accepted' ? 3 : 2);
      await control(render(), 'inspectAgain').props.onClick!();
      expect(() => form(render())).toThrow();
      expect(
        fetcher.mock.calls.filter(([, options]) => options.method === 'POST')
      ).toHaveLength(1);
    }
  );

  it('drops a ready review on permission change and ignores an in-flight inspection after account switch', async () => {
    const fetcher = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(Response.json({ state: 'ready', review }));

    let respond: (response: Response) => void = () => {};

    fetcher.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        })
    );
    vi.stubGlobal('fetch', fetcher);
    const { render, permissions } = mountHistory();
    await control(render(), 'inspect').props.onClick!();
    expect(form(render())).toBeDefined();
    permissions.revision += 1;
    permissions.saving = true;
    expect(() => form(render())).toThrow();
    expect(control(render(), 'states.stale')).toBeDefined();
    expect(control(render(), 'inspectAgain').props.disabled).toBe(true);
    permissions.saving = false;
    expect(fetcher).toHaveBeenCalledTimes(1);
    const inspecting = control(render(), 'inspectAgain').props.onClick!();
    auth.accountId = 'account-b';

    if (auth.profile) auth.profile.account_id = auth.accountId;
    expect(control(render(), 'inspect')).toBeDefined();
    respond(Response.json({ state: 'ready', review }));
    await inspecting;
    expect(control(render(), 'inspect')).toBeDefined();
    expect(() => form(render())).toThrow();
  });
});

describe('Signup recovery', () => {
  const route = '/api/whatsapp/coexistence/operator/signup-recovery';

  const attempt = {
    id: '11111111-1111-4111-8111-111111111111',
    state: 'expired_unstarted',
    launched_at: null,
    exchange_started: false,
    known_claims: 1,
    disposition: null,
    reviewed_at: null,
  };

  const timestamp = '2026-11-18T05:00:00Z';
  const onClosed = vi.fn();

  function mountRecovery() {
    return mountDraft(() => {
      const child = CoexistenceSignupRecoveryPanel({ onClosed });

      if (!child) throw new Error('Expected recovery inspection');

      return child;
    });
  }

  const button = (tree: ReactNode, label: string) =>
    find(tree, (node) => node.props.children === label);

  beforeEach(() => {
    onClosed.mockClear();
    auth.accountRole = 'admin';
    auth.profile = {
      full_name: null,
      email: '',
      account_role: 'admin',
      account_id: auth.accountId,
    };
  });

  it('is a separate lazy inspection for an admin, even without owner inspection', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ status: 'ok', attempt: null })
    );

    vi.stubGlobal('fetch', fetcher);
    expect(CoexistenceSignupPanel()).toBeNull();
    const wrapper = WhatsAppConfig();
    expect(wrapper.type).toBeInstanceOf(Function);
    // SAFETY: the assertion above verifies the settings wrapper is a function.

    const tree = (
      wrapper.type as (props: typeof wrapper.props) => ReactElement
    )(wrapper.props);

    expect(
      find(tree, (node) => node.type === CoexistenceSignupRecoveryPanel)
    ).toBeDefined();
    const render = mountRecovery();

    render();
    expect(fetcher).not.toHaveBeenCalled();
    await button(render(), 'inspect').props.onClick!();
    await vi.waitFor(() => expect(button(render(), 'empty')).toBeDefined());
    expect(fetcher).toHaveBeenCalledWith(
      route,
      expect.objectContaining({
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
      })
    );
  });

  it('deduplicates close clicks, refreshes after ambiguous acceptance, and only resubmits on request with the same UUID', async () => {
    const pending = Promise.withResolvers<Response>();
    const posts: string[] = [];
    let closed = false;

    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        expect(init.body).toEqual(expect.any(String));
        const body = String(init.body);
        posts.push(body);

        if (posts.length === 1) return pending.promise;
        closed = true;

        return Response.json({
          status: 'recorded',
          attempt_id: attempt.id,
          request_id: JSON.parse(body).request_id,
          disposition: 'closed_unstarted',
          reviewed_at: timestamp,
        });
      }

      return Response.json({
        status: 'ok',
        attempt: closed
          ? {
              ...attempt,
              state: 'cancelled',
              disposition: 'closed_unstarted',
              reviewed_at: timestamp,
              known_claims: 0,
            }
          : attempt,
      });
    });

    vi.stubGlobal('fetch', fetcher);
    const render = mountRecovery();

    await button(render(), 'inspect').props.onClick!();
    await vi.waitFor(() =>
      expect(button(render(), 'actions.close_unstarted')).toBeDefined()
    );
    const close = button(render(), 'actions.close_unstarted').props.onClick!;
    const first = close();
    await close();
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0])).toEqual({
      attempt_id: attempt.id,
      request_id: expect.stringMatching(
        /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i
      ),
      action: 'close_unstarted',
    });
    pending.resolve(Response.json({ error: 'unavailable' }, { status: 503 }));
    await first;
    await vi.waitFor(() =>
      expect(button(render(), 'unknownAcceptance')).toBeDefined()
    );
    expect(fetcher.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual(
      ['GET', 'POST', 'GET']
    );
    await button(render(), 'resubmit').props.onClick!();
    await vi.waitFor(() =>
      expect(button(render(), 'dispositions.closed_unstarted')).toBeDefined()
    );
    expect(posts).toEqual([posts[0], posts[0]]);
    expect(fetcher.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual(
      ['GET', 'POST', 'GET', 'POST', 'GET']
    );
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(() => button(render(), 'actions.close_unstarted')).toThrow();
  });

  it.each(['agent', 'viewer'])('hides recovery from %s', (role) => {
    auth.accountRole = role;
    expect(CoexistenceSignupRecoveryPanel({ onClosed })).toBeNull();
  });

  it('shows audit-only hold for a launched attempt and retires the old request when the latest attempt changes', async () => {
    const next = { ...attempt, id: '22222222-2222-4222-8222-222222222222' };

    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          status: 'ok',
          attempt: {
            ...attempt,
            state: 'review_required',
            launched_at: timestamp,
          },
        })
      )
      .mockResolvedValueOnce(
        Response.json({ error: 'unavailable' }, { status: 503 })
      )
      .mockResolvedValueOnce(Response.json({ status: 'ok', attempt: next }));

    vi.stubGlobal('fetch', fetcher);

    const render = mountRecovery();
    await button(render(), 'inspect').props.onClick!();
    await vi.waitFor(() =>
      expect(button(render(), 'actions.record_hold')).toBeDefined()
    );
    expect(button(render(), 'policy')).toBeDefined();
    expect(() => button(render(), 'actions.close_unstarted')).toThrow();

    const hold = button(render(), 'actions.record_hold').props.onClick!;
    await hold();
    await vi.waitFor(() =>
      expect(button(render(), 'actions.close_unstarted')).toBeDefined()
    );
    expect(() => button(render(), 'resubmit')).toThrow();
    await hold();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
      action: 'record_hold',
      attempt_id: attempt.id,
      request_id: expect.any(String),
    });
    expect(onClosed).not.toHaveBeenCalled();
  });

  it('aborts an old actor’s review and never refreshes or resubmits from its late response', async () => {
    const pending = Promise.withResolvers<Response>();

    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ status: 'ok', attempt }))
      .mockReturnValueOnce(pending.promise);

    vi.stubGlobal('fetch', fetcher);

    const render = mountRecovery();
    await button(render(), 'inspect').props.onClick!();
    await vi.waitFor(() =>
      expect(button(render(), 'actions.close_unstarted')).toBeDefined()
    );

    const close = button(render(), 'actions.close_unstarted').props.onClick!;
    const first = close();
    auth.user = { id: 'other-admin' };
    expect(button(render(), 'inspect')).toBeDefined();
    expect(fetcher.mock.calls[1][1].signal.aborted).toBe(true);
    pending.resolve(Response.json({ error: 'unavailable' }, { status: 503 }));
    await first;
    await close();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(onClosed).not.toHaveBeenCalled();
  });

  it('fails closed on an unexpected status field without showing stale controls', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ status: 'ok', attempt }))
      .mockResolvedValueOnce(
        Response.json({
          status: 'ok',
          attempt: { ...attempt, extra: 'unexpected' },
        })
      );

    vi.stubGlobal('fetch', fetcher);

    const render = mountRecovery();
    await button(render(), 'inspect').props.onClick!();
    await vi.waitFor(() =>
      expect(button(render(), 'actions.close_unstarted')).toBeDefined()
    );
    await button(render(), 'refresh').props.onClick!();
    expect(button(render(), 'failed')).toBeDefined();
    expect(() => button(render(), 'actions.close_unstarted')).toThrow();
  });
});

describe('Owner history-sharing rehearsal (controlled preview only)', () => {
  const scope = {
    actorId: 'owner-a',
    accountId: 'account-a',
    sessionId: 'session-a',
    attemptId: '11111111-1111-4111-8111-111111111111',
    contextId: 'inspection-a',
  };

  const context = { ...scope, kind: 'signup-preview', role: 'owner' } as const;

  const preview = {
    ...scope,
    attempt: {
      id: scope.attemptId,
      state: 'confirmed',
      intended_phone: '+12025550123',
      reason: null,
      preview: {
        phone_number_id: '12345',
        waba_id: '67890',
        display_phone_number: '+1 202 555 0123',
        normalized_phone_number: '+12025550123',
      },
      created_at: '2026-11-17T11:00:00Z',
      lease_until: '2026-11-17T11:02:00Z',
    },
  };

  const control = (tree: ReactNode, label: string) =>
    find(tree, (node) => node.props.children === label);

  const checkbox = (tree: ReactNode) =>
    find(
      tree,
      (node) => node.type === 'input' && node.props.type === 'checkbox'
    );

  it('starts with no sharing and reviews an explicit history-only choice without dispatching', () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);

    const render = mountDraft(() => {
      const child = CoexistenceHistoryRehearsal({ context, preview });

      if (!child) throw new Error('Expected matching owner rehearsal');

      return child;
    });

    expect(checkbox(render()).props.checked).toBe(false);
    expect(control(render(), 'review').props.disabled).toBe(true);
    expect(control(render(), 'target: •••• 0123')).toBeDefined();
    expect(renderToStaticMarkup(render())).not.toContain(
      preview.attempt.intended_phone
    );
    expect(control(render(), 'contactsUnavailable')).toBeDefined();
    checkbox(render()).props.onChange!({
      target: { value: 'on', checked: true },
    });
    expect(() => control(render(), 'reviewed')).toThrow();
    expect(control(render(), 'review').props.disabled).toBe(false);
    void control(render(), 'review').props.onClick!();
    expect(control(render(), 'reviewed')).toBeDefined();
    void control(render(), 'cancel').props.onClick!();
    expect(checkbox(render()).props.checked).toBe(false);
    expect(() => control(render(), 'reviewed')).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('hides non-owner, ordinary configuration and missing or unconfirmed previews', () => {
    for (const role of ['admin', 'agent', 'viewer'] as const)
      expect(
        CoexistenceHistoryRehearsal({ context: { ...context, role }, preview })
      ).toBeNull();
    expect(CoexistenceHistoryRehearsal({ context: null, preview })).toBeNull();
    expect(CoexistenceHistoryRehearsal({ context, preview: null })).toBeNull();
    expect(
      CoexistenceHistoryRehearsal({
        context: { ...context, kind: 'configuration' },
        preview,
      })
    ).toBeNull();

    for (const attempt of [
      { ...preview.attempt, state: 'verified' },
      { ...preview.attempt, state: 'review_required' },
      { ...preview.attempt, reason: 'verification_failed' },
      { ...preview.attempt, preview: null },
      { ...preview.attempt, intended_phone: '+12025559876' },
      { ...preview.attempt, id: '22222222-2222-4222-8222-222222222222' },
    ])
      expect(
        CoexistenceHistoryRehearsal({
          context,
          preview: { ...preview, attempt },
        })
      ).toBeNull();
  });

  it.each([
    'actorId',
    'accountId',
    'sessionId',
    'attemptId',
    'contextId',
  ] as const)(
    'rejects a scope mismatch and resets a reviewed draft when %s changes',
    (field) => {
      let current = context;
      let evidence = preview;

      const render = mountDraft(() => {
        const child = CoexistenceHistoryRehearsal({
          context: current,
          preview: evidence,
        });

        if (!child) throw new Error('Expected matching owner rehearsal');

        return child;
      });

      checkbox(render()).props.onChange!({
        target: { value: 'on', checked: true },
      });
      void control(render(), 'review').props.onClick!();
      expect(control(render(), 'reviewed')).toBeDefined();
      current = { ...context, [field]: '22222222-2222-4222-8222-222222222222' };
      expect(
        CoexistenceHistoryRehearsal({ context: current, preview: evidence })
      ).toBeNull();
      evidence = {
        ...preview,
        ...current,
        attempt: { ...preview.attempt, id: current.attemptId },
      };
      expect(checkbox(render()).props.checked).toBe(false);
      expect(() => control(render(), 'reviewed')).toThrow();
    }
  );
});

describe('Owner supervised signup inspection', () => {
  const status = {
    enabled: false,
    launch_available: false,
    reason: 'launch_prerequisites_incomplete',
    attempt: null,
  };

  const attempt = {
    id: '11111111-1111-4111-8111-111111111111',
    state: 'verified',
    intended_phone: '+12025550123',
    reason: null,
    preview: {
      phone_number_id: '12345',
      waba_id: '67890',
      display_phone_number: '+1 202 555 0123',
      normalized_phone_number: '+12025550123',
    },
    created_at: '2026-11-17T11:00:00Z',
    lease_until: '2026-11-17T11:02:00Z',
  };

  function owner() {
    auth.profile = {
      full_name: null,
      email: '',
      account_role: 'owner',
      account_id: auth.accountId,
    };
  }

  function draft() {
    const child = CoexistenceSignupPanel();

    if (!child) throw new Error('Expected owner inspection');

    return child;
  }

  const button = (tree: ReactNode, label: string) =>
    find(tree, (node) => node.props.children === label);

  it.each(['admin', 'viewer', 'agent'])(
    'does not mount inspection for %s',
    (role) => {
      owner();
      auth.accountRole = role;
      const fetcher = vi.fn();
      vi.stubGlobal('fetch', fetcher);
      expect(CoexistenceSignupPanel()).toBeNull();
      expect(fetcher).not.toHaveBeenCalled();
    }
  );

  it('waits for resolved auth/account and a matching owner profile', () => {
    owner();

    for (const change of [
      { loading: true },
      { profileLoading: true },
      { accountStatus: 'error' },
      { profile: null },
      { accountId: 'other-account' },
    ]) {
      const previous = { ...auth };
      Object.assign(auth, change);
      expect(CoexistenceSignupPanel()).toBeNull();
      Object.assign(auth, previous);
    }
  });

  it('is composed beside the mode gate, including busy/blocked early returns', () => {
    const wrapper = WhatsAppConfig();
    expect(wrapper.type).toBeInstanceOf(Function);
    // SAFETY: the assertion above verifies the settings wrapper is a function.

    const tree = (
      wrapper.type as (props: typeof wrapper.props) => ReactElement
    )(wrapper.props);

    expect(
      find(tree, (node) => node.type === CoexistenceSignupPanel)
    ).toBeDefined();
  });

  it('loads only on inspection, shows unavailable policy and refreshes without mutation', async () => {
    owner();

    const fetcher = vi
      .fn()
      .mockImplementation(async () => Response.json(status));

    vi.stubGlobal('fetch', fetcher);
    const render = mountDraft(draft);
    render();
    expect(fetcher).not.toHaveBeenCalled();
    await button(render(), 'inspect').props.onClick!();
    await vi.waitFor(() => expect(button(render(), 'empty')).toBeDefined());

    for (const label of ['policy', 'unavailable', 'notActivated', 'disabled'])
      expect(button(render(), label)).toBeDefined();
    expect(fetcher.mock.calls[0]).toEqual([
      '/api/whatsapp/coexistence/signup',
      expect.objectContaining({
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
      }),
    ]);
    await button(render(), 'refresh').props.onClick!();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every((call) => !call[1].method)).toBe(true);
  });

  it.each([
    'prepared',
    'launch_possible',
    'exchanging',
    'token_received',
    'verified',
    'confirmed',
    'review_required',
    'cancelled',
  ])(
    'shows only known own attempt state %s and verified previews',
    async (state) => {
      owner();
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockImplementation(async () =>
            Response.json({ ...status, attempt: { ...attempt, state } })
          )
      );
      const render = mountDraft(draft);
      await button(render(), 'inspect').props.onClick!();
      await vi.waitFor(() =>
        expect(button(render(), `states.${state}`)).toBeDefined()
      );

      expect(button(render(), '67890')).toBeDefined();
      expect(button(render(), 'notActivated')).toBeDefined();
    }
  );

  it.each([
    { ...status, launch_available: true },
    { ...status, attempt: { ...attempt, state: 'secret' } },
    { ...status, attempt: { ...attempt, reason: 'secret' } },
    {
      ...status,
      attempt: {
        ...attempt,
        preview: { ...attempt.preview, access_token: 'secret' },
      },
    },
    { ...status, attempt: { ...attempt, intended_phone: 'x'.repeat(5000) } },
  ])(
    'fails closed on malformed status without showing diagnostics',
    async (body) => {
      owner();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async () => Response.json(body))
      );
      const render = mountDraft(draft);
      await button(render(), 'inspect').props.onClick!();
      await vi.waitFor(() => expect(button(render(), 'failed')).toBeDefined());
      expect(() => button(render(), '67890')).toThrow();
      expect(() => button(render(), 'secret')).toThrow();
    }
  );

  it('clears a preview when refresh fails and permits manual recovery', async () => {
    owner();

    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ...status, attempt }))
      .mockResolvedValueOnce(
        Response.json({ error: 'secret' }, { status: 403 })
      )
      .mockResolvedValueOnce(Response.json(status));

    vi.stubGlobal('fetch', fetcher);
    const render = mountDraft(draft);
    await button(render(), 'inspect').props.onClick!();
    await vi.waitFor(() => expect(button(render(), '67890')).toBeDefined());
    await button(render(), 'refresh').props.onClick!();
    await vi.waitFor(() => expect(button(render(), 'failed')).toBeDefined());
    expect(() => button(render(), '67890')).toThrow();
    await button(render(), 'refresh').props.onClick!();
    await vi.waitFor(() => expect(button(render(), 'empty')).toBeDefined());
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each(['collapse', 'context', 'account', 'unmount'])(
    'aborts on %s and ignores a late response',
    async (action) => {
      owner();
      const pending = Promise.withResolvers<Response>();

      const fetcher = vi
        .fn()
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValueOnce(Response.json(status));

      vi.stubGlobal('fetch', fetcher);
      const render = mountDraft(draft);
      await button(render(), 'inspect').props.onClick!();
      render();

      if (action === 'collapse')
        await button(render(), 'hide').props.onClick!();
      else if (action === 'context' || action === 'account') {
        if (action === 'context') auth.user = { id: 'user-b' };
        else auth.accountId = 'account-b';
        owner();
        render();
      } else
        hooks.cleanups.forEach((cleanup) => {
          if (cleanup) cleanup();
        });
      expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
      pending.resolve(Response.json({ ...status, attempt }));
      await pending.promise;
      await Promise.resolve();

      if (action !== 'unmount') {
        expect(() => button(render(), '67890')).toThrow();
        await button(render(), 'inspect').props.onClick!();
        await vi.waitFor(() => expect(button(render(), 'empty')).toBeDefined());
      }
    }
  );
});

describe('WhatsApp local mode preflight', () => {
  it.each([
    { managed: false },
    { managed: false, operation_state: null },
    { managed: false, operation_state: 'unexpected' },
  ])('fails closed on an incomplete local gate contract: %s', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body)));
    const render = mountDraft(WhatsAppConfig);
    render();
    await vi.waitFor(() =>
      expect(
        find(render(), (node) => node.props.children === 'operator.modeFailed')
      ).toBeDefined()
    );
  });

  it.each([
    [false, 'busy'],
    [false, 'blocked'],
    [true, 'busy'],
    [true, 'blocked'],
  ])(
    'gates setup and preserves managed inspection (managed=%s, state=%s)',
    async (managed, state) => {
      const fetcher = vi
        .fn()
        .mockImplementation(async () =>
          Response.json({ managed, operation_state: state })
        );

      vi.stubGlobal('fetch', fetcher);
      const render = mountDraft(WhatsAppConfig);
      render();
      await vi.waitFor(() =>
        expect(
          find(
            render(),
            (node) => node.props.children === `connectionGate.${state}`
          )
        ).toBeDefined()
      );

      if (managed)
        expect(
          find(render(), (node) => node.type === CoexistenceOperatorPanel)
        ).toBeDefined();
      expect(() =>
        find(render(), (node) => Boolean(node.props.onConnectionGate))
      ).toThrow();
      expect(fetcher).toHaveBeenCalledTimes(1);
      await find(render(), (node) => node.props.children === 'operator.refresh')
        .props.onClick!();
      render();
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
      await vi.waitFor(() =>
        expect(
          find(
            render(),
            (node) => node.props.children === `connectionGate.${state}`
          )
        ).toBeDefined()
      );
      expect(
        fetcher.mock.calls.every(
          (call) => call[0] === '/api/whatsapp/config?mode=local'
        )
      ).toBe(true);
    }
  );

  it('replaces a mounted form on a mutation gate response and refreshes without resubmitting', async () => {
    const fetcher = vi
      .fn()
      .mockImplementation(async () =>
        Response.json({ managed: false, operation_state: 'idle' })
      );

    vi.stubGlobal('fetch', fetcher);
    const render = mountDraft(WhatsAppConfig);
    render();
    await vi.waitFor(() => expect(render().type).not.toBe('section'));
    const legacy = render();

    if (!isValidElement<{ onConnectionGate: (state: string) => void }>(legacy))
      throw new Error('Expected form');
    legacy.props.onConnectionGate('blocked');
    expect(
      find(render(), (node) => node.props.children === 'connectionGate.blocked')
    ).toBeDefined();
    expect(render().type).not.toBe(legacy.type);
    await find(render(), (node) => node.props.children === 'operator.refresh')
      .props.onClick!();
    render();
    await vi.waitFor(() => expect(render().type).toBe(legacy.type));
    expect(render().props).toMatchObject({ checkHealth: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      fetcher.mock.calls.every(
        (call) => call[0] === '/api/whatsapp/config?mode=local'
      )
    ).toBe(true);
  });

  it.each(['idle', 'busy', 'blocked', 'invalid', 'unavailable'])(
    'unmounts uncertain drafts before a local-only %s recheck',
    async (state) => {
      const pending = Promise.withResolvers<Response>();

      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ managed: false, operation_state: 'idle' })
        )
        .mockReturnValueOnce(pending.promise);

      vi.stubGlobal('fetch', fetcher);
      const render = mountDraft(WhatsAppConfig);
      render();
      await vi.waitFor(() => expect(render().type).not.toBe('section'));
      const legacy = render();

      if (!isValidElement<{ onUncertain: () => void }>(legacy))
        throw new Error('Expected form');
      legacy.props.onUncertain();
      expect(
        find(render(), (node) => node.props.children === 'operator.modeLoading')
      ).toBeDefined();
      expect(render().type).not.toBe(legacy.type);
      pending.resolve(
        state === 'unavailable'
          ? Response.json({}, { status: 503 })
          : Response.json({ managed: false, operation_state: state })
      );
      await pending.promise;
      await vi.waitFor(() => {
        if (state === 'idle') {
          expect(render().type).toBe(legacy.type);
          expect(render().props).toMatchObject({ checkHealth: false });
        } else
          expect(
            find(
              render(),
              (node) =>
                node.props.children ===
                (state === 'invalid' || state === 'unavailable'
                  ? 'operator.modeFailed'
                  : `connectionGate.${state}`)
            )
          ).toBeDefined();
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(
        fetcher.mock.calls.every(
          (call) => call[0] === '/api/whatsapp/config?mode=local'
        )
      ).toBe(true);
    }
  );

  it('waits for resolved auth and account before reading mode', () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    auth.profileLoading = true;
    mountDraft(WhatsAppConfig)();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fails closed with a manual retry rather than mounting legacy controls', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ error: 'secret' }, { status: 503 })
      )
      .mockResolvedValueOnce(
        Response.json({ managed: false, operation_state: 'idle' })
      );

    vi.stubGlobal('fetch', fetcher);
    const render = mountDraft(WhatsAppConfig);
    render();
    await vi.waitFor(() =>
      expect(
        find(render(), (node) => node.props.children === 'operator.modeFailed')
      ).toBeDefined()
    );
    await find(render(), (node) => node.props.children === 'operator.refresh')
      .props.onClick!();
    render();
    await vi.waitFor(() => expect(render().type).not.toBe('section'));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('shows managed read-only mode to viewers without mounting the operator or legacy form', async () => {
    auth.canEditSettings = false;

    const fetcher = vi
      .fn()
      .mockResolvedValue(
        Response.json({ managed: true, operation_state: 'idle' })
      );

    vi.stubGlobal('fetch', fetcher);
    const render = mountDraft(WhatsAppConfig);
    render();
    await vi.waitFor(() =>
      expect(
        find(
          render(),
          (node) => node.props.children === 'operator.managedReadOnly'
        )
      ).toBeDefined()
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(() =>
      find(render(), (node) => node.props.children === 'verifyWithMeta')
    ).toThrow();
    expect(() =>
      find(render(), (node) => node.props.children === 'resetConfig')
    ).toThrow();
  });

  it('preserves the mounted unmanaged form across same-account auth refreshes', async () => {
    const fetcher = vi
      .fn()
      .mockImplementation(async () =>
        Response.json({ managed: false, operation_state: 'idle' })
      );

    vi.stubGlobal('fetch', fetcher);
    const render = mountDraft(WhatsAppConfig);
    render();
    await vi.waitFor(() => expect(render().type).not.toBe('section'));
    const legacy = render().type;
    auth.profileLoading = true;
    expect(render().type).toBe(legacy);
    auth.profileLoading = false;
    expect(render().type).toBe(legacy);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('aborts the old account mode read and ignores its late unmanaged response', async () => {
    const first = Promise.withResolvers<Response>();

    const fetcher = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(
        Response.json({ managed: true, operation_state: 'idle' })
      );

    vi.stubGlobal('fetch', fetcher);
    const render = mountDraft(WhatsAppConfig);
    render();
    const previousKey = WhatsAppConfig().key;
    auth.accountId = 'account-b';
    expect(WhatsAppConfig().key).not.toBe(previousKey);
    render();
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);

    const operator = () =>
      find(render(), (node) => node.type === CoexistenceOperatorPanel);

    await vi.waitFor(() => expect(operator()).toBeDefined());
    first.resolve(Response.json({ managed: false, operation_state: 'idle' }));
    await first.promise;
    await Promise.resolve();
    expect(operator()).toBeDefined();
  });

  it('does not mount legacy credentials while local mode is unresolved or managed', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        Response.json({ managed: true, operation_state: 'idle' })
      );

    vi.stubGlobal('fetch', fetcher);
    const render = mountDraft(WhatsAppConfig);
    expect(
      find(render(), (node) => node.props.children === 'operator.modeLoading')
    ).toBeDefined();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(render().type).not.toBe('section'));
    expect(fetcher.mock.calls[0][0]).toBe('/api/whatsapp/config?mode=local');
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
    });
    vi.unstubAllGlobals();
  });
});

describe('Managed WhatsApp import permissions', () => {
  const route = '/api/whatsapp/coexistence/import-permissions';
  const requestId = '9c79d95e-4058-4c34-9312-3d4dd61fc2fa';
  const context = 'a'.repeat(64);
  const expires = '2099-11-19T09:00:00Z';

  const initial = {
    context,
    phone_id_suffix: '0317',
    can_grant: true,
    can_withdraw: false,
    state: 'none',
    history: false,
    contacts: false,
    previous_request_id: null,
    expires_at: null,
  } satisfies NonNullable<ImportSettingsStatus['connection']>;

  const existing = {
    ...initial,
    can_withdraw: true,
    state: 'effective',
    history: true,
    previous_request_id: requestId,
    expires_at: expires,
  } satisfies NonNullable<ImportSettingsStatus['connection']>;

  const status = (connection: ImportSettingsStatus['connection'] = initial) =>
    Response.json({ status: 'ok', connection });

  type PostedChoices = {
    request_id: string;
    history: boolean;
    contacts: boolean;
  };

  function receipt(options?: RequestInit) {
    const { request_id, history, contacts }: PostedChoices = JSON.parse(
      String(options?.body)
    );

    return Response.json({
      status: 'recorded',
      request_id,
      history,
      contacts,
      expires_at: expires,
      dispatch_authorized: false,
    });
  }

  const text = (tree: ReactNode, label: string) =>
    find(tree, (node) => node.props.children === label);

  const choice = (tree: ReactNode, label: string) =>
    find(
      find(
        tree,
        (node) =>
          node.type === 'label' &&
          Children.toArray(node.props.children).includes(label)
      ),
      (node) => node.props.type === 'checkbox'
    );

  const form = (tree: ReactNode) =>
    find(tree, (node) => node.type === 'fieldset');

  function mountPermissions() {
    return mountDraft(() => {
      const panel = CoexistenceImportPermissionsPanel();

      if (!panel) throw new Error('Expected owner permissions');

      return panel;
    });
  }

  beforeEach(() => {
    auth.profile = {
      full_name: null,
      email: '',
      account_id: auth.accountId,
      account_role: 'owner',
    };
  });

  it.each(['owner', 'admin', 'agent', 'viewer'])(
    'renders only for the resolved owner (role: %s)',
    (role) => {
      auth.accountRole = role;

      if (role === 'owner') {
        const owner = CoexistenceImportPermissionsPanel();
        expect(owner).not.toBeNull();
        Object.assign(auth.profile ?? {}, { account_id: 'unrelated-account' });
      }

      expect(CoexistenceImportPermissionsPanel()).toBeNull();
    }
  );

  it.each([
    [true, 'idle'],
    [true, 'blocked'],
    [false, 'idle'],
  ])(
    'mounts only on managed mode (%s, %s) without an added mount fetch',
    async (managed, operation_state) => {
      const fetcher = vi.fn(async () =>
        Response.json({ managed, operation_state })
      );

      vi.stubGlobal('fetch', fetcher);
      const render = mountDraft(WhatsAppConfig);
      render();
      await vi.waitFor(() => {
        const tree = render();
        expect(() => text(tree, 'operator.modeLoading')).toThrow();

        const panel = () =>
          find(tree, (node) => node.type === CoexistenceImportPermissionsPanel);

        if (managed) expect(panel()).toBeDefined();
        else expect(panel).toThrow();
      });
      expect(fetcher.mock.calls).toEqual([
        [
          '/api/whatsapp/config?mode=local',
          expect.objectContaining({
            credentials: 'same-origin',
            cache: 'no-store',
          }),
        ],
      ]);
    }
  );

  it('lazily inspects, records distinct choices, then deliberately withdraws without dispatch', async () => {
    const fetcher = vi
      .fn<(url: string, options?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(status())
      .mockImplementationOnce(async (_url, options) => receipt(options))
      .mockImplementationOnce(async () => {
        const posted = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));

        return status({ ...existing, previous_request_id: posted.request_id });
      })
      .mockImplementationOnce(async (_url, options) => receipt(options));

    vi.stubGlobal('fetch', fetcher);
    const render = mountPermissions();
    const initialTree = render();
    expect(fetcher).not.toHaveBeenCalled();
    await text(initialTree, 'inspect').props.onClick!();

    const inspected = render();
    expect(text(inspected, 'phoneIdSuffix: •••• 0317')).toBeDefined();
    expect(choice(inspected, 'history').props.checked).toBe(false);
    expect(choice(inspected, 'contacts').props.checked).toBe(false);
    expect(text(inspected, 'save').props.disabled).toBe(true);
    choice(inspected, 'history').props.onChange!({
      target: { value: '', checked: true },
    });
    await text(render(), 'save').props.onClick!();

    expect(text(render(), 'recorded')).toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(2);

    const positive: PostedChoices = JSON.parse(
      String(fetcher.mock.calls[1]?.[1]?.body)
    );

    expect(positive).toEqual({
      context,
      request_id: expect.any(String),
      previous_request_id: null,
      history: true,
      contacts: false,
      version: 'projection-v1',
    });

    await text(render(), 'refresh').props.onClick!();
    expect(text(render(), 'states.effective')).toBeDefined();
    expect(choice(render(), 'history').props.checked).toBe(true);
    await text(render(), 'withdraw').props.onClick!();
    expect(fetcher).toHaveBeenCalledTimes(3);
    await text(render(), 'confirmWithdrawal').props.onClick!();

    expect(text(render(), 'withdrawalRecorded')).toBeDefined();
    expect(
      fetcher.mock.calls.map(([url, options]) => [
        url,
        options?.method ?? 'GET',
      ])
    ).toEqual([
      [route, 'GET'],
      [route, 'POST'],
      [route, 'GET'],
      [route, 'POST'],
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[3]?.[1]?.body))).toEqual({
      context,
      request_id: expect.not.stringMatching(positive.request_id),
      previous_request_id: positive.request_id,
      history: false,
      contacts: false,
      version: 'projection-v1',
    });
    expect(database.maybeSingle).not.toHaveBeenCalled();
  });

  it.each([
    { ...existing, state: 'inactive' as const, can_grant: false },
    { ...existing, expires_at: '2020-01-01T00:00:00Z' },
  ])(
    'keeps withdrawal available for saved but unavailable or expired permission',
    async (connection) => {
      const fetcher = vi.fn().mockResolvedValueOnce(status(connection));
      vi.stubGlobal('fetch', fetcher);
      const render = mountPermissions();
      await text(render(), 'inspect').props.onClick!();
      const inspected = render();
      expect(text(inspected, 'savedHistoryOn')).toBeDefined();
      expect(text(inspected, 'states.inactive')).toBeDefined();
      expect(choice(inspected, 'history').props.checked).toBe(false);
      expect(form(inspected).props.disabled).toBe(true);
      expect(text(inspected, 'withdraw').props.disabled).not.toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  );

  it('expires an open snapshot without reloading or preserving an affirmative draft', async () => {
    vi.useFakeTimers();

    try {
      const fetcher = vi.fn().mockResolvedValueOnce(
        status({
          ...existing,
          expires_at: new Date(Date.now() + 1000).toISOString(),
        })
      );

      vi.stubGlobal('fetch', fetcher);
      const render = mountPermissions();

      await text(render(), 'inspect').props.onClick!();
      expect(text(render(), 'states.effective')).toBeDefined();
      expect(choice(render(), 'history').props.checked).toBe(true);
      vi.advanceTimersByTime(1000);
      expect(text(render(), 'expired')).toBeDefined();
      expect(choice(render(), 'history').props.checked).toBe(false);
      expect(form(render()).props.disabled).toBe(true);
      expect(text(render(), 'withdraw')).toBeDefined();
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for explicit refresh after conflict and drops drafts across the refreshed scope', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(status())
      .mockResolvedValueOnce(
        Response.json({ error: 'opaque' }, { status: 409 })
      )
      .mockResolvedValueOnce(status({ ...initial, context: 'b'.repeat(64) }));

    vi.stubGlobal('fetch', fetcher);
    const render = mountPermissions();
    await text(render(), 'inspect').props.onClick!();
    choice(render(), 'contacts').props.onChange!({
      target: { value: '', checked: true },
    });
    await text(render(), 'save').props.onClick!();
    expect(text(render(), 'stale')).toBeDefined();
    expect(() => text(render(), 'retry')).toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
    await text(render(), 'refresh').props.onClick!();
    expect(choice(render(), 'contacts').props.checked).toBe(false);
    expect(text(render(), 'save').props.disabled).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('retries an uncertain withdrawal verbatim, never interpreting denial as recorded', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(status({ ...existing, can_grant: false }))
      .mockResolvedValueOnce(
        Response.json({
          status: 'recorded',
          request_id: requestId,
          expires_at: expires,
          history: true,
          contacts: false,
          dispatch_authorized: false,
        })
      )
      .mockResolvedValueOnce(
        Response.json({ error: 'untrusted' }, { status: 403 })
      );

    vi.stubGlobal('fetch', fetcher);
    const render = mountPermissions();
    await text(render(), 'inspect').props.onClick!();
    await text(render(), 'withdraw').props.onClick!();
    await text(render(), 'confirmWithdrawal').props.onClick!();
    expect(text(render(), 'uncertain')).toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
    await text(render(), 'retry').props.onClick!();
    expect(fetcher.mock.calls[2]?.[1]?.body).toBe(
      fetcher.mock.calls[1]?.[1]?.body
    );
    expect(text(render(), 'denied')).toBeDefined();
    expect(() => text(render(), 'withdrawalRecorded')).toThrow();
    expect(() => text(render(), 'retry')).toThrow();
  });

  it('aborts an old owner inspection and starts the next owner closed', async () => {
    const pending = Promise.withResolvers<Response>();
    const fetcher = vi.fn().mockReturnValueOnce(pending.promise);
    vi.stubGlobal('fetch', fetcher);
    const render = mountPermissions();
    const first = text(render(), 'inspect').props.onClick!();
    auth.user = { id: 'user-b' };
    expect(text(render(), 'inspect')).toBeDefined();
    expect(fetcher.mock.calls[0]?.[1]?.signal.aborted).toBe(true);
    pending.resolve(status(existing));
    await first;
    expect(text(render(), 'inspect')).toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('WhatsApp connection mutations', () => {
  it.each(['idle', 'busy'])(
    'does not reopen credential settings after recovery closes an attempt (prior mode %s)',
    async (priorMode) => {
      database.maybeSingle.mockResolvedValue({
        data: { phone_number_id: '12345', access_token: 'fixture-credential' },
        error: null,
      });

      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ managed: false, operation_state: priorMode })
        )
        .mockResolvedValueOnce(
          Response.json({ managed: false, operation_state: 'idle' })
        );

      vi.stubGlobal('fetch', fetcher);

      let close: () => void = () => {
        throw new Error('Expected recovery panel');
      };

      const render = mountDraft(WhatsAppConfig, (onClosed) => {
        close = onClosed;
      });

      render();
      await vi.waitFor(() =>
        expect(render().type === 'section').toBe(priorMode === 'busy')
      );

      close();
      const afterClosure = render();

      if (afterClosure.type !== 'section') {
        hooks.slots = [];
        mountDraft(() => afterClosure)();
      }

      await Promise.resolve();
      expect(database.maybeSingle).not.toHaveBeenCalled();
      expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
        '/api/whatsapp/config?mode=local',
      ]);
      await find(
        render(),
        (node) => node.props.children === 'connectionGate.openSettings'
      ).props.onClick!();
      render();
      await vi.waitFor(() => expect(render().type).not.toBe('section'));

      const legacy = render();
      hooks.slots = [];
      mountDraft(() => legacy)();
      await vi.waitFor(() =>
        expect(database.maybeSingle).toHaveBeenCalledTimes(1)
      );
    }
  );

  async function mountLegacy(
    onConnectionGate = vi.fn(),
    checkHealth = true,
    onUncertain = vi.fn()
  ) {
    const gate = mountDraft(WhatsAppConfig);
    gate();
    await vi.waitFor(() => expect(gate().type).not.toBe('section'));
    const legacy = gate();

    if (
      !isValidElement<{
        onConnectionGate: (state: string) => void;
        checkHealth: boolean;
      }>(legacy)
    )
      throw new Error('Expected legacy form');

    const render = mountDraft(() => ({
      ...legacy,
      props: { ...legacy.props, onConnectionGate, checkHealth, onUncertain },
    }));

    render();
    await vi.waitFor(() =>
      expect(
        find(
          render(),
          (node) => node.props.placeholder === 'phoneNumberIdPlaceholder'
        )
      ).toBeDefined()
    );

    return render;
  }

  function fillCredentials(tree: ReactNode) {
    for (const [placeholder, value] of [
      ['phoneNumberIdPlaceholder', '12345'],
      ['accessTokenPlaceholder', 'draft-secret'],
      ['pinPlaceholder', '123456'],
    ])
      change(
        find(tree, (node) => node.props.placeholder === placeholder),
        value
      );
  }

  function mutation(tree: ReactNode, method: string) {
    return find(tree, (node) =>
      method === 'POST'
        ? node.props.children === 'saveConfig'
        : isValidElement<{ children: ReactNode }>(node.props.children) &&
          Array.isArray(node.props.children.props.children) &&
          node.props.children.props.children.includes('resetConfig')
    );
  }

  it.each([
    ['POST', 409, 'busy'],
    ['POST', 503, 'blocked'],
    ['DELETE', 409, 'busy'],
    ['DELETE', 503, 'blocked'],
  ])(
    'locks further %s mutations after %s/%s without showing server details',
    async (method, status, state) => {
      database.maybeSingle.mockResolvedValue({
        data: { phone_number_id: '12345' },
        error: null,
      });
      vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));

      const fetcher = vi
        .fn()
        .mockImplementation(async (url: string, options?: RequestInit) =>
          Response.json(
            options?.method === method
              ? {
                  reason: `connection_operation_${state}`,
                  error: 'secret server detail',
                }
              : url.endsWith('mode=local')
                ? { managed: false, operation_state: 'idle' }
                : { connected: true },
            { status: options?.method === method ? Number(status) : 200 }
          )
        );

      vi.stubGlobal('fetch', fetcher);
      const onGate = vi.fn();
      const render = await mountLegacy(onGate);
      fillCredentials(render());
      const click = mutation(render(), String(method)).props.onClick!;
      await click();
      expect(onGate).toHaveBeenCalledExactlyOnceWith(state);
      await click();
      expect(
        fetcher.mock.calls.filter((call) => call[1]?.method === method)
      ).toHaveLength(1);

      const request = fetcher.mock.calls.find(
        (call) => call[1]?.method === method
      )!;

      expect(request[1]).toMatchObject({
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
      });

      if (method === 'DELETE') {
        expect(request[1]).toMatchObject({
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
      }

      expect(() =>
        find(render(), (node) => node.props.children === 'secret server detail')
      ).toThrow();
    }
  );

  it.each([
    ['POST', 'network'],
    ['DELETE', 'network'],
    ['POST', 'non-json'],
    ['DELETE', 'non-json'],
    ['POST', 'unavailable'],
    ['DELETE', 'unavailable'],
  ])(
    'locks %s after an uncertain %s reply and requests local revalidation',
    async (method, failure) => {
      database.maybeSingle.mockResolvedValue({
        data: { phone_number_id: '12345' },
        error: null,
      });
      vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));

      const fetcher = vi
        .fn()
        .mockImplementation(async (url: string, options?: RequestInit) => {
          if (options?.method === method) {
            if (failure === 'network') throw new TypeError('Lost reply');

            if (failure === 'non-json') return new Response('proxy error');

            return Response.json({ error: 'Unavailable' }, { status: 503 });
          }

          return Response.json(
            url.endsWith('mode=local')
              ? { managed: false, operation_state: 'idle' }
              : { connected: true }
          );
        });

      vi.stubGlobal('fetch', fetcher);
      const onUncertain = vi.fn();
      const render = await mountLegacy(vi.fn(), true, onUncertain);
      fillCredentials(render());
      const click = mutation(render(), method).props.onClick!;
      await click();
      expect(onUncertain).toHaveBeenCalledExactlyOnceWith();
      await click();
      await mutation(render(), method === 'POST' ? 'DELETE' : 'POST').props
        .onClick!();
      expect(
        fetcher.mock.calls.filter((call) =>
          ['POST', 'DELETE'].includes(call[1]?.method ?? '')
        )
      ).toHaveLength(1);
    }
  );

  it.each(['POST', 'DELETE'])(
    'prevents duplicate and overlapping mutations before %s settles',
    async (method) => {
      database.maybeSingle.mockResolvedValue({
        data: { phone_number_id: '12345' },
        error: null,
      });
      vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
      const pending = Promise.withResolvers<Response>();

      const fetcher = vi
        .fn()
        .mockImplementation(async (url: string, options?: RequestInit) => {
          if (options?.method === 'POST' || options?.method === 'DELETE')
            return pending.promise;

          return Response.json(
            url.endsWith('mode=local')
              ? { managed: false, operation_state: 'idle' }
              : { connected: true }
          );
        });

      vi.stubGlobal('fetch', fetcher);
      const render = await mountLegacy();
      fillCredentials(render());
      const tree = render();
      const click = mutation(tree, method).props.onClick!;
      const first = click();
      await click();
      await mutation(tree, method === 'POST' ? 'DELETE' : 'POST').props
        .onClick!();
      expect(
        fetcher.mock.calls.filter((call) =>
          ['POST', 'DELETE'].includes(call[1]?.method ?? '')
        )
      ).toHaveLength(1);
      pending.resolve(Response.json({ error: 'Rejected' }, { status: 400 }));
      await first;
    }
  );

  it('preserves credentials and PIN on ordinary save errors without gating or resubmitting', async () => {
    const fetcher = vi
      .fn()
      .mockImplementation(async (_url: string, options?: RequestInit) =>
        options?.method === 'POST'
          ? Response.json(
              { error: 'Ordinary validation error' },
              { status: 400 }
            )
          : Response.json({ managed: false, operation_state: 'idle' })
      );

    vi.stubGlobal('fetch', fetcher);
    const onGate = vi.fn();
    const render = await mountLegacy(onGate);
    fillCredentials(render());
    await mutation(render(), 'POST').props.onClick!();
    expect(onGate).not.toHaveBeenCalled();
    expect(
      find(
        render(),
        (node) => node.props.placeholder === 'accessTokenPlaceholder'
      ).props.value
    ).toBe('draft-secret');
    expect(
      find(render(), (node) => node.props.placeholder === 'pinPlaceholder')
        .props.value
    ).toBe('123456');
    expect(
      fetcher.mock.calls.filter((call) => call[1]?.method === 'POST')
    ).toHaveLength(1);
  });

  it.each([0, null, 1])(
    'acknowledges media-only updates only when one row changed (count=%s)',
    async (count) => {
      database.maybeSingle.mockResolvedValue({
        data: { phone_number_id: '12345', mirror_inbound_media: true },
        error: null,
      });
      database.eq.mockResolvedValue({ error: null, count });
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockImplementation(async (url: string) =>
            Response.json(
              url.endsWith('mode=local')
                ? { managed: false, operation_state: 'idle' }
                : { connected: true }
            )
          )
      );
      const render = await mountLegacy();

      const toggle = () =>
        find(render(), (node) => Boolean(node.props.onCheckedChange));

      await toggle().props.onCheckedChange!(false);
      expect(database.update).toHaveBeenCalledExactlyOnceWith(
        { mirror_inbound_media: false },
        { count: 'exact' }
      );
      expect(toggle().props.checked).toBe(count !== 1);
    }
  );

  it('does not probe Meta when mounting after a local-only gate refresh', async () => {
    database.maybeSingle.mockResolvedValue({
      data: { phone_number_id: '12345' },
      error: null,
    });

    const fetcher = vi
      .fn()
      .mockImplementation(async () =>
        Response.json({ managed: false, operation_state: 'idle' })
      );

    vi.stubGlobal('fetch', fetcher);
    await mountLegacy(vi.fn(), false);
    expect(
      fetcher.mock.calls.every(
        (call) => call[0] === '/api/whatsapp/config?mode=local'
      )
    ).toBe(true);
  });
});

describe('Coexistence operator inspection', () => {
  it('aborts an old account inventory request and ignores its late records', async () => {
    const old = Promise.withResolvers<Response>();

    const current = {
      enabled: false,
      connection: { managed: true, connected: true, verified: true },
      observed_at: '2026-11-17T12:00:00Z',
      items: [],
      next_cursor: null,
      count: 0,
      count_capped: false,
    };

    const fetcher = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockImplementationOnce(async () => Response.json(current));

    vi.stubGlobal('fetch', fetcher);
    const render = mountDraft(CoexistenceOperatorPanel);
    render();
    auth.accountId = 'account-b';
    render();
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    await vi.waitFor(() =>
      expect(
        find(render(), (node) => node.props.children === 'operator.empty')
      ).toBeDefined()
    );
    old.resolve(Response.json({ ...current, count: 1000, count_capped: true }));
    await old.promise;
    await Promise.resolve();
    expect(
      find(render(), (node) => node.props.children === 'operator.empty')
    ).toBeDefined();
    expect(() =>
      find(
        render(),
        (node) =>
          Array.isArray(node.props.children) &&
          node.props.children.includes(1000)
      )
    ).toThrow();
  });

  it('does not fetch queues for viewers even if the panel is mounted directly', () => {
    auth.canEditSettings = false;
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const tree = mountDraft(CoexistenceOperatorPanel)();
    expect(
      find(tree, (node) => node.props.children === 'operator.managedReadOnly')
    ).toBeDefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('preserves keyset microseconds and resets the cursor on Refresh and queue changes', async () => {
    const cursor = {
      created_at: '2026-11-17T11:00:00.123456Z',
      id: '11111111-1111-4111-8111-111111111111',
    };

    const fetcher = vi.fn().mockImplementation(async () =>
      Response.json({
        enabled: false,
        connection: { managed: true, connected: true, verified: true },
        observed_at: '2026-11-17T12:00:00Z',
        items: [],
        next_cursor: cursor,
        count: 1000,
        count_capped: true,
      })
    );

    vi.stubGlobal('fetch', fetcher);
    const render = mountDraft(CoexistenceOperatorPanel);
    render();
    await vi.waitFor(() =>
      expect(
        find(render(), (node) => node.props.children === 'operator.next').props
          .disabled
      ).toBe(false)
    );
    await find(render(), (node) => node.props.children === 'operator.next')
      .props.onClick!();
    render();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    const next = new URL(fetcher.mock.calls[1][0], 'https://example.test');
    expect(next.searchParams.get('before_created_at')).toBe(cursor.created_at);
    expect(next.searchParams.get('before_id')).toBe(cursor.id);
    await vi.waitFor(() =>
      expect(
        find(render(), (node) => node.props.children === 'operator.refresh')
          .props.disabled
      ).toBe(false)
    );
    await find(render(), (node) => node.props.children === 'operator.refresh')
      .props.onClick!();
    render();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    expect(fetcher.mock.calls[2][0]).toBe(
      '/api/whatsapp/coexistence/operator?kind=jobs&limit=25'
    );
    await vi.waitFor(() =>
      expect(currency(render()).props.disabled).toBe(false)
    );
    change(currency(render()), 'effects');
    render();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
    expect(fetcher.mock.calls[3][0]).toBe(
      '/api/whatsapp/coexistence/operator?kind=effects&limit=25'
    );
  });

  it.each([false, true])(
    'refreshes a bounded local jobs page without displaying arbitrary server reasons (enabled=%s)',
    async (enabled) => {
      const fetcher = vi.fn().mockImplementation(async () =>
        Response.json({
          enabled,
          connection: { managed: true, connected: true, verified: true },
          observed_at: '2026-11-17T12:00:00Z',
          items: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              state: 'ambiguous',
              reason: 'secret customer text',
              created_at: '2026-11-17T11:00:00Z',
              lease_until: null,
              available_at: null,
              attempts: null,
              stage: null,
              retention_until: null,
              payload_present: null,
              operator_requested_at: null,
              current_binding: true,
              overdue: true,
              retry_eligible: true,
            },
          ],
          next_cursor: null,
          count: 1000,
          count_capped: true,
        })
      );

      vi.stubGlobal('fetch', fetcher);
      const render = mountDraft(CoexistenceOperatorPanel);
      render();
      await vi.waitFor(() =>
        expect(
          find(render(), (node) => node.props.children === 'operator.uncertain')
        ).toBeDefined()
      );

      if (!enabled)
        expect(
          find(render(), (node) => node.props.children === 'operator.disabled')
        ).toBeDefined();
      expect(() =>
        find(render(), (node) => node.props.children === 'operator.retry')
      ).toThrow();
      expect(() =>
        find(render(), (node) => node.props.children === 'secret customer text')
      ).toThrow();
      expect(fetcher.mock.calls[0][0]).toBe(
        '/api/whatsapp/coexistence/operator?kind=jobs&limit=25'
      );
      await find(render(), (node) => node.props.children === 'operator.refresh')
        .props.onClick!();
      render();
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
      vi.unstubAllGlobals();
    }
  );
});

describe('Coexistence ingestion retry', () => {
  it('refreshes stale eligibility on 409 without exposing server errors or automatically retrying', async () => {
    let queuedRequest = false;

    const fetcher = vi
      .fn()
      .mockImplementation(async (_url: string, options: RequestInit) => {
        if (options.method === 'POST') {
          queuedRequest = true;

          return Response.json(
            { error: 'secret internal error' },
            { status: 409 }
          );
        }

        return Response.json({
          enabled: true,
          connection: { managed: true, connected: true, verified: true },
          observed_at: '2026-11-17T12:00:00Z',
          items: queuedRequest
            ? []
            : [
                {
                  id: '11111111-1111-4111-8111-111111111111',
                  state: 'quarantined',
                  reason: null,
                  created_at: '2026-11-17T11:00:00Z',
                  lease_until: null,
                  available_at: null,
                  attempts: null,
                  stage: null,
                  retention_until: null,
                  payload_present: null,
                  operator_requested_at: null,
                  current_binding: true,
                  overdue: false,
                  retry_eligible: true,
                },
              ],
          next_cursor: null,
          count: queuedRequest ? 0 : 1,
          count_capped: false,
        });
      });

    vi.stubGlobal('fetch', fetcher);
    const render = mountDraft(CoexistenceOperatorPanel);
    render();
    await vi.waitFor(() =>
      expect(
        find(render(), (node) => node.props.children === 'operator.retry')
      ).toBeDefined()
    );
    await find(render(), (node) => node.props.children === 'operator.retry')
      .props.onClick!();
    await find(render(), (node) => node.props.children === 'operator.confirm')
      .props.onClick!();
    render();
    await vi.waitFor(() =>
      expect(
        find(render(), (node) => node.props.children === 'operator.empty')
      ).toBeDefined()
    );
    expect(
      find(
        render(),
        (node) => node.props.children === 'operator.staleEligibility'
      )
    ).toBeDefined();
    expect(
      fetcher.mock.calls.filter((call) => call[1].method === 'POST')
    ).toHaveLength(1);
    expect(() =>
      find(render(), (node) => node.props.children === 'secret internal error')
    ).toThrow();
  });

  it.each([
    { enabled: false, kind: 'jobs', requested: null, eligible: true },
    {
      enabled: true,
      kind: 'jobs',
      requested: '2026-11-17T12:00:00Z',
      eligible: true,
    },
    { enabled: true, kind: 'jobs', requested: null, eligible: false },
    { enabled: true, kind: 'effects', requested: null, eligible: true },
  ])(
    'leaves disabled, previously requested, ineligible and non-ingestion work read-only: %s',
    async ({ enabled, kind, requested, eligible }) => {
      const fetcher = vi.fn().mockImplementation(async () =>
        Response.json({
          enabled,
          connection: { managed: true, connected: true, verified: true },
          observed_at: '2026-11-17T12:00:00Z',
          items: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              state: 'quarantined',
              reason: 'worker_failed',
              created_at: '2026-11-17T11:00:00Z',
              lease_until: null,
              available_at: null,
              attempts: null,
              stage: null,
              retention_until: null,
              payload_present: null,
              operator_requested_at: requested,
              current_binding: true,
              overdue: false,
              retry_eligible: eligible,
            },
          ],
          next_cursor: null,
          count: 1,
          count_capped: false,
        })
      );

      vi.stubGlobal('fetch', fetcher);
      const render = mountDraft(CoexistenceOperatorPanel);
      render();
      await vi.waitFor(() =>
        expect(currency(render()).props.disabled).toBe(false)
      );

      if (kind !== 'jobs') {
        change(currency(render()), kind);
        render();
        await vi.waitFor(() =>
          expect(currency(render()).props.disabled).toBe(false)
        );
      }

      expect(() =>
        find(render(), (node) => node.props.children === 'operator.retry')
      ).toThrow();
      expect(
        fetcher.mock.calls.every((call) => call[1].method !== 'POST')
      ).toBe(true);
    }
  );

  it.each(['network', 'unavailable'])(
    'requires confirmation and preserves the intent UUID after %s uncertainty and double click',
    async (failure) => {
      const requests: string[] = [];

      const fetcher = vi
        .fn()
        .mockImplementation(async (_url: string, options: RequestInit) => {
          if (options.method === 'POST') {
            requests.push(String(options.body));

            if (requests.length === 1) {
              if (failure === 'network')
                throw new Error('lost acknowledgement secret');

              return Response.json({ error: 'server secret' }, { status: 503 });
            }

            return Response.json(
              { status: 'queued', requested_at: '2026-11-17T12:01:00Z' },
              { status: 202 }
            );
          }

          return Response.json({
            enabled: true,
            connection: { managed: true, connected: true, verified: true },
            observed_at: '2026-11-17T12:00:00Z',
            items: [
              {
                id: '11111111-1111-4111-8111-111111111111',
                state: 'quarantined',
                reason: 'worker_failed',
                created_at: '2026-11-17T11:00:00Z',
                lease_until: null,
                available_at: null,
                attempts: null,
                stage: null,
                retention_until: null,
                payload_present: null,
                operator_requested_at: null,
                current_binding: true,
                overdue: false,
                retry_eligible: true,
              },
            ],
            next_cursor: null,
            count: 1,
            count_capped: false,
          });
        });

      vi.stubGlobal('fetch', fetcher);
      const render = mountDraft(CoexistenceOperatorPanel);
      render();
      await vi.waitFor(() =>
        expect(
          find(render(), (node) => node.props.children === 'operator.retry')
        ).toBeDefined()
      );
      await find(render(), (node) => node.props.children === 'operator.retry')
        .props.onClick!();
      expect(requests).toHaveLength(0);
      expect(
        find(
          render(),
          (node) => node.props.children === 'operator.confirmDescription'
        )
      ).toBeDefined();

      const confirm = find(
        render(),
        (node) => node.props.children === 'operator.confirm'
      ).props.onClick!;

      await Promise.all([confirm(), confirm()]);
      expect(requests).toHaveLength(1);
      expect(
        find(
          render(),
          (node) => node.props.children === 'operator.unknownAcceptance'
        )
      ).toBeDefined();
      await find(render(), (node) => node.props.children === 'operator.confirm')
        .props.onClick!();
      expect(requests).toHaveLength(2);
      expect(requests[1]).toBe(requests[0]);
      expect(JSON.parse(requests[0]).request_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(
        find(render(), (node) => node.props.children === 'operator.queued')
      ).toBeDefined();
      expect(() =>
        find(render(), (node) => node.props.children === 'operator.retry')
      ).toThrow();
    }
  );
});

describe('ProfileForm drafts', () => {
  it('fills untouched inputs when the profile arrives after the initial render', () => {
    const render = mountDraft(ProfileForm);
    let tree = render();
    expect(field(tree, 'profile-full-name').props.value).toBe('');
    expect(field(tree, 'profile-email').props.value).toBe('');
    expect(profileSave(tree).props.disabled).toBe(true);

    auth.profile = { full_name: 'Alice', email: 'alice@example.com' };
    tree = render();
    expect(field(tree, 'profile-full-name').props.value).toBe('Alice');
    expect(field(tree, 'profile-email').props.value).toBe('alice@example.com');
    expect(profileSave(tree).props.disabled).toBe(true);
  });

  it.each([
    ['profile-full-name', 'Local name', 'profile-email', 'updated@example.com'],
    ['profile-email', 'local@example.com', 'profile-full-name', 'Updated name'],
    ['profile-full-name', '', 'profile-email', 'updated@example.com'],
    ['profile-email', '', 'profile-full-name', 'Updated name'],
  ])(
    'preserves edited %s (including empty drafts) while untouched fields refresh: %s',
    (edited, draft, untouched, refreshed) => {
      auth.profile = { full_name: 'Alice', email: 'alice@example.com' };
      const render = mountDraft(ProfileForm);
      change(field(render(), edited), draft);
      auth.profile = {
        full_name: 'Updated name',
        email: 'updated@example.com',
      };
      const tree = render();
      expect(field(tree, edited).props.value).toBe(draft);
      expect(field(tree, untouched).props.value).toBe(refreshed);
      expect(profileSave(tree).props.disabled).toBe(false);
    }
  );

  it.each(['account', 'user'])(
    'discards both drafts when the %s identity changes',
    (identity) => {
      auth.profile = { full_name: 'Alice', email: 'alice@example.com' };
      const render = mountDraft(ProfileForm);
      const initial = render();
      change(field(initial, 'profile-full-name'), 'Unsaved name');
      change(field(initial, 'profile-email'), 'unsaved@example.com');
      expect(field(render(), 'profile-full-name').props.value).toBe(
        'Unsaved name'
      );
      const previousKey = ProfileForm().key;

      if (identity === 'account') auth.accountId = 'account-b';
      else auth.user = { id: 'user-b' };
      auth.profile = { full_name: 'Bob', email: 'bob@example.com' };
      expect(ProfileForm().key).not.toBe(previousKey);
      const tree = render();
      expect(field(tree, 'profile-full-name').props.value).toBe('Bob');
      expect(field(tree, 'profile-email').props.value).toBe('bob@example.com');
      expect(profileSave(tree).props.disabled).toBe(true);
    }
  );
});

describe('submitted drafts', () => {
  const submitProfile = (tree: ReactNode) =>
    find(tree, (node) => node.type === 'form').props.onSubmit!({
      preventDefault() {},
    });

  it('rebases a submitted email to the verified profile without resending on a later name save', async () => {
    auth.profile = { full_name: 'Alice', email: 'alice@example.com' };
    const render = mountDraft(ProfileForm);
    change(field(render(), 'profile-email'), 'requested@example.com');
    auth.refreshProfile.mockImplementation(async () => {
      auth.profile = { full_name: 'Alice', email: 'alice@example.com' };
    });
    await submitProfile(render());
    let tree = render();
    expect(field(tree, 'profile-email').props.value).toBe('alice@example.com');
    expect(profileSave(tree).props.disabled).toBe(true);
    expect(
      find(tree, (node) => node.props.children === 'requested@example.com')
    ).toBeDefined();

    change(field(tree, 'profile-full-name'), 'New name');
    auth.refreshProfile.mockImplementation(async () => {
      auth.profile = { full_name: 'New name', email: 'alice@example.com' };
    });
    await submitProfile(render());
    tree = render();
    expect(database.updateUser).toHaveBeenCalledTimes(1);
    expect(profileSave(tree).props.disabled).toBe(true);
    auth.profile = { full_name: 'External name', email: 'alice@example.com' };
    expect(field(render(), 'profile-full-name').props.value).toBe(
      'External name'
    );
  });

  it('keeps a failed email draft but rebases the successfully saved name', async () => {
    auth.profile = { full_name: 'Alice', email: 'alice@example.com' };
    const render = mountDraft(ProfileForm);
    const tree = render();
    change(field(tree, 'profile-full-name'), 'Saved name');
    change(field(tree, 'profile-email'), 'retry@example.com');
    database.updateUser.mockResolvedValue({ error: { message: 'Try again' } });
    auth.refreshProfile.mockImplementation(async () => {
      auth.profile = { full_name: 'Saved name', email: 'alice@example.com' };
    });
    await submitProfile(render());
    auth.profile = { full_name: 'External name', email: 'alice@example.com' };
    expect(field(render(), 'profile-full-name').props.value).toBe(
      'External name'
    );
    expect(field(render(), 'profile-email').props.value).toBe(
      'retry@example.com'
    );
  });

  it('keeps drafts when the profile write fails', async () => {
    auth.profile = { full_name: 'Alice', email: 'alice@example.com' };
    const render = mountDraft(ProfileForm);
    change(field(render(), 'profile-full-name'), 'Retry name');
    database.eq.mockResolvedValue({ error: { message: 'Try again' } });
    await submitProfile(render());
    expect(field(render(), 'profile-full-name').props.value).toBe('Retry name');
    expect(database.updateUser).not.toHaveBeenCalled();
    expect(auth.refreshProfile).not.toHaveBeenCalled();
  });

  it('does not discard newer profile edits made while refresh is in flight', async () => {
    auth.profile = { full_name: 'Alice', email: 'alice@example.com' };
    const render = mountDraft(ProfileForm);
    change(field(render(), 'profile-full-name'), 'Submitted name');
    auth.refreshProfile.mockImplementation(async () => {
      const tree = render();
      change(field(tree, 'profile-full-name'), 'Newer name');
      change(field(tree, 'profile-email'), 'newer@example.com');
      auth.profile = {
        full_name: 'Submitted name',
        email: 'alice@example.com',
      };
    });
    await submitProfile(render());
    expect(field(render(), 'profile-full-name').props.value).toBe('Newer name');
    expect(field(render(), 'profile-email').props.value).toBe(
      'newer@example.com'
    );
  });

  it.each([false, true])(
    'rebases saved currency and preserves newer edits: %s',
    async (newerEdit) => {
      const render = mountDraft(DealsSettings);
      change(currency(render()), 'GBP');
      auth.refreshProfile.mockImplementation(async () => {
        if (newerEdit) change(currency(render()), 'CAD');
        auth.defaultCurrency = 'GBP';
      });
      await currencySave(render()).props.onClick!();
      expect(currency(render()).props.value).toBe(newerEdit ? 'CAD' : 'GBP');
      auth.defaultCurrency = 'EUR';
      expect(currency(render()).props.value).toBe(newerEdit ? 'CAD' : 'EUR');
    }
  );
});

describe('DealsSettings drafts', () => {
  it('uses the late-loaded account currency until the selection is edited', () => {
    auth.profileLoading = true;
    const render = mountDraft(DealsSettings);
    let tree = render();
    expect(currency(tree).props.value).toBe('USD');
    expect(currency(tree).props.disabled).toBe(true);

    auth.defaultCurrency = 'EUR';
    auth.profileLoading = false;
    tree = render();
    expect(currency(tree).props.value).toBe('EUR');
    expect(currency(tree).props.disabled).toBe(false);
    expect(currencySave(tree).props.disabled).toBe(true);
  });

  it('preserves an edited selection during same-account refresh and clears dirty when saved data catches up', () => {
    const render = mountDraft(DealsSettings);
    change(currency(render()), 'GBP');
    auth.defaultCurrency = 'EUR';
    let tree = render();
    expect(currency(tree).props.value).toBe('GBP');
    expect(currencySave(tree).props.disabled).toBe(false);

    auth.defaultCurrency = 'GBP';
    tree = render();
    expect(currency(tree).props.value).toBe('GBP');
    expect(currencySave(tree).props.disabled).toBe(true);
  });

  it.each(['account', 'user'])(
    'discards the selected currency when the %s identity changes',
    (identity) => {
      const render = mountDraft(DealsSettings);
      change(currency(render()), 'GBP');
      expect(currency(render()).props.value).toBe('GBP');
      const previousKey = DealsSettings().key;

      if (identity === 'account') auth.accountId = 'account-b';
      else auth.user = { id: 'user-b' };
      auth.defaultCurrency = 'EUR';
      expect(DealsSettings().key).not.toBe(previousKey);
      const tree = render();
      expect(currency(tree).props.value).toBe('EUR');
      expect(currencySave(tree).props.disabled).toBe(true);
    }
  );
});
