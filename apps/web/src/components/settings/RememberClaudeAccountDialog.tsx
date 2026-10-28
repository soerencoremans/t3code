import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProviderInstanceId,
  RememberedClaudeAccount,
} from "@t3tools/contracts";
import { useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { Input } from "../ui/input";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup } from "../ui/wizard";
import { claudeAccountErrorMessage } from "./claudeAccounts.logic";
import { SettingsRow } from "./settingsLayout";
import { CLAUDE_ACCOUNT_COMMAND_OPTIONS } from "./useClaudeAccounts";

export function RememberClaudeAccountDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly email: string;
  readonly onClose: () => void;
  readonly onRemembered: (account: RememberedClaudeAccount) => void;
}) {
  const remember = useAtomCommand(
    serverEnvironment.rememberClaudeAccount,
    CLAUDE_ACCOUNT_COMMAND_OPTIONS,
  );
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);

  const submit = async () => {
    if (pendingRef.current || !name.trim()) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    // The server trims the name, so it gets what the user typed.
    const result = await remember({
      environmentId: props.environmentId,
      input: { instanceId: props.instanceId, name },
    });
    pendingRef.current = false;
    setPending(false);
    if (result._tag === "Success") {
      props.onRemembered(result.value);
      props.onClose();
    } else if (!isAtomCommandInterrupted(result)) {
      setError(claudeAccountErrorMessage(squashAtomCommandFailure(result)));
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <WizardPopup>
        <WizardHeader
          title="Remember this Claude account"
          description={`Logged in as ${props.email}. Give it a name to switch back to it later.`}
        />
        <WizardPanel>
          <form
            id="remember-claude-account"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <SettingsRow
              title="Account name"
              control={
                <Input
                  aria-label="Account name"
                  value={name}
                  disabled={pending}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="e.g. Work or Private"
                />
              }
            />
          </form>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </WizardPanel>
        <WizardFooter>
          <Button variant="outline" disabled={pending} onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="default"
            form="remember-claude-account"
            disabled={pending || !name.trim()}
          >
            Remember
          </Button>
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}
