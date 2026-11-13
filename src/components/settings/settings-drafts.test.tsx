import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  effects: [] as (() => void)[],
  changed: false,
}));
const auth = vi.hoisted(() => ({
  user: { id: "user-a" },
  accountId: "account-a",
  profile: null as { full_name: string | null; email: string } | null,
  defaultCurrency: "USD",
  canEditSettings: true,
  profileLoading: false,
  refreshProfile: vi.fn(),
}));

const database = vi.hoisted(() => ({
  eq: vi.fn(),
  updateUser: vi.fn(),
}));

// Node-only hook runner: retain state between renders and flush dependency-based
// effects. It does not render leaf components, reconcile DOM, or run cleanups.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  function useState<T>(initial: T | (() => T)) {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) {
      hooks.slots[index] = typeof initial === "function"
        ? (initial as () => T)() : initial;
    }
    return [hooks.slots[index], (next: T | ((previous: T) => T)) => {
      const value = typeof next === "function"
        ? (next as (previous: T) => T)(hooks.slots[index] as T) : next;
      hooks.changed ||= !Object.is(value, hooks.slots[index]);
      hooks.slots[index] = value;
    }] as const;
  }
  return {
    ...actual,
    useState,
    useRef: (initial: unknown) => useState({ current: initial })[0],
    useEffect: (effect: () => void, dependencies?: unknown[]) => {
      const index = hooks.cursor++;
      const previous = hooks.slots[index] as unknown[] | undefined;
      if (!dependencies || !previous || dependencies.length !== previous.length ||
          dependencies.some((value, i) => !Object.is(value, previous[i]))) {
        hooks.effects.push(effect);
      }
      hooks.slots[index] = dependencies;
    },
  };
});
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => auth }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({
  from: () => ({ update: () => ({ eq: database.eq }) }),
  auth: { updateUser: database.updateUser },
}) }));
vi.mock("next-intl", async (importOriginal) => ({
  ...await importOriginal<typeof import("next-intl")>(),
  useTranslations: () => Object.assign((key: string) => key, {
    rich: (key: string, values?: { newEmail?: string }) => values?.newEmail ?? key,
  }),
}));
vi.mock("./browser-notifications-card", () => ({ BrowserNotificationsCard: () => null }));

import { ProfileForm } from "./profile-form";
import { DealsSettings } from "./deals-settings";

function mountDraft(Component: () => ReactElement) {
  let previousKey: string | null | undefined;
  return () => {
    const child = Component();
    if (child.key !== previousKey) hooks.slots = [];
    previousKey = child.key;
    expect(typeof child.type).toBe("function");
    for (let pass = 0; pass < 10; pass++) {
      hooks.cursor = 0;
      hooks.changed = false;
      hooks.effects = [];
      const tree = (child.type as () => ReactElement)();
      hooks.effects.forEach((effect) => effect());
      if (!hooks.changed) return tree;
    }
    throw new Error("Draft did not settle after 10 renders");
  };
}

type ControlProps = {
  children?: ReactNode;
  id?: string;
  value?: string;
  disabled?: boolean;
  type?: string;
  onChange?: (event: { target: { value: string } }) => void;
  onSubmit?: (event: { preventDefault: () => void }) => Promise<void>;
  onClick?: () => Promise<void>;
};
function find(tree: ReactNode, match: (node: ReactElement<ControlProps>) => boolean): ReactElement<ControlProps> {
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
  if (!result) throw new Error("Expected draft control not found");
  return result;
}
const field = (tree: ReactNode, id: string) => find(tree, (node) => node.props.id === id);
const currency = (tree: ReactNode) => find(tree, (node) => node.type === "select");
const profileSave = (tree: ReactNode) => find(tree, (node) => node.props.type === "submit");
const currencySave = (tree: ReactNode) => find(tree, (node) => node.props.children === "save");
function change(control: ReactElement<ControlProps>, value: string) {
  expect(control.props.onChange).toBeTypeOf("function");
  control.props.onChange!({ target: { value } });
}

beforeEach(() => {
  hooks.slots = [];
  database.eq.mockReset().mockResolvedValue({ error: null });
  database.updateUser.mockReset().mockResolvedValue({ error: null });
  auth.refreshProfile.mockReset();
  Object.assign(auth, {
    user: { id: "user-a" }, accountId: "account-a", profile: null,
    defaultCurrency: "USD", canEditSettings: true, profileLoading: false,
  });
});

