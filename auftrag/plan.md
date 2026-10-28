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
- Criteria: AK-2, AK-3, AK-4, AK-5, AK-7, AK-10, AK-11, AK-26, AK-31, AK-35, AK-38, AK-39 (server half). AK-8/AK-9 moved to ticket-7 (turn 5 amendment, pragmatist-1).
- Turn 5 fixes: re-check turnsRunning right before stopSetupSessions (concurrency-1); switch body forked into the layer scope and joined, so caller interruption does not cut it (reliability-1).
- AS DRAFTED (turn 4): service input gains stopRunningTurns; turnsRunning gate after refuseExternalPrograms, before login check; switchInProgress via second Semaphore withPermitsIfAvailable (global). Refresh in ClaudeAccountsRpc.ts: claudeAccountsSwitchRpcHandler(accounts, refreshAfterSwitch) + refreshSwitchedSetups(instances, registry). ClaudeDriver fallback also compares accountUuid. AK-37 moved to ticket 5.

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
- Criteria: AK-1, AK-2, AK-3, AK-4, AK-6, AK-7, AK-8, AK-12, AK-13, AK-17, AK-28, AK-33, AK-34, AK-35, AK-37 (moved from ticket 2: the picker row is the only switch entry; the usage-limit message gets none).

### ticket-6 — Add provider dialog: share config option
- Checkbox at top of the Identity step (resolve the open point: avoids unused label/id/colour), only for Claude, Linux, an existing Claude setup; ticked -> account name + Setup picker (>1 setups) + Log in step using ClaudeAddAccountLogin; no instance created. 
- Criteria: AK-19, AK-20, AK-21, AK-33, AK-34.

### ticket-7 — Fresh account display after a switch (added turn 5, split from ticket 2 on pragmatist-1)
- Blocked by ticket 2. Placed last so ticket 1's references to tickets 3-6 keep their numbers. Last ticket: test-affected gate.
- Refresh is part of ClaudeAccounts.switch (architect-1): a provider-domain dependency (e.g. a small `ClaudeSetupSnapshots` service tag with invalidate+refreshInstance, layer from ProviderInstanceRegistry+ProviderRegistry) called inside the switch permit before it is released (concurrency-2).
- A probe that started before the login files were written must not publish over the post-switch snapshot (concurrency-2): decide generation counter / ordering there; test with held SDK spy across the switch.
- Fallback identity (orgId + accountUuid) read BEFORE the probe and stored with its result (concurrency-3); uuid read through claudeLoginFiles.ts parser (architect-3).
- Probe timeout bounds the refresh (reliability-3).
- Criteria: AK-8, AK-9.

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

## Ticket 3 ruling (turn 8) — carry into later tickets
- ticket-3 = #13 (#12 orphan duplicate). Blocked by #10, #11.
- Ticket 4 hand-off must ask the human for a manual add-account from a browser on another device (AK-16, focus-1).
- Each of tickets 4, 5, 6 proves AK-23 dialog-close (cancel on unmount) for its own screen (focus-2).
- Ticket 3 contract: one attempt per connection; claudeAccountAddState has completeWhen; ProviderAuthTerminalResponse exported from providerSetup.ts.

## Ticket 4 drafted (turn 9) = #14. Seats: ui, ux, component-reuse.
- Produces for 5/6 in apps/web/src/components/settings/: claudeAccounts.logic.ts (claudeAccountsAvailable, claudeSetupAccountView, claudeAccountErrorMessage), useClaudeAccounts.ts (useClaudeAccountsAvailable, useClaudeSetupAccounts, useClaudeAccountSwitch with shared pending atom), RememberClaudeAccountDialog, AddClaudeAccountDialog, ClaudeAccountAddLogin, ClaudeAccountsSection.
- Ticket 4 criteria incl. AK-4, AK-5, AK-7 (settings), AK-16/36/39 manual checks in hand-off.

## PLAN AMENDMENT (turn 10, ticket-4 fixes, pragmatist-1)
- ticket-4 (#14): card only — row, list, switch, forget, remember. Exposes `renderAddAccount?` slot prop on ClaudeAccountsSection. Criteria lose AK-16/18/22/23/32.
- ticket-5: model picker row WITHOUT "Add account…" (drop AK-17). Keeps the rest. Exposes a slot for ticket 6's Add account… menu item.
- ticket-6 (REDEFINED): add-account flow — AddClaudeAccountDialog with login step inside (no separate ClaudeAccountAddLogin unless ticket 8 needs it -> ticket 8 extracts), wired into settings card (AK-18) and picker (AK-17). AK-15, 16, 17, 18, 22, 23, 32. Cancel on close path (Cancel / onOpenChange(false)), NOT effect cleanup (StrictMode, architect-2); StrictMode browser case. Hand-off: manual AK-16 check from another device. Blocked by 4, 5.
- ticket-7: unchanged (fresh account display, AK-8, AK-9).
- ticket-8 (NEW, last, test-affected gate): Add provider share-config option (old ticket-6 content), blocked by 6. AK-19, 20, 21, 33/34 dialog part. Ticket 3's "Add provider dialog (ticket 6)" now means ticket 8 — say so in closing.
- Ticket-4 suggestions to take at ruling: security-1 (Redacted list emails), ux-2 (set pending atom only once a call that can switch runs: set after confirm/before 2nd call; first call w/ false sets pending too? -> set pending on first call too but clear before confirm), ux-5, ui-2, ui-3, ui-4 partly, component-reuse-1,2,4,5. Declined/moot: security-2, ux-3, ux-4, component-reuse-3,6, pragmatist-2 -> moved to ticket 6; focus-1 -> ticket 6 (AK-15).

## Ticket 4 ruling (turn 11) — #14 closed, blocked by #10, #11 only
- NO renderAddAccount slot (pragmatist dispute upheld): ticket 6 MODIFIES ClaudeAccountsSection.tsx to put "Add account…" as control of the "Remembered accounts" SettingsRow (enabled also in loggedOut).
- Ticket 4 produces: claudeAccounts.logic.ts (claudeAccountsAvailable, ClaudeAccountRow, ClaudeSetupAccountView, claudeSetupAccountView, claudeAccountErrorMessage), useClaudeAccounts.ts (useClaudeAccountsAvailable, useClaudeSetupAccounts{view,error,refresh}, useClaudeAccountSwitch(env, inst, onSwitched){pendingTarget,error,switchTo}), RememberClaudeAccountDialog(props env, instanceId, email, onClose, onRemembered), ClaudeAccountsSection(env, instanceId).
- Carry into ticket 6: security-2 (Log in disabled during start, double-submit case), ux-3 (retry on failed login: back to name step with name kept), ux-4 (outside click during login step: decide; prefer no dismiss on outside click while running), AK-15 assertion (Work stays Active), StrictMode case, AddProviderShareConfig.dc.html board 3 cited, WizardPopup size wide for terminal, shared name form optional.
- Carry into ticket 5: confirm text and Switching text from ModelPickerAccount.dc.html already in useClaudeAccountSwitch; picker's AK-17 moves to ticket 6.
