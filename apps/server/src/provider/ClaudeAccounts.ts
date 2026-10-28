import {
  ClaudeAccountError,
  ClaudeSettings,
  CommandId,
  RememberedClaudeAccount,
  type ClaudeAccountList,
  type ClaudeSetupAccountState,
  ProviderInstanceId,
  type OrchestrationV2Run,
  type ProjectId,
  type ProviderInstanceConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ClaudeExternalProcesses } from "./ClaudeExternalProcesses.ts";
import { ClaudeLoginCheck } from "./ClaudeLoginCheck.ts";
import { resolveClaudeSetupPaths, type ClaudeSetupPaths } from "./Drivers/ClaudeHome.ts";
import {
  claudeAccountIdentity,
  readClaudeSetupLogin,
  sameClaudeAccount,
  writeClaudeSetupLogin,
  type ClaudeAccountIdentity,
  type JsonObject,
} from "./claudeLoginFiles.ts";
import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

export {
  ClaudeAccountError,
  ClaudeAccountErrorReason,
  ClaudeAccountList,
  ClaudeSetupAccountState,
  RememberedClaudeAccount,
} from "@t3tools/contracts";

export const ClaudeSwitchResult = Schema.Struct({
  instanceId: ProviderInstanceId,
  active: RememberedClaudeAccount,
  /** Every Claude setup on the same config dir, the requested one first. */
  affectedInstanceIds: Schema.Array(ProviderInstanceId),
});
export type ClaudeSwitchResult = typeof ClaudeSwitchResult.Type;

export class ClaudeAccounts extends Context.Service<
  ClaudeAccounts,
  {
    readonly remember: (input: {
      readonly instanceId: ProviderInstanceId;
      readonly name: string;
    }) => Effect.Effect<RememberedClaudeAccount, ClaudeAccountError>;
    readonly list: Effect.Effect<ClaudeAccountList, ClaudeAccountError>;
    readonly forget: (input: { readonly name: string }) => Effect.Effect<void, ClaudeAccountError>;
    readonly switch: (input: {
      readonly instanceId: ProviderInstanceId;
      readonly name: string;
    }) => Effect.Effect<ClaudeSwitchResult, ClaudeAccountError>;
  }
>()("t3/provider/ClaudeAccounts") {}

/** How long a switch waits for the setup's T3 turns to stop, under `accountsLock`. */
export const CLAUDE_SWITCH_STOP_TIMEOUT = Duration.seconds(10);
const SWITCH_STOP_REASON = "Stopped for a Claude account switch";

const STORAGE_NAME = "claude-accounts";
const MAX_NAME_LENGTH = 64;
const CONTROL_CHARACTER = /\p{Cc}/u;
const CLAUDE_DRIVER = "claudeAgent";

const JsonObjectSchema = Schema.Record(Schema.String, Schema.Unknown);
const StoredAccounts = Schema.Struct({
  version: Schema.Literal(1),
  accounts: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      oauthAccount: JsonObjectSchema,
      claudeAiOauth: JsonObjectSchema,
    }),
  ),
});
const decodeClaudeSettings = Schema.decodeUnknownEffect(ClaudeSettings);
const encodeStoredAccounts = Schema.encodeEffect(Schema.fromJsonString(StoredAccounts));
const decodeStoredAccounts = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredAccounts));

interface StoredAccount {
  readonly name: string;
  readonly oauthAccount: JsonObject;
  readonly claudeAiOauth: Redacted.Redacted<JsonObject>;
  readonly identity: ClaudeAccountIdentity;
}

interface ClaudeSetup {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string | null;
  readonly paths: ClaudeSetupPaths;
  readonly settings: ClaudeSettings;
  readonly environment: NodeJS.ProcessEnv;
}

interface SwitchPlan {
  readonly _tag: "SwitchPlan";
  readonly setup: ClaudeSetup;
  readonly affectedInstanceIds: ReadonlyArray<ProviderInstanceId>;
  readonly outgoingName: string;
  readonly target: StoredAccount;
  readonly newClaudeAiOauth: Redacted.Redacted<JsonObject>;
}