describe("ProfileForm drafts", () => {
  it("fills untouched inputs when the profile arrives after the initial render", () => {
    const render = mountDraft(ProfileForm);
    let tree = render();
    expect(field(tree, "profile-full-name").props.value).toBe("");
    expect(field(tree, "profile-email").props.value).toBe("");
    expect(profileSave(tree).props.disabled).toBe(true);

    auth.profile = { full_name: "Alice", email: "alice@example.com" };
    tree = render();
    expect(field(tree, "profile-full-name").props.value).toBe("Alice");
    expect(field(tree, "profile-email").props.value).toBe("alice@example.com");
    expect(profileSave(tree).props.disabled).toBe(true);
  });

  it.each([
    ["profile-full-name", "Local name", "profile-email", "updated@example.com"],
    ["profile-email", "local@example.com", "profile-full-name", "Updated name"],
    ["profile-full-name", "", "profile-email", "updated@example.com"],
    ["profile-email", "", "profile-full-name", "Updated name"],
  ])("preserves edited %s (including empty drafts) while untouched fields refresh: %s", (edited, draft, untouched, refreshed) => {
    auth.profile = { full_name: "Alice", email: "alice@example.com" };
    const render = mountDraft(ProfileForm);
    change(field(render(), edited), draft);
    auth.profile = { full_name: "Updated name", email: "updated@example.com" };
    const tree = render();
    expect(field(tree, edited).props.value).toBe(draft);
    expect(field(tree, untouched).props.value).toBe(refreshed);
    expect(profileSave(tree).props.disabled).toBe(false);
  });

  it.each(["account", "user"])("discards both drafts when the %s identity changes", (identity) => {
    auth.profile = { full_name: "Alice", email: "alice@example.com" };
    const render = mountDraft(ProfileForm);
    const initial = render();
    change(field(initial, "profile-full-name"), "Unsaved name");
    change(field(initial, "profile-email"), "unsaved@example.com");
    expect(field(render(), "profile-full-name").props.value).toBe("Unsaved name");
    const previousKey = ProfileForm().key;

    if (identity === "account") auth.accountId = "account-b";
    else auth.user = { id: "user-b" };
    auth.profile = { full_name: "Bob", email: "bob@example.com" };
    expect(ProfileForm().key).not.toBe(previousKey);
    const tree = render();
    expect(field(tree, "profile-full-name").props.value).toBe("Bob");
    expect(field(tree, "profile-email").props.value).toBe("bob@example.com");
    expect(profileSave(tree).props.disabled).toBe(true);
  });
});

