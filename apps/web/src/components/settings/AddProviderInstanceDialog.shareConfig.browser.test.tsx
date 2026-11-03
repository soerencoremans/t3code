import {
  EnvironmentId,
  ProviderInstanceId,
  type ClaudeAccountAddState,
  type ClaudeAccountList,
} from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

interface QueryView<A> {
  readonly data: A | null;
  readonly error: string | null;
  readonly failure: unknown;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

const state = vi.hoisted(() => ({
  os: "linux" as string | undefined,
  granted: true,
  view: null as QueryView<ClaudeAccountList> | null,
  addView: null as QueryView<ClaudeAccountAddState> | null,
  list: vi.fn((_target: unknown) => "claude-accounts"),
  addState: vi.fn((_target: unknown) => "claude-account-add-state"),
  start: vi.fn(),
  respond: vi.fn(),
  cancel: vi.fn(),
  refresh: vi.fn(),
  toast: vi.fn(),
  persist: vi.fn(),
  onOpenChange: vi.fn(),
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
  const remember = actual.serverEnvironment.rememberClaudeAccount;
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      claudeAccountList: state.list as never,
      rememberClaudeAccount: Object.assign(Object.create(remember), {
        permissionAtom: () => cached(grants, state.granted, () => Atom.make(state.granted)),
      }) as never,
      startClaudeAccountAdd: state.start as never,
      respondClaudeAccountAdd: state.respond as never,
      cancelClaudeAccountAdd: state.cancel as never,
      claudeAccountAddState: state.addState as never,
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
// The list and the add state behave like live queries: changing a view and calling `publish()`
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
    useEnvironmentQuery: ((key: unknown) =>
      useSyncExternalStore(subscribe, () =>
        key === "claude-account-add-state" ? state.addView : state.view,
      )) as never,
  };
});
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => ({ providerInstances: {} })) as never,
  usePersistEnvironmentProviderInstanceMutation: (() => state.persist) as never,
}));
vi.mock(import("../../state/session"), async (original) => {
  const hasScope = (_environmentId: EnvironmentId, scope: string) =>
    scope === "providers:manage" && state.granted;
  return {
    ...(await original()),
    useEnvironmentScope: hasScope as never,
    readEnvironmentScope: hasScope as never,
  };
});
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: state.toast } };
});
// Ghostty does not load headless.
vi.mock(import("./ProviderAuthTerminal"), () => ({
  default: ({ output }) => <pre data-testid="terminal">{output}</pre>,
}));

import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";

const environmentId = EnvironmentId.make("remote-linux");
const claudeAgent = ProviderInstanceId.make("claudeAgent");
const claudeWork = ProviderInstanceId.make("claudeAgent_work");
const loggedIn = { email: "work@example.com", rememberedAs: "Work" };
const oneSetup: ClaudeAccountList = {
  accounts: [{ name: "Work", email: "work@example.com" }],
  setups: [{ instanceId: claudeAgent, displayName: null, active: loggedIn }],
};
const twoSetups: ClaudeAccountList = {
  accounts: oneSetup.accounts,
  setups: [
    { instanceId: claudeAgent, displayName: null, active: loggedIn },
    { instanceId: claudeWork, displayName: "Work Claude", active: loggedIn },
  ],
};
const running: ClaudeAccountAddState = {
  attemptId: "a1",
  instanceId: claudeAgent,
  name: "Private",
  phase: "running",
  output: "",
  outputOffset: 0,
  account: null,
  error: null,
};
const success = (value: unknown = undefined) => ({ _tag: "Success", value });
const SHARE_LABEL = "Share config with my existing Claude setup";

function setList(data: ClaudeAccountList | null) {
  state.view = { data, error: null, failure: null, isPending: false, refresh: state.refresh };
}
const publish = () =>
  act(async () => {
    for (const listener of queryListeners) listener();
  });
function setAdd(data: ClaudeAccountAddState | null) {
  state.addView = { data, error: null, failure: null, isPending: false, refresh: () => {} };
}
function publishAdd(data: ClaudeAccountAddState) {
  setAdd(data);
  return publish();
}

