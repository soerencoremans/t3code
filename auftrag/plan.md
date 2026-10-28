# Plan — Auftrag #8 (soerencoremans/t3code): switch, add, forget Claude accounts from T3's screens

Private. Six tickets, server first, then the three screens.

## Tickets

### ticket-1 — Claude accounts over the wire: list, remember, forget
- New contracts file `packages/contracts/src/claudeAccounts.ts`: move ClaudeAccountErrorReason, ClaudeAccountError (plain-language messages: no instance id, no CLI command), RememberedClaudeAccount, ClaudeSetupAccountState, ClaudeAccountList, ClaudeSwitchResult out of the server; add ClaudeAccountRememberInput, ClaudeAccountForgetInput.
- RPCs `claudeAccounts.list` (orchestration:read), `claudeAccounts.remember`, `claudeAccounts.forget` (providers:manage, client-guarded).
- Handlers in `apps/server/src/provider/ClaudeAccountsRpc.ts` (plain function over the service), spread into ws.ts.
- client-runtime: `claudeAccountList` query family, `rememberClaudeAccount`, `forgetClaudeAccount` commands.
- Criteria: AK-14, AK-25, AK-28, AK-30, AK-36 (server half via RPC).

### ticket-2 — Switch over the wire, with confirm gate, single-flight and fresh account display
- `claudeAccounts.switch {instanceId, name, stopRunningTurns}`; new reasons `turnsRunning` (runs active and stopRunningTurns false, nothing stopped) and `switchInProgress` (refuse instead of queueing on accountsLock — use a separate in-flight Ref/semaphore tryAcquire).
- After success: for every affectedInstanceId, `invalidateCaches` (Claude driver's also resets lastGoodCapabilities) then `providerRegistry.refreshInstance`, so snapshot email + usage are the new account's. Needs ClaudeAccounts → ProviderInstanceRegistry/ProviderRegistry dependency, or do it in the RPC handler module (decide in ticket; prefer handler module to avoid cycle — check runtimeLayer).
- client-runtime `switchClaudeAccount` command.
- AMENDED (ticket-1 fixes, pragmatist-1): ticket 2 rewrites the 8 switch-only error texts (currentNotRemembered, needsFreshLogin, loginCheckFailed, switchFailed, switchRollbackFailed, externalClaudePrograms, processCheckFailed, sessionStopFailed) using ticket-1 draft's texts, and updates assertions ClaudeAccounts.integration.test.ts:1374, :2214 under AK-31. Also moves ClaudeSwitchResult if ticket 1 ruling drops it. Switch RPC scope providers:manage, client-guarded, pinned in RpcAuthorization.test.ts.
- Ticket 1 decided: list is providers:manage (security-1); reason is ForwardCompatibleOptional, new reasons are safe to add.
- Criteria: AK-2, AK-3, AK-4, AK-5, AK-7, AK-8, AK-9, AK-10, AK-11, AK-26, AK-31, AK-35, AK-37, AK-38, AK-39 (server half).

### ticket-3 — Add an account beside the setup: login in a throwaway dir
- Service `ClaudeAccountLogin` (apps/server/src/provider/ClaudeAccountLogin.ts): start {instanceId, name} validates name first (invalidName/nameInUse), creates `${stateDir}/claude-account-logins/<flowId>` (0700), spawns `claude auth login` in PTY with makeClaudeEnvironment({homePath: dir}, setup env) and setup binaryPath, terminal interaction (keystrokes for pasted code -> remote browser), on exit 0 reads login from dir, remembers via new `ClaudeAccounts.rememberLogin`, deletes dir.
- Cleanup: cancel, 5 min timeout, owner WebSocket connection close (finalizer in layerWsRpc), startup sweep of the folder.
- RPCs `claudeAccounts.add.start/respond/cancel/subscribe`, state reuses ProviderAuthState shape.
- New reasons: loginFailed, loginInProgress, alreadyRemembered reused.
- docs/internals/providers.md paragraph.
- Criteria: AK-15, AK-16, AK-22, AK-23, AK-24, AK-32.
- Risk: remote-device login (paste code) unverifiable without real CLI; name as unproven.

### ticket-4 — Claude provider settings: accounts list, switch, forget, remember, add
- `ClaudeAccountsSection.tsx` in Claude card setup slot (ProviderSettingsPanel chain branch `claudeAgent`), Linux-only via environment platform.
- Shared web pieces produced here: `useClaudeAccounts(environmentId)`, `useClaudeAccountSwitch(environmentId, instanceId)` (turnsRunning -> confirm -> retry with stopRunningTurns; in-progress atom shared per environment+instance), `RememberClaudeAccountDialog`, `ClaudeAddAccountLogin` (terminal via ProviderAuthTerminal, cancel on unmount).
- Criteria: AK-8, AK-14, AK-18, AK-25, AK-26, AK-27, AK-28, AK-29, AK-30, AK-36, AK-38, AK-39, AK-7, AK-31, AK-32 (UI), AK-33/34 (settings part).

### ticket-5 — Model picker account row
- Footer in Claude tab of ModelPickerContent: account, "all Claude chats", menu with remembered accounts, Remember… when not remembered, Add account…, Manage accounts; switching state; consumes ticket-4 hooks.
- Criteria: AK-1, AK-2, AK-3, AK-4, AK-6, AK-7, AK-8, AK-12, AK-13, AK-17, AK-28, AK-33, AK-34, AK-35.

### ticket-6 — Add provider dialog: share config option
- Checkbox at top of the Identity step (resolve the open point: avoids unused label/id/colour), only for Claude, Linux, an existing Claude setup; ticked -> account name + Setup picker (>1 setups) + Log in step using ClaudeAddAccountLogin; no instance created. Last ticket: test-affected gate.
- Criteria: AK-19, AK-20, AK-21, AK-33, AK-34.

## Deliberately left out
- Mobile app; usage-limit switch offer; automatic switching; dedicated error screens; command palette; live updates on other devices (Auftrag R14).
- Capability flag in ExecutionEnvironmentCapabilities: platform.os === "linux" suffices.

## Deliberately added
- Plain-language rewrite of all ClaudeAccountError messages (R11).
- turnsRunning server gate instead of a client-side running-turn check (client check disagrees with server rule).
- switchInProgress refusal (server queues today; AK-7 needs refusal).
- Resetting lastGoodCapabilities on invalidateCaches (AK-9 edge, same-org accounts).

## Risks
- `claude auth login` remote-device behaviour unverified.
- ws.ts handler extraction deviates slightly from "all handlers inline".
