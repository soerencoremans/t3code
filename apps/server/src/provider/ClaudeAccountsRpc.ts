import {
  WS_METHODS,
  type ClaudeAccountAddAttemptInput,
  type ClaudeAccountAddRespondInput,
  type ClaudeAccountAddStartInput,
  type ClaudeAccountForgetInput,
  type ClaudeAccountListInput,
  type ClaudeAccountRememberInput,
  type ClaudeAccountSwitchInput,
} from "@t3tools/contracts";

import type { ClaudeAccountLoginConnection } from "./ClaudeAccountLogin.ts";
import type { ClaudeAccounts } from "./ClaudeAccounts.ts";

export const claudeAccountsRpcHandlers = (accounts: ClaudeAccounts["Service"]) => ({
  [WS_METHODS.claudeAccountsList]: (_input: ClaudeAccountListInput) => accounts.list,
  [WS_METHODS.claudeAccountsRemember]: (input: ClaudeAccountRememberInput) =>
    accounts.remember(input),
  [WS_METHODS.claudeAccountsForget]: (input: ClaudeAccountForgetInput) => accounts.forget(input),
  [WS_METHODS.claudeAccountsSwitch]: (input: ClaudeAccountSwitchInput) => accounts.switch(input),
});

export const claudeAccountAddRpcHandlers = (connection: ClaudeAccountLoginConnection) => ({
  [WS_METHODS.claudeAccountsAddStart]: (input: ClaudeAccountAddStartInput) =>
    connection.start(input),
  [WS_METHODS.claudeAccountsAddRespond]: (input: ClaudeAccountAddRespondInput) =>
    connection.respond(input),
  [WS_METHODS.claudeAccountsAddCancel]: (input: ClaudeAccountAddAttemptInput) =>
    connection.cancel(input),
  [WS_METHODS.claudeAccountsAddSubscribe]: (input: ClaudeAccountAddAttemptInput) =>
    connection.subscribe(input),
});