// Keeps `open` in state and unmounts the dialog on close, as the provider settings panel does.
function Host() {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <AddProviderInstanceDialog
      open
      environmentId={environmentId}
      environmentLabel="Remote Linux"
      onOpenChange={(next) => {
        state.onOpenChange(next);
        if (!next) setOpen(false);
      }}
    />
  );
}

let root: Root;

const render = () => act(async () => root.render(<Host />));
function button(label: string) {
  return (
    [...document.querySelectorAll("button")].find(
      (element) => element.textContent?.trim() === label,
    ) ?? null
  );
}
async function click(label: string) {
  const target = button(label);
  expect(target, `button ${label}`).not.toBeNull();
  expect(target!.disabled, `${label} disabled`).toBe(false);
  await act(async () => target!.click());
}
async function chooseDriver(label: string) {
  const radio = [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find((element) =>
    element.textContent?.includes(label),
  );
  expect(radio, `radio ${label}`).toBeDefined();
  await act(async () => radio!.click());
}
async function chooseClaude() {
  await chooseDriver("Claude");
  await click("Next");
}
const shareCheckbox = () =>
  [...document.querySelectorAll<HTMLElement>('[role="checkbox"]')].find((element) =>
    element.closest("label")?.textContent?.includes(SHARE_LABEL),
  ) ?? null;
const toggleShare = () => act(async () => shareCheckbox()!.click());
// Off-step rows stay mounted under a `hidden` ancestor; only what is laid out counts as shown.
const visible = (element: Element | null) =>
  element !== null && (element as HTMLElement).offsetParent !== null;
const shown = (selector: string) => visible(document.querySelector(selector));
const shownText = (text: string) =>
  [...document.querySelectorAll<HTMLElement>("div, span, label")].some(
    (element) => element.textContent?.trim() === text && visible(element),
  );
const identityShown = () =>
  shown("#add-provider-label") && shown("#add-provider-instance-id") && shownText("Accent color");
const identityHidden = () =>
  !shown("#add-provider-label") &&
  !shown("#add-provider-instance-id") &&
  !shownText("Accent color");
const stepTitles = () =>
  [...document.querySelectorAll('ol[aria-label="Setup progress"] > li [aria-label]')].map(
    (element) => element.getAttribute("aria-label")!.split(",")[0],
  );
const title = () => document.querySelector('[data-slot="dialog-title"]')?.textContent ?? null;
const setupTrigger = () => document.querySelector<HTMLElement>("#add-provider-claude-setup");
const setupOption = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (element) => element.textContent?.trim() === label,
  );
async function nameAndLogIn() {
  await act(() =>
    userEvent.fill(
      document.querySelector<HTMLInputElement>('input[aria-label="Account name"]')!,
      "Private",
    ),
  );
  await click("Log in…");
}
const flushMicrotasks = () => act(async () => {});

