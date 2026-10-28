import {
  ClaudeAccountError,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ClaudeAccountErrorReason,
  type ClaudeAccountList,
  type ServerProvider,
} from "@t3tools/contracts";
import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

interface QueryView {
  readonly data: ClaudeAccountList | null;
  readonly error: string | null;
  readonly failure: unknown;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

const state = vi.hoisted(() => ({
  os: "linux" as string | undefined,
  granted: true,
  view: null as QueryView | null,
  list: vi.fn((_target: unknown) => "claude-accounts"),
  refresh: vi.fn(),
  remember: vi.fn(),
  switch: vi.fn(),
  confirm: vi.fn(),
  navigate: vi.fn(),
  toast: vi.fn(),
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const configs = new Map<string | undefined, Atom.Atom<unknown>>();
  const grants = new Map<boolean, Atom.Atom<boolean>>();
  const cached = <K, A>(map: Map<K, A>, key: K, make: () => A) => {
    if (!map.has(key)) map.set(key, make());
    return map.get(key)!;
  };
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      claudeAccountList: state.list as never,
      rememberClaudeAccount: Object.assign(state.remember, {
        permissionAtom: () => cached(grants, state.granted, () => Atom.make(state.granted)),
      }) as never,
      switchClaudeAccount: state.switch as never,
      configValueAtom: (() =>
        cached(configs, state.os, () =>
          Atom.make({ environment: { platform: { os: state.os } } }),
        )) as never,
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
// The list behaves like a live query: changing `state.view` and calling `publish()`
// re-renders every component that reads it.
const queryListeners = vi.hoisted(() => new Set<() => void>());
vi.mock(import("../../state/query"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    queryListeners.add(listener);
    return () => queryListeners.delete(listener);
  };
  return {
    ...(await original()),
    useEnvironmentQuery: (() => useSyncExternalStore(subscribe, () => state.view)) as never,
  };
});
vi.mock(import("../../localApi"), async (original) => ({
  ...(await original()),
  ensureLocalApi: () => ({ dialogs: { confirm: state.confirm } }) as never,
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: state.toast } };
});

const favoritesAtom = Atom.make<ReadonlyArray<{ provider: ProviderInstanceId; model: string }>>(
  [],
).pipe(Atom.keepAlive);

vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentModelPreferences: () => ({
    favorites: useAtomValue(favoritesAtom),
    providerModelPreferences: {},
  }),
  useToggleEnvironmentModelFavorite: () => {
    const setFavorites = useAtomSet(favoritesAtom);
    return async (provider: ProviderInstanceId, model: string) => {
      setFavorites((favorites) =>
        favorites.filter((favorite) => favorite.provider !== provider || favorite.model !== model),
      );
    };
  },
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: () => state.navigate,
}));

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { useClaudeAccountSwitch } from "../settings/useClaudeAccounts";
import { ProviderModelPicker } from "./ProviderModelPicker";

const environmentId = EnvironmentId.make("remote-linux");
const instanceId = ProviderInstanceId.make("claudeAgent");
const codexId = ProviderInstanceId.make("codex");
const work = { name: "Work", email: "bob@example.com" };
const priv = { name: "Private", email: "carol@example.org" };

function accounts(
  active: { email: string; rememberedAs: string | null } | null,
  remembered = [work, priv],
): ClaudeAccountList {
  return { accounts: remembered, setups: [{ instanceId, displayName: null, active }] };
}
const workActive = accounts({ email: work.email, rememberedAs: "Work" });
const privateActive = accounts({ email: priv.email, rememberedAs: "Private" });

function setList(data: ClaudeAccountList | null, failure: unknown = null) {
  state.view = {
    data,
    error: failure === null ? null : "formatted",
    failure,
    isPending: false,
    refresh: state.refresh,
  };
}
const publish = () =>
  act(async () => {
    for (const listener of queryListeners) listener();
  });

const success = (value: unknown = undefined) => ({ _tag: "Success", value });
const refusal = (reason: ClaudeAccountErrorReason) => ({
  _tag: "Failure",
  cause: Cause.fail(new ClaudeAccountError({ reason })),
});
const message = (reason: ClaudeAccountErrorReason) => new ClaudeAccountError({ reason }).message;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const switchConfirm = `Switch this Claude setup to "Private"? Switching stops running Claude turns on this setup, in every chat that uses it. Queued messages wait and send on the new account. Send "continue" to pick a stopped turn up.`;

