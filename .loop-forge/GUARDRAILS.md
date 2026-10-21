# Guard rails

The rules every Loop-Forge agent is bound by in this repository, whatever its role.
`AGENTS.md` (loaded through `CLAUDE.md`) is the full reference; this file adds only what the
loop needs on top of it. Where the two disagree, `AGENTS.md` wins and the disagreement is a
finding.

This repository is a fork of `pingdotgg/t3code`. Aufträge are cut from `loop/main`, which is
upstream `main` plus this directory. Keep every change upstreamable: no fork-only
conventions in product code.

## 1. Safety

These outrank the ticket. A ticket that needs one of them broken stops with `Human`.

- ⛔ Never read-write, start a server against, or clean up `~/.t3/userdata`. It is the
  developer's live T3 Code database, in use while you work.
- ⛔ Never kill a process found by name, path or pattern (`pkill -f`, `pgrep | kill`). Other
  agents, dev servers and the developer's T3 Code run on this machine. Kill only a PID you
  spawned yourself.
- ⛔ Never touch a real Claude, Codex or other provider config directory (`~/.claude*`,
  `~/.codex`, …), not even to read credentials. Code that reads, writes or swaps credentials
  is exercised only against temporary directories the test creates and removes.
- ⛔ Never set `VITE_HTTP_URL` or `VITE_WS_URL`.
- No dev servers, no browsers, no computer use. The gate and the tests are the proof.

## 2. Tests

- **Red first, Chicago School.** Write the tests the ticket's specification names, watch
  them fail, then the smallest code that passes. Assert on outcomes and state, with real
  collaborators; doubles only at real boundaries (provider CLIs, network, clock, filesystem
  outside a temp dir).
- **Meaningful only** (`AGENTS.md`, Verifying): no tests that mirror the implementation,
  assert callback wiring, or render components to static markup to check props.
- **No sleeps, no polling.** The server is event-sourced: drain
  `OrchestrationEffectWorkerV2.drain` or await the persisted event or `Deferred` that marks
  the milestone. A test that needs a timeout to pass is wrong.
- **Altered existing tests** need a written justification in the hand-off comment. A
  deleted or weakened assertion is a rejection unless the ticket required the behaviour
  change.

| Level              | Where                                                                                                                         | Run one file                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Unit               | `*.test.ts(x)` next to the source, Vitest                                                                                     | `node .loop-forge/test-scoped.mjs <path>` |
| Integration        | `apps/server`: `*.integration.test.ts`, the orchestration testkit (`src/orchestration-v2/testkit`), `apps/server/integration` | same                                      |
| Browser components | `apps/web` `browser` project, headless Chromium                                                                               | same                                      |

**There is no end-to-end suite.** Server integration tests stand in for e2e: each Gherkin
acceptance criterion maps to an integration test that drives the behaviour through the
service or RPC boundary a client would use. A criterion only a real client can prove is
named in the hand-off as unproven, not faked.

Always run tests through `test-scoped.mjs` or the package's own `test` script
(`vp run --filter <package> test <files>`). A root-level `vp test run apps/server/…` uses
the wrong config and proves nothing.

## 3. The gate

Run before every hand-off, from the ticket worktree:

```bash
vp run --filter <each package you changed> typecheck
vp lint <changed files>
vp fmt <changed files>
```

Never `vp check`, `vp run -r test` or `vp run -r typecheck`: they are repo-wide and CI's job.

The gate the transition tool runs comes from `.loop-forge/config.json` in the BASE worktree:

- Every ticket but the last: `test-scoped.mjs` over the test files the Auftrag added or
  changed, each through its own package.
- The last ticket: `test-affected.mjs`. It maps the Auftrag's diff to packages and their
  dependents with `.github/scripts/ci-changes.cjs`, exactly as CI does for a pull request,
  then typechecks them and runs their suites. It runs every group even after one fails and
  ends with a summary; read that first. `apps/server` runs one file at a time by design and
  takes over ten minutes when it is affected.

## 4. Working inside the loop

- Work only in the ticket worktree under `.loop-forge/worktrees/ticket-<n>`. BASE
  (`auftrag-<n>`) is read-only.
- A fresh worktree has no `node_modules`: run `vp i --frozen-lockfile -- --yes` once. A
  lockfile change is a deliberate, justified commit.
- Contracts first: anything crossing the wire is typed in `packages/contracts`. A change
  there reaches server, web, mobile and desktop; name every consumer you updated.
- Commit on the ticket branch only, Conventional Commits (`<type>(<scope>): <summary>`), the
  ticket number and turn in the message. Never push, never touch `main` or `loop/main`,
  never rewrite history on BASE.
- The transition tool is the only way to move the ticket. Labels, statuses and the board
  are never edited by hand.
- Never edit `.loop-forge/` or `.github/`. Stop with `Human` when the ticket needs that, a
  new dependency, a new external service, or a decision the Auftrag's purpose does not
  settle.
