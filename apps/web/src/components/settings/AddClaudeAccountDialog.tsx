import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  ClaudeAccountAddAttemptId,
  EnvironmentId,
  ProviderInstanceId,
  RememberedClaudeAccount,
} from "@t3tools/contracts";
import { useEffect, useRef, useState, type RefObject } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { Input } from "../ui/input";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup } from "../ui/wizard";
import { ClaudeAccountAddLogin, type ClaudeAccountAddOutcome } from "./ClaudeAccountAddLogin";
import { claudeAccountErrorMessage } from "./claudeAccounts.logic";
import { SettingsRow } from "./settingsLayout";
import { CLAUDE_ACCOUNT_COMMAND_OPTIONS } from "./useClaudeAccounts";

export function AddClaudeAccountDialog({
  environmentId,
  instanceId,
  onClose,
  onAdded,
  finalFocus,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly onClose: () => void;
  readonly onAdded: (account: RememberedClaudeAccount) => void;
  readonly finalFocus?: RefObject<HTMLElement | null>;
}) {
  const start = useAtomCommand(
    serverEnvironment.startClaudeAccountAdd,
    CLAUDE_ACCOUNT_COMMAND_OPTIONS,
  );
  const cancel = useAtomCommand(
    serverEnvironment.cancelClaudeAccountAdd,
    CLAUDE_ACCOUNT_COMMAND_OPTIONS,
  );
  const [name, setName] = useState("");
  const [attemptId, setAttemptId] = useState<ClaudeAccountAddAttemptId | null>(null);
  const [added, setAdded] = useState<RememberedClaudeAccount | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startingRef = useRef(false);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const submit = async () => {
    if (startingRef.current || !name.trim()) return;
    startingRef.current = true;
    setStarting(true);
    setError(null);
    // The server trims the name, so it gets what the user typed.
    const result = await start({ environmentId, input: { instanceId, name } });
    startingRef.current = false;
    if (result._tag === "Success") {
      if (mountedRef.current) setAttemptId(result.value.attemptId);
      // Closed while the call ran: stop the attempt instead of leaving it to the server timeout.
      else void cancel({ environmentId, input: { attemptId: result.value.attemptId } });
    } else if (mountedRef.current && !isAtomCommandInterrupted(result)) {
      setError(claudeAccountErrorMessage(squashAtomCommandFailure(result)));
    }
    if (mountedRef.current) setStarting(false);
  };

  const ended = (outcome: ClaudeAccountAddOutcome) => {
    setAttemptId(null);
    if (outcome.kind === "succeeded") {
      setAdded(outcome.account);
      onAdded(outcome.account);
    } else {
      setError(outcome.message);
    }
  };

  const loginTitle = `Add account “${name.trim()}”`;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      // One stray click while switching to the browser would throw the login away.
      disablePointerDismissal={attemptId !== null}
    >
      <WizardPopup size="wide" {...(finalFocus ? { finalFocus } : {})}>
        {added !== null ? (
          <>
            <WizardHeader
              title={loginTitle}
              description="Log in with the Claude account you want to add."
            />
            <WizardPanel>
              <p className="text-sm">
                Added “{added.name}”. This setup stays logged in as before; switch to the new
                account from the model picker or the account list.
              </p>
            </WizardPanel>
            <WizardFooter>
              <Button variant="default" onClick={onClose}>
                Done
              </Button>
            </WizardFooter>
          </>
        ) : attemptId !== null ? (
          <>
            <WizardHeader
              title={loginTitle}
              description="Log in with the Claude account you want to add."
            />
            <WizardPanel>
              <ClaudeAccountAddLogin
                key={attemptId}
                environmentId={environmentId}
                attemptId={attemptId}
                onEnded={ended}
              />
            </WizardPanel>
            <WizardFooter>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button variant="default" disabled>
                Done
              </Button>
            </WizardFooter>
          </>
        ) : (
          <>
            <WizardHeader
              title="Add Claude account"
              description="Log in with another Claude account and give it a name. This setup stays logged in as it is."
            />
            <WizardPanel>
              <form
                id="add-claude-account"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit();
                }}
              >
                <SettingsRow
                  title="Account name"
                  description="How this account appears in the model picker."
                  control={
                    <Input
                      aria-label="Account name"
                      placeholder="e.g. Work or Private"
                      value={name}
                      disabled={starting}
                      onChange={(event) => setName(event.target.value)}
                    />
                  }
                />
              </form>
              {error !== null ? (
                <p role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              ) : null}
            </WizardPanel>
            <WizardFooter>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                form="add-claude-account"
                variant="default"
                disabled={starting || name.trim() === ""}
              >
                Log in…
              </Button>
            </WizardFooter>
          </>
        )}
      </WizardPopup>
    </Dialog>
  );
}
