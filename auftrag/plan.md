# Plan — Auftrag #2 (soerencoremans/t3code): switch the Claude account behind a Claude setup

Private working plan of the Gremium Author. Never posted. 3 tickets: ticket-1, ticket-2, ticket-3.
After ticket-3 there is NO ticket-4 → a draft turn for ticket-4 posts the closing comment.

## Shape

"Claude setup" = a Claude provider instance (driver kind `claudeAgent`), addressed by `ProviderInstanceId`.
What it owns: its resolved config dir (`resolveClaudeHomePath`) and its `.claude.json` path
(`<configDir>/.claude.json` when homePath or inherited CLAUDE_CONFIG_DIR is set, else `~/.claude.json`).
Instance config comes from `deriveProviderInstanceConfigMap(serverSettings.getSettings)` + `ClaudeSettings`
decode + `mergeProviderInstanceEnvironment` — no change to ClaudeDriverEnv (avoids test-harness ripple).
New shared helper `resolveClaudeSetupPaths` in ClaudeHome.ts; ClaudeDriver uses it too; the now unused
`claudeAccountConfigPath` export is removed (Knip).

Login on Linux = `<configDir>/.credentials.json` → `claudeAiOauth` (other keys stay).
Identity = `.claude.json` → `oauthAccount` (emailAddress, accountUuid, organizationUuid, …).
Account match key = (accountUuid, organizationUuid), email as display.

Remembered accounts = ONE secret `claude-accounts` in `ServerSecretStore`:
`{ version: 1, accounts: [{ name, oauthAccount, claudeAiOauth }] }` (opaque JSON objects, round-trip).
Mutations serialised by one Semaphore in the `ClaudeAccounts` service.

Backend only: no contracts, no WS RPC, no MCP tool. Service methods are the server API (AK-26).

## Tickets

1. **ticket-1 — ClaudeAccounts: remember, list, forget.** Seats: api-contract, testability.
   Files: ClaudeHome.ts (+test), ClaudeDriver.ts, claudeResetCredits.ts (drop export), NEW
   claudeLoginFiles.ts (+test), NEW ClaudeAccounts.ts, NEW ClaudeAccounts.integration.test.ts. CLOSED (#3).
   Ticket-2 notes: claudeAiOauth is Redacted<JsonObject>; result types are Schemas with null absence;
   ClaudeAccountError.instanceId is ProviderInstanceId; decide ResetCreditCoordinator serialisation.
   AKs: AK-1..AK-9, AK-23, AK-24, AK-27, AK-28, AK-29.
2. **ticket-2 — ClaudeAccounts.switch: the file transaction.** Linux gate (AK-30), unremembered current
   refused (AK-17), external Claude programs refused (AK-20; NEW claudeExternalProcesses.ts, /proc scan with
   injectable root, "outside T3" = not descendant of server pid and not in ownedAgentSlice), target login
   checked (AK-22; boundary `ClaudeLoginCheck`), outgoing login saved (AK-16), only `claudeAiOauth` and
   `oauthAccount` replaced (AK-18), rollback on failure (AK-19). Seats likely: data-safety, integration,
   reliability.
   Decide login check: not-expired → GET /api/oauth/usage (401/403 dead); expired → ??? (refresh endpoint
   would be new external call; prefer: treat as "check by the CLI" — decide at drafting with facts).
3. **ticket-3 — Switch stops the setup's T3 sessions; threads continue.** Order: all refusals first
   (AK-21, AK-31), then for every Claude instance resolving to the same config dir: interrupt every active
   run (`run.interrupt` → status interrupted, AK-13) and drain, then release remaining live sessions
   (idle ones too, so no CLI keeps old tokens in memory), then file transaction, then `invalidateCaches`.
   ALSO wires `ClaudeAccounts.layer` into server.ts (moved from ticket-1 by ruling pragmatist-2; needs
   orchestration services below it in the layer chain).
   AKs: AK-10..AK-15, AK-21, AK-25, AK-26, AK-31. Seats likely: concurrency, reliability, async-jobs.

## Deliberately left out
- Contracts / WS RPC / MCP tool / client permission scopes — the frontend Auftrag.
- macOS/Windows — "unavailable" error only.
- Renaming / editing a remembered account; logging in from T3.
- Per-thread switching.

## Deliberately added
- Refusing to remember the same account twice under two names (keeps "active as <name>" unambiguous).
- Capability-cache invalidation after a switch (no stale "who is logged in" label).
- Shared `resolveClaudeSetupPaths` helper (one source of truth for where a setup's login lives).

## Risks
- Release mid-turn fails the run → must interrupt first (ticket-3).
- Claude CLI holds tokens in memory and may rewrite `.credentials.json` → stop idle sessions too.
- `.claude.json` large and concurrently written → read-modify-write one key with atomic rename; external
  program refusal covers concurrent CLIs.

## Ticket-2 drafted (#4), round 1
Seats: data-safety, integration, testability. Decisions: login check = probeClaudeCapabilities in temp dir
(CLI renews; usage present → Valid); outside-T3 = env marker T3CODE_CLAUDE_OWNER_PID (not terminals);
own keep-mode atomic write; whole switch under accountsLock; switch = checkSwitch + applySwitch.
Ticket-3 notes: insert stop step between checkSwitch and applySwitch; wire ClaudeAccounts.layer +
ClaudeLoginCheck.layer + ClaudeExternalProcesses.layer in server.ts; invalidateCaches after apply.
