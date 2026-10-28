import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, CircleDashedIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { AddClaudeAccountDialog } from "../settings/AddClaudeAccountDialog";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { RememberClaudeAccountDialog } from "../settings/RememberClaudeAccountDialog";
import {
  useClaudeAccountSwitch,
  useClaudeAccountsAvailable,
  useClaudeSetupAccounts,
} from "../settings/useClaudeAccounts";
import { Button, InlineButton } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { toastManager } from "../ui/toast";

type ClaudeAccountPickerRowProps = {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly onRequestClose?: () => void;
};

export function ClaudeAccountPickerRow(props: ClaudeAccountPickerRowProps) {
  // Mounting the inner row lists accounts, which fails off Linux or without the grant.
  if (!useClaudeAccountsAvailable(props.environmentId)) return null;
  return <ClaudeAccountPickerRowInner {...props} />;
}

const ROW_LABEL = "Account · all Claude chats";

function RowLines(props: { readonly children: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="text-xs text-muted-foreground">{ROW_LABEL}</span>
      <span className="flex items-center gap-1 text-sm font-medium">{props.children}</span>
    </span>
  );
}

function ClaudeAccountPickerRowInner({
  environmentId,
  instanceId,
  onRequestClose,
}: ClaudeAccountPickerRowProps) {
  const accounts = useClaudeSetupAccounts(environmentId, instanceId);
  const accountSwitch = useClaudeAccountSwitch(environmentId, instanceId, accounts.refresh);
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [rememberOpen, setRememberOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  // After a remember the trigger replaces "Remember…", so focus has to follow it there.
  const focusTriggerOnMountRef = useRef(false);
  // The add dialog returns focus here, because the menu item that opened it is gone.
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // A switch can outlive the picker's popup; its outcome then goes to a toast.
  const mountedRef = useRef(false);
  const view = accounts.view;
  const pending = accountSwitch.pendingTarget;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const attachTrigger = (element: HTMLButtonElement | null) => {
    triggerRef.current = element;
    if (element === null || !focusTriggerOnMountRef.current) return;
    focusTriggerOnMountRef.current = false;
    element.focus();
  };

  const pick = async (name: string) => {
    setAnnouncement("");
    const outcome = await accountSwitch.switchTo(name);
    if (outcome.kind === "switched") {
      if (mountedRef.current) setAnnouncement(`Claude account switched to ${name}.`);
      else toastManager.add({ type: "success", title: `Claude account switched to ${name}` });
    } else if (outcome.kind === "failed" && !mountedRef.current) {
      toastManager.add({
        type: "error",
        title: "Claude account not switched",
        description: outcome.message,
      });
    }
  };

  const manageAccounts = () => {
    onRequestClose?.();
    void navigate({ to: "/settings/providers", search: { environmentId, instanceId } });
  };

  const alert = accountSwitch.error ?? accounts.error;

  let row: ReactNode;
  if (pending !== null || view?.kind === "remembered") {
    const activeName = view?.kind === "remembered" ? view.name : null;
    row = (
      <Menu open={menuOpen && pending === null} onOpenChange={setMenuOpen}>
        <MenuTrigger
          ref={attachTrigger}
          aria-label={
            pending !== null
              ? `Claude account for all Claude chats: switching to ${pending}`
              : `Claude account for all Claude chats: ${activeName}`
          }
          render={
            <button
              type="button"
              className="flex w-full items-center justify-between gap-2 border-t border-border/70 px-3 py-2 text-left hover:bg-accent"
            />
          }
        >
          <RowLines>
            {pending !== null ? (
              <>
                <CircleDashedIcon aria-hidden="true" className="size-3.5" />
                Switching to {pending}…
              </>
            ) : (
              activeName
            )}
          </RowLines>
          <ChevronDownIcon aria-hidden="true" className="size-4 text-muted-foreground" />
        </MenuTrigger>
        <MenuPopup side="top" align="end">
          <MenuGroup>
            <MenuGroupLabel>Switch account</MenuGroupLabel>
            <MenuRadioGroup
              value={activeName}
              onValueChange={(name: string) => {
                if (name !== activeName) void pick(name);
              }}
            >
              {(view?.accounts ?? []).map((account) => (
                <MenuRadioItem key={account.name} value={account.name} closeOnClick>
                  <MenuRadioItemIndicator />
                  {account.name}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
          <MenuSeparator />
          <MenuItem onClick={() => setAddOpen(true)}>
            <PlusIcon aria-hidden="true" />
            Add account…
          </MenuItem>
          <MenuItem onClick={manageAccounts}>
            <SettingsIcon aria-hidden="true" />
            Manage accounts
          </MenuItem>
        </MenuPopup>
      </Menu>
    );
  } else {
    let value: ReactNode = null;
    let action: ReactNode = null;
    if (view?.kind === "notRemembered") {
      value = (
        <RedactedSensitiveText
          value={view.email}
          ariaLabel="Toggle account email visibility"
          revealTooltip="Click to reveal email"
          hideTooltip="Click to hide email"
        />
      );
      action = (
        <Button
          variant="secondary"
          size="xs"
          aria-label="Remember the Claude account for all Claude chats"
          onClick={() => setRememberOpen(true)}
        >
          Remember…
        </Button>
      );
    } else if (view?.kind === "loggedOut") {
      value = "No Claude account is logged in on this setup.";
      action = <InlineButton onClick={manageAccounts}>Manage accounts</InlineButton>;
    } else if (accounts.error === null) {
      value = <span className="text-muted-foreground">Loading account…</span>;
    } else {
      action = <InlineButton onClick={accounts.refresh}>Retry</InlineButton>;
    }
    row = (
      <div className="flex items-center justify-between gap-2 border-t border-border/70 px-3 py-2">
        <RowLines>{value}</RowLines>
        {action}
      </div>
    );
  }

  return (
    <div data-slot="claude-account-picker-row">
      {row}
      {alert !== null ? (
        <p role="alert" className="px-3 pb-2 text-xs text-destructive">
          {alert}
        </p>
      ) : null}
      <span role="status" className="sr-only">
        {pending !== null ? `Switching Claude account to ${pending}…` : announcement}
      </span>
      {rememberOpen && view?.kind === "notRemembered" ? (
        <RememberClaudeAccountDialog
          environmentId={environmentId}
          instanceId={instanceId}
          email={view.email}
          onClose={() => setRememberOpen(false)}
          onRemembered={() => {
            focusTriggerOnMountRef.current = true;
            accounts.refresh();
          }}
        />
      ) : null}
      {addOpen ? (
        <AddClaudeAccountDialog
          environmentId={environmentId}
          instanceId={instanceId}
          finalFocus={triggerRef}
          // A login can land just as the user cancels, so the list is re-read on every close.
          onClose={() => {
            setAddOpen(false);
            accounts.refresh();
          }}
          onAdded={() => accounts.refresh()}
        />
      ) : null}
    </div>
  );
}