function providerEntry(id: string, driver: string) {
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-28T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
  return deriveProviderInstanceEntries([provider])[0]!;
}
const claudeEntry = providerEntry("claudeAgent", "claudeAgent");
const codexEntry = providerEntry("codex", "codex");

// Stands in for the settings card: a second user of the same switch hook.
function SettingsStandIn() {
  const { switchTo } = useClaudeAccountSwitch(environmentId, instanceId, () => {});
  return (
    <button type="button" data-testid="settings-switch" onClick={() => void switchTo("Private")} />
  );
}

let root: Root;
let registry: AtomRegistry.AtomRegistry;

async function render(
  options: {
    readonly environmentId?: EnvironmentId | null;
    readonly multiModel?: boolean;
    readonly standIn?: boolean;
  } = {},
) {
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <ProviderModelPicker
          environmentId={
            options.environmentId === undefined ? environmentId : options.environmentId
          }
          activeInstanceId={instanceId}
          model="claude-opus"
          lockedProvider={null}
          instanceEntries={[claudeEntry, codexEntry]}
          modelOptionsByInstance={
            new Map([
              [instanceId, [{ slug: "claude-opus", name: "Claude Opus" }]],
              [codexId, [{ slug: "gpt-5", name: "GPT 5" }]],
            ])
          }
          {...(options.multiModel
            ? { selectedModels: [{ instanceId, model: "claude-opus" }], onToggleModel: () => {} }
            : {})}
          onInstanceModelChange={() => {}}
        />
        {options.standIn ? <SettingsStandIn /> : null}
      </RegistryContext.Provider>,
    ),
  );
}

const pickerTrigger = () =>
  document
    .querySelector<HTMLElement>('[data-chat-provider-model-picker-label="true"]')!
    .closest("button")!;
const searchInput = () => document.querySelector<HTMLInputElement>('input[type="text"], input')!;
const modelOption = () => page.getByRole("option", { name: /Claude Opus/ });
// A modal dialog hides the picker from the accessibility tree, so look in the DOM instead.
const modelInDom = () =>
  [...document.querySelectorAll('[role="option"]')].some((option) =>
    option.textContent?.includes("Claude Opus"),
  );

async function click(target: Parameters<typeof userEvent.click>[0]) {
  await act(async () => userEvent.click(target));
}
async function openPicker(tab = claudeEntry.displayName) {
  await click(pickerTrigger());
  await click(page.getByRole("button", { name: tab, exact: true }));
}
async function closePicker() {
  searchInput().focus();
  await act(async () => userEvent.keyboard("{Escape}"));
  await expect.element(modelOption()).not.toBeInTheDocument();
}

const row = () => document.querySelector<HTMLElement>('[data-slot="claude-account-picker-row"]');
const rowTrigger = () =>
  document.querySelector<HTMLButtonElement>(
    'button[aria-label^="Claude account for all Claude chats"]',
  );
const rowAlert = () => row()?.querySelector('[role="alert"]')?.textContent ?? null;
const rowStatus = () => row()?.querySelector('[role="status"]')?.textContent ?? null;
const menuItems = () => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
const menuOpen = () => document.querySelector('[role="menu"]') !== null;
function button(label: string) {
  return (
    [...document.querySelectorAll("button")].find(
      (element) => element.getAttribute("aria-label") === label || element.textContent === label,
    ) ?? null
  );
}

// The model rows' favorite buttons are tab stops too, so the row is a few Tabs away.
async function tabTo(target: Element | null) {
  for (let presses = 0; presses < 6 && document.activeElement !== target; presses++) {
    await act(async () => userEvent.keyboard("{Tab}"));
  }
  expect(document.activeElement).toBe(target);
}

async function openAccountMenu() {
  await click(rowTrigger()!);
  await expect.poll(menuOpen).toBe(true);
}
async function pickPrivate() {
  await openAccountMenu();
  await click(page.getByRole("menuitemradio", { name: "Private" }));
}

