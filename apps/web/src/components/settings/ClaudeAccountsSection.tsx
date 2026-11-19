import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import { useRef, useState, type ReactNode } from "react";

import { ensureLocalApi } from "../../localApi";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AddClaudeAccountDialog } from "./AddClaudeAccountDialog";
import {
  claudeAccountErrorMessage,
  type ClaudeAccountRow,
  type ClaudeSetupAccountView,
} from "./claudeAccounts.logic";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import { RememberClaudeAccountDialog } from "./RememberClaudeAccountDialog";
import { SettingsRow } from "./settingsLayout";
import {
  CLAUDE_ACCOUNT_COMMAND_OPTIONS,
  useClaudeAccountsAvailable,
  useClaudeAccountSwitch,
  useClaudeSetupAccounts,
} from "./useClaudeAccounts";

type Gt = ReturnType<typeof useGT>;

interface ClaudeAccountsSectionProps {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
}

export function ClaudeAccountsSection(props: ClaudeAccountsSectionProps) {
  // Outside Linux or without the scope the list call would fail, so it is never mounted.
  if (!useClaudeAccountsAvailable(props.environmentId)) return null;
  return <ClaudeAccountsCard {...props} />;
}

function Email(props: { readonly value: string; readonly className?: string }) {
  const gt = useGT();
  return (
    <RedactedSensitiveText
      value={props.value}
      ariaLabel={gt("Toggle account email visibility")}
      revealTooltip={gt("Click to reveal email")}
      hideTooltip={gt("Click to hide email")}
      {...(props.className ? { className: props.className } : {})}
    />
  );
}

function accountDescription(
  gt: Gt,
  view: ClaudeSetupAccountView | null,
  pendingTarget: string | null,
  listFailed: boolean,
): ReactNode {
  if (pendingTarget !== null) return gt("Switching to {target}…", { target: pendingTarget });
  if (view === null) return listFailed ? undefined : gt("Loading accounts…");
  switch (view.kind) {
    case "remembered":
      return (
        <T>
          Logged in as <Var>{view.name}</Var> (<Email value={view.email} />
          ). Used by all chats on this setup.
        </T>
      );
    case "notRemembered":
      return (
        <T>
          Logged in as <Email value={view.email} />. Remember it to switch back to it later.
        </T>
      );
    case "loggedOut":
      return gt(
        "No Claude account is logged in on this setup. Log in to Claude on the machine T3 runs on, then reopen this page. Remembered accounts can be switched to once a login exists.",
      );
  }
}

function forgetConfirmText(gt: Gt, account: ClaudeAccountRow): string {
  return account.active
    ? gt(
        'Forget "{name}"? T3 deletes its saved login. This setup stays logged in as {email}, but you can\'t switch back to it after switching away, unless you add it again.',
        { name: account.name, email: account.email },
      )
    : gt(
        'Forget "{name}"? T3 deletes its saved login. You can\'t switch to it again unless you add it again.',
        { name: account.name },
      );
}

function switchBlockedReason(gt: Gt, view: ClaudeSetupAccountView): string | null {
  if (view.kind === "notRemembered") return gt("Remember the current account first.");
  if (view.kind === "loggedOut") return gt("Log in to Claude on this setup first.");
  return null;
}

