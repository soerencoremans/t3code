import { useAtom, useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  ClaudeSetupAccountState,
  EnvironmentId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useRef, useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  claudeAccountErrorMessage,
  claudeAccountsAvailable,
  claudeSetupAccountView,
  claudeShareConfigSetups,
  isClaudeAccountError,
  type ClaudeSetupAccountView,
} from "./claudeAccounts.logic";

export const CLAUDE_ACCOUNT_COMMAND_OPTIONS = { reportFailure: false, reportDefect: false };

export function useClaudeAccountsAvailable(environmentId: EnvironmentId): boolean {
  const os = useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
    (config) => config?.environment.platform.os,
  );
  const canManageProviders = useAtomValue(
    serverEnvironment.rememberClaudeAccount.permissionAtom(environmentId),
  );
  return claudeAccountsAvailable({ os, canManageProviders });
}

/** Mount only where `useClaudeAccountsAvailable` is true: the list call fails elsewhere. */
export function useClaudeSetupAccounts(
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
): {
  readonly view: ClaudeSetupAccountView | null;
  readonly error: string | null;
  readonly refresh: () => void;
} {
  const query = useEnvironmentQuery(
    serverEnvironment.claudeAccountList({ environmentId, input: {} }),
  );
  return {
    view: query.data === null ? null : claudeSetupAccountView(query.data, instanceId),
    // The formatted `error` string loses the reason; the typed failure carries the server's text.
    error:
      query.failure === null && query.error === null
        ? null
        : claudeAccountErrorMessage(query.failure),
    refresh: query.refresh,
  };
}

/** Mount only where `useClaudeAccountsAvailable` is true. `null` while pending or failed. */
export function useClaudeShareConfigSetups(
  environmentId: EnvironmentId,
): ReadonlyArray<ClaudeSetupAccountState> | null {
  const query = useEnvironmentQuery(
    serverEnvironment.claudeAccountList({ environmentId, input: {} }),
  );
  if (query.data === null || query.failure !== null || query.error !== null) return null;
  return claudeShareConfigSetups(query.data);
}

// Shared by the settings card and the model picker, so neither offers a second switch while
// this client's call runs. The server's `switchInProgress` refusal covers other clients.
// Kept alive because the picker's popup can unmount mid-switch; a dropped value would let a
// reopened picker offer a second switch.
const claudeAccountSwitchPendingAtom = Atom.family((_key: string) =>
  Atom.make<string | null>(null).pipe(Atom.keepAlive),
);

export type ClaudeAccountSwitchOutcome =
  | { readonly kind: "switched" }
  | { readonly kind: "declined" }
  | { readonly kind: "skipped" }
  | { readonly kind: "failed"; readonly message: string };

function switchConfirmText(name: string): string {
  return `Switch this Claude setup to "${name}"? Switching stops running Claude turns on this setup, in every chat that uses it. Queued messages wait and send on the new account. Send "continue" to pick a stopped turn up.`;
}

export function useClaudeAccountSwitch(
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
  onSwitched: () => void,
): {
  readonly pendingTarget: string | null;
  readonly error: string | null;
  readonly switchTo: (name: string) => Promise<ClaudeAccountSwitchOutcome>;
} {
  const [pendingTarget, setPendingTarget] = useAtom(
    claudeAccountSwitchPendingAtom(`${environmentId}:${instanceId}`),
  );
  const [error, setError] = useState<string | null>(null);
  // Set while this hook's confirm is open, when the shared atom is deliberately null.
  const busyRef = useRef(false);
  const switchAccount = useAtomCommand(
    serverEnvironment.switchClaudeAccount,
    CLAUDE_ACCOUNT_COMMAND_OPTIONS,
  );

  const switchTo = async (name: string): Promise<ClaudeAccountSwitchOutcome> => {
    if (pendingTarget !== null || busyRef.current) return { kind: "skipped" };
    busyRef.current = true;
    setError(null);
    setPendingTarget(name);
    const outcome = await runClaudeAccountSwitch(
      name,
      (stopRunningTurns) =>
        switchAccount({ environmentId, input: { instanceId, name, stopRunningTurns } }),
      setPendingTarget,
    ).finally(() => {
      setPendingTarget(null);
      busyRef.current = false;
    });
    if (outcome.kind === "switched") onSwitched();
    setError(outcome.kind === "failed" ? outcome.message : null);
    return outcome;
  };

  return { pendingTarget, error, switchTo };
}

// Outside the hook because the React Compiler does not support this control flow in hooks.
async function runClaudeAccountSwitch(
  name: string,
  call: (stopRunningTurns: boolean) => Promise<AtomCommandResult<unknown, unknown>>,
  setPending: (name: string | null) => void,
): Promise<ClaudeAccountSwitchOutcome> {
  let result = await call(false);
  if (
    result._tag === "Failure" &&
    !isAtomCommandInterrupted(result) &&
    isTurnsRunning(squashAtomCommandFailure(result))
  ) {
    // Nothing switches while the user decides, so no screen may claim it does.
    setPending(null);
    const confirmed = await ensureLocalApi().dialogs.confirm(switchConfirmText(name), {
      variant: "destructive",
    });
    if (!confirmed) return { kind: "declined" };
    setPending(name);
    result = await call(true);
  }
  if (result._tag === "Success") return { kind: "switched" };
  if (isAtomCommandInterrupted(result)) return { kind: "skipped" };
  return { kind: "failed", message: claudeAccountErrorMessage(squashAtomCommandFailure(result)) };
}

function isTurnsRunning(failure: unknown): boolean {
  return isClaudeAccountError(failure) && failure.reason === "turnsRunning";
}