describe("AddProviderInstanceDialog share config", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    state.os = "linux";
    state.granted = true;
    setAdd(null);
    setList(oneSetup);
    state.start.mockReset().mockResolvedValue(success(running));
    state.respond.mockReset().mockResolvedValue(success());
    state.cancel.mockReset().mockResolvedValue(success());
    state.persist.mockReset().mockResolvedValue(success({}));
    root = createRoot(document.body.appendChild(document.createElement("div")));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("fetches the list when Claude is chosen, before Next, and only once", async () => {
    await render();
    await chooseDriver("Claude");
    expect(state.list).toHaveBeenCalledTimes(1);
    expect(state.list).toHaveBeenCalledWith({ environmentId, input: {} });

    await click("Next");
    expect(state.list).toHaveBeenCalledTimes(1);
  });

  it("AK-19 / AK-33: offers the option unticked above the identity rows on Linux", async () => {
    await render();
    await chooseClaude();

    const checkbox = shareCheckbox();
    expect(visible(checkbox)).toBe(true);
    expect(checkbox!.getAttribute("aria-checked")).toBe("false");
    const labelRow = document.querySelector("#add-provider-label")!;
    expect(
      checkbox!.compareDocumentPosition(labelRow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(identityShown()).toBe(true);
    expect(button("Next")).not.toBeNull();
  });

  it.each([
    [
      "only a logged-out setup",
      { ...oneSetup, setups: [{ ...oneSetup.setups[0]!, active: null }] },
    ],
    ["no setups", { accounts: [], setups: [] }],
  ] as const)("AK-20: hides the option with %s", async (_name, list) => {
    setList(list);
    await render();
    await chooseClaude();

    expect(shareCheckbox()).toBeNull();
    expect(identityShown()).toBe(true);
    expect(button("Next")).not.toBeNull();
  });

  it.each([
    ["off Linux", () => (state.os = "darwin")],
    ["without the providers:manage grant", () => (state.granted = false)],
  ])("AK-34: hides the option %s, without calling the list or an alert", async (_name, arrange) => {
    arrange();
    await render();
    await chooseClaude();

    expect(shareCheckbox()).toBeNull();
    expect(state.list).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("offers the option for Claude only", async () => {
    await render();
    await click("Configure manually");

    expect(shareCheckbox()).toBeNull();
  });

  it("AK-21: one setup — adds the account to it and creates no provider", async () => {
    await render();
    await chooseClaude();
    await toggleShare();

    expect(identityHidden()).toBe(true);
    expect(setupTrigger()).toBeNull();
    expect(stepTitles()).toEqual(["Provider", "Identity"]);
    expect(button("Next")).toBeNull();

    await click("Add account…");
    expect(title()).toBe("Add Claude account");
    expect(document.body.textContent).not.toContain("Add provider");

    await nameAndLogIn();
    expect(state.start).toHaveBeenCalledTimes(1);
    expect(state.start).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId: claudeAgent, name: "Private" },
    });

    await expect.poll(() => document.querySelector('[data-testid="terminal"]')).not.toBeNull();
    await publishAdd({
      ...running,
      phase: "succeeded",
      account: { name: "Private", email: "private@example.com" },
    });
    await expect.poll(() => document.body.textContent).toContain("Added “Private”.");

    await click("Done");
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(state.onOpenChange).toHaveBeenCalledWith(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(state.persist).not.toHaveBeenCalled();
    expect(state.toast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "Provider instance added" }),
    );
  });

  it("two setups — the Setup select chooses which one gets the account", async () => {
    setList(twoSetups);
    await render();
    await chooseClaude();
    await toggleShare();

    expect(setupTrigger()?.textContent).toContain("Claude");
    expect(setupTrigger()?.textContent).not.toContain("Work Claude");
    await act(async () => setupTrigger()!.click());
    await expect.poll(() => setupOption("Work Claude")).toBeDefined();
    await act(async () => setupOption("Work Claude")!.click());
    await expect.poll(() => setupTrigger()?.textContent).toContain("Work Claude");

    await click("Add account…");
    await nameAndLogIn();
    expect(state.start).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId: claudeWork, name: "Private" },
    });
  });

  it("unticking restores the identity rows and a new driver choice starts unticked", async () => {
    await render();
    await chooseClaude();
    await toggleShare();
    await toggleShare();

    expect(identityShown()).toBe(true);
    expect(stepTitles()).toEqual(["Provider", "Identity", "Config"]);
    expect(button("Next")).not.toBeNull();

    await toggleShare();
    await click("Back");
    await chooseDriver("Codex");
    await chooseDriver("Claude");
    await click("Next");
    expect(shareCheckbox()!.getAttribute("aria-checked")).toBe("false");
    expect(identityShown()).toBe(true);
  });

  it("AK-22 / AK-23: Cancel during the login stops the attempt once and closes", async () => {
    await render();
    await chooseClaude();
    await toggleShare();
    await click("Add account…");
    await nameAndLogIn();
    await expect.poll(() => document.querySelector('[data-testid="terminal"]')).not.toBeNull();

    await click("Cancel");
    await flushMicrotasks();

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(state.onOpenChange).toHaveBeenCalledWith(false);
    expect(state.cancel).toHaveBeenCalledTimes(1);
    expect(state.cancel).toHaveBeenCalledWith({ environmentId, input: { attemptId: "a1" } });
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });
});