function ClaudeAccountsCard({ environmentId, instanceId }: ClaudeAccountsSectionProps) {
  const gt = useGT();
  const { view, error: listError, refresh } = useClaudeSetupAccounts(environmentId, instanceId);
  const {
    pendingTarget,
    error: switchError,
    switchTo,
  } = useClaudeAccountSwitch(environmentId, instanceId, refresh);
  const forget = useAtomCommand(
    serverEnvironment.forgetClaudeAccount,
    CLAUDE_ACCOUNT_COMMAND_OPTIONS,
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [rememberOpen, setRememberOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const forgetRef = useRef(false);
  const error = switchError ?? actionError ?? listError;

  const forgetAccount = async (account: ClaudeAccountRow) => {
    if (forgetRef.current) return;
    forgetRef.current = true;
    const confirmed = await ensureLocalApi()
      .dialogs.confirm(forgetConfirmText(gt, account), { variant: "destructive" })
      .catch(() => false);
    if (confirmed) {
      setActionError(null);
      const result = await forget({ environmentId, input: { name: account.name } });
      if (result._tag === "Success") refresh();
      else if (!isAtomCommandInterrupted(result)) {
        setActionError(claudeAccountErrorMessage(squashAtomCommandFailure(result)));
      }
    }
    forgetRef.current = false;
  };

  return (
    <section aria-label={gt("Claude accounts")} className="divide-y divide-border/50">
      <SettingsRow
        title={gt("Claude account")}
        description={accountDescription(gt, view, pendingTarget, listError !== null)}
        control={
          view?.kind === "notRemembered" && pendingTarget === null ? (
            <Button
              variant="default"
              size="sm"
              onClick={() => {
                setActionError(null);
                setRememberOpen(true);
              }}
            >
              <T>Remember…</T>
            </Button>
          ) : undefined
        }
      />
      {view !== null ? (
        <SettingsRow
          title={gt("Remembered accounts")}
          description={gt("Saved logins you can switch to without logging in again.")}
          control={
            <Button variant="secondary" size="sm" onClick={() => setAddOpen(true)}>
              <T>Add account…</T>
            </Button>
          }
        >
          {view.accounts.length === 0 ? (
            <p className="text-meta text-muted-foreground">
              <T>No remembered accounts yet.</T>
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {view.accounts.map((account) => (
                <li
                  key={account.name}
                  className="flex items-center gap-2 rounded-lg border border-border px-2.5 py-2 text-body"
                >
                  <span>{account.name}</span>
                  <Email value={account.email} className="text-muted-foreground" />
                  {account.active ? (
                    <Badge variant="success">
                      <T>Active</T>
                    </Badge>
                  ) : null}
                  <div className="ml-auto flex items-center gap-1">
                    {account.active ? null : (
                      <SwitchButton
                        name={account.name}
                        blockedReason={switchBlockedReason(gt, view)}
                        busy={pendingTarget !== null}
                        onSwitch={() => void switchTo(account.name)}
                      />
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={gt("Forget {name}", { name: account.name })}
                      disabled={pendingTarget !== null}
                      onClick={() => void forgetAccount(account)}
                    >
                      <T>Forget</T>
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SettingsRow>
      ) : null}
      {error !== null ? (
        <p role="alert" className="px-3 py-2 text-meta text-destructive sm:px-4">
          {error}
        </p>
      ) : null}
      {rememberOpen && view?.kind === "notRemembered" ? (
        <RememberClaudeAccountDialog
          environmentId={environmentId}
          instanceId={instanceId}
          email={view.email}
          onClose={() => setRememberOpen(false)}
          onRemembered={refresh}
        />
      ) : null}
      {addOpen ? (
        <AddClaudeAccountDialog
          environmentId={environmentId}
          instanceId={instanceId}
          // A login can land just as the user cancels, so the list is re-read on every close.
          onClose={() => {
            setAddOpen(false);
            refresh();
          }}
          onAdded={() => refresh()}
        />
      ) : null}
    </section>
  );
}

function SwitchButton(props: {
  readonly name: string;
  readonly blockedReason: string | null;
  readonly busy: boolean;
  readonly onSwitch: () => void;
}) {
  const gt = useGT();
  const button = (
    <Button
      variant="ghost"
      size="sm"
      aria-label={gt("Switch to {name}", { name: props.name })}
      disabled={props.busy || props.blockedReason !== null}
      onClick={props.onSwitch}
    >
      <T>Switch</T>
    </Button>
  );
  if (props.blockedReason === null) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={<span />}>{button}</TooltipTrigger>
      <TooltipPopup>{props.blockedReason}</TooltipPopup>
    </Tooltip>
  );
}
