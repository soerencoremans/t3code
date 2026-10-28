import * as Schema from "effect/Schema";
import {
  ClaudeAccountError,
  type ClaudeAccountList,
  type ProviderInstanceId,
} from "@t3tools/contracts";

export function claudeAccountsAvailable(input: {
  readonly os: string | undefined;
  readonly canManageProviders: boolean;
}): boolean {
  return input.os === "linux" && input.canManageProviders;
}

export type ClaudeAccountRow = {
  readonly name: string;
  readonly email: string;
  readonly active: boolean;
};

export type ClaudeSetupAccountView =
  | {
      readonly kind: "remembered";
      readonly name: string;
      readonly email: string;
      readonly accounts: ReadonlyArray<ClaudeAccountRow>;
    }
  | {
      readonly kind: "notRemembered";
      readonly email: string;
      readonly accounts: ReadonlyArray<ClaudeAccountRow>;
    }
  | { readonly kind: "loggedOut"; readonly accounts: ReadonlyArray<ClaudeAccountRow> };

export function claudeSetupAccountView(
  list: ClaudeAccountList,
  instanceId: ProviderInstanceId,
): ClaudeSetupAccountView {
  const active = list.setups.find((setup) => setup.instanceId === instanceId)?.active ?? null;
  const accounts = list.accounts.map((account) => ({
    name: account.name,
    email: account.email,
    active: active?.rememberedAs != null && account.name === active.rememberedAs,
  }));
  if (active === null) return { kind: "loggedOut", accounts };
  if (active.rememberedAs === null) return { kind: "notRemembered", email: active.email, accounts };
  return { kind: "remembered", name: active.rememberedAs, email: active.email, accounts };
}

export const isClaudeAccountError = Schema.is(ClaudeAccountError);

export function claudeAccountErrorMessage(failure: unknown): string {
  return isClaudeAccountError(failure)
    ? failure.message
    : "T3 could not reach the Claude accounts. Try again.";
}
