import {
  ClaudeSettings,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
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
]);
export type ClaudeAccountErrorReason = typeof ClaudeAccountErrorReason.Type;

export class ClaudeAccountError extends Schema.TaggedError<ClaudeAccountError>()(
  "ClaudeAccountError",
  {
    reason: ClaudeAccountErrorReason,
    instanceId: Schema.optional(ProviderInstanceId),
    name: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unavailable":
        return "Claude account switching is unavailable on this system. It is supported on Linux only.";
      case "setupNotFound":
        return `No Claude setup "${this.instanceId}" is configured.`;
      case "setupUnreadable":
        return `Could not read the Claude login of setup "${this.instanceId}".`;
      case "notLoggedIn":
        return `No Claude account is logged in on setup "${this.instanceId}".`;
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
        return `The account logged in on setup "${this.instanceId}" is not remembered. Remember it first, then switch.`;
      case "needsFreshLogin":
        return `The saved login of "${this.name}" no longer works. Log in to that account again with \`claude auth login\`, then forget "${this.name}" and remember it again.`;
      case "loginCheckFailed":
        return `Could not check the saved login of "${this.name}". Try again.`;
      case "switchFailed":
        return `Switching setup "${this.instanceId}" failed. The setup is logged in as before.`;
      case "switchRollbackFailed":
        return `Switching setup "${this.instanceId}" failed and its login files could not be restored. Log in again with \`claude auth login\` for this setup.`;
      case "externalClaudePrograms":
        return `Claude programs started outside T3 are using setup "${this.instanceId}". Close them, then switch again.`;
      case "processCheckFailed":
        return `Could not check whether Claude programs outside T3 are using setup "${this.instanceId}". Try again.`;
    }
  }
}

export const RememberedClaudeAccount = Schema.Struct({ name: Schema.String, email: Schema.String });
export type RememberedClaudeAccount = typeof RememberedClaudeAccount.Type;

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

  const switchAccount = Effect.fn("ClaudeAccounts.switch")(function* (input: {
    readonly instanceId: ProviderInstanceId;
    readonly name: string;
  }) {
    return yield* accountsLock.withPermits(1)(
      Effect.gen(function* () {
        const plan = yield* checkSwitch(input);
        return plan._tag === "AlreadyActive" ? plan.result : yield* applySwitch(plan);
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
> = Layer.effect(ClaudeAccounts, make);
