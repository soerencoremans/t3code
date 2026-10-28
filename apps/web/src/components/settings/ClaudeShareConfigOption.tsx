import { ProviderInstanceId, type EnvironmentId } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { Checkbox } from "../ui/checkbox";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { AddClaudeAccountDialog } from "./AddClaudeAccountDialog";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow } from "./settingsLayout";
import { useClaudeSetupAccounts, useClaudeShareConfigSetups } from "./useClaudeAccounts";

/** Mount only where `useClaudeAccountsAvailable` is true. `null` value means unticked. */
export function ClaudeShareConfigOption({
  environmentId,
  value,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly value: ProviderInstanceId | null;
  readonly onChange: (value: ProviderInstanceId | null) => void;
}) {
  const setups = useClaudeShareConfigSetups(environmentId);
  // A pending or failed list hides the option; the settings card reports list failures.
  if (setups === null) return null;
  const [first] = setups;
  if (first === undefined) return null;
  const selected = setups.find((setup) => setup.instanceId === value) ?? first;
  const label = selected.displayName ?? "Claude";

  return (
    <div className="grid gap-3 pb-4">
      <div
        className={cn(
          "rounded-lg border border-border px-3.5 py-3",
          value !== null && "border-primary/60 bg-primary/5",
        )}
      >
        <label className="flex cursor-pointer items-start gap-3">
          <Checkbox
            checked={value !== null}
            onCheckedChange={(checked) => onChange(checked === true ? first.instanceId : null)}
          />
          <span className="grid gap-0.5">
            <span className="text-sm font-medium text-foreground">
              Share config with my existing Claude setup
            </span>
            <span className="text-xs text-muted-foreground">
              Adds another account to “{label}” instead of a new provider. Chats and settings stay
              shared; you switch accounts in the model picker.
            </span>
          </span>
        </label>
      </div>
      {value !== null && setups.length > 1 ? (
        <SettingsGroup variant="plain">
          <SettingsRow
            title={<label htmlFor="add-provider-claude-setup">Setup</label>}
            description="The Claude setup that gets the new account."
            control={
              <Select
                value={value}
                onValueChange={(next) => {
                  if (typeof next === "string") onChange(ProviderInstanceId.make(next));
                }}
              >
                <SelectTrigger
                  id="add-provider-claude-setup"
                  size="sm"
                  aria-label="Setup"
                  className="w-full @min-[32rem]/settings-row:w-56"
                >
                  <SelectValue>{label}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="start" alignItemWithTrigger={false}>
                  {setups.map((setup) => (
                    <SelectItem key={setup.instanceId} value={setup.instanceId}>
                      {setup.displayName ?? "Claude"}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        </SettingsGroup>
      ) : null}
      {value !== null ? (
        <p className="text-xs text-muted-foreground">
          No new provider is added. Next, you name the account and log in with it; the setup stays
          logged in as it is.
        </p>
      ) : null}
    </div>
  );
}

export function ClaudeShareConfigAddAccount({
  environmentId,
  instanceId,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly onClose: () => void;
}) {
  const { refresh } = useClaudeSetupAccounts(environmentId, instanceId);
  // Every way out of the dialog goes through `onClose`, so one refresh covers success and cancel.
  return (
    <AddClaudeAccountDialog
      environmentId={environmentId}
      instanceId={instanceId}
      onAdded={() => {}}
      onClose={() => {
        refresh();
        onClose();
      }}
    />
  );
}
