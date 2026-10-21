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
import { resolveClaudeSetupPaths, type ClaudeSetupPaths } from "./Drivers/ClaudeHome.ts";
import {
  claudeAccountIdentity,
  readClaudeSetupLogin,
  sameClaudeAccount,
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

export class ClaudeAccounts extends Context.Service<
  ClaudeAccounts,
  {
    readonly remember: (input: {
      readonly instanceId: ProviderInstanceId;
      readonly name: string;
    }) => Effect.Effect<RememberedClaudeAccount, ClaudeAccountError>;
    readonly list: Effect.Effect<ClaudeAccountList, ClaudeAccountError>;
    readonly forget: (input: { readonly name: string }) => Effect.Effect<void, ClaudeAccountError>;
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
  const settings = yield* ServerSettingsService;
  const accountsLock = yield* Semaphore.make(1);

  const requireLinux = Effect.fn("ClaudeAccounts.requireLinux")(function* () {
    if ((yield* HostProcess.Platform) !== "linux") {
      return yield* new ClaudeAccountError({ reason: "unavailable" });
    }
  });

  const readLogin = (paths: ClaudeSetupPaths) =>
    readClaudeSetupLogin(paths).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));

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
    return { instanceId, displayName: entry.displayName ?? null, paths } satisfies ClaudeSetup;
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

  return ClaudeAccounts.of({ remember, list: list(), forget });
});

export const layer: Layer.Layer<
  ClaudeAccounts,
  never,
  ServerSecretStore.ServerSecretStore | ServerSettingsService | FileSystem.FileSystem | Path.Path
> = Layer.effect(ClaudeAccounts, make);