describe("ClaudeAccountPickerRow", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    state.os = "linux";
    state.granted = true;
    setList(workActive);
    state.remember.mockReset().mockResolvedValue(success(work));
    state.switch.mockReset().mockResolvedValue(success());
    state.confirm.mockReset().mockResolvedValue(false);
    registry = AtomRegistry.make();
    root = createRoot(document.body.appendChild(document.createElement("div")));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    registry.dispose();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("AK-1: shows the logged-in account for all Claude chats below the Claude models", async () => {
    await render();
    await openPicker();

    await expect.element(modelOption()).toBeVisible();
    expect(row()?.textContent).toContain("Account · all Claude chats");
    expect(row()?.textContent).toContain("Work");
    expect(rowTrigger()?.getAttribute("aria-label")).toBe(
      "Claude account for all Claude chats: Work",
    );
    expect(
      modelOption().element().compareDocumentPosition(row()!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(state.list).toHaveBeenCalledWith({ environmentId, input: {} });
  });

  it("AK-2: lists the remembered accounts and switches at once when no turns run", async () => {
    await render();
    await openPicker();
    await openAccountMenu();

    expect(menuItems().map((item) => item.textContent)).toEqual(["Work", "Private"]);
    expect(menuItems().map((item) => item.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    expect(document.querySelector('[role="menu"] [role="separator"]')).not.toBeNull();
    expect(page.getByRole("menuitem", { name: "Manage accounts" }).element()).toBeTruthy();

    await click(page.getByRole("menuitemradio", { name: "Private" }));

    expect(state.switch).toHaveBeenCalledTimes(1);
    expect(state.switch).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, name: "Private", stopRunningTurns: false },
    });
    expect(state.confirm).not.toHaveBeenCalled();
    await expect.poll(menuOpen).toBe(false);
    await expect.element(modelOption()).toBeVisible();
  });

  it("AK-3 / AK-4: asks before stopping running turns, and declining changes nothing", async () => {
    state.switch.mockResolvedValueOnce(refusal("turnsRunning"));
    await render();
    await openPicker();
    await pickPrivate();

    expect(state.confirm).toHaveBeenCalledTimes(1);
    expect(state.confirm).toHaveBeenCalledWith(switchConfirm, { variant: "destructive" });
    expect(state.switch).toHaveBeenCalledTimes(1);
    expect(rowAlert()).toBeNull();
    expect(rowTrigger()?.textContent).toContain("Work");
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it("AK-5: confirming switches again with running turns stopped", async () => {
    state.switch.mockResolvedValueOnce(refusal("turnsRunning"));
    state.confirm.mockResolvedValueOnce(true);
    await render();
    await openPicker();
    await pickPrivate();

    expect(state.switch).toHaveBeenCalledTimes(2);
    expect(state.switch).toHaveBeenLastCalledWith({
      environmentId,
      input: { instanceId, name: "Private", stopRunningTurns: true },
    });
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });

  it("AK-6: shows a running switch, even after the picker is closed and reopened", async () => {
    const call = deferred<unknown>();
    state.switch.mockReturnValueOnce(call.promise);
    await render();
    await openPicker();
    await pickPrivate();

    expect(rowTrigger()?.textContent).toContain("Switching to Private…");
    expect(rowStatus()).toBe("Switching Claude account to Private…");
    await click(rowTrigger()!);
    expect(menuOpen()).toBe(false);

    await closePicker();
    await openPicker();
    expect(rowTrigger()?.textContent).toContain("Switching to Private…");

    await act(async () => call.resolve(success()));
    await openAccountMenu();
  });

  it("AK-7: a switch started elsewhere blocks the picker's menu", async () => {
    const call = deferred<unknown>();
    state.switch.mockReturnValueOnce(call.promise);
    await render({ standIn: true });
    // Started before the picker opens: a press outside the picker would close it.
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-testid="settings-switch"]')!.click(),
    );
    await openPicker();

    expect(rowTrigger()?.textContent).toContain("Switching to Private…");
    await click(rowTrigger()!);
    expect(menuOpen()).toBe(false);
    expect(state.switch).toHaveBeenCalledTimes(1);

    await act(async () => call.resolve(success()));
  });

  it("AK-7: a switch refused because another runs shows why in the row, not as a toast", async () => {
    state.switch.mockResolvedValueOnce(refusal("switchInProgress"));
    await render();
    await openPicker();
    await pickPrivate();

    expect(rowAlert()).toBe(message("switchInProgress"));
    expect(state.toast).not.toHaveBeenCalled();
  });

  it("clears the switch error when the next pick starts", async () => {
    state.switch.mockResolvedValueOnce(refusal("switchInProgress"));
    const call = deferred<unknown>();
    state.switch.mockReturnValueOnce(call.promise);
    await render();
    await openPicker();
    await pickPrivate();
    expect(rowAlert()).toBe(message("switchInProgress"));

    await pickPrivate();
    expect(rowAlert()).toBeNull();
    await act(async () => call.resolve(success()));
  });

  it("AK-8: after a switch the row shows the new account and announces it", async () => {
    await render();
    await openPicker();
    await pickPrivate();
    setList(privateActive);
    await publish();

    expect(rowTrigger()?.textContent).toContain("Private");
    expect(rowTrigger()?.textContent).not.toContain("Work");
    expect(rowStatus()).toBe("Claude account switched to Private.");
  });

  it("reports a failed switch as a toast when the picker closed while it ran", async () => {
    const call = deferred<unknown>();
    state.switch.mockReturnValueOnce(call.promise);
    await render();
    await openPicker();
    await pickPrivate();
    await closePicker();

    await act(async () => call.resolve(refusal("externalClaudePrograms")));
    expect(state.toast).toHaveBeenCalledTimes(1);
    expect(state.toast).toHaveBeenCalledWith({
      type: "error",
      title: "Claude account not switched",
      description: message("externalClaudePrograms"),
    });
  });

  it("reports a successful switch as a toast when the picker closed while it ran", async () => {
    const call = deferred<unknown>();
    state.switch.mockReturnValueOnce(call.promise);
    await render();
    await openPicker();
    await pickPrivate();
    await closePicker();

    await act(async () => call.resolve(success()));
    expect(state.toast).toHaveBeenCalledWith({
      type: "success",
      title: "Claude account switched to Private",
    });
  });

  it("AK-12: offers to remember an account T3 has not remembered yet", async () => {
    setList(accounts({ email: work.email, rememberedAs: null }, [priv]));
    await render();
    await openPicker();

    expect(row()?.querySelector('[aria-label="Toggle account email visibility"]')).not.toBeNull();
    expect(button("Remember the Claude account for all Claude chats")?.textContent).toBe(
      "Remember…",
    );
    expect(rowTrigger()).toBeNull();
    expect(menuItems()).toEqual([]);
  });

  it("AK-13: remembers the account from the picker and keeps the picker open", async () => {
    setList(accounts({ email: work.email, rememberedAs: null }, [priv]));
    await render();
    await openPicker();
    await click(button("Remember the Claude account for all Claude chats")!);
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Account name"]')!;
    expect(modelInDom()).toBe(true);
    await act(() => userEvent.fill(input, "Work"));
    await click(page.getByRole("button", { name: "Remember", exact: true }));

    expect(state.remember).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, name: "Work" },
    });
    await expect.poll(() => document.querySelector('input[aria-label="Account name"]')).toBeNull();
    expect(modelInDom()).toBe(true);
    expect(state.refresh).toHaveBeenCalledTimes(1);

    setList(workActive);
    await publish();
    expect(rowTrigger()?.textContent).toContain("Work");
    await expect.poll(() => document.activeElement).toBe(rowTrigger());
  });

  it("returns focus to Remember… when the dialog is cancelled", async () => {
    setList(accounts({ email: work.email, rememberedAs: null }, [priv]));
    await render();
    await openPicker();
    const remember = button("Remember the Claude account for all Claude chats")!;
    await click(remember);
    await click(page.getByRole("button", { name: "Cancel" }));

    await expect.poll(() => document.activeElement).toBe(remember);
    await expect.element(modelOption()).toBeInTheDocument();
  });

  it("keyboard: Tab reaches the row, arrows and Enter switch, focus stays on the row", async () => {
    const call = deferred<unknown>();
    state.switch.mockReturnValueOnce(call.promise);
    await render();
    await openPicker();
    searchInput().focus();

    await tabTo(rowTrigger());
    await act(async () => userEvent.keyboard("{ArrowDown}"));
    await expect.poll(menuOpen).toBe(true);
    await expect.poll(() => document.activeElement?.getAttribute("role")).toBe("menuitemradio");
    for (let i = 0; i < 3 && document.activeElement?.textContent !== "Private"; i++) {
      await act(async () => userEvent.keyboard("{ArrowDown}"));
    }
    await act(async () => userEvent.keyboard("{Enter}"));

    expect(state.switch).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, name: "Private", stopRunningTurns: false },
    });
    await expect.poll(() => document.activeElement).toBe(rowTrigger());
    await act(async () => call.resolve(success()));
    expect(document.activeElement).toBe(rowTrigger());
  });

  it("keyboard: Tab reaches Remember…, Enter opens the dialog and submits the name", async () => {
    setList(accounts({ email: work.email, rememberedAs: null }, [priv]));
    await render();
    await openPicker();
    searchInput().focus();
    const remember = button("Remember the Claude account for all Claude chats");

    await tabTo(remember);
    await act(async () => userEvent.keyboard("{Enter}"));
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Account name"]')!;
    await expect.poll(() => document.activeElement).toBe(input);
    await act(async () => userEvent.keyboard("Work{Enter}"));

    expect(state.remember).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, name: "Work" },
    });
  });

  it("keyboard: Escape in the account menu closes only the menu", async () => {
    await render();
    await openPicker();
    rowTrigger()!.focus();
    await act(async () => userEvent.keyboard("{ArrowDown}"));
    await expect.poll(menuOpen).toBe(true);

    await act(async () => userEvent.keyboard("{Escape}"));
    await expect.poll(menuOpen).toBe(false);
    await expect.element(modelOption()).toBeVisible();
    await expect.poll(() => document.activeElement).toBe(rowTrigger());
  });

  it("AK-28: a forgotten account is no longer offered", async () => {
    await render();
    await openPicker();
    setList(accounts({ email: work.email, rememberedAs: "Work" }, [work]));
    await publish();
    await openAccountMenu();

    expect(menuItems().map((item) => item.textContent)).toEqual(["Work"]);
  });

  it("Manage accounts closes the picker and opens the setup's provider settings", async () => {
    await render();
    await openPicker();
    await openAccountMenu();
    await click(page.getByRole("menuitem", { name: "Manage accounts" }));

    await expect.element(modelOption()).not.toBeInTheDocument();
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/settings/providers",
      search: { environmentId, instanceId },
    });
  });

  it("says so when no account is logged in, and offers Manage accounts", async () => {
    setList(accounts(null, [priv]));
    await render();
    await openPicker();

    expect(row()?.textContent).toContain("No Claude account is logged in on this setup.");
    expect(button("Manage accounts")).not.toBeNull();
    expect(rowTrigger()).toBeNull();
  });

  it("shows a loading line before the list arrives", async () => {
    setList(null);
    await render();
    await openPicker();

    expect(row()?.textContent).toContain("Loading account…");
    expect(rowAlert()).toBeNull();
  });

  it("shows a read failure's reason with Retry, and clears it once the list arrives", async () => {
    setList(null, new ClaudeAccountError({ reason: "setupUnreadable" }));
    await render();
    await openPicker();

    expect(rowAlert()).toBe(message("setupUnreadable"));
    await click(button("Retry")!);
    expect(state.refresh).toHaveBeenCalledTimes(1);

    setList(workActive);
    await publish();
    expect(rowAlert()).toBeNull();
  });

  it("AK-33: shows the row on the Claude tab on Linux with the grant", async () => {
    await render();
    await openPicker();

    expect(row()).not.toBeNull();
  });

  it("AK-34: shows no row and never lists accounts off Linux", async () => {
    state.os = "darwin";
    await render();
    await openPicker();

    await expect.element(modelOption()).toBeVisible();
    expect(row()).toBeNull();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(state.list).not.toHaveBeenCalled();
  });

  it("AK-34: shows no row and never lists accounts without the provider grant", async () => {
    state.granted = false;
    await render();
    await openPicker();

    await expect.element(modelOption()).toBeVisible();
    expect(row()).toBeNull();
    expect(state.list).not.toHaveBeenCalled();
  });

  it("shows no row on the Codex tab or under Favorites", async () => {
    await render();
    await openPicker(codexEntry.displayName);
    await expect.element(page.getByRole("option", { name: /GPT 5/ })).toBeVisible();
    expect(row()).toBeNull();

    await click(page.getByRole("button", { name: "Favorites", exact: true }));
    expect(row()).toBeNull();
  });

  it("shows no row when the picker has no environment", async () => {
    await render({ environmentId: null });
    await openPicker();

    await expect.element(modelOption()).toBeVisible();
    expect(row()).toBeNull();
  });

  it("shows the row in multi-model mode", async () => {
    await render({ multiModel: true });
    await openPicker();

    await expect.element(modelOption()).toBeVisible();
    expect(row()).not.toBeNull();
  });
});
