import {
  ClaudeAccountError,
  EnvironmentId,
  ProviderInstanceId,
  type ClaudeAccountAddState,
  type ClaudeAccountErrorReason,
  type ClaudeAccountList,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import type { Atom } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

interface QueryView<A = ClaudeAccountList> {
  readonly data: A | null;
  readonly error: string | null;
  readonly failure: unknown;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

const state = vi.hoisted(() => ({
  os: "linux" as string | undefined,
  granted: true,
  view: null as QueryView | null,
  addView: null as QueryView<ClaudeAccountAddState> | null,
  list: vi.fn((_target: unknown) => "claude-accounts"),
  addState: vi.fn((_target: unknown) => "claude-account-add-state"),
  start: vi.fn(),
  respond: vi.fn(),
  cancel: vi.fn(),
  refresh: vi.fn(),
  remember: vi.fn(),
  forget: vi.fn(),
  switch: vi.fn(),
  confirm: vi.fn(),
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
      forgetClaudeAccount: state.forget as never,
      startClaudeAccountAdd: state.start as never,
      respondClaudeAccountAdd: state.respond as never,
      cancelClaudeAccountAdd: state.cancel as never,
      claudeAccountAddState: state.addState as never,
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
// The list and the add state behave like live queries: changing `state.view` and calling `publish()`
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
vi.mock(import("../../localApi"), async (original) => ({
  ...(await original()),
  ensureLocalApi: () => ({ dialogs: { confirm: state.confirm } }) as never,
}));

// Ghostty does not load headless.
vi.mock(import("./ProviderAuthTerminal"), () => ({
  default: ({ output }) => <pre data-testid="terminal">{output}</pre>,
}));

import { ClaudeAccountsSection } from "./ClaudeAccountsSection";
import { useClaudeAccountSwitch } from "./useClaudeAccounts";

const remoteEnvironmentId = EnvironmentId.make("remote-linux");
const instanceId = ProviderInstanceId.make("claudeAgent");
const work = { name: "Work", email: "bob@example.com" };
const priv = { name: "Private", email: "carol@example.org" };

function accounts(
  active: { email: string; rememberedAs: string | null } | null,
  remembered = [work, priv],
): ClaudeAccountList {
  return { accounts: remembered, setups: [{ instanceId, displayName: null, active }] };
}
const workActive = accounts({ email: work.email, rememberedAs: "Work" });

function setList(
  data: ClaudeAccountList | null,
  failure: { failure: unknown; error: string } | null = null,
) {
  state.view = {
    data,
    error: failure?.error ?? null,
    failure: failure?.failure ?? null,
    isPending: false,
    refresh: state.refresh,
  };
}
const publish = () =>
  act(async () => {
    for (const listener of queryListeners) listener();
  });

function publishAdd(data: ClaudeAccountAddState) {
  state.addView = { data, error: null, failure: null, isPending: false, refresh: () => {} };
  return publish();
}
const running: ClaudeAccountAddState = {
  attemptId: "a1",
  instanceId,
  name: "Private",
  phase: "running",
  output: "",
  outputOffset: 0,
  account: null,
  error: null,
};

const success = (value: unknown = undefined) => ({ _tag: "Success", value });
const refusal = (reason: ClaudeAccountErrorReason, name?: string) => ({
  _tag: "Failure",
  cause: Cause.fail(new ClaudeAccountError({ reason, ...(name ? { name } : {}) })),
});
const message = (reason: ClaudeAccountErrorReason, name?: string) =>
  new ClaudeAccountError({ reason, ...(name ? { name } : {}) }).message;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function PickerStandIn() {
  const { pendingTarget } = useClaudeAccountSwitch(remoteEnvironmentId, instanceId, () => {});
  return <output data-testid="picker-pending">{pendingTarget ?? "none"}</output>;
}

let root: Root;
let container: HTMLDivElement;

function render() {
  return act(async () =>
    root.render(
      <>
        <ClaudeAccountsSection environmentId={remoteEnvironmentId} instanceId={instanceId} />
        <PickerStandIn />
      </>,
    ),
  );
}

function button(label: string) {
  return (
    [...document.querySelectorAll("button")].find(
      (element) => element.getAttribute("aria-label") === label || element.textContent === label,
    ) ?? null
  );
}
async function click(label: string) {
  const target = button(label);
  expect(target, `button ${label}`).not.toBeNull();
  expect(target!.disabled, `${label} disabled`).toBe(false);
  await act(async () => target!.click());
}
function item(name: string) {
  return (
    [...container.querySelectorAll("li")].find(
      (element) => element.firstElementChild?.textContent === name,
    ) ?? null
  );
}
const section = () => container.querySelector('section[aria-label="Claude accounts"]');
const alertText = () => document.querySelector('[role="alert"]')?.textContent ?? null;
const pickerPending = () =>
  container.querySelector('[data-testid="picker-pending"]')?.textContent ?? null;
async function tooltipOf(label: string) {
  await act(() => userEvent.hover(button(label)!.parentElement!));
  await expect
    .poll(() => document.querySelector('[data-slot="tooltip-popup"][data-open]')?.textContent)
    .toBeTruthy();
  return document.querySelector('[data-slot="tooltip-popup"][data-open]')?.textContent;
}

const switchConfirm = `Switch this Claude setup to "Private"? Switching stops running Claude turns on this setup, in every chat that uses it. Queued messages wait and send on the new account. Send "continue" to pick a stopped turn up.`;

describe("ClaudeAccountsSection", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    state.os = "linux";
    state.granted = true;
    setList(workActive);
    state.addView = { data: null, error: null, failure: null, isPending: false, refresh: () => {} };
    for (const command of [state.remember, state.forget, state.switch, state.cancel]) {
      command.mockReset().mockResolvedValue(success());
    }
    state.start.mockReset().mockResolvedValue(success(running));
    state.confirm.mockReset().mockResolvedValue(false);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("AK-25 / AK-36: lists the remote setup's accounts and marks the active one", async () => {
    await render();

    expect(state.list).toHaveBeenCalledWith({ environmentId: remoteEnvironmentId, input: {} });
    expect(item("Work")?.textContent).toContain("Active");
    expect(button("Switch to Work")).toBeNull();
    expect(item("Private")?.textContent).not.toContain("Active");
    expect(button("Switch to Private")).not.toBeNull();
    expect(section()?.textContent).toContain("Logged in as Work");
    expect(section()?.textContent).toContain("Used by all chats on this setup.");
  });

  it("AK-26 / AK-39: switches at once when no turns run, then shows the new active account", async () => {
    await render();
    await click("Switch to Private");

    expect(state.switch).toHaveBeenCalledTimes(1);
    expect(state.switch).toHaveBeenCalledWith({
      environmentId: remoteEnvironmentId,
      input: { instanceId, name: "Private", stopRunningTurns: false },
    });
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.refresh).toHaveBeenCalledTimes(1);

    setList(accounts({ email: priv.email, rememberedAs: "Private" }));
    await publish();
    expect(item("Private")?.textContent).toContain("Active");
    expect(item("Work")?.textContent).not.toContain("Active");
  });

  it("AK-38 / AK-4: asks before stopping running turns, and declining changes nothing", async () => {
    state.switch.mockResolvedValueOnce(refusal("turnsRunning"));
    const answer = deferred<boolean>();
    state.confirm.mockReturnValueOnce(answer.promise);
    await render();
    await click("Switch to Private");

    expect(state.confirm).toHaveBeenCalledTimes(1);
    expect(state.confirm).toHaveBeenCalledWith(switchConfirm, { variant: "destructive" });
    expect(section()?.textContent).not.toContain("Switching to");
    expect(pickerPending()).toBe("none");

    await act(async () => answer.resolve(false));
    expect(state.switch).toHaveBeenCalledTimes(1);
    expect(alertText()).toBeNull();
    expect(item("Work")?.textContent).toContain("Active");
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it("AK-5: confirming stops the running turns and switches", async () => {
    state.switch.mockResolvedValueOnce(refusal("turnsRunning"));
    state.confirm.mockResolvedValueOnce(true);
    await render();
    await click("Switch to Private");

    expect(state.switch).toHaveBeenCalledTimes(2);
    expect(state.switch).toHaveBeenLastCalledWith({
      environmentId: remoteEnvironmentId,
      input: { instanceId, name: "Private", stopRunningTurns: true },
    });
    expect(state.refresh).toHaveBeenCalledTimes(1);
    expect(alertText()).toBeNull();
  });

  it("AK-7: no second switch starts while one runs, here or in the model picker", async () => {
    setList(
      accounts({ email: work.email, rememberedAs: "Work" }, [
        work,
        priv,
        { name: "Third", email: "t@example.com" },
      ]),
    );
    const call = deferred<unknown>();
    state.switch.mockReturnValueOnce(call.promise);
    await render();
    await click("Switch to Private");

    expect(section()?.textContent).toContain("Switching to Private…");
    expect(button("Switch to Private")!.disabled).toBe(true);
    expect(button("Switch to Third")!.disabled).toBe(true);
    expect(pickerPending()).toBe("Private");
    await act(async () => button("Switch to Third")!.click());
    expect(state.switch).toHaveBeenCalledTimes(1);

    await act(async () => call.resolve(success()));
    expect(button("Switch to Private")!.disabled).toBe(false);
    expect(button("Switch to Third")!.disabled).toBe(false);
    expect(pickerPending()).toBe("none");
    expect(section()?.textContent).not.toContain("Switching to");
  });

  it("AK-7: a switch refused because another one runs shows why and does not refresh", async () => {
    state.switch.mockResolvedValueOnce(refusal("switchInProgress"));
    await render();
    await click("Switch to Private");

    expect(alertText()).toBe(message("switchInProgress"));
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it("AK-31: a refused switch tells the user why in plain words", async () => {
    state.switch.mockResolvedValueOnce(refusal("externalClaudePrograms"));
    await render();
    await click("Switch to Private");

    const text = alertText();
    expect(text).toBe(message("externalClaudePrograms"));
    expect(text).not.toContain("claudeAgent");
    expect(text).not.toContain("`");
    expect(text).not.toContain("claude auth");
    expect(item("Work")?.textContent).toContain("Active");
  });

  it("AK-27 / AK-29: forget asks first, and declining keeps the account", async () => {
    await render();
    await click("Forget Private");

    expect(state.confirm).toHaveBeenCalledWith(
      `Forget "Private"? T3 deletes its saved login. You can't switch to it again unless you add it again.`,
      { variant: "destructive" },
    );
    expect(state.forget).not.toHaveBeenCalled();
    expect(item("Private")).not.toBeNull();
  });

  it("AK-28: confirming forget removes the account from the list", async () => {
    state.confirm.mockResolvedValueOnce(true);
    await render();
    await click("Forget Private");

    expect(state.forget).toHaveBeenCalledWith({
      environmentId: remoteEnvironmentId,
      input: { name: "Private" },
    });
    expect(state.refresh).toHaveBeenCalledTimes(1);
    setList(accounts({ email: work.email, rememberedAs: "Work" }, [work]));
    await publish();
    expect(item("Private")).toBeNull();
  });

  it("AK-30: forgetting the active account keeps the login and offers to remember it", async () => {
    state.confirm.mockResolvedValueOnce(true);
    await render();
    await click("Forget Work");

    expect(state.confirm).toHaveBeenCalledWith(
      `Forget "Work"? T3 deletes its saved login. This setup stays logged in as bob@example.com, but you can't switch back to it after switching away, unless you add it again.`,
      { variant: "destructive" },
    );
    setList(accounts({ email: work.email, rememberedAs: null }, [priv]));
    await publish();

    expect(button("Remember…")).not.toBeNull();
    expect(section()?.textContent).toContain("Remember it to switch back to it later.");
    expect(button("Switch to Private")!.disabled).toBe(true);
    expect(await tooltipOf("Switch to Private")).toBe("Remember the current account first.");
  });

  it("AK-14: remembers the logged-in account under a name", async () => {
    setList(accounts({ email: work.email, rememberedAs: null }, [priv]));
    state.remember.mockResolvedValueOnce(success(work));
    await render();
    await click("Remember…");
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Account name"]')!;
    await act(() => userEvent.fill(input, "Work"));
    await click("Remember");

    expect(state.remember).toHaveBeenCalledWith({
      environmentId: remoteEnvironmentId,
      input: { instanceId, name: "Work" },
    });
    expect(document.querySelector('input[aria-label="Account name"]')).toBeNull();
    expect(state.refresh).toHaveBeenCalledTimes(1);

    setList(accounts({ email: work.email, rememberedAs: "Work" }, [work, priv]));
    await publish();
    expect(item("Work")?.textContent).toContain("Active");
  });

  it("keeps the remember dialog open with the server's reason, and submits once", async () => {
    setList(accounts({ email: work.email, rememberedAs: null }, [priv]));
    const call = deferred<unknown>();
    state.remember.mockReturnValueOnce(call.promise);
    await render();
    await click("Remember…");
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Account name"]')!;
    await act(() => userEvent.fill(input, "Private"));
    const form = input.closest("form")!;
    await act(async () => {
      form.requestSubmit();
      form.requestSubmit();
    });
    expect(state.remember).toHaveBeenCalledTimes(1);

    await act(async () => call.resolve(refusal("nameInUse", "Private")));
    const dialogAlert = input.closest('[role="dialog"]')?.querySelector('[role="alert"]');
    expect(dialogAlert?.textContent).toBe(message("nameInUse", "Private"));
    expect(document.querySelector('input[aria-label="Account name"]')).not.toBeNull();
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it("tells the user what to do when no account is logged in", async () => {
    setList(accounts(null, [priv]));
    await render();

    expect(section()?.textContent).toContain(
      "No Claude account is logged in on this setup. Log in to Claude on the machine T3 runs on, then reopen this page. Remembered accounts can be switched to once a login exists.",
    );
    expect(button("Switch to Private")!.disabled).toBe(true);
    expect(button("Forget Private")!.disabled).toBe(false);
    expect(await tooltipOf("Switch to Private")).toBe("Log in to Claude on this setup first.");
  });

  it("shows a loading state before the list arrives", async () => {
    setList(null);
    await render();

    expect(section()?.textContent).toContain("Loading accounts…");
    expect(container.querySelector("ul")).toBeNull();
    expect(alertText()).toBeNull();
  });

  it("clears a forget error when the next forget succeeds", async () => {
    state.confirm.mockResolvedValue(true);
    state.forget.mockResolvedValueOnce(refusal("storage"));
    await render();
    await click("Forget Private");
    expect(alertText()).toBe(message("storage"));

    await click("Forget Private");
    expect(alertText()).toBeNull();
  });

  it("AK-34: renders nothing and never lists outside Linux", async () => {
    state.os = "darwin";
    await render();

    expect(section()).toBeNull();
    expect(state.list).not.toHaveBeenCalled();
    expect(alertText()).toBeNull();
  });

  it("AK-34: renders nothing and never lists without the provider scope", async () => {
    state.granted = false;
    await render();

    expect(section()).toBeNull();
    expect(state.list).not.toHaveBeenCalled();
  });

  it("AK-33: shows the account row and the remembered accounts on Linux", async () => {
    await render();

    expect(section()?.textContent).toContain("Claude account");
    expect(section()?.textContent).toContain("Remembered accounts");
  });

  it("shows the list failure's own reason, not the formatted error", async () => {
    setList(null, {
      failure: new ClaudeAccountError({ reason: "setupUnreadable" }),
      error: "Some unrelated transport text",
    });
    await render();

    expect(alertText()).toBe(message("setupUnreadable"));
    expect(container.querySelector("ul")).toBeNull();
  });

  async function startAdding() {
    await click("Add account…");
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Account name"]')!;
    await act(() => userEvent.fill(input, "Private"));
    await click("Log in…");
    await expect.poll(() => document.querySelector('[data-testid="terminal"]')).not.toBeNull();
  }

  it("AK-18: adds an account from the Remembered accounts row and keeps the setup's account", async () => {
    setList(accounts({ email: work.email, rememberedAs: "Work" }, [work]));
    await render();
    await startAdding();

    expect(state.start).toHaveBeenCalledWith({
      environmentId: remoteEnvironmentId,
      input: { instanceId, name: "Private" },
    });
    await publishAdd({ ...running, phase: "succeeded", account: priv });
    expect(state.refresh).toHaveBeenCalledTimes(1);

    setList(workActive);
    await publish();
    await click("Done");
    expect(item("Private")).not.toBeNull();
    expect(item("Work")?.textContent).toContain("Active");
    expect(item("Private")?.textContent).not.toContain("Active");
  });

  it("offers Add account… when the account is not remembered or no one is logged in", async () => {
    setList(accounts({ email: work.email, rememberedAs: null }, [priv]));
    await render();
    expect(button("Add account…")).not.toBeNull();

    setList(accounts(null));
    await publish();
    expect(button("Add account…")).not.toBeNull();
  });

  it("re-reads the list when the add dialog is cancelled during the login", async () => {
    await render();
    await startAdding();

    await click("Cancel");

    expect(state.refresh).toHaveBeenCalledTimes(1);
    await expect.poll(() => state.cancel.mock.calls.length).toBe(1);
  });
});
