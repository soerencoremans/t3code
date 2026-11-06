import {
  ClaudeAccountError,
  EnvironmentId,
  ProviderInstanceId,
  type ClaudeAccountAddState,
  type ClaudeAccountErrorReason,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { StrictMode, useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";

interface QueryView {
  readonly data: ClaudeAccountAddState | null;
  readonly error: string | null;
  readonly failure: unknown;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

const state = vi.hoisted(() => ({
  view: null as QueryView | null,
  addState: vi.fn((_target: unknown) => "claude-account-add-state"),
  start: vi.fn(),
  respond: vi.fn(),
  cancel: vi.fn(),
  switch: vi.fn(),
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      startClaudeAccountAdd: state.start as never,
      respondClaudeAccountAdd: state.respond as never,
      cancelClaudeAccountAdd: state.cancel as never,
      claudeAccountAddState: state.addState as never,
      switchClaudeAccount: state.switch as never,
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
// The add state behaves like a live subscription: changing `state.view` and calling
// `publish()` re-renders the login step.
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
// Ghostty does not load headless; the stub shows the output and sends typed input.
vi.mock(import("./ProviderAuthTerminal"), () => ({
  default: ({ output, onResponse }) => (
    <div data-testid="terminal">
      <pre>{output}</pre>
      <button type="button" onClick={() => onResponse({ type: "terminal", data: "abc" })}>
        Type
      </button>
      <button
        type="button"
        onClick={() => onResponse({ type: "terminal", data: "x".repeat(5000) })}
      >
        Paste
      </button>
      <button
        type="button"
        onClick={() => onResponse({ type: "terminal", data: "", size: { cols: 80, rows: 24 } })}
      >
        Resize
      </button>
    </div>
  ),
}));

import { AddClaudeAccountDialog } from "./AddClaudeAccountDialog";

const environmentId = EnvironmentId.make("remote-linux");
const instanceId = ProviderInstanceId.make("claudeAgent");
const privateAccount = { name: "Private", email: "private@example.com" };

function addState(overrides: Partial<ClaudeAccountAddState> = {}): ClaudeAccountAddState {
  return {
    attemptId: "a1",
    instanceId,
    name: "Private",
    phase: "running",
    output: "",
    outputOffset: 0,
    account: null,
    error: null,
    ...overrides,
  };
}
function setAddState(data: ClaudeAccountAddState | null, failure: unknown = null) {
  state.view = {
    data,
    error: failure === null ? null : "formatted",
    failure,
    isPending: false,
    refresh: () => {},
  };
}
const publish = (data: ClaudeAccountAddState | null, failure: unknown = null) => {
  setAddState(data, failure);
  return act(async () => {
    for (const listener of queryListeners) listener();
  });
};

const success = (value: unknown = undefined) => ({ _tag: "Success", value });
const refusal = (reason: ClaudeAccountErrorReason, name?: string) => ({
  _tag: "Failure",
  cause: Cause.fail(new ClaudeAccountError({ reason, ...(name ? { accountName: name } : {}) })),
});
const message = (reason: ClaudeAccountErrorReason, name?: string) =>
  new ClaudeAccountError({ reason, ...(name ? { accountName: name } : {}) }).message;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const onClose = vi.fn();
const onAdded = vi.fn();

// Stands in for a host: it unmounts the dialog when the dialog asks to close.
function Host() {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <AddClaudeAccountDialog
      environmentId={environmentId}
      instanceId={instanceId}
      onClose={() => {
        onClose();
        setOpen(false);
      }}
      onAdded={onAdded}
    />
  );
}

function renderHost(options: { readonly strict?: boolean } = {}) {
  return render(
    options.strict ? (
      <StrictMode>
        <Host />
      </StrictMode>
    ) : (
      <Host />
    ),
    // The dialog does not use the router.
    { router: false },
  );
}

function setup() {
  vi.clearAllMocks();
  setAddState(null);
  state.start.mockReset().mockResolvedValue(success(addState()));
  state.respond.mockReset().mockResolvedValue(success());
  state.cancel.mockReset().mockResolvedValue(success());
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
const nameInput = () =>
  document.querySelector<HTMLInputElement>('input[aria-label="Account name"]');
const alertText = () => document.querySelector('[role="alert"]')?.textContent ?? null;
const title = () => document.querySelector('[data-slot="dialog-title"]')?.textContent ?? null;
const dialogOpen = () => document.querySelector('[role="dialog"]') !== null;
const flushMicrotasks = () => act(async () => {});

async function typeName(value: string) {
  await userEvent.fill(nameInput()!, value);
}
async function submitName(value = "Private") {
  await typeName(value);
  await click("Log in…");
}
async function reachLogin() {
  state.start.mockResolvedValueOnce(success(addState()));
  await submitName();
  await expect.poll(() => document.querySelector('[data-testid="terminal"]')).not.toBeNull();
}
// A click on the viewport's corner lands outside the popup, on the backdrop area.
async function clickOutside() {
  const viewport = document.querySelector<HTMLElement>('[data-slot="dialog-viewport"]')!;
  await userEvent.click(viewport, { position: { x: 4, y: 4 } });
}

describe("AddClaudeAccountDialog", () => {
  it("name step: disables Log in… until a name is typed and starts the login once", async () => {
    setup();
    const call = deferred<unknown>();
    state.start.mockReturnValueOnce(call.promise);
    await using _screen = await renderHost();

    expect(title()).toBe("Add Claude account");
    expect(button("Log in…")!.disabled).toBe(true);
    await typeName("   ");
    expect(button("Log in…")!.disabled).toBe(true);

    await submitName("Private");
    expect(button("Log in…")!.disabled).toBe(true);
    await act(async () =>
      document.querySelector<HTMLFormElement>("#add-claude-account")!.requestSubmit(),
    );

    expect(state.start).toHaveBeenCalledTimes(1);
    expect(state.start).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, name: "Private" },
    });
    await act(async () => call.resolve(success(addState())));
  });

  it("AK-32: a refused name stays on the name step with the reason and no subscription", async () => {
    setup();
    state.start.mockResolvedValueOnce(refusal("nameInUse", "Private"));
    await using _screen = await renderHost();
    await submitName();

    await expect.poll(alertText).toBe(message("nameInUse", "Private"));
    expect(nameInput()?.value).toBe("Private");
    expect(title()).toBe("Add Claude account");
    expect(state.addState).not.toHaveBeenCalled();
  });

  it("AK-15 / AK-16: the login step shows the terminal and sends its input in order", async () => {
    setup();
    await using _screen = await renderHost();
    await reachLogin();

    expect(title()).toBe("Add account “Private”");
    expect(state.addState).toHaveBeenCalledWith({ environmentId, input: { attemptId: "a1" } });
    await publish(addState({ output: "Paste code here if prompted >" }));
    expect(document.querySelector('[data-testid="terminal"] pre')?.textContent).toBe(
      "Paste code here if prompted >",
    );
    expect(document.body.textContent).toContain(
      "If the browser is on another device, log in there and paste the code it shows into the terminal.",
    );

    await click("Type");
    await click("Resize");
    await click("Paste");
    await expect.poll(() => state.respond.mock.calls.length).toBe(4);
    expect(state.respond.mock.calls.map(([call]) => call)).toEqual([
      { environmentId, input: { attemptId: "a1", data: "abc" } },
      { environmentId, input: { attemptId: "a1", data: "", size: { cols: 80, rows: 24 } } },
      { environmentId, input: { attemptId: "a1", data: "x".repeat(4096) } },
      { environmentId, input: { attemptId: "a1", data: "x".repeat(904) } },
    ]);
  });

  it("AK-15: a landed login reports the account and Done closes without switching", async () => {
    setup();
    await using _screen = await renderHost();
    await reachLogin();
    expect(button("Done")!.disabled).toBe(true);

    await publish(addState({ phase: "succeeded", account: privateAccount }));

    await expect.poll(() => document.body.textContent).toContain("Added “Private”.");
    expect(onAdded).toHaveBeenCalledTimes(1);
    expect(onAdded).toHaveBeenCalledWith(privateAccount);
    await click("Done");
    expect(onClose).toHaveBeenCalledTimes(1);
    await flushMicrotasks();
    expect(state.switch).not.toHaveBeenCalled();
    expect(state.cancel).not.toHaveBeenCalled();
  });

  it.each(["loginFailed", "loginTimedOut"] as const)(
    "AK-32: a %s login returns to the name step with the reason",
    async (reason) => {
      setup();
      await using _screen = await renderHost();
      await reachLogin();

      await publish(addState({ phase: "failed", error: new ClaudeAccountError({ reason }) }));

      await expect.poll(alertText).toBe(message(reason));
      expect(nameInput()?.value).toBe("Private");
      expect(onAdded).not.toHaveBeenCalled();
    },
  );

  it("a lost subscription returns to the name step with the server's reason", async () => {
    setup();
    await using _screen = await renderHost();
    await reachLogin();

    await publish(null, new ClaudeAccountError({ reason: "loginNotFound" }));

    await expect
      .poll(alertText)
      .toBe("This Claude login is no longer running. Start adding the account again.");
    expect(nameInput()?.value).toBe("Private");
  });

  it("a success without an account returns to the name step and says to check", async () => {
    setup();
    await using _screen = await renderHost();
    await reachLogin();

    await publish(addState({ phase: "succeeded", account: null }));

    await expect
      .poll(alertText)
      .toBe("The account may have been added. Check the remembered accounts.");
    expect(onAdded).not.toHaveBeenCalled();
  });

  it("a failed send to the terminal shows why and drops the queued input", async () => {
    setup();
    const first = deferred<unknown>();
    state.respond.mockReturnValueOnce(first.promise);
    await using _screen = await renderHost();
    await reachLogin();

    await click("Type");
    await click("Type");
    await act(async () => first.resolve(refusal("loginNotFound")));

    await expect.poll(alertText).toBe("The login terminal is no longer available. Start again.");
    expect(state.respond).toHaveBeenCalledTimes(1);
  });

  it("a login the server stopped returns to the name step", async () => {
    setup();
    await using _screen = await renderHost();
    await reachLogin();

    await publish(addState({ phase: "cancelled" }));

    await expect.poll(alertText).toBe("This login was stopped. Start again.");
    expect(nameInput()?.value).toBe("Private");
  });

  it("AK-22: Cancel during the login stops the attempt once and closes", async () => {
    setup();
    await using _screen = await renderHost();
    await reachLogin();

    await click("Cancel");
    await flushMicrotasks();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(state.cancel).toHaveBeenCalledTimes(1);
    expect(state.cancel).toHaveBeenCalledWith({ environmentId, input: { attemptId: "a1" } });
  });

  it("AK-23: Escape during the login stops the attempt once", async () => {
    setup();
    await using _screen = await renderHost();
    await reachLogin();

    await userEvent.keyboard("{Escape}");
    await expect.poll(dialogOpen).toBe(false);
    await flushMicrotasks();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(state.cancel).toHaveBeenCalledTimes(1);
    expect(state.cancel).toHaveBeenCalledWith({ environmentId, input: { attemptId: "a1" } });
  });

  it("AK-23: unmounting the whole tree during the login stops the attempt once", async () => {
    setup();
    await using screen = await renderHost();
    await reachLogin();

    await screen.unmount();
    await flushMicrotasks();

    expect(state.cancel).toHaveBeenCalledTimes(1);
    expect(state.cancel).toHaveBeenCalledWith({ environmentId, input: { attemptId: "a1" } });
  });

  it("an outside click closes the name step but not a running login", async () => {
    setup();
    await using first = await renderHost();
    await clickOutside();
    await expect.poll(dialogOpen).toBe(false);

    onClose.mockClear();
    await first.unmount();
    await using _second = await renderHost();
    await reachLogin();
    await clickOutside();
    await flushMicrotasks();

    expect(dialogOpen()).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(state.cancel).not.toHaveBeenCalled();
  });

  it("AK-23: closing while the start is pending stops the attempt it returns", async () => {
    setup();
    const call = deferred<unknown>();
    state.start.mockReturnValueOnce(call.promise);
    await using _screen = await renderHost();
    await submitName();

    await userEvent.keyboard("{Escape}");
    await expect.poll(dialogOpen).toBe(false);
    await act(async () => call.resolve(success(addState({ attemptId: "a2" }))));

    expect(state.cancel).toHaveBeenCalledTimes(1);
    expect(state.cancel).toHaveBeenCalledWith({ environmentId, input: { attemptId: "a2" } });
  });

  it("AK-23: StrictMode's remount does not stop the login, a real unmount does once", async () => {
    setup();
    await using screen = await renderHost({ strict: true });
    await reachLogin();
    await flushMicrotasks();
    expect(state.cancel).not.toHaveBeenCalled();

    await screen.unmount();
    await flushMicrotasks();

    expect(state.cancel).toHaveBeenCalledTimes(1);
  });

  it("sends no cancel after the login succeeded or failed", async () => {
    setup();
    await using first = await renderHost();
    await reachLogin();
    await publish(addState({ phase: "succeeded", account: privateAccount }));
    await expect.poll(() => document.body.textContent).toContain("Added “Private”.");
    await first.unmount();
    await flushMicrotasks();
    expect(state.cancel).not.toHaveBeenCalled();
    setAddState(null);
    await using second = await renderHost();
    await reachLogin();
    await publish(
      addState({ phase: "failed", error: new ClaudeAccountError({ reason: "loginFailed" }) }),
    );
    await expect.poll(alertText).toBe(message("loginFailed"));
    await second.unmount();
    await flushMicrotasks();
    expect(state.cancel).not.toHaveBeenCalled();
  });
});
