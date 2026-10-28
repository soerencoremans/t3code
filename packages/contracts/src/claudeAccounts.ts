import * as Schema from "effect/Schema";

import { ForwardCompatibleOptional } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const ClaudeAccountErrorReason = Schema.Literals([
  "unavailable",
  "setupNotFound",
  "setupUnreadable",
  "notLoggedIn",
  "invalidName",
  "nameInUse",
  "alreadyRemembered",
  "accountNotFound",
  "storage",
  "currentNotRemembered",
  "needsFreshLogin",
  "loginCheckFailed",
  "switchFailed",
  "switchRollbackFailed",
  "externalClaudePrograms",
  "processCheckFailed",
  "sessionStopFailed",
  "turnsRunning",
  "switchInProgress",
]);
export type ClaudeAccountErrorReason = typeof ClaudeAccountErrorReason.Type;

export class ClaudeAccountError extends Schema.TaggedError<ClaudeAccountError>()(
  "ClaudeAccountError",
  {
    // A newer server may refuse with a reason this build does not know yet.
    reason: ForwardCompatibleOptional(ClaudeAccountErrorReason),
    instanceId: Schema.optional(ProviderInstanceId),
    name: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case undefined:
        return "T3 refused this Claude account action. Try again, or update T3 on both ends.";
      case "unavailable":
        return "Switching Claude accounts is only supported when T3 runs on Linux.";
      case "setupNotFound":
        return "This Claude setup no longer exists.";
      case "setupUnreadable":
        return "T3 could not read the login of this Claude setup.";
      case "notLoggedIn":
        return "No Claude account is logged in on this Claude setup.";
      case "invalidName":
        return "An account name must be 1 to 64 characters long and contain no control characters.";
      case "nameInUse":
        return `The name "${this.name}" is already in use.`;
      case "alreadyRemembered":
        return `This account is already remembered as "${this.name}".`;
      case "accountNotFound":
        return `No remembered Claude account is named "${this.name}".`;
      case "storage":
        return "Could not read or save the remembered Claude accounts.";
      case "currentNotRemembered":
        return "The account logged in on this Claude setup is not remembered yet. Remember it first, then switch.";
      case "needsFreshLogin":
        return `The saved login of "${this.name}" no longer works. Forget "${this.name}", then add the account again.`;
      case "loginCheckFailed":
        return `Could not check the saved login of "${this.name}". Try again.`;
      case "switchFailed":
        return "Switching this Claude setup failed. It is still logged in as before.";
      case "switchRollbackFailed":
        return "Switching this Claude setup failed, and its previous login could not be restored. Log in to Claude again on this setup.";
      case "externalClaudePrograms":
        return "Claude programs started outside T3 are using this Claude setup. Close them, then switch again.";
      case "processCheckFailed":
        return "Could not check whether Claude programs outside T3 are using this Claude setup. Try again.";
      case "sessionStopFailed":
        return "Could not check or stop the running turns on this Claude setup. It is still logged in as before. Try again.";
      case "turnsRunning":
        return "Turns are running on this Claude setup. Switching the account stops them.";
      case "switchInProgress":
        return "Another Claude account switch is still running. Wait until it finishes, then try again.";
    }
  }
}

export const RememberedClaudeAccount = Schema.Struct({ name: Schema.String, email: Schema.String });
export type RememberedClaudeAccount = typeof RememberedClaudeAccount.Type;

export const ClaudeSwitchResult = Schema.Struct({
  instanceId: ProviderInstanceId,
  active: RememberedClaudeAccount,
  /** Every Claude setup on the same config dir, the requested one first. */
  affectedInstanceIds: Schema.Array(ProviderInstanceId),
});
export type ClaudeSwitchResult = typeof ClaudeSwitchResult.Type;

export const ClaudeSetupAccountState = Schema.Struct({
  instanceId: ProviderInstanceId,
  displayName: Schema.NullOr(Schema.String),
  active: Schema.NullOr(
    Schema.Struct({ email: Schema.String, rememberedAs: Schema.NullOr(Schema.String) }),
  ),
});
export type ClaudeSetupAccountState = typeof ClaudeSetupAccountState.Type;

export const ClaudeAccountList = Schema.Struct({
  accounts: Schema.Array(RememberedClaudeAccount),
  setups: Schema.Array(ClaudeSetupAccountState),
});
export type ClaudeAccountList = typeof ClaudeAccountList.Type;

// A coarse bound at the wire; the service enforces the real 1 to 64 character rule.
export const ClaudeAccountNameInput = Schema.String.check(Schema.isMaxLength(256));
export type ClaudeAccountNameInput = typeof ClaudeAccountNameInput.Type;

export const ClaudeAccountListInput = Schema.Struct({});
export type ClaudeAccountListInput = typeof ClaudeAccountListInput.Type;

export const ClaudeAccountRememberInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  name: ClaudeAccountNameInput,
});
export type ClaudeAccountRememberInput = typeof ClaudeAccountRememberInput.Type;

export const ClaudeAccountForgetInput = Schema.Struct({ name: ClaudeAccountNameInput });
export type ClaudeAccountForgetInput = typeof ClaudeAccountForgetInput.Type;

export const ClaudeAccountSwitchInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  name: ClaudeAccountNameInput,
  stopRunningTurns: Schema.Boolean,
});
export type ClaudeAccountSwitchInput = typeof ClaudeAccountSwitchInput.Type;
