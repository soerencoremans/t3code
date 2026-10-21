# Plan — Auftrag #2 (soerencoremans/t3code): switch the Claude account behind a Claude setup

Private working plan of the Gremium Author. Never posted. AMENDED (ticket-2 round 2, pragmatist-2): 4 tickets: ticket-1, ticket-2, ticket-3, ticket-4.
After ticket-4 there is NO ticket-5 → a draft turn for ticket-5 posts the closing comment.

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

## AMENDMENT (ticket-2 fixes, round 2) — 4 tickets
- ticket-2 (#4): switch + write/rollback + login check; AK-16,17,18,19,22,30. No marker, no /proc scan.
  Siblings: all instances on the same configDir switched together (affectedInstanceIds in SwitchPlan/result).
  Check returns latestClaudeAiOauth always; saved to target record right after check.
  writeFileStringAtomically gains optional mode (packages/shared).
- ticket-3 (NEW): external-process gate. Marker T3CODE_CLAUDE_OWNER_PID (consider one constructor,
  architect-3; pid from one place, architect-4), spawn sites ClaudeProvider 357/441, ClaudeTextGeneration 93,
  ClaudeAdapterV2 10338 — per-site tests through seams (fake claude on PATH, ClaudeAgentSdkQueryRunner double)
  (testability-1); ClaudeExternalProcesses /proc scan, cmdline first, environ only for claude pids
  (security-3); reasons externalClaudePrograms/processCheckFailed; gate in checkSwitch before login check;
  sibling instances' marked CLIs allowed. AK-20. Seats: integration, testability, security-relevant.
  Note integration out-of-lens: scan before 25s check → re-scan right before apply?
- ticket-4 (was ticket-3): stop sessions of ALL affectedInstanceIds (interrupt runs, release sessions,
  also probes/text-gen?) between checkSwitch and applySwitch; invalidateCaches for all; wire
  ClaudeAccounts/ClaudeLoginCheck/ClaudeExternalProcesses layers in server.ts. AK-10..15,21,25,26,31.

## Ticket-2 CLOSED (#4, round 2 ruling). Carry to ticket-3: architect-3 (one constructor for marker),
architect-4 (pid from one place), security-3 (cmdline first, environ only for claude), testability-3
(unreadable environ skip as root), testability-1 (per-site marker tests), security out-of-lens (re-scan
right before apply?). Carry to ticket-4: data-safety OOL — T3 probe/text-gen CLIs of affected instances
may renew mid-switch; stop/await them too or accept. Login check uses ~29s under accountsLock.

## Ticket-3 drafted (round 1)
Seats: integration, testability, codebase. Marker in makeClaudeEnvironment (always), makeClaudeTerminalEnvironment
for Manager.ts (strips marker); HostProcess.ProcessId reference; ClaudeExternalProcesses layerWith({procRoot});
gate refuseExternalPrograms in checkSwitch after already-active, before login check, AND first step of applySwitch.
Reasons externalClaudePrograms/processCheckFailed. AK-20 only. Ticket-4 notes: provide ClaudeExternalProcesses.layer
in server.ts; AK-21 proven in ticket 4 (stop step after checkSwitch, refusal leaves turns running); applySwitch's
first step is the re-scan, so ticket-4's stop runs before it.