interface AlreadyActive {
  readonly _tag: "AlreadyActive";
  readonly result: ClaudeSwitchResult;
}

interface HeldThread {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
}

type SessionStopStep = "enumerate" | "interrupt" | "wait" | "close" | "verify" | "timeout";

class SessionStopStepError extends Data.TaggedError("SessionStopStepError")<{
  readonly step: SessionStopStep;
  readonly errorTag: string | undefined;
}> {}

const errorTagOf = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "_tag" in cause && typeof cause._tag === "string"
    ? cause._tag
    : undefined;

const stopStepFailed = (step: SessionStopStep) => (cause?: unknown) =>
  new SessionStopStepError({ step, errorTag: errorTagOf(cause) });

const isLiveSession = (session: { readonly status: string }) =>
  session.status !== "stopped" && session.status !== "error";

const storageError = () => new ClaudeAccountError({ reason: "storage" });

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const isValidName = (name: string) =>
  name.length > 0 && Array.from(name).length <= MAX_NAME_LENGTH && !CONTROL_CHARACTER.test(name);

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const loginCheck = yield* ClaudeLoginCheck;
  const externalProcesses = yield* ClaudeExternalProcesses;
  const settings = yield* ServerSettingsService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const crypto = yield* Crypto.Crypto;
  const accountsLock = yield* Semaphore.make(1);

  const requireLinux = Effect.fn("ClaudeAccounts.requireLinux")(function* () {
    if ((yield* HostProcess.Platform) !== "linux") {
      return yield* new ClaudeAccountError({ reason: "unavailable" });
    }
  });

  const readLogin = (paths: ClaudeSetupPaths) =>
    readClaudeSetupLogin(paths).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));

  const writeLogin = (...args: Parameters<typeof writeClaudeSetupLogin>) =>
    writeClaudeSetupLogin(...args).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const setupFromEntry = Effect.fn("ClaudeAccounts.setupFromEntry")(function* (
    instanceId: ProviderInstanceId,
    entry: ProviderInstanceConfig,
  ) {
    const config = yield* decodeClaudeSettings(entry.config ?? {}).pipe(
      Effect.mapError(() => new ClaudeAccountError({ reason: "setupUnreadable", instanceId })),
    );
    const environment = yield* mergeProviderInstanceEnvironment(
      entry.environment,
      yield* HostProcess.Environment,
    );
    const paths = yield* resolveClaudeSetupPaths(config, environment).pipe(
      Effect.provideService(Path.Path, path),
    );
    return {
      instanceId,
      displayName: entry.displayName ?? null,
      paths,
      settings: config,
      environment,
    } satisfies ClaudeSetup;
  });

  const claudeEntries = Effect.fn("ClaudeAccounts.claudeEntries")(function* () {
    const current = yield* settings.getSettings.pipe(Effect.mapError(storageError));
    return Object.entries(deriveProviderInstanceConfigMap(current)).flatMap(([key, entry]) =>
      entry.driver === CLAUDE_DRIVER ? [[ProviderInstanceId.make(key), entry] as const] : [],
    );
  });

  const resolveSetup = Effect.fn("ClaudeAccounts.resolveSetup")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const entry = (yield* claudeEntries()).find(([candidate]) => candidate === instanceId);
    if (entry === undefined) {
      return yield* new ClaudeAccountError({ reason: "setupNotFound", instanceId });
    }
    return yield* setupFromEntry(instanceId, entry[1]);
  });

  const loadAccounts = Effect.fn("ClaudeAccounts.loadAccounts")(function* () {
    const stored = yield* secrets.get(STORAGE_NAME).pipe(Effect.mapError(storageError));
    if (Option.isNone(stored)) return [] as ReadonlyArray<StoredAccount>;
    // No cause is kept: a decode issue would quote the stored login.
    const decoded = yield* decodeStoredAccounts(new TextDecoder().decode(stored.value)).pipe(
      Effect.mapError(storageError),
    );
    const accounts: Array<StoredAccount> = [];
    for (const record of decoded.accounts) {
      const identity = claudeAccountIdentity(record.oauthAccount);
      if (Option.isNone(identity)) return yield* storageError();
      accounts.push({
        name: record.name,
        oauthAccount: record.oauthAccount,
        claudeAiOauth: Redacted.make(record.claudeAiOauth),
        identity: identity.value,
      });
    }
    return accounts as ReadonlyArray<StoredAccount>;
  });

  const saveAccounts = Effect.fn("ClaudeAccounts.saveAccounts")(function* (
    accounts: ReadonlyArray<StoredAccount>,
  ) {
    const json = yield* encodeStoredAccounts({
      version: 1,
      accounts: accounts.map((account) => ({
        name: account.name,
        oauthAccount: account.oauthAccount,
        claudeAiOauth: Redacted.value(account.claudeAiOauth),
      })),
    });
    yield* secrets.set(STORAGE_NAME, new TextEncoder().encode(json));
  }, Effect.mapError(storageError));

  const remember = Effect.fn("ClaudeAccounts.remember")(function* (input: {
    readonly instanceId: ProviderInstanceId;
    readonly name: string;
  }) {
    yield* requireLinux();
    const { instanceId } = input;
    const setup = yield* resolveSetup(instanceId);
    const login = yield* readLogin(setup.paths).pipe(
      Effect.mapError(() => new ClaudeAccountError({ reason: "setupUnreadable", instanceId })),
    );
    if (Option.isNone(login)) {
      return yield* new ClaudeAccountError({ reason: "notLoggedIn", instanceId });
    }
    const name = input.name.trim();
    const remembered = yield* accountsLock.withPermits(1)(
      Effect.gen(function* () {
        if (!isValidName(name)) return yield* new ClaudeAccountError({ reason: "invalidName" });
        const accounts = yield* loadAccounts();
        if (accounts.some((account) => sameName(account.name, name))) {
          return yield* new ClaudeAccountError({ reason: "nameInUse", name });
        }
        const duplicate = accounts.find((account) =>
          sameClaudeAccount(account.identity, login.value.identity),
        );
        if (duplicate !== undefined) {
          return yield* new ClaudeAccountError({
            reason: "alreadyRemembered",
            name: duplicate.name,
          });
        }
        yield* saveAccounts([
          ...accounts,
          {
            name,
            oauthAccount: login.value.oauthAccount,
            claudeAiOauth: login.value.claudeAiOauth,
            identity: login.value.identity,
          },
        ]);
        return { name, email: login.value.identity.email } satisfies RememberedClaudeAccount;
      }),
    );
    yield* Effect.logInfo("Claude account remembered", { operation: "remember", name, instanceId });
    return remembered;
  });

  const activeAccount = Effect.fn("ClaudeAccounts.activeAccount")(function* (
    entry: readonly [ProviderInstanceId, ProviderInstanceConfig],
    accounts: ReadonlyArray<StoredAccount>,
  ) {
    // One unreadable setup must not hide the others.
    const login = yield* setupFromEntry(entry[0], entry[1]).pipe(
      Effect.flatMap((setup) => readLogin(setup.paths)),
      Effect.orElseSucceed(() => Option.none()),
    );
    if (Option.isNone(login)) return null;
    const match = accounts.find((account) =>
      sameClaudeAccount(account.identity, login.value.identity),
    );
    return { email: login.value.identity.email, rememberedAs: match?.name ?? null };
  });

  const list = Effect.fn("ClaudeAccounts.list")(function* () {
    yield* requireLinux();
    const accounts = yield* loadAccounts();
    const setups: Array<ClaudeSetupAccountState> = [];
    for (const entry of yield* claudeEntries()) {
      setups.push({
        instanceId: entry[0],
        displayName: entry[1].displayName ?? null,
        active: yield* activeAccount(entry, accounts),
      });
    }
    return {
      accounts: accounts.map((account) => ({
        name: account.name,
        email: account.identity.email,
      })),
      setups,
    } satisfies ClaudeAccountList;
  });

  const forget = Effect.fn("ClaudeAccounts.forget")(function* (input: { readonly name: string }) {
    yield* requireLinux();
    const name = input.name.trim();
    yield* accountsLock.withPermits(1)(
      Effect.gen(function* () {
        const accounts = yield* loadAccounts();
        if (!accounts.some((account) => sameName(account.name, name))) {
          return yield* new ClaudeAccountError({ reason: "accountNotFound", name });
        }
        yield* saveAccounts(accounts.filter((account) => !sameName(account.name, name)));
      }),
    );
    yield* Effect.logInfo("Claude account forgotten", { operation: "forget", name });
  });

  const unreadable = (instanceId: ProviderInstanceId) => () =>
    new ClaudeAccountError({ reason: "setupUnreadable", instanceId });

  const sameConfigDirSetups = Effect.fn("ClaudeAccounts.sameConfigDirSetups")(function* (
    setup: ClaudeSetup,
  ) {
    const configDir = path.resolve(setup.paths.configDir);
    const siblings: Array<ProviderInstanceId> = [];
    for (const [candidate, entry] of yield* claudeEntries()) {
      if (candidate === setup.instanceId) continue;
      // A sibling whose own config cannot be resolved is not switched with this one.
      const resolved = yield* Effect.option(setupFromEntry(candidate, entry));
      if (Option.isSome(resolved) && path.resolve(resolved.value.paths.configDir) === configDir) {
        siblings.push(candidate);
      }
    }
    return [setup.instanceId, ...siblings] as ReadonlyArray<ProviderInstanceId>;
  });

  // One scan covers every affected setup: they share this config dir by construction.
  const refuseExternalPrograms = Effect.fn("ClaudeAccounts.refuseExternalPrograms")(function* (
    setup: ClaudeSetup,
  ) {
    const { instanceId } = setup;
    const pids = yield* externalProcesses.findUsing(setup.paths.configDir).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Claude account switch refused", {
          operation: "switch",
          outcome: "processCheckFailed",
          instanceId,
          scanFailure: error.reason,
        }).pipe(
          Effect.andThen(
            Effect.fail(new ClaudeAccountError({ reason: "processCheckFailed", instanceId })),
          ),
        ),
      ),
    );
    if (pids.length > 0) {
      yield* Effect.logInfo("Claude account switch refused", {
        operation: "switch",
        outcome: "externalClaudePrograms",
        instanceId,
        processCount: pids.length,
      });
      return yield* new ClaudeAccountError({ reason: "externalClaudePrograms", instanceId });
    }
  });

  const checkSwitch = Effect.fn("ClaudeAccounts.checkSwitch")(function* (input: {
    readonly instanceId: ProviderInstanceId;
    readonly name: string;
  }) {
    const { instanceId } = input;
    yield* requireLinux();
    const setup = yield* resolveSetup(instanceId);
    const affectedInstanceIds = yield* sameConfigDirSetups(setup);
    const login = yield* readLogin(setup.paths).pipe(Effect.mapError(unreadable(instanceId)));
    if (Option.isNone(login)) {
      return yield* new ClaudeAccountError({ reason: "notLoggedIn", instanceId });
    }
    const accounts = yield* loadAccounts();
    const outgoing = accounts.find((account) =>
      sameClaudeAccount(account.identity, login.value.identity),
    );
    if (outgoing === undefined) {
      return yield* new ClaudeAccountError({ reason: "currentNotRemembered", instanceId });
    }
    const name = input.name.trim();
    const target = accounts.find((account) => sameName(account.name, name));
    if (target === undefined) {
      return yield* new ClaudeAccountError({ reason: "accountNotFound", name });
    }
    if (target === outgoing) {
      return {
        _tag: "AlreadyActive",
        result: {
          instanceId,
          active: { name: target.name, email: target.identity.email },
          affectedInstanceIds,
        },
      } satisfies AlreadyActive;
    }
    yield* refuseExternalPrograms(setup);

    const checked = yield* loginCheck.check({
      claudeAiOauth: target.claudeAiOauth,
      oauthAccount: target.oauthAccount,
      settings: setup.settings,
      environment: setup.environment,
    });
    // The check's renewal rotates the refresh token, so the stored copy is dead once it ran.
    const renewed = Option.getOrElse(checked.latestClaudeAiOauth, () => target.claudeAiOauth);
    if (Option.isSome(checked.latestClaudeAiOauth)) {
      yield* saveAccounts(
        accounts.map((account) =>
          account === target ? { ...account, claudeAiOauth: renewed } : account,
        ),
      );
    }
    if (checked.verdict === "NeedsLogin") {
      return yield* new ClaudeAccountError({ reason: "needsFreshLogin", name: target.name });
    }
    if (checked.verdict === "Unknown") {
      return yield* new ClaudeAccountError({ reason: "loginCheckFailed", name: target.name });
    }
    return {
      _tag: "SwitchPlan",
      setup,
      affectedInstanceIds,
      outgoingName: outgoing.name,
      target,
      newClaudeAiOauth: renewed,
    } satisfies SwitchPlan;
  });

  const applySwitch = Effect.fn("ClaudeAccounts.applySwitch")(function* (plan: SwitchPlan) {
    const { setup, target, affectedInstanceIds } = plan;
    const { instanceId } = setup;
    // A program may have started during the login check, which can take about 29 s.
    yield* refuseExternalPrograms(setup);
    const switchFailed = () => new ClaudeAccountError({ reason: "switchFailed", instanceId });
    // T3's own sessions may have renewed the login since checkSwitch read it.
    const current = yield* readLogin(setup.paths).pipe(Effect.mapError(switchFailed));
    if (Option.isNone(current)) return yield* switchFailed();
    const accounts = yield* loadAccounts();
    const outgoing = accounts.find((account) => account.name === plan.outgoingName);
    if (outgoing === undefined || !sameClaudeAccount(outgoing.identity, current.value.identity)) {
      return yield* switchFailed();
    }
    yield* saveAccounts(
      accounts.map((account) =>
        account === outgoing
          ? {
              ...account,
              claudeAiOauth: current.value.claudeAiOauth,
              oauthAccount: current.value.oauthAccount,
            }
          : account,
      ),
    );
    yield* writeLogin(setup.paths, {
      claudeAiOauth: plan.newClaudeAiOauth,
      oauthAccount: target.oauthAccount,
    }).pipe(
      Effect.catch((failure) =>
        failure.restored
          ? Effect.logWarning("Claude account switch failed", {
              operation: "switch",
              outcome: "switchFailed",
              instanceId,
              from: plan.outgoingName,
              to: target.name,
            }).pipe(Effect.andThen(Effect.fail(switchFailed())))
          : Effect.logError("Claude account switch could not restore the setup files", {
              instanceId,
              path: failure.path,
            }).pipe(
              Effect.andThen(
                Effect.fail(new ClaudeAccountError({ reason: "switchRollbackFailed", instanceId })),
              ),
            ),
      ),
    );
    yield* Effect.logInfo("Claude account switched", {
      operation: "switch",
      instanceId,
      affectedInstanceIds,
      from: plan.outgoingName,
      to: target.name,
    });
    return {
      instanceId,
      active: { name: target.name, email: target.identity.email },
      affectedInstanceIds,
    } satisfies ClaudeSwitchResult;
  });

  // The same query ProviderAuthService.stopSessions uses for threads with live provider work.
  const activeRunsOn = Effect.fn("ClaudeAccounts.activeRunsOn")(
    function* (affected: ReadonlySet<ProviderInstanceId>) {
      const found: Array<HeldThread & { readonly run: OrchestrationV2Run }> = [];
      for (const threadId of yield* projections.getRecoveryThreadIds("runtime")) {
        const records = yield* projections.getThreadRecords(threadId, ["runs"]);
        const run = ThreadManagementService.latestActiveRun(records);
        if (run === undefined || !affected.has(run.providerInstanceId)) continue;
        found.push({ projectId: records.thread.projectId, threadId, run });
      }
      return found;
    },
    Effect.mapError(stopStepFailed("enumerate")),
  );

  const runEnded = (threadId: ThreadId, runId: OrchestrationV2Run["id"]) =>
    projections.getThreadRecords(threadId, ["runs"]).pipe(
      Effect.map((records) => {
        const run = records.runs.find((candidate) => candidate.id === runId);
        return run !== undefined && !ThreadManagementService.isActiveRun(run);
      }),
    );

  // Interrupting rather than releasing the session ends the turn as interrupted, not failed.
  const stopRun = Effect.fn("ClaudeAccounts.stopRun")(function* (
    target: HeldThread & { readonly run: OrchestrationV2Run },
    switchId: string,
    held: Ref.Ref<ReadonlyArray<HeldThread>>,
  ) {
    const { projectId, threadId, run } = target;
    const interrupted = yield* threads
      .dispatch({
        type: "run.interrupt",
        commandId: CommandId.make(`claude-account-switch:${switchId}:${run.id}`),
        threadId,
        runId: run.id,
        reason: SWITCH_STOP_REASON,
        holdQueue: true,
      })
      .pipe(
        Effect.as(true),
        // A run that ended on its own meanwhile is no longer interruptible, and is done.
        Effect.catch((cause) =>
          runEnded(threadId, run.id).pipe(
            Effect.mapError(stopStepFailed("interrupt")),
            Effect.flatMap((ended) =>
              ended ? Effect.succeed(false) : Effect.fail(stopStepFailed("interrupt")(cause)),
            ),
          ),
        ),
      );
    if (!interrupted) return false;
    yield* Ref.update(held, (current) =>
      current.some((entry) => entry.threadId === threadId)
        ? current
        : [...current, { projectId, threadId }],
    );
    const waited = yield* threads
      .waitForThread({
        projectId,
        threadId,
        runId: run.id,
        // A backstop only: the stop's own timeout bounds the whole wait and names the step.
        timeoutMs: Duration.toMillis(Duration.times(CLAUDE_SWITCH_STOP_TIMEOUT, 2)),
      })
      .pipe(Effect.mapError(stopStepFailed("wait")));
    if (waited.timedOut) return yield* stopStepFailed("wait")();
    return true;
  });

  const stopPass = Effect.fn("ClaudeAccounts.stopPass")(function* (
    affected: ReadonlySet<ProviderInstanceId>,
    switchId: string,
    held: Ref.Ref<ReadonlyArray<HeldThread>>,
  ) {
    const stopped = yield* Effect.forEach(
      yield* activeRunsOn(affected),
      (target) => stopRun(target, switchId, held),
      { concurrency: "unbounded" },
    );
    return stopped.filter(Boolean).length;
  });

  const verifyStopped = Effect.fn("ClaudeAccounts.verifyStopped")(
    function* (affected: ReadonlySet<ProviderInstanceId>) {
      for (const threadId of yield* projections.getRecoveryThreadIds("runtime")) {
        const records = yield* projections.getThreadRecords(threadId, ["runs", "providerSessions"]);
        const run = ThreadManagementService.latestActiveRun(records);
        const liveSession = records.providerSessions.some(
          (session) => affected.has(session.providerInstanceId) && isLiveSession(session),
        );
        if ((run !== undefined && affected.has(run.providerInstanceId)) || liveSession) {
          return yield* stopStepFailed("verify")();
        }
      }
    },
    Effect.mapError((failure) =>
      failure instanceof SessionStopStepError ? failure : stopStepFailed("verify")(failure),
    ),
  );

  const stopSetupSessions = Effect.fn("ClaudeAccounts.stopSetupSessions")(function* (
    instanceIds: ReadonlyArray<ProviderInstanceId>,
    requestedId: ProviderInstanceId,
    held: Ref.Ref<ReadonlyArray<HeldThread>>,
    switchId: string,
  ) {
    const affected = new Set(instanceIds);
    const interruptedRuns = yield* Effect.gen(function* () {
      const first = yield* stopPass(affected, switchId, held);
      // Catches a turn sent on an idle thread of the setup during the first pass.
      const second = yield* stopPass(affected, switchId, held);
      // Also releases idle sessions: an idle Claude process still holds and renews the old login.
      for (const instanceId of instanceIds) {
        yield* providerSessions
          .closeInstance(instanceId)
          .pipe(Effect.mapError(stopStepFailed("close")));
      }
      yield* verifyStopped(affected);
      return first + second;
    }).pipe(
      Effect.timeoutOrElse({
        duration: CLAUDE_SWITCH_STOP_TIMEOUT,
        orElse: () => Effect.fail(stopStepFailed("timeout")()),
      }),
      Effect.catchTags({
        SessionStopStepError: (failure) =>
          Effect.logWarning("Claude account switch could not stop sessions", {
            operation: "switch",
            outcome: "sessionStopFailed",
            instanceId: requestedId,
            step: failure.step,
            errorTag: failure.errorTag,
          }).pipe(
            Effect.andThen(
              Effect.fail(
                new ClaudeAccountError({ reason: "sessionStopFailed", instanceId: requestedId }),
              ),
            ),
          ),
      }),
    );
    yield* Effect.logInfo("Claude account switch stopped sessions", {
      operation: "switch",
      instanceId: requestedId,
      affectedInstanceIds: instanceIds,
      interruptedRuns,
    });
    return interruptedRuns;
  });

  const resumeHeldQueues = Effect.fn("ClaudeAccounts.resumeHeldQueues")(function* (
    held: Ref.Ref<ReadonlyArray<HeldThread>>,
    switchId: string,
  ) {
    for (const { threadId } of yield* Ref.get(held)) {
      yield* threads
        .dispatch({
          type: "queue.resume",
          commandId: CommandId.make(`claude-account-switch:${switchId}:resume:${threadId}`),
          threadId,
        })
        .pipe(
          Effect.uninterruptible,
          Effect.catchCause((cause) =>
            Effect.logWarning("Claude account switch could not resume a held queue", {
              operation: "switch",
              outcome: "queueResumeFailed",
              threadId,
              errorTag: errorTagOf(Cause.squash(cause)),
            }),
          ),
        );
    }
  });

  const switchAccount = Effect.fn("ClaudeAccounts.switch")(function* (input: {
    readonly instanceId: ProviderInstanceId;
    readonly name: string;
  }) {
    return yield* accountsLock.withPermits(1)(
      Effect.gen(function* () {
        // Every refusal comes before anything is stopped, so a refused switch leaves turns alone.
        const plan = yield* checkSwitch(input);
        if (plan._tag === "AlreadyActive") return plan.result;
        // Command ids are persisted receipts, so they must stay unique across restarts.
        const switchId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
        const held = yield* Ref.make<ReadonlyArray<HeldThread>>([]);
        return yield* Effect.gen(function* () {
          const interruptedRuns = yield* stopSetupSessions(
            plan.affectedInstanceIds,
            input.instanceId,
            held,
            switchId,
          );
          return yield* applySwitch(plan).pipe(
            Effect.tapError((error) =>
              Effect.logInfo("Claude account switch refused after stopping sessions", {
                operation: "switch",
                instanceId: input.instanceId,
                reason: error.reason,
                interruptedRuns,
              }),
            ),
          );
        }).pipe(Effect.ensuring(resumeHeldQueues(held, switchId)));
      }),
    );
  });

  return ClaudeAccounts.of({ remember, list: list(), forget, switch: switchAccount });
});

export const layer: Layer.Layer<
  ClaudeAccounts,
  never,
  | ServerSecretStore.ServerSecretStore
  | ServerSettingsService
  | FileSystem.FileSystem
  | Path.Path
  | ClaudeLoginCheck
  | ClaudeExternalProcesses
  | ThreadManagementService.ThreadManagementService
  | ProviderSessionManager.ProviderSessionManagerV2
  | ProjectionStore.ProjectionStoreV2
  | Crypto.Crypto
> = Layer.effect(ClaudeAccounts, make);
