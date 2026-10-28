import {
  WS_METHODS,
  type ClaudeAccountForgetInput,
  type ClaudeAccountListInput,
  type ClaudeAccountRememberInput,
} from "@t3tools/contracts";

import type { ClaudeAccounts } from "./ClaudeAccounts.ts";

export const claudeAccountsRpcHandlers = (accounts: ClaudeAccounts["Service"]) => ({
  [WS_METHODS.claudeAccountsList]: (_input: ClaudeAccountListInput) => accounts.list,
  [WS_METHODS.claudeAccountsRemember]: (input: ClaudeAccountRememberInput) =>
    accounts.remember(input),
  [WS_METHODS.claudeAccountsForget]: (input: ClaudeAccountForgetInput) => accounts.forget(input),
});