describe("submitted drafts", () => {
  const submitProfile = (tree: ReactNode) =>
    find(tree, (node) => node.type === "form").props.onSubmit!({ preventDefault() {} });

  it("rebases a submitted email to the verified profile without resending on a later name save", async () => {
    auth.profile = { full_name: "Alice", email: "alice@example.com" };
    const render = mountDraft(ProfileForm);
    change(field(render(), "profile-email"), "requested@example.com");
    auth.refreshProfile.mockImplementation(async () => {
      auth.profile = { full_name: "Alice", email: "alice@example.com" };
    });
    await submitProfile(render());
    let tree = render();
    expect(field(tree, "profile-email").props.value).toBe("alice@example.com");
    expect(profileSave(tree).props.disabled).toBe(true);
    expect(find(tree, (node) => node.props.children === "requested@example.com")).toBeDefined();

    change(field(tree, "profile-full-name"), "New name");
    auth.refreshProfile.mockImplementation(async () => {
      auth.profile = { full_name: "New name", email: "alice@example.com" };
    });
    await submitProfile(render());
    tree = render();
    expect(database.updateUser).toHaveBeenCalledTimes(1);
    expect(profileSave(tree).props.disabled).toBe(true);
    auth.profile = { full_name: "External name", email: "alice@example.com" };
    expect(field(render(), "profile-full-name").props.value).toBe("External name");
  });

  it("keeps a failed email draft but rebases the successfully saved name", async () => {
    auth.profile = { full_name: "Alice", email: "alice@example.com" };
    const render = mountDraft(ProfileForm);
    const tree = render();
    change(field(tree, "profile-full-name"), "Saved name");
    change(field(tree, "profile-email"), "retry@example.com");
    database.updateUser.mockResolvedValue({ error: { message: "Try again" } });
    auth.refreshProfile.mockImplementation(async () => {
      auth.profile = { full_name: "Saved name", email: "alice@example.com" };
    });
    await submitProfile(render());
    auth.profile = { full_name: "External name", email: "alice@example.com" };
    expect(field(render(), "profile-full-name").props.value).toBe("External name");
    expect(field(render(), "profile-email").props.value).toBe("retry@example.com");
  });

  it("keeps drafts when the profile write fails", async () => {
    auth.profile = { full_name: "Alice", email: "alice@example.com" };
    const render = mountDraft(ProfileForm);
    change(field(render(), "profile-full-name"), "Retry name");
    database.eq.mockResolvedValue({ error: { message: "Try again" } });
    await submitProfile(render());
    expect(field(render(), "profile-full-name").props.value).toBe("Retry name");
    expect(database.updateUser).not.toHaveBeenCalled();
    expect(auth.refreshProfile).not.toHaveBeenCalled();
  });

  it("does not discard newer profile edits made while refresh is in flight", async () => {
    auth.profile = { full_name: "Alice", email: "alice@example.com" };
    const render = mountDraft(ProfileForm);
    change(field(render(), "profile-full-name"), "Submitted name");
    auth.refreshProfile.mockImplementation(async () => {
      const tree = render();
      change(field(tree, "profile-full-name"), "Newer name");
      change(field(tree, "profile-email"), "newer@example.com");
      auth.profile = { full_name: "Submitted name", email: "alice@example.com" };
    });
    await submitProfile(render());
    expect(field(render(), "profile-full-name").props.value).toBe("Newer name");
    expect(field(render(), "profile-email").props.value).toBe("newer@example.com");
  });

  it.each([false, true])("rebases saved currency and preserves newer edits: %s", async (newerEdit) => {
    const render = mountDraft(DealsSettings);
    change(currency(render()), "GBP");
    auth.refreshProfile.mockImplementation(async () => {
      if (newerEdit) change(currency(render()), "CAD");
      auth.defaultCurrency = "GBP";
    });
    await currencySave(render()).props.onClick!();
    expect(currency(render()).props.value).toBe(newerEdit ? "CAD" : "GBP");
    auth.defaultCurrency = "EUR";
    expect(currency(render()).props.value).toBe(newerEdit ? "CAD" : "EUR");
  });
});

describe("DealsSettings drafts", () => {
  it("uses the late-loaded account currency until the selection is edited", () => {
    auth.profileLoading = true;
    const render = mountDraft(DealsSettings);
    let tree = render();
    expect(currency(tree).props.value).toBe("USD");
    expect(currency(tree).props.disabled).toBe(true);

    auth.defaultCurrency = "EUR";
    auth.profileLoading = false;
    tree = render();
    expect(currency(tree).props.value).toBe("EUR");
    expect(currency(tree).props.disabled).toBe(false);
    expect(currencySave(tree).props.disabled).toBe(true);
  });

  it("preserves an edited selection during same-account refresh and clears dirty when saved data catches up", () => {
    const render = mountDraft(DealsSettings);
    change(currency(render()), "GBP");
    auth.defaultCurrency = "EUR";
    let tree = render();
    expect(currency(tree).props.value).toBe("GBP");
    expect(currencySave(tree).props.disabled).toBe(false);

    auth.defaultCurrency = "GBP";
    tree = render();
    expect(currency(tree).props.value).toBe("GBP");
    expect(currencySave(tree).props.disabled).toBe(true);
  });

  it.each(["account", "user"])("discards the selected currency when the %s identity changes", (identity) => {
    const render = mountDraft(DealsSettings);
    change(currency(render()), "GBP");
    expect(currency(render()).props.value).toBe("GBP");
    const previousKey = DealsSettings().key;

    if (identity === "account") auth.accountId = "account-b";
    else auth.user = { id: "user-b" };
    auth.defaultCurrency = "EUR";
    expect(DealsSettings().key).not.toBe(previousKey);
    const tree = render();
    expect(currency(tree).props.value).toBe("EUR");
    expect(currencySave(tree).props.disabled).toBe(true);
  });
});
