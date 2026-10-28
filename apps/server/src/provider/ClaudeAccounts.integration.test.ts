import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  type RunId,
  ThreadId,
  WS_METHODS,
  WsClaudeAccountsForgetRpc,
  WsClaudeAccountsListRpc,
  WsClaudeAccountsRememberRpc,
  WsClaudeAccountsSwitchRpc,
  type ClaudeAccountForgetInput,
  type ClaudeAccountList,
  type ClaudeAccountListInput,
  type ClaudeAccountRememberInput,
  type ClaudeAccountSwitchInput,
  type ClaudeSwitchResult,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { Headers } from "effect/http";
import { RpcGroup, RpcMessage, RpcServer } from "effect/rpc";
import * as NodeUtil from "node:util";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as ClaudeAccountsModule from "./ClaudeAccounts.ts";
import { claudeAccountsRpcHandlers } from "./ClaudeAccountsRpc.ts";
import * as ClaudeExternalProcesses from "./ClaudeExternalProcesses.ts";
import { ClaudeLoginCheck, type ClaudeLoginCheckResult } from "./ClaudeLoginCheck.ts";
import type { JsonObject } from "./claudeLoginFiles.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

const { ClaudeAccountError, ClaudeAccounts } = ClaudeAccountsModule;

const UNAVAILABLE_MESSAGE = "Switching Claude accounts is only supported when T3 runs on Linux.";
const STORAGE_NAME = "claude-accounts";
const SERVER_PID = 4242;

const id = (value: string) => ProviderInstanceId.make(value);

interface Login {
  readonly email: string;
  readonly accountUuid: string;
  readonly organizationUuid?: string;
}
type SetupState = Login | "loggedOut" | "noOauth" | "corrupt";
interface SetupSpec {
  readonly id: string;
  readonly state: SetupState;
  readonly displayName?: string;
  /** Declares the same config dir as another setup of the spec, which must come first. */
  readonly sharesDirWith?: string;
}
interface HarnessSpec {
  readonly setups: ReadonlyArray<SetupSpec>;
  readonly platform?: NodeJS.Platform;
  readonly withCodexInstance?: boolean;
  /** Fails `rename` onto `.claude.json`; "rollbackToo" also fails the second rename onto `.credentials.json`. */
  readonly renameFault?: "claudeJson" | "rollbackToo";
  /** Points the process scan at a path that does not exist. */
  readonly missingProcRoot?: boolean;
}

const alice: Login = {
  email: "alice@example.com",
  accountUuid: "uuid-alice",
  organizationUuid: "org-alice",
};
const bob: Login = {
  email: "bob@example.com",
  accountUuid: "uuid-bob",
  organizationUuid: "org-bob",
};
const carol: Login = {
  email: "carol@example.com",
  accountUuid: "uuid-carol",
  organizationUuid: "org-carol",
};

const one = (state: SetupState): HarnessSpec => ({ setups: [{ id: "claudeAgent", state }] });
const two = (first: SetupState, second: SetupState): HarnessSpec => ({
  setups: [
    { id: "claudeAgent", state: first },
    { id: "claudeWork2", state: second },
  ],
});

const decodeStored = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.Literal(1),
      accounts: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          oauthAccount: Schema.Record(Schema.String, Schema.Unknown),
          claudeAiOauth: Schema.Record(Schema.String, Schema.Unknown),
        }),
      ),
    }),
  ),
);

const randomToken = Effect.fn("test.randomToken")(function* (label: string) {
  const crypto = yield* Crypto.Crypto;
  return `${label}-${yield* crypto.randomUUIDv4()}`;
});

const FIXED_SETTINGS = '{"theme":"dark"}\n';
const FIXED_SESSION = '{"role":"user","text":"hello"}\n';

// Writes the two login files of a setup the way the Claude CLI leaves them.
const writeLoginFiles = Effect.fn("test.writeLoginFiles")(function* (dir: string, login: Login) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const accessToken = yield* randomToken("access");
  const refreshToken = yield* randomToken("refresh");
  const mcpToken = yield* randomToken("mcp");
  const credentialsPath = path.join(dir, ".credentials.json");
  const accountPath = path.join(dir, ".claude.json");
  yield* fileSystem.writeFileString(
    credentialsPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken,
        refreshToken,
        expiresAt: 1_900_000_000_000,
        scopes: ["user:inference"],
      },
      mcpOAuth: { srv: { accessToken: mcpToken } },
    }),
  );
  yield* fileSystem.chmod(credentialsPath, 0o600);
  yield* fileSystem.writeFileString(
    accountPath,
    JSON.stringify({
      numStartups: 3,
      oauthAccount: {
        emailAddress: login.email,
        accountUuid: login.accountUuid,
        ...(login.organizationUuid === undefined
          ? {}
          : { organizationUuid: login.organizationUuid }),
      },
      projects: { "/x": { history: [] } },
    }),
  );
  yield* fileSystem.chmod(accountPath, 0o644);
  return [accessToken, refreshToken, mcpToken];
});

const writeSetup = Effect.fn("test.writeSetup")(function* (state: SetupState) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-setup-test-" });
  const tokens: Array<string> = [];
  if (state === "loggedOut") return { dir, tokens };
  const credentialsPath = path.join(dir, ".credentials.json");
  if (state === "corrupt") {
    const accessToken = yield* randomToken("access");
    tokens.push(accessToken);
    yield* fileSystem.writeFileString(
      credentialsPath,
      `{"claudeAiOauth":{"accessToken":"${accessToken}"`,
    );
    return { dir, tokens };
  }
  if (state === "noOauth") {
    yield* fileSystem.writeFileString(credentialsPath, JSON.stringify({ mcpOAuth: { x: 1 } }));
    return { dir, tokens };
  }
  tokens.push(...(yield* writeLoginFiles(dir, state)));
  yield* fileSystem.writeFileString(path.join(dir, "settings.json"), FIXED_SETTINGS);
  yield* fileSystem.makeDirectory(path.join(dir, "projects", "x"), { recursive: true });
  yield* fileSystem.writeFileString(
    path.join(dir, "projects", "x", "session.jsonl"),
    FIXED_SESSION,
  );
  return { dir, tokens };
});

type CheckInput = Parameters<Context.Service.Shape<typeof ClaudeLoginCheck>["check"]>[0];

// Fails the renames the spec names; every other rename, such as the secret store's, passes through.
const renameFaultFileSystem = (mode: "claudeJson" | "rollbackToo") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    let credentialsRenames = 0;
    return FileSystem.make({
      ...fs,
      rename: (from, to) => {
        if (path.basename(to) === ".credentials.json") credentialsRenames += 1;
        const failing =
          path.basename(to) === ".claude.json" ||
          (mode === "rollbackToo" &&
            path.basename(to) === ".credentials.json" &&
            credentialsRenames > 1);
        return failing
          ? Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "rename",
                pathOrDescriptor: to,
                description: "denied",
              }),
            )
          : fs.rename(from, to);
      },
    });
  });

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

interface OpenedSession {
  readonly instanceId: string;
  readonly threadId: string;
  /** The native thread id the session was asked to resume, if any. */
  readonly resume: string | null;
}

// Stands in for the Claude CLI behind every instance of the test driver.
interface FakeClaude {
  readonly opens: Array<OpenedSession>;
  readonly interrupts: Array<{ readonly instanceId: string; readonly threadId: string }>;
  /** Holds the next turn started on a thread until the Deferred completes. */
  readonly holds: Map<string, Deferred.Deferred<void>>;
  readonly started: (threadId: string) => Deferred.Deferred<void>;
  readonly interruptSeen: (threadId: string) => Deferred.Deferred<void>;
  readonly ignoreInterrupts: Set<string>;
  onInterrupt: (threadId: string) => Effect.Effect<void>;
}

const makeFakeClaude = (): FakeClaude => {
  const once = () => {
    const deferreds = new Map<string, Deferred.Deferred<void>>();
    return (threadId: string) => {
      const existing = deferreds.get(threadId);
      if (existing !== undefined) return existing;
      const created = Deferred.makeUnsafe<void>();
      deferreds.set(threadId, created);
      return created;
    };
  };
  return {
    opens: [],
    interrupts: [],
    holds: new Map(),
    started: once(),
    interruptSeen: once(),
    ignoreInterrupts: new Set(),
    onInterrupt: () => Effect.void,
  };
};

const nativeThreadId = (threadId: string) => `claude-native:${threadId}`;

const makeFakeAdapter = (
  instanceId: ProviderInstanceId,
  fake: FakeClaude,
  scope: Scope.Scope,
): ProviderAdapter.ProviderAdapterV2["Service"] => ({
  instanceId,
  driver: CLAUDE_DRIVER,
  getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: (input) =>
    Effect.gen(function* () {
      fake.opens.push({
        instanceId,
        threadId: input.threadId,
        resume: input.initialNativeThreadId ?? null,
      });
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const now = yield* DateTime.now;
      const running = new Map<
        string,
        { readonly turn: ProviderAdapter.ProviderAdapterV2TurnInput; settled: boolean }
      >();
      const providerTurn = (
        turn: ProviderAdapter.ProviderAdapterV2TurnInput,
        status: "running" | "completed" | "interrupted",
        at: DateTime.Utc,
      ): ProviderAdapter.ProviderAdapterV2Event => ({
        type: "provider_turn.updated",
        driver: CLAUDE_DRIVER,
        providerTurn: {
          id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
          providerThreadId: turn.providerThread.id,
          nodeId: turn.rootNodeId,
          runAttemptId: turn.attemptId,
          nativeTurnRef: {
            driver: CLAUDE_DRIVER,
            nativeId: `native-turn:${turn.attemptId}`,
            strength: "strong",
          },
          ordinal: turn.providerTurnOrdinal,
          status,
          startedAt: at,
          completedAt: status === "running" ? null : at,
        },
      });
      const settle = (
        entry: { readonly turn: ProviderAdapter.ProviderAdapterV2TurnInput; settled: boolean },
        status: "completed" | "interrupted",
      ) =>
        Effect.gen(function* () {
          if (entry.settled) return;
          entry.settled = true;
          const at = yield* DateTime.now;
          yield* Queue.offerAll(events, [
            providerTurn(entry.turn, status, at),
            {
              type: "turn.terminal",
              driver: CLAUDE_DRIVER,
              providerThreadId: entry.turn.providerThread.id,
              providerTurnId: ProviderTurnId.make(`provider-turn:${entry.turn.attemptId}`),
              runOrdinal: entry.turn.runOrdinal,
              status,
              failure: null,
              threadDisposition: "reusable",
            },
          ]);
        });
      return {
        instanceId,
        driver: CLAUDE_DRIVER,
        providerSessionId: input.providerSessionId,
        providerSession: {
          id: input.providerSessionId,
          driver: CLAUDE_DRIVER,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: input.runtimePolicy.cwd ?? process.cwd(),
          model: input.modelSelection.model,
          capabilities: ClaudeProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
        events: Stream.fromQueue(events),
        ensureThread: ({ threadId }) =>
          Effect.succeed({
            id: ProviderThreadId.make(`provider-thread:claude:${threadId}`),
            driver: CLAUDE_DRIVER,
            providerInstanceId: instanceId,
            providerSessionId: input.providerSessionId,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: {
              driver: CLAUDE_DRIVER,
              nativeId: nativeThreadId(threadId),
              strength: "strong",
            },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          }),
        resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
        startTurn: (turn) =>
          Effect.gen(function* () {
            yield* Queue.offer(events, providerTurn(turn, "running", yield* DateTime.now));
            const entry = { turn, settled: false };
            const release = fake.holds.get(turn.threadId);
            if (release === undefined) {
              yield* settle(entry, "completed");
            } else {
              fake.holds.delete(turn.threadId);
              running.set(turn.threadId, entry);
              yield* Deferred.await(release).pipe(
                Effect.andThen(settle(entry, "completed")),
                Effect.forkIn(scope),
              );
            }
            yield* Deferred.succeed(fake.started(turn.threadId), undefined);
          }),
        steerTurn: () => Effect.die("unused"),
        interruptTurn: (interrupt) =>
          Effect.gen(function* () {
            const threadId = interrupt.providerThread.appThreadId ?? "";
            fake.interrupts.push({ instanceId, threadId });
            yield* Deferred.succeed(fake.interruptSeen(threadId), undefined);
            yield* fake.onInterrupt(threadId);
            if (fake.ignoreInterrupts.has(threadId)) return;
            const entry = running.get(threadId);
            if (entry !== undefined) yield* settle(entry, "interrupted");
          }),
        respondToRuntimeRequest: () => Effect.die("unused"),
        readThreadSnapshot: () => Effect.die("unused"),
        rollbackThread: () => Effect.die("unused"),
        forkThread: () => Effect.die("unused"),
      } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
    }),
});

// A hand-written claudeAgent driver: the provider CLI boundary, nothing else.
const testClaudeDriver = (fake: FakeClaude, scope: Scope.Scope): ProviderDriver<unknown> => ({
  driverKind: CLAUDE_DRIVER,
  metadata: { displayName: "Claude (test)" },
  configSchema: Schema.Unknown,
  defaultConfig: () => ({}),
  create: (input) =>
    Effect.succeed({
      instanceId: input.instanceId,
      driverKind: CLAUDE_DRIVER,
      continuationIdentity: defaultProviderContinuationIdentity({
        driverKind: CLAUDE_DRIVER,
        instanceId: input.instanceId,
      }),
      displayName: input.displayName,
      enabled: input.enabled,
      snapshot: {} as ProviderInstance["snapshot"],
      orchestrationAdapter: makeFakeAdapter(input.instanceId, fake, scope),
      textGeneration: {} as ProviderInstance["textGeneration"],
    } satisfies ProviderInstance),
});

// A fresh stack per call: memory SQLite, registry, orchestration and the account service.
const makeAccountsTestLayer = (options: {
  readonly providerInstances: Record<string, ProviderInstanceConfig>;
  readonly procRoot: string;
  readonly checkLayer: Layer.Layer<ClaudeLoginCheck>;
  readonly fileSystem: FileSystem.FileSystem;
  readonly fake: FakeClaude;
  readonly scope: Scope.Scope;
}) => {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerSettings = ServerSettingsService.layerTest({
    providerInstances: options.providerInstances,
  });
  const layerInstances = Layer.unwrap(
    Effect.gen(function* () {
      const current = yield* (yield* ServerSettingsService).getSettings.pipe(Effect.orDie);
      return ProviderInstanceRegistry.layer({
        drivers: [testClaudeDriver(options.fake, options.scope)],
        configMap: deriveProviderInstanceConfigMap(current),
      });
    }),
  ).pipe(Layer.provide(layerSettings));
  const layerOrchestration = ThreadManagementService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerDatabase,
        ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
        EventStore.layer.pipe(Layer.provide(layerDatabase)),
        EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
        ProviderReplayHarness.layerWithRegistry(
          { name: "claude-accounts" },
          ProviderAdapterRegistry.layerFromProviderInstanceRegistry.pipe(
            Layer.provide(layerInstances),
          ),
          { databaseLayer: layerDatabase, runEffectWorker: true, stopDelegatedTasks: true },
        ),
      ),
    ),
    Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  );
  return ClaudeAccountsModule.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ServerSecretStore.layer,
        options.checkLayer,
        ClaudeExternalProcesses.layerWith({ procRoot: options.procRoot }),
        layerOrchestration,
      ).pipe(
        Layer.provideMerge(layerSettings),
        Layer.provideMerge(
          ServerConfig.ServerConfig.layerTest(process.cwd(), {
            prefix: "t3-claude-accounts-test-",
          }),
        ),
      ),
    ),
    Layer.provide(Layer.succeed(FileSystem.FileSystem, options.fileSystem)),
  );
};

const buildHarness = Effect.fn("test.buildHarness")(function* (spec: HarnessSpec) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const setups: Record<string, { readonly dir: string }> = {};
  const tokens: Array<string> = [];
  const providerInstances: Record<string, ProviderInstanceConfig> = {};
  for (const setup of spec.setups) {
    const written =
      setup.sharesDirWith === undefined
        ? yield* writeSetup(setup.state)
        : { dir: setups[setup.sharesDirWith]!.dir, tokens: [] };
    setups[setup.id] = { dir: written.dir };
    tokens.push(...written.tokens);
    providerInstances[setup.id] = {
      driver: ProviderDriverKind.make("claudeAgent"),
      ...(setup.displayName === undefined ? {} : { displayName: setup.displayName }),
      config: { homePath: written.dir },
    };
  }
  if (spec.withCodexInstance)
    providerInstances.codex = { driver: ProviderDriverKind.make("codex") };

  const check = {
    calls: [] as Array<CheckInput>,
    respond: ((input) =>
      Effect.succeed({
        verdict: "Valid",
        latestClaudeAiOauth: Option.some(input.claudeAiOauth),
      })) as (input: CheckInput, call: number) => Effect.Effect<ClaudeLoginCheckResult>,
  };
  const checkLayer = Layer.succeed(
    ClaudeLoginCheck,
    ClaudeLoginCheck.of({
      check: (input) => {
        check.calls.push(input);
        return check.respond(input, check.calls.length);
      },
    }),
  );
  // An empty fake /proc unless a test adds a process to it.
  const procDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-fake-proc-" });
  const procRoot = spec.missingProcRoot ? path.join(procDir, "missing") : procDir;
  const serviceFileSystem =
    spec.renameFault === undefined ? fileSystem : yield* renameFaultFileSystem(spec.renameFault);

  const fake = makeFakeClaude();
  const scope = yield* Effect.scope;
  const context = yield* Layer.build(
    Layer.fresh(
      makeAccountsTestLayer({
        providerInstances,
        procRoot,
        checkLayer,
        fileSystem: serviceFileSystem,
        fake,
        scope,
      }),
    ),
  );
  const config = Context.get(context, ServerConfig.ServerConfig);
  const secrets = Context.get(context, ServerSecretStore.ServerSecretStore);
  return {
    accounts: Context.get(context, ClaudeAccounts),
    threads: Context.get(context, ThreadManagementService.ThreadManagementService),
    orchestrator: Context.get(context, Orchestrator.OrchestratorV2),
    providerSessions: Context.get(context, ProviderSessionManager.ProviderSessionManagerV2),
    sql: Context.get(context, SqlClient.SqlClient),
    fake,
    procDir,
    secrets,
    baseDir: config.baseDir,
    secretsDir: config.secretsDir,
    setups,
    tokens,
    check,
    readSetupFiles: (instance: string) =>
      Effect.all([
        fileSystem.readFile(path.join(setups[instance]!.dir, ".credentials.json")),
        fileSystem.readFile(path.join(setups[instance]!.dir, ".claude.json")),
      ]),
    /** Every file the setup holds, as bytes. */
    readEverything: (instance: string) =>
      Effect.all({
        credentials: fileSystem.readFile(path.join(setups[instance]!.dir, ".credentials.json")),
        account: fileSystem.readFile(path.join(setups[instance]!.dir, ".claude.json")),
        settings: fileSystem.readFile(path.join(setups[instance]!.dir, "settings.json")),
        session: fileSystem.readFile(
          path.join(setups[instance]!.dir, "projects", "x", "session.jsonl"),
        ),
      }),
    readJson: (instance: string, file: ".credentials.json" | ".claude.json") =>
      fileSystem
        .readFileString(path.join(setups[instance]!.dir, file))
        .pipe(Effect.map((text) => JSON.parse(text) as Record<string, JsonObject>)),
    /** Stands in for the CLI renewing the access token on a setup. */
    renewCredentials: Effect.fn("test.renewCredentials")(function* (
      instance: string,
      claudeAiOauth: JsonObject,
    ) {
      const file = path.join(setups[instance]!.dir, ".credentials.json");
      const parsed = JSON.parse(yield* fileSystem.readFileString(file));
      yield* fileSystem.writeFileString(file, JSON.stringify({ ...parsed, claudeAiOauth }));
    }),
    logInAs: Effect.fn("test.logInAs")(function* (instance: string, login: Login) {
      tokens.push(
        ...(yield* writeLoginFiles(setups[instance]!.dir, login).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.provideService(Crypto.Crypto, crypto),
        )),
      );
    }),
    newOauth: Effect.fn("test.newOauth")(function* (label: string) {
      const accessToken = `${label}-access-${yield* crypto.randomUUIDv4()}`;
      const refreshToken = `${label}-refresh-${yield* crypto.randomUUIDv4()}`;
      tokens.push(accessToken, refreshToken);
      return {
        accessToken,
        refreshToken,
        expiresAt: 1_950_000_000_000,
        scopes: ["user:inference"],
      } satisfies JsonObject;
    }),
    storedAccounts: Effect.fn("test.storedAccounts")(function* () {
      const stored = yield* secrets.get(STORAGE_NAME);
      if (Option.isNone(stored)) return [];
      return decodeStored(new TextDecoder().decode(stored.value)).accounts;
    }),
    storedBytes: secrets.get(STORAGE_NAME),
    /** Stands in for a Claude program running on a config dir, in the fake /proc. */
    addClaudeProcess: Effect.fn("test.addClaudeProcess")(function* (
      pid: number,
      configDir: string,
      extraEnviron: ReadonlyArray<string> = [],
    ) {
      const pidDir = path.join(procDir, String(pid));
      yield* fileSystem.makeDirectory(pidDir);
      yield* fileSystem.writeFileString(path.join(pidDir, "cmdline"), "claude\0");
      yield* fileSystem.writeFileString(
        path.join(pidDir, "environ"),
        [`CLAUDE_CONFIG_DIR=${configDir}`, ...extraEnviron].map((entry) => `${entry}\0`).join(""),
      );
    }),
  };
});
type Harness = Effect.Success<ReturnType<typeof buildHarness>>;

// Every dependency on the host OS is pinned: nothing can fall back to a real `~/.claude`.
const run = <A, E>(
  spec: HarnessSpec,
  body: (
    harness: Harness,
  ) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope | Crypto.Crypto>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-home-test-" });
    return yield* buildHarness(spec).pipe(
      Effect.flatMap(body),
      Effect.provideService(HostProcess.Platform, spec.platform ?? "linux"),
      Effect.provideService(HostProcess.HomeDirectory, home),
      Effect.provideService(HostProcess.Environment, {}),
      Effect.provideService(HostProcess.ProcessId, SERVER_PID),
    );
  }).pipe(Effect.scoped);

const assertNoLogin = (harness: Harness, text: string) => {
  for (const token of harness.tokens) assert.notInclude(text, token);
};

const refusal = Effect.fn("test.refusal")(function* (
  harness: Harness,
  effect: Effect.Effect<unknown, ClaudeAccountsModule.ClaudeAccountError>,
  reason: ClaudeAccountsModule.ClaudeAccountErrorReason,
) {
  const error = yield* effect.pipe(
    Effect.match({ onSuccess: () => undefined, onFailure: (failure) => failure }),
  );
  assert.instanceOf(error, ClaudeAccountError);
  assert.strictEqual(error.reason, reason);
  assertNoLogin(harness, JSON.stringify(error));
  assertNoLogin(harness, error.message);
  return error;
});

const work = (harness: Harness, instanceId = "claudeAgent", name = "Work") =>
  harness.accounts.remember({ instanceId: id(instanceId), name });

const MODEL = "claude-sonnet-4-6";
const PROJECT_A = ProjectId.make("project:claude-accounts-a");
const PROJECT_B = ProjectId.make("project:claude-accounts-b");
// A guard for a broken test, not a condition any test passes on.
const WAIT_MS = 60_000;

interface TestThread {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
}

const createThread = Effect.fn("test.createThread")(function* (
  h: Harness,
  name: string,
  instanceId = "claudeAgent",
  projectId = PROJECT_A,
) {
  const threadId = ThreadId.make(`thread:${name}`);
  yield* h.threads.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${name}`),
    threadId,
    projectId,
    title: name,
    modelSelection: { instanceId: id(instanceId), model: MODEL },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  return { projectId, threadId } satisfies TestThread;
});

const send = (h: Harness, thread: TestThread, text: string, mode: "auto" | "queue" = "auto") =>
  h.threads
    .sendToThread({
      projectId: thread.projectId,
      commandId: CommandId.make(`send:${thread.threadId}:${text}`),
      threadId: thread.threadId,
      messageId: MessageId.make(`message:${thread.threadId}:${text}`),
      text,
      attachments: [],
      mode,
      createdBy: "user",
      creationSource: "web",
    })
    .pipe(Effect.map((sent) => sent.run));

const waitForRun = Effect.fn("test.waitForRun")(function* (
  h: Harness,
  thread: TestThread,
  runId: RunId,
) {
  const waited = yield* h.threads.waitForThread({ ...thread, runId, timeoutMs: WAIT_MS });
  assert.isFalse(waited.timedOut);
  return waited.run!;
});

/** Sends a message whose turn completes at once, and waits for it. */
const completeTurn = Effect.fn("test.completeTurn")(function* (
  h: Harness,
  thread: TestThread,
  text: string,
) {
  const run = yield* send(h, thread, text);
  const done = yield* waitForRun(h, thread, run.id);
  assert.strictEqual(done.status, "completed");
  return done;
});

/** Holds the thread's next turn until the returned Deferred completes, released at the latest when the test ends. */
const holdNextTurn = Effect.fn("test.holdNextTurn")(function* (h: Harness, thread: TestThread) {
  const release = yield* Deferred.make<void>();
  h.fake.holds.set(thread.threadId, release);
  yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
  return release;
});

/** Starts a turn the fake CLI holds, and waits until the orchestrator sees it running. */
const startHeldTurn = Effect.fn("test.startHeldTurn")(function* (
  h: Harness,
  thread: TestThread,
  text: string,
) {
  const release = yield* holdNextTurn(h, thread);
  const running = yield* h.orchestrator.streamDomainEvents.pipe(
    Stream.filter(
      (event) =>
        event.type === "provider-turn.updated" &&
        event.threadId === thread.threadId &&
        event.payload.status === "running",
    ),
    Stream.take(1),
    Stream.runDrain,
    Effect.forkScoped,
  );
  const run = yield* send(h, thread, text);
  yield* Deferred.await(h.fake.started(thread.threadId));
  yield* Fiber.join(running);
  return { run, release };
});

const records = (h: Harness, thread: TestThread) =>
  h.threads.getThreadRecords(thread.threadId, ["runs", "attempts", "providerSessions"]);

const runStatus = Effect.fn("test.runStatus")(function* (
  h: Harness,
  thread: TestThread,
  runId: RunId,
) {
  return (yield* records(h, thread)).runs.find((run) => run.id === runId)?.status;
});

const sessionStatuses = Effect.fn("test.sessionStatuses")(function* (
  h: Harness,
  thread: TestThread,
) {
  return (yield* records(h, thread)).providerSessions.map((session) => session.status);
});

const interruptsOn = (h: Harness, thread: TestThread) =>
  h.fake.interrupts.filter((entry) => entry.threadId === thread.threadId);

const opensAfter = (h: Harness, mark: number, thread: TestThread) =>
  h.fake.opens.slice(mark).filter((open) => open.threadId === thread.threadId);

it.layer(NodeServices.layer)("ClaudeAccounts", (it) => {
  it.effect("AK-1: remembers the account logged in on a setup under a chosen name", () =>
    run(one(alice), (h) =>
      Effect.gen(function* () {
        assert.deepEqual(yield* work(h), { name: "Work", email: "alice@example.com" });
        assert.deepEqual((yield* h.accounts.list).accounts, [
          { name: "Work", email: "alice@example.com" },
        ]);
      }),
    ),
  );

  it.effect("AK-2: remembers several accounts on one machine, in order", () =>
    run(two(alice, bob), (h) =>
      Effect.gen(function* () {
        yield* work(h);
        yield* work(h, "claudeWork2", "Private");
        assert.deepEqual((yield* h.accounts.list).accounts, [
          { name: "Work", email: "alice@example.com" },
          { name: "Private", email: "bob@example.com" },
        ]);
      }),
    ),
  );

  it.effect("AK-2: concurrent remembers do not lose an update", () =>
    run(two(alice, bob), (h) =>
      Effect.gen(function* () {
        yield* Effect.all([work(h), work(h, "claudeWork2", "Private")], {
          concurrency: "unbounded",
        });
        const names = (yield* h.accounts.list).accounts.map((account) => account.name);
        assert.sameMembers(names, ["Work", "Private"]);
      }),
    ),
  );

  it.effect("AK-3: refuses to remember when no account is logged in", () =>
    run(two("loggedOut", "noOauth"), (h) =>
      Effect.gen(function* () {
        yield* refusal(h, work(h), "notLoggedIn");
        yield* refusal(h, work(h, "claudeWork2"), "notLoggedIn");
        assert.deepEqual((yield* h.accounts.list).accounts, []);
      }),
    ),
  );

  it.effect("AK-4: refuses a name already in use, ignoring case and surrounding spaces", () =>
    run(two(alice, bob), (h) =>
      Effect.gen(function* () {
        yield* work(h);
        yield* refusal(h, work(h, "claudeWork2"), "nameInUse");
        const error = yield* refusal(h, work(h, "claudeWork2", " work "), "nameInUse");
        assert.strictEqual(error.message, 'The name "work" is already in use.');
        assert.deepEqual((yield* h.accounts.list).accounts, [
          { name: "Work", email: "alice@example.com" },
        ]);
      }),
    ),
  );

  it.effect("refuses to remember the same account twice, naming the existing name", () =>
    run(one(alice), (h) =>
      Effect.gen(function* () {
        yield* work(h);
        const error = yield* refusal(h, work(h, "claudeAgent", "Again"), "alreadyRemembered");
        assert.strictEqual(error.name, "Work");
        assert.strictEqual(error.message, 'This account is already remembered as "Work".');
      }),
    ),
  );

  it.effect("AK-5: lists the active account per setup with its remembered name", () =>
    run(
      {
        setups: [
          { id: "claudeAgent", state: alice },
          { id: "claudeWork2", state: bob, displayName: "Second" },
        ],
      },
      (h) =>
        Effect.gen(function* () {
          yield* work(h);
          yield* work(h, "claudeWork2", "Private");
          assert.deepEqual((yield* h.accounts.list).setups, [
            {
              instanceId: id("claudeAgent"),
              displayName: null,
              active: { email: "alice@example.com", rememberedAs: "Work" },
            },
            {
              instanceId: id("claudeWork2"),
              displayName: "Second",
              active: { email: "bob@example.com", rememberedAs: "Private" },
            },
          ]);
        }),
    ),
  );

  it.effect("AK-6: lists an active account that is not remembered", () =>
    run(one(carol), (h) =>
      Effect.gen(function* () {
        const setups = (yield* h.accounts.list).setups;
        assert.deepEqual(setups[0]?.active, { email: "carol@example.com", rememberedAs: null });
      }),
    ),
  );

  it.effect("AK-7: lists nothing remembered and every Claude setup, not other drivers", () =>
    run({ ...two(alice, "loggedOut"), withCodexInstance: true }, (h) =>
      Effect.gen(function* () {
        const list = yield* h.accounts.list;
        assert.deepEqual(list.accounts, []);
        assert.deepEqual(
          list.setups.map((setup) => setup.instanceId),
          [id("claudeAgent"), id("claudeWork2")],
        );
        assert.deepEqual(list.setups[0]?.active, {
          email: "alice@example.com",
          rememberedAs: null,
        });
        assert.strictEqual(list.setups[1]?.active, null);
      }),
    ),
  );

  it.effect("lists a setup with a corrupt login as inactive without hiding the others", () =>
    run(two("corrupt", alice), (h) =>
      Effect.gen(function* () {
        const setups = (yield* h.accounts.list).setups;
        assert.strictEqual(setups[0]?.active, null);
        assert.strictEqual(setups[1]?.active?.email, "alice@example.com");
      }),
    ),
  );

  it.effect("AK-8: forgets an account that is not active", () =>
    run(two(alice, bob), (h) =>
      Effect.gen(function* () {
        yield* work(h);
        yield* work(h, "claudeWork2", "Private");
        yield* h.accounts.forget({ name: "Private" });
        assert.deepEqual((yield* h.accounts.list).accounts, [
          { name: "Work", email: "alice@example.com" },
        ]);
      }),
    ),
  );

  it.effect("AK-9: forgetting the active account leaves the setup's login files untouched", () =>
    run(one(alice), (h) =>
      Effect.gen(function* () {
        yield* work(h);
        const before = yield* h.readSetupFiles("claudeAgent");
        yield* h.accounts.forget({ name: "Work" });
        const after = yield* h.readSetupFiles("claudeAgent");
        assert.deepEqual(after, before);
        const list = yield* h.accounts.list;
        assert.deepEqual(list.accounts, []);
        assert.deepEqual(list.setups[0]?.active, {
          email: "alice@example.com",
          rememberedAs: null,
        });
      }),
    ),
  );

  it.effect("refuses to forget a name that is not remembered", () =>
    run(one(alice), (h) => refusal(h, h.accounts.forget({ name: "Nope" }), "accountNotFound")),
  );

  it.effect("refuses to remember on an unknown setup or on a setup of another driver", () =>
    run({ ...one(alice), withCodexInstance: true }, (h) =>
      Effect.gen(function* () {
        yield* refusal(h, work(h, "missing"), "setupNotFound");
        const error = yield* refusal(h, work(h, "codex"), "setupNotFound");
        assert.strictEqual(error.message, "This Claude setup no longer exists.");
      }),
    ),
  );

  it.effect("refuses invalid names", () =>
    run(one(alice), (h) =>
      Effect.gen(function* () {
        for (const name of ["", "   ", "x".repeat(65), "Work\nAdmin"]) {
          yield* refusal(h, work(h, "claudeAgent", name), "invalidName");
        }
        assert.deepEqual((yield* h.accounts.list).accounts, []);
      }),
    ),
  );

  it.effect("fails every action with reason storage when the stored value does not decode", () =>
    run(one(alice), (h) =>
      Effect.gen(function* () {
        yield* h.secrets.set(
          STORAGE_NAME,
          new TextEncoder().encode('{"version":1,"accounts":"seeded-bytes-ZZ"}'),
        );
        const errors = [
          yield* refusal(h, h.accounts.list, "storage"),
          yield* refusal(h, work(h), "storage"),
          yield* refusal(h, h.accounts.forget({ name: "Work" }), "storage"),
        ];
        for (const error of errors) assert.notInclude(JSON.stringify(error), "seeded-bytes-ZZ");
      }),
    ),
  );

  it.effect("AK-23: keeps the remembered login only in the protected secret", () =>
    run(one(alice), (h) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* work(h);
        const stored = yield* h.secrets.get(STORAGE_NAME);
        assert.isTrue(Option.isSome(stored));
        const holders: Array<string> = [];
        for (const entry of yield* fileSystem.readDirectory(h.baseDir, { recursive: true })) {
          const file = path.join(h.baseDir, entry);
          if ((yield* fileSystem.stat(file)).type !== "File") continue;
          const text = new TextDecoder().decode(yield* fileSystem.readFile(file));
          if (h.tokens.some((token) => text.includes(token))) holders.push(path.basename(file));
        }
        assert.deepEqual(holders, [`${STORAGE_NAME}.bin`]);
      }),
    ),
  );

  it.effect("AK-24: the list never reveals a login", () =>
    run(two(alice, bob), (h) =>
      Effect.gen(function* () {
        yield* work(h);
        yield* work(h, "claudeWork2", "Private");
        const list = yield* h.accounts.list;
        const text = JSON.stringify(list);
        assertNoLogin(h, text);
        for (const forbidden of ["accessToken", "refreshToken", "claudeAiOauth"]) {
          assert.notInclude(text, forbidden);
        }
        for (const account of list.accounts) {
          assert.deepEqual(Object.keys(account).sort(), ["email", "name"]);
        }
      }),
    ),
  );

  it.effect("logs one info line per remember and forget and never a login", () => {
    const lines: Array<{ readonly level: string; readonly message: unknown }> = [];
    const capture = Logger.layer([
      Logger.make(({ logLevel, message }) => {
        lines.push({ level: logLevel, message });
      }),
    ]);
    return run(one(alice), (h) =>
      Effect.gen(function* () {
        yield* work(h);
        yield* h.accounts.list;
        yield* h.accounts.forget({ name: "Work" });
        yield* h.secrets.set(STORAGE_NAME, new TextEncoder().encode("not json"));
        yield* Effect.ignore(h.accounts.list);
        yield* Effect.ignore(h.accounts.forget({ name: "Work" }));
        assertNoLogin(h, NodeUtil.inspect(lines, { depth: 8 }));
        const operations = lines.flatMap(({ level, message }) => {
          const annotation = (message as ReadonlyArray<unknown>)[1];
          return (annotation as Record<string, unknown> | undefined)?.operation
            ? [{ level, annotation }]
            : [];
        });
        assert.deepEqual(operations, [
          {
            level: "Info",
            annotation: { operation: "remember", name: "Work", instanceId: "claudeAgent" },
          },
          { level: "Info", annotation: { operation: "forget", name: "Work" } },
        ]);
      }),
    ).pipe(Effect.provide(capture));
  });

  const OTHER_SYSTEMS = ["darwin", "win32"] as const;

  it.effect.each(OTHER_SYSTEMS)("AK-27: remembering is unavailable on %s", (platform) =>
    run({ ...one(alice), platform }, (h) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const error = yield* refusal(h, work(h), "unavailable");
        assert.strictEqual(error.message, UNAVAILABLE_MESSAGE);
        assert.isFalse(yield* fileSystem.exists(path.join(h.secretsDir, `${STORAGE_NAME}.bin`)));
      }),
    ),
  );

  it.effect.each(OTHER_SYSTEMS)("AK-28: listing is unavailable on %s", (platform) =>
    run({ ...one(alice), platform }, (h) =>
      Effect.gen(function* () {
        const error = yield* refusal(h, h.accounts.list, "unavailable");
        assert.strictEqual(error.message, UNAVAILABLE_MESSAGE);
      }),
    ),
  );

  it.effect.each(OTHER_SYSTEMS)("AK-29: forgetting is unavailable on %s", (platform) =>
    run({ ...one(alice), platform }, (h) =>
      Effect.gen(function* () {
        const error = yield* refusal(h, h.accounts.forget({ name: "Work" }), "unavailable");
        assert.strictEqual(error.message, UNAVAILABLE_MESSAGE);
      }),
    ),
  );

  const privateAccount = (h: Harness) => work(h, "claudeWork2", "Private");
  const switchTo = (h: Harness, name = "Private", instanceId = "claudeAgent") =>
    h.accounts.switch({ instanceId: id(instanceId), name, stopRunningTurns: true });
  const switchSpec = (extra: Partial<HarnessSpec> = {}): HarnessSpec => ({
    ...two(alice, bob),
    ...extra,
  });
  // Work active on claudeAgent, Private remembered from claudeWork2.
  const rememberBoth = Effect.fn("test.rememberBoth")(function* (h: Harness) {
    yield* work(h);
    yield* privateAccount(h);
  });

  type Line = { readonly level: string; readonly message: ReadonlyArray<unknown> };
  const captureLogs = () => {
    const lines: Array<Line> = [];
    const layer = Logger.layer(
      [
        Logger.make(({ logLevel, message }) => {
          lines.push({ level: logLevel, message: message as ReadonlyArray<unknown> });
        }),
      ],
      { mergeWithExisting: false },
    );
    const switchLines = (level: string) =>
      lines.flatMap((line) => {
        const annotation = line.message[1] as Record<string, unknown> | undefined;
        return line.level === level && annotation?.operation === "switch" ? [annotation] : [];
      });
    return { lines, layer, switchLines };
  };

  it.effect("AK-18: switches only the logged-in account and leaves the rest of the setup", () => {
    const logs = captureLogs();
    return run(switchSpec(), (h) =>
      Effect.gen(function* () {
        yield* rememberBoth(h);
        const p2 = yield* h.newOauth("renewed-private");
        h.check.respond = () =>
          Effect.succeed({ verdict: "Valid", latestClaudeAiOauth: Option.some(Redacted.make(p2)) });
        const before = yield* h.readEverything("claudeAgent");
        const beforeCredentials = yield* h.readJson("claudeAgent", ".credentials.json");
        const beforeAccount = yield* h.readJson("claudeAgent", ".claude.json");
        const privateAccountJson = (yield* h.readJson("claudeWork2", ".claude.json")).oauthAccount;

        const result = yield* switchTo(h);

        assert.deepEqual(result, {
          instanceId: id("claudeAgent"),
          active: { name: "Private", email: "bob@example.com" },
          affectedInstanceIds: [id("claudeAgent")],
        });
        const credentials = yield* h.readJson("claudeAgent", ".credentials.json");
        assert.deepEqual(credentials.claudeAiOauth, p2);
        assert.deepEqual(credentials.mcpOAuth, beforeCredentials.mcpOAuth);
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const info = yield* fileSystem.stat(
          path.join(h.setups.claudeAgent!.dir, ".credentials.json"),
        );
        assert.strictEqual(info.mode & 0o777, 0o600);
        const account = yield* h.readJson("claudeAgent", ".claude.json");
        assert.deepEqual(account.oauthAccount, privateAccountJson);
        assert.deepEqual(
          { ...account, oauthAccount: undefined },
          { ...beforeAccount, oauthAccount: undefined },
        );
        const after = yield* h.readEverything("claudeAgent");
        assert.deepEqual(after.settings, before.settings);
        assert.deepEqual(after.session, before.session);
        assert.deepEqual((yield* h.accounts.list).setups[0]?.active, {
          email: "bob@example.com",
          rememberedAs: "Private",
        });
        const stored = (yield* h.storedAccounts()).find((account) => account.name === "Private");
        assert.deepEqual(stored?.claudeAiOauth, p2);

        const input = h.check.calls[0]!;
        assert.deepEqual(input.oauthAccount, privateAccountJson);
        assert.strictEqual(input.settings.homePath, h.setups.claudeAgent!.dir);
        assert.deepEqual(logs.switchLines("Info"), [
          {
            operation: "switch",
            instanceId: "claudeAgent",
            affectedInstanceIds: ["claudeAgent"],
            interruptedRuns: 0,
          },
          {
            operation: "switch",
            instanceId: "claudeAgent",
            affectedInstanceIds: ["claudeAgent"],
            from: "Work",
            to: "Private",
          },
        ]);
        assertNoLogin(h, NodeUtil.inspect(logs.lines, { depth: 8 }));
      }),
    ).pipe(Effect.provide(logs.layer));
  });

  it.effect("switches every setup on the same config dir together, the requested one first", () =>
    run(
      {
        setups: [
          { id: "claudeAgent", state: alice },
          { id: "claudeShared2", state: "loggedOut", sharesDirWith: "claudeAgent" },
          { id: "claudeOther3", state: carol },
          { id: "claudeBob4", state: bob },
        ],
      },
      (h) =>
        Effect.gen(function* () {
          yield* work(h);
          yield* work(h, "claudeBob4", "Private");
          const otherBefore = yield* h.readEverything("claudeOther3");

          const result = yield* switchTo(h, "Private", "claudeShared2");

          assert.deepEqual(result.affectedInstanceIds, [id("claudeShared2"), id("claudeAgent")]);
          const active = (instance: string) =>
            Effect.map(
              h.accounts.list,
              (list) => list.setups.find((setup) => setup.instanceId === instance)?.active,
            );
          const privateActive = { email: "bob@example.com", rememberedAs: "Private" };
          assert.deepEqual(yield* active("claudeAgent"), privateActive);
          assert.deepEqual(yield* active("claudeShared2"), privateActive);
          assert.deepEqual(yield* active("claudeOther3"), {
            email: "carol@example.com",
            rememberedAs: null,
          });
          assert.deepEqual(yield* h.readEverything("claudeOther3"), otherBefore);
        }),
    ),
  );

  it.effect("AK-16: switching back uses the login the CLI renewed in the meantime", () =>
    run(switchSpec(), (h) =>
      Effect.gen(function* () {
        yield* rememberBoth(h);
        const renewed = yield* h.newOauth("renewed-work");
        yield* h.renewCredentials("claudeAgent", renewed);

        yield* switchTo(h, "Private");
        yield* switchTo(h, "Work");

        const credentials = yield* h.readJson("claudeAgent", ".credentials.json");
        assert.deepEqual(credentials.claudeAiOauth, renewed);
        assert.deepEqual(Redacted.value(h.check.calls[1]!.claudeAiOauth), renewed);
        assert.deepEqual((yield* h.accounts.list).setups[0]?.active, {
          email: "alice@example.com",
          rememberedAs: "Work",
        });
      }),
    ),
  );

  it.effect("AK-17: refuses to switch away from an account that is not remembered", () =>
    run(two(carol, bob), (h) =>
      Effect.gen(function* () {
        yield* work(h, "claudeWork2", "Private");
        const before = yield* h.readEverything("claudeAgent");
        const error = yield* refusal(h, switchTo(h), "currentNotRemembered");
        assert.strictEqual(
          error.message,
          "The account logged in on this Claude setup is not remembered yet. Remember it first, then switch.",
        );
        assert.deepEqual(yield* h.readEverything("claudeAgent"), before);
        assert.strictEqual(h.check.calls.length, 0);
        assert.strictEqual((yield* h.accounts.list).setups[0]?.active?.email, "carol@example.com");
      }),
    ),
  );

  it.effect("AK-19: a switch that fails partway restores the setup and keeps the renewals", () => {
    const logs = captureLogs();
    return run(switchSpec({ renameFault: "claudeJson" }), (h) =>
      Effect.gen(function* () {
        yield* rememberBoth(h);
        const renewedWork = yield* h.newOauth("renewed-work");
        yield* h.renewCredentials("claudeAgent", renewedWork);
        const p2 = yield* h.newOauth("renewed-private");
        h.check.respond = () =>
          Effect.succeed({ verdict: "Valid", latestClaudeAiOauth: Option.some(Redacted.make(p2)) });
        const before = yield* h.readEverything("claudeAgent");

        const error = yield* refusal(h, switchTo(h), "switchFailed");

        assert.strictEqual(
          error.message,
          "Switching this Claude setup failed. It is still logged in as before.",
        );
        assert.deepEqual(yield* h.readEverything("claudeAgent"), before);
        assert.deepEqual((yield* h.accounts.list).setups[0]?.active, {
          email: "alice@example.com",
          rememberedAs: "Work",
        });
        const stored = yield* h.storedAccounts();
        assert.deepEqual(stored.find((a) => a.name === "Work")?.claudeAiOauth, renewedWork);
        assert.deepEqual(stored.find((a) => a.name === "Private")?.claudeAiOauth, p2);
        assert.deepEqual(logs.switchLines("Warn"), [
          {
            operation: "switch",
            outcome: "switchFailed",
            instanceId: "claudeAgent",
            from: "Work",
            to: "Private",
          },
        ]);
        assertNoLogin(h, NodeUtil.inspect(logs.lines, { depth: 8 }));
      }),
    ).pipe(Effect.provide(logs.layer));
  });

  it.effect("a failed switch whose rollback fails too says so and keeps a recovery copy", () => {
    const logs = captureLogs();
    return run(switchSpec({ renameFault: "rollbackToo" }), (h) =>
      Effect.gen(function* () {
        yield* rememberBoth(h);
        const renewedWork = yield* h.newOauth("renewed-work");
        yield* h.renewCredentials("claudeAgent", renewedWork);
        const beforeAccount = (yield* h.readJson("claudeAgent", ".claude.json")).oauthAccount;

        const error = yield* refusal(h, switchTo(h), "switchRollbackFailed");

        assert.strictEqual(
          error.message,
          "Switching this Claude setup failed, and its previous login could not be restored. Log in to Claude again on this setup.",
        );
        const recovery = (yield* h.storedAccounts()).find((a) => a.name === "Work");
        assert.deepEqual(recovery?.claudeAiOauth, renewedWork);
        assert.deepEqual(recovery?.oauthAccount, beforeAccount);
        const errors = logs.lines.filter((line) => line.level === "Error");
        assert.strictEqual(errors.length, 1);
        const annotation = errors[0]!.message[1] as { instanceId: string; path: string };
        assert.strictEqual(annotation.instanceId, "claudeAgent");
        assert.strictEqual(annotation.path, `${h.setups.claudeAgent!.dir}/.claude.json`);
        assertNoLogin(h, NodeUtil.inspect(logs.lines, { depth: 8 }));
      }),
    ).pipe(Effect.provide(logs.layer));
  });

  it.effect(
    "AK-22: refuses an account whose saved login no longer works, keeping the renewal",
    () => {
      const logs = captureLogs();
      return run(switchSpec(), (h) =>
        Effect.gen(function* () {
          yield* rememberBoth(h);
          const p2 = yield* h.newOauth("renewed-private");
          h.check.respond = () =>
            Effect.succeed({
              verdict: "NeedsLogin",
              latestClaudeAiOauth: Option.some(Redacted.make(p2)),
            });
          const before = yield* h.readEverything("claudeAgent");

          const error = yield* refusal(h, switchTo(h), "needsFreshLogin");

          assert.strictEqual(error.name, "Private");
          assert.include(error.message, '"Private"');
          assert.deepEqual(yield* h.readEverything("claudeAgent"), before);
          const stored = (yield* h.storedAccounts()).find((a) => a.name === "Private");
          assert.deepEqual(stored?.claudeAiOauth, p2);
          assertNoLogin(h, NodeUtil.inspect(logs.lines, { depth: 8 }));
        }),
      ).pipe(Effect.provide(logs.layer));
    },
  );

  it.effect("fails with loginCheckFailed when the check cannot tell, changing nothing", () =>
    run(switchSpec(), (h) =>
      Effect.gen(function* () {
        yield* rememberBoth(h);
        h.check.respond = () =>
          Effect.succeed({ verdict: "Unknown", latestClaudeAiOauth: Option.none() });
        const filesBefore = yield* h.readEverything("claudeAgent");
        const storedBefore = yield* h.storedBytes;

        const error = yield* refusal(h, switchTo(h), "loginCheckFailed");

        assert.strictEqual(
          error.message,
          'Could not check the saved login of "Private". Try again.',
        );
        assert.deepEqual(yield* h.readEverything("claudeAgent"), filesBefore);
        assert.deepEqual(yield* h.storedBytes, storedBefore);
      }),
    ),
  );

  it.effect("refuses when the setup changed during the check, touching nothing of it", () =>
    run(switchSpec(), (h) =>
      Effect.gen(function* () {
        yield* rememberBoth(h);
        const p2 = yield* h.newOauth("renewed-private");
        let afterCarol: Effect.Success<ReturnType<Harness["readEverything"]>>;
        h.check.respond = () =>
          Effect.gen(function* () {
            yield* h.logInAs("claudeAgent", carol);
            afterCarol = yield* h.readEverything("claudeAgent");
            return {
              verdict: "Valid",
              latestClaudeAiOauth: Option.some(Redacted.make(p2)),
            } as const;
          }).pipe(Effect.orDie);

        yield* refusal(h, switchTo(h), "switchFailed");

        assert.deepEqual(yield* h.readEverything("claudeAgent"), afterCarol!);
        assert.strictEqual((yield* h.accounts.list).setups[0]?.active?.email, "carol@example.com");
        const stored = (yield* h.storedAccounts()).find((a) => a.name === "Private");
        assert.deepEqual(stored?.claudeAiOauth, p2);
      }),
    ),
  );

  it.effect("switching to the account that is already active writes nothing", () =>
    run(switchSpec(), (h) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* rememberBoth(h);
        const before = yield* h.readEverything("claudeAgent");
        const mtimes = () =>
          Effect.all(
            [".credentials.json", ".claude.json"].map((file) =>
              Effect.map(fileSystem.stat(path.join(h.setups.claudeAgent!.dir, file)), (info) =>
                Option.getOrUndefined(info.mtime)?.getTime(),
              ),
            ),
          );
        const mtimesBefore = yield* mtimes();

        const result = yield* switchTo(h, "Work");

        assert.deepEqual(result, {
          instanceId: id("claudeAgent"),
          active: { name: "Work", email: "alice@example.com" },
          affectedInstanceIds: [id("claudeAgent")],
        });
        assert.deepEqual(yield* h.readEverything("claudeAgent"), before);
        assert.deepEqual(yield* mtimes(), mtimesBefore);
        assert.strictEqual(h.check.calls.length, 0);
      }),
    ),
  );

  it.effect("refuses an unknown account, an unknown setup and a setup without login", () =>
    run(
      {
        setups: [
          { id: "claudeAgent", state: alice },
          { id: "claudeWork2", state: bob },
          { id: "claudeOut", state: "loggedOut" },
        ],
      },
      (h) =>
        Effect.gen(function* () {
          yield* rememberBoth(h);
          const before = yield* h.readEverything("claudeAgent");
          yield* refusal(h, switchTo(h, "Nobody"), "accountNotFound");
          yield* refusal(h, switchTo(h, "Private", "missing"), "setupNotFound");
          yield* refusal(h, switchTo(h, "Private", "claudeOut"), "notLoggedIn");
          assert.deepEqual(yield* h.readEverything("claudeAgent"), before);
          assert.strictEqual(h.check.calls.length, 0);
        }),
    ),
  );

  it.effect("refuses a second switch while one runs", () =>
    run(switchSpec(), (h) =>
      Effect.gen(function* () {
        yield* rememberBoth(h);
        const p2 = yield* h.newOauth("renewed-private");
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        h.check.respond = () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return {
              verdict: "Valid",
              latestClaudeAiOauth: Option.some(Redacted.make(p2)),
            } as const;
          });
        const before = yield* h.readEverything("claudeAgent");

        const first = yield* Effect.forkChild(switchTo(h), { startImmediately: true });
        yield* Deferred.await(entered);
        yield* refusal(h, switchTo(h), "switchInProgress");
        assert.strictEqual(h.check.calls.length, 1);
        assert.deepEqual(yield* h.readEverything("claudeAgent"), before);

        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(first);

        assert.deepEqual(result.active, { name: "Private", email: "bob@example.com" });
        assert.strictEqual(h.check.calls.length, 1);
        const credentials = yield* h.readJson("claudeAgent", ".credentials.json");
        assert.deepEqual(credentials.claudeAiOauth, p2);
      }),
    ),
  );

  const privateLogin = Effect.fn("test.privateLogin")(function* (h: Harness) {
    return {
      claudeAiOauth: (yield* h.readJson("claudeWork2", ".credentials.json")).claudeAiOauth,
      oauthAccount: (yield* h.readJson("claudeWork2", ".claude.json")).oauthAccount,
    };
  });
  const assertSetupHolds = Effect.fn("test.assertSetupHolds")(function* (
    h: Harness,
    instance: string,
    login: { readonly claudeAiOauth: unknown; readonly oauthAccount: unknown },
  ) {
    assert.deepEqual(
      (yield* h.readJson(instance, ".credentials.json")).claudeAiOauth,
      login.claudeAiOauth,
    );
    assert.deepEqual(
      (yield* h.readJson(instance, ".claude.json")).oauthAccount,
      login.oauthAccount,
    );
  });
  const PRIVATE_ACTIVE = { email: "bob@example.com", rememberedAs: "Private" };
  const activeOn = (h: Harness, instance: string) =>
    Effect.map(
      h.accounts.list,
      (list) => list.setups.find((setup) => setup.instanceId === instance)?.active,
    );

  it.effect(
    "AK-10, AK-26: after a switch, every thread on the setup works with the new account",
    () =>
      run(switchSpec(), (h) =>
        Effect.gen(function* () {
          yield* rememberBoth(h);
          const first = yield* createThread(h, "ak10-a", "claudeAgent", PROJECT_A);
          const second = yield* createThread(h, "ak10-b", "claudeAgent", PROJECT_B);
          yield* completeTurn(h, first, "hello");
          yield* completeTurn(h, second, "hello");
          const login = yield* privateLogin(h);

          // Requested from the service itself: no WebSocket, HTTP or client layer is in this test.
          const result = yield* switchTo(h);
          const mark = h.fake.opens.length;

          assert.deepEqual(result, {
            instanceId: id("claudeAgent"),
            active: { name: "Private", email: "bob@example.com" },
            affectedInstanceIds: [id("claudeAgent")],
          });
          for (const thread of [first, second]) {
            assert.deepEqual(yield* sessionStatuses(h, thread), ["stopped"]);
          }
          assert.deepEqual(yield* activeOn(h, "claudeAgent"), PRIVATE_ACTIVE);
          yield* assertSetupHolds(h, "claudeAgent", login);
          for (const thread of [first, second]) {
            yield* completeTurn(h, thread, "after the switch");
            assert.deepEqual(
              opensAfter(h, mark, thread).map((open) => open.instanceId),
              ["claudeAgent"],
            );
          }
        }),
      ),
  );

  it.effect("AK-11: a switch keeps every thread's history and continues the conversation", () =>
    run(switchSpec(), (h) =>
      Effect.gen(function* () {
        yield* rememberBoth(h);
        const thread = yield* createThread(h, "ak11");
        yield* completeTurn(h, thread, "first");
        yield* completeTurn(h, thread, "second");
        const history = Effect.map(h.threads.getThreadSnapshot(thread.threadId), (snapshot) => ({
          messages: snapshot.projection.messages.map((message) => [message.id, message.text]),
          turnItems: snapshot.projection.turnItems.map((item) => [
            item.id,
            "text" in item ? item.text : null,
          ]),
        }));
        const before = yield* history;

        yield* switchTo(h);
        const mark = h.fake.opens.length;

        assert.deepEqual(yield* history, before);
        yield* completeTurn(h, thread, "third");
        assert.deepEqual(opensAfter(h, mark, thread), [
          {
            instanceId: "claudeAgent",
            threadId: thread.threadId,
            resume: nativeThreadId(thread.threadId),
          },
        ]);
        const handoffs = yield* h.threads.getThreadRecords(thread.threadId, ["contextHandoffs"]);
        assert.deepEqual(handoffs.contextHandoffs, []);
      }),
    ),
  );

  it.effect("AK-12: a switch does not touch threads on another setup", () =>
    run(switchSpec(), (h) =>
      Effect.gen(function* () {
        yield* rememberBoth(h);
        const other = yield* createThread(h, "ak12", "claudeWork2");
        yield* completeTurn(h, other, "hello");
        const filesBefore = yield* h.readSetupFiles("claudeWork2");

        yield* switchTo(h);
        const mark = h.fake.opens.length;

        assert.notInclude(yield* sessionStatuses(h, other), "stopped");
        assert.deepEqual(yield* h.readSetupFiles("claudeWork2"), filesBefore);
        assert.deepEqual(yield* activeOn(h, "claudeWork2"), PRIVATE_ACTIVE);
        yield* completeTurn(h, other, "after the switch");
        assert.deepEqual(opensAfter(h, mark, other), []);
      }),
    ),
  );

  // Holds a turn on setup one, switches, and returns what the next turn needs.
  const switchWhileTurnRuns = Effect.fn("test.switchWhileTurnRuns")(function* (h: Harness) {
    yield* rememberBoth(h);
    const thread = yield* createThread(h, "running");
    const { run: held } = yield* startHeldTurn(h, thread, "long task");
    const accountsDuringInterrupt: Array<unknown> = [];
    h.fake.onInterrupt = () =>
      h.readJson("claudeAgent", ".claude.json").pipe(
        Effect.map((json) => {
          accountsDuringInterrupt.push(json.oauthAccount?.emailAddress);
        }),
        Effect.orDie,
      );
    yield* switchTo(h);
    return { thread, held, mark: h.fake.opens.length, accountsDuringInterrupt };
  });

  it.effect("AK-13: a running turn on the setup is stopped cleanly by a switch", () =>
    run(switchSpec(), (h) =>
      Effect.gen(function* () {
        const { thread, held, accountsDuringInterrupt } = yield* switchWhileTurnRuns(h);

        const after = yield* records(h, thread);
        assert.strictEqual(after.runs.find((run) => run.id === held.id)?.status, "interrupted");
        const attempts = after.attempts.filter((attempt) => attempt.runId === held.id);
        assert.isNotEmpty(attempts);
        for (const attempt of attempts) assert.strictEqual(attempt.status, "interrupted");
        assert.isUndefined(ThreadManagementService.latestActiveRun(after));
        assert.strictEqual(interruptsOn(h, thread).length, 1);
        // Read inside the fake interrupt: the files still named Work when the turn was stopped.
        assert.deepEqual(accountsDuringInterrupt, ["alice@example.com"]);
      }),
    ),
  );

  it.effect("AK-14: a thread stopped by a switch continues on the new account", () =>
    run(switchSpec(), (h) =>
      Effect.gen(function* () {
        const { thread, mark } = yield* switchWhileTurnRuns(h);

        yield* completeTurn(h, thread, "continue");

        assert.deepEqual(opensAfter(h, mark, thread), [
          {
            instanceId: "claudeAgent",
            threadId: thread.threadId,
            resume: nativeThreadId(thread.threadId),
          },
        ]);
      }),
    ),
  );

  it.effect("AK-15: running turns on another setup are not stopped", () =>
    run(switchSpec(), (h) =>
      Effect.gen(function* () {
        yield* rememberBoth(h);
        const other = yield* createThread(h, "ak15", "claudeWork2");
        const { run: held, release } = yield* startHeldTurn(h, other, "long task");

        yield* switchTo(h);

        assert.strictEqual(yield* runStatus(h, other, held.id), "running");
        assert.deepEqual(interruptsOn(h, other), []);
        yield* Deferred.succeed(release, undefined);
        assert.strictEqual((yield* waitForRun(h, other, held.id)).status, "completed");
      }),
    ),
  );

  it.effect("AK-21: a switch refused for outside Claude programs leaves running turns alone", () =>
    run(switchSpec(), (h) =>
      Effect.gen(function* () {
        yield* rememberBoth(h);
        const thread = yield* createThread(h, "ak21");
        const { run: held } = yield* startHeldTurn(h, thread, "long task");
        // Not SERVER_PID: the scan never counts the server itself.
        yield* h.addClaudeProcess(4343, h.setups.claudeAgent!.dir);

        yield* refusal(h, switchTo(h), "externalClaudePrograms");

        assert.strictEqual(yield* runStatus(h, thread, held.id), "running");
        assert.deepEqual(h.fake.interrupts, []);
        assert.notInclude(yield* sessionStatuses(h, thread), "stopped");
      }),
    ),
  );

  it.effect("AK-31: a switch refused for an unremembered account leaves running turns alone", () =>
    run(two(carol, bob), (h) =>
      Effect.gen(function* () {
        yield* privateAccount(h);
        const thread = yield* createThread(h, "ak31");
        const { run: held } = yield* startHeldTurn(h, thread, "long task");

        yield* refusal(h, switchTo(h), "currentNotRemembered");

        assert.strictEqual(yield* runStatus(h, thread, held.id), "running");
        assert.deepEqual(h.fake.interrupts, []);
      }),
    ),
  );

  it.effect("holds a queued message during the switch and starts it on the new login", () =>
    run(switchSpec(), (h) =>
      Effect.gen(function* () {
        yield* rememberBoth(h);
        const thread = yield* createThread(h, "queued");
        const { run: held } = yield* startHeldTurn(h, thread, "long task");
        const queued = yield* send(h, thread, "next", "queue");
        assert.strictEqual(queued.status, "queued");

        yield* switchTo(h);
        const mark = h.fake.opens.length;

        assert.strictEqual(yield* runStatus(h, thread, held.id), "interrupted");
        // The only session opened before the mark is the held turn's.
        assert.strictEqual(
          h.fake.opens.slice(0, mark).filter((open) => open.threadId === thread.threadId).length,
          1,
        );
        assert.strictEqual((yield* waitForRun(h, thread, queued.id)).status, "completed");
        assert.strictEqual(opensAfter(h, mark, thread).length, 1);
        const commands = yield* h.sql<{ readonly command_id: string }>`
          SELECT command_id FROM orchestration_events
          WHERE command_id LIKE 'claude-account-switch:%'
          GROUP BY command_id ORDER BY MIN(sequence)`;
        assert.strictEqual(commands.length, 2);
        assert.isTrue(commands[0]!.command_id.endsWith(`:${held.id}`));
        assert.isTrue(commands[1]!.command_id.endsWith(`:resume:${thread.threadId}`));
        // holdQueue: true is what marks the queued run held under the interrupt command.
        const holds = yield* h.sql<{ readonly payload_json: string }>`
          SELECT payload_json FROM orchestration_events
          WHERE command_id LIKE 'claude-account-switch:%' AND event_type = 'run.updated'
            AND json_extract(payload_json, '$.id') = ${queued.id}
          ORDER BY sequence`;
        assert.deepEqual(
          holds.map((row) => (JSON.parse(row.payload_json) as { queueHeld?: boolean }).queueHeld),
          [true, false],
        );
      }),
    ),
  );

  it.effect("stops a turn sent on an idle thread of the setup while the stop runs", () =>
    run(switchSpec(), (h) =>
      Effect.gen(function* () {
        yield* rememberBoth(h);
        const a = yield* createThread(h, "admitted-a");
        const b = yield* createThread(h, "admitted-b");
        const { run: heldA } = yield* startHeldTurn(h, a, "long task");
        const queuedA = yield* send(h, a, "next", "queue");
        const gate = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(gate, undefined));
        h.fake.onInterrupt = (threadId) =>
          threadId === a.threadId ? Deferred.await(gate) : Effect.void;
        const login = yield* privateLogin(h);

        const switching = yield* Effect.forkChild(switchTo(h), { startImmediately: true });
        yield* Deferred.await(h.fake.interruptSeen(a.threadId));
        yield* holdNextTurn(h, b);
        const runB = yield* send(h, b, "sent during the stop");
        yield* Deferred.await(h.fake.started(b.threadId));
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(switching);
        const mark = h.fake.opens.length;

        assert.strictEqual(yield* runStatus(h, a, heldA.id), "interrupted");
        assert.strictEqual(yield* runStatus(h, b, runB.id), "interrupted");
        assert.strictEqual((yield* waitForRun(h, a, queuedA.id)).status, "completed");
        assert.strictEqual(opensAfter(h, mark, a).length, 1);
        yield* assertSetupHolds(h, "claudeAgent", login);
      }),
    ),
  );

  it.effect("stops the turns of every setup on a shared config dir", () =>
    run(
      {
        setups: [
          { id: "claudeAgent", state: alice },
          { id: "claudeWork2", state: "loggedOut", sharesDirWith: "claudeAgent" },
          { id: "claudeBob3", state: bob },
        ],
      },
      (h) =>
        Effect.gen(function* () {
          yield* work(h);
          yield* work(h, "claudeBob3", "Private");
          const one = yield* createThread(h, "shared-one", "claudeAgent");
          const two = yield* createThread(h, "shared-two", "claudeWork2");
          const { run: heldOne } = yield* startHeldTurn(h, one, "long task");
          const { run: heldTwo } = yield* startHeldTurn(h, two, "long task");

          yield* switchTo(h);

          assert.strictEqual(yield* runStatus(h, one, heldOne.id), "interrupted");
          assert.strictEqual(yield* runStatus(h, two, heldTwo.id), "interrupted");
          for (const thread of [one, two]) {
            assert.deepEqual(yield* sessionStatuses(h, thread), ["stopped"]);
          }
        }),
    ),
  );

  it.effect("refuses with sessionStopFailed when a turn does not stop in time", () => {
    const logs = captureLogs();
    return run(switchSpec(), (h) =>
      Effect.gen(function* () {
        yield* rememberBoth(h);
        const thread = yield* createThread(h, "stuck");
        yield* startHeldTurn(h, thread, "long task");
        h.fake.ignoreInterrupts.add(thread.threadId);
        const before = yield* h.readEverything("claudeAgent");

        const switching = yield* Effect.forkChild(switchTo(h), { startImmediately: true });
        yield* Deferred.await(h.fake.interruptSeen(thread.threadId));
        yield* TestClock.adjust(
          Duration.sum(ClaudeAccountsModule.CLAUDE_SWITCH_STOP_TIMEOUT, Duration.seconds(1)),
        );
        const error = yield* refusal(h, Fiber.join(switching), "sessionStopFailed");

        assert.strictEqual(
          error.message,
          "Could not check or stop the running turns on this Claude setup. It is still logged in as before. Try again.",
        );
        assert.deepEqual(yield* h.readEverything("claudeAgent"), before);
        const warnings = logs.switchLines("Warn");
        assert.deepEqual(
          warnings.map((line) => [line.outcome, line.step]),
          [["sessionStopFailed", "timeout"]],
        );
      }),
    ).pipe(Effect.provide(logs.layer));
  });

  it.effect("a switch refused after the stop leaves the old login and resumes the queue", () => {
    const logs = captureLogs();
    return run(switchSpec(), (h) =>
      Effect.gen(function* () {
        yield* rememberBoth(h);
        const thread = yield* createThread(h, "refused-late");
        const { run: held } = yield* startHeldTurn(h, thread, "long task");
        const queued = yield* send(h, thread, "next", "queue");
        h.fake.onInterrupt = () =>
          h.addClaudeProcess(4343, h.setups.claudeAgent!.dir).pipe(Effect.orDie);
        const before = yield* h.readEverything("claudeAgent");

        yield* refusal(h, switchTo(h), "externalClaudePrograms");

        assert.strictEqual(yield* runStatus(h, thread, held.id), "interrupted");
        assert.deepEqual(yield* h.readEverything("claudeAgent"), before);
        assert.strictEqual((yield* waitForRun(h, thread, queued.id)).status, "completed");
        const refusedAfterStop = logs.lines.filter(
          (line) =>
            line.level === "Info" &&
            line.message[0] === "Claude account switch refused after stopping sessions",
        );
        assert.deepEqual(
          refusedAfterStop.map((line) => line.message[1]),
          [
            {
              operation: "switch",
              instanceId: "claudeAgent",
              reason: "externalClaudePrograms",
              interruptedRuns: 1,
            },
          ],
        );
      }),
    ).pipe(Effect.provide(logs.layer));
  });

  it.effect("switching to the active account stops nothing", () =>
    run(switchSpec(), (h) =>
      Effect.gen(function* () {
        yield* rememberBoth(h);
        const thread = yield* createThread(h, "already-active");
        const { run: held } = yield* startHeldTurn(h, thread, "long task");

        yield* switchTo(h, "Work");

        assert.deepEqual(h.fake.interrupts, []);
        assert.strictEqual(yield* runStatus(h, thread, held.id), "running");
        assert.notInclude(yield* sessionStatuses(h, thread), "stopped");
      }),
    ),
  );

  it.effect("AK-25: logs, threads and stored records never reveal a login", () => {
    const logs = captureLogs();
    return run(switchSpec(), (h) =>
      Effect.gen(function* () {
        yield* rememberBoth(h);
        const busy = yield* createThread(h, "ak25-busy");
        const idle = yield* createThread(h, "ak25-idle");
        yield* completeTurn(h, idle, "hello");
        const { run: held } = yield* startHeldTurn(h, busy, "long task");

        yield* switchTo(h);

        assert.isNotEmpty(h.tokens);
        assertNoLogin(h, NodeUtil.inspect(logs.lines, { depth: 12 }));
        for (const thread of [busy, idle]) {
          assertNoLogin(h, JSON.stringify(yield* h.threads.getThreadSnapshot(thread.threadId)));
        }
        const tables = yield* h.sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master WHERE type = 'table'`;
        assert.isNotEmpty(tables);
        for (const { name } of tables) {
          const rows = yield* h.sql.unsafe(`SELECT * FROM "${name}"`);
          assertNoLogin(h, JSON.stringify(rows));
        }
        const interruptRequests = (yield* h.threads.getThreadRecords(busy.threadId, [
          "turnItems",
        ])).turnItems
          .filter((item) => item.runId === held.id && item.type === "run_interrupt_request")
          .map((item) => ("message" in item ? item.message : null));
        assert.deepEqual(interruptRequests, ["Stopped for a Claude account switch"]);
      }),
    ).pipe(Effect.provide(logs.layer), Effect.provideService(References.MinimumLogLevel, "All"));
  });

  const EXTERNAL_MESSAGE =
    "Claude programs started outside T3 are using this Claude setup. Close them, then switch again.";

  it.effect("AK-20: a switch is refused while Claude programs outside T3 use the setup", () => {
    const logs = captureLogs();
    return run(switchSpec(), (h) =>
      Effect.gen(function* () {
        yield* rememberBoth(h);
        yield* h.addClaudeProcess(101, h.setups.claudeAgent!.dir);
        const filesBefore = yield* h.readEverything("claudeAgent");
        const storedBefore = yield* h.storedBytes;

        const error = yield* refusal(h, switchTo(h), "externalClaudePrograms");

        assert.strictEqual(error.message, EXTERNAL_MESSAGE);
        assert.deepEqual(yield* h.readEverything("claudeAgent"), filesBefore);
        assert.deepEqual((yield* h.accounts.list).setups[0]?.active, {
          email: "alice@example.com",
          rememberedAs: "Work",
        });
        assert.strictEqual(h.check.calls.length, 0);
        assert.deepEqual(yield* h.storedBytes, storedBefore);
        assert.deepEqual(logs.switchLines("Info"), [
          {
            operation: "switch",
            outcome: "externalClaudePrograms",
            instanceId: "claudeAgent",
            processCount: 1,
          },
        ]);
      }),
    ).pipe(Effect.provide(logs.layer));
  });

  it.effect("T3's own Claude programs do not block a switch", () =>
    run(switchSpec(), (h) =>
      Effect.gen(function* () {
        yield* rememberBoth(h);
        yield* h.addClaudeProcess(101, h.setups.claudeAgent!.dir, [
          `T3CODE_CLAUDE_OWNER_PID=${SERVER_PID}`,
        ]);
        const result = yield* switchTo(h);
        assert.deepEqual(result.active, { name: "Private", email: "bob@example.com" });
      }),
    ),
  );

  it.effect("a Claude program on another setup does not block a switch", () =>
    run(switchSpec(), (h) =>
      Effect.gen(function* () {
        yield* rememberBoth(h);
        yield* h.addClaudeProcess(101, h.setups.claudeWork2!.dir);
        const result = yield* switchTo(h);
        assert.deepEqual(result.active, { name: "Private", email: "bob@example.com" });
      }),
    ),
  );

  it.effect("a Claude program on a shared config dir blocks every setup on it", () =>
    run(
      {
        setups: [
          { id: "claudeAgent", state: alice },
          { id: "claudeShared2", state: "loggedOut", sharesDirWith: "claudeAgent" },
          { id: "claudeWork2", state: bob },
        ],
      },
      (h) =>
        Effect.gen(function* () {
          yield* rememberBoth(h);
          yield* h.addClaudeProcess(101, h.setups.claudeAgent!.dir);
          const before = yield* h.readEverything("claudeAgent");

          yield* refusal(h, switchTo(h, "Private", "claudeShared2"), "externalClaudePrograms");

          assert.deepEqual(yield* h.readEverything("claudeAgent"), before);
          const setups = (yield* h.accounts.list).setups;
          for (const instance of ["claudeAgent", "claudeShared2"]) {
            assert.deepEqual(setups.find((setup) => setup.instanceId === instance)?.active, {
              email: "alice@example.com",
              rememberedAs: "Work",
            });
          }
        }),
    ),
  );

  it.effect("refuses a Claude program started during the login check, keeping the renewal", () =>
    run(switchSpec(), (h) =>
      Effect.gen(function* () {
        yield* rememberBoth(h);
        const p2 = yield* h.newOauth("renewed-private");
        h.check.respond = () =>
          h.addClaudeProcess(103, h.setups.claudeAgent!.dir).pipe(
            Effect.as({
              verdict: "Valid",
              latestClaudeAiOauth: Option.some(Redacted.make(p2)),
            } as const),
            Effect.orDie,
          );
        const filesBefore = yield* h.readEverything("claudeAgent");
        const workBefore = (yield* h.storedAccounts()).find((a) => a.name === "Work");

        yield* refusal(h, switchTo(h), "externalClaudePrograms");

        assert.strictEqual(h.check.calls.length, 1);
        assert.deepEqual(yield* h.readEverything("claudeAgent"), filesBefore);
        const stored = yield* h.storedAccounts();
        assert.deepEqual(stored.find((a) => a.name === "Private")?.claudeAiOauth, p2);
        assert.deepEqual(
          stored.find((a) => a.name === "Work"),
          workBefore,
        );
      }),
    ),
  );

  it.effect("refuses with processCheckFailed when the process scan fails", () => {
    const logs = captureLogs();
    return run(switchSpec({ missingProcRoot: true }), (h) =>
      Effect.gen(function* () {
        yield* rememberBoth(h);
        const before = yield* h.readEverything("claudeAgent");

        const error = yield* refusal(h, switchTo(h), "processCheckFailed");

        assert.strictEqual(
          error.message,
          "Could not check whether Claude programs outside T3 are using this Claude setup. Try again.",
        );
        assert.deepEqual(yield* h.readEverything("claudeAgent"), before);
        assert.strictEqual(h.check.calls.length, 0);
        assert.deepEqual(logs.switchLines("Warn"), [
          {
            operation: "switch",
            outcome: "processCheckFailed",
            instanceId: "claudeAgent",
            scanFailure: "listFailed",
          },
        ]);
      }),
    ).pipe(Effect.provide(logs.layer));
  });

  it.effect("refusals that need no process scan come first", () =>
    Effect.gen(function* () {
      yield* run(switchSpec({ platform: "darwin" }), (h) =>
        Effect.gen(function* () {
          yield* h.addClaudeProcess(101, h.setups.claudeAgent!.dir);
          yield* refusal(h, switchTo(h), "unavailable");
        }),
      );
      yield* run(switchSpec(), (h) =>
        Effect.gen(function* () {
          yield* rememberBoth(h);
          yield* h.addClaudeProcess(101, h.setups.claudeAgent!.dir);
          yield* refusal(h, switchTo(h, "Nobody"), "accountNotFound");
        }),
      );
      yield* run(two(carol, bob), (h) =>
        Effect.gen(function* () {
          yield* privateAccount(h);
          yield* h.addClaudeProcess(101, h.setups.claudeAgent!.dir);
          yield* refusal(h, switchTo(h), "currentNotRemembered");
        }),
      );
    }),
  );

  it.effect("switching to the already active account succeeds while a program blocks", () =>
    run(switchSpec(), (h) =>
      Effect.gen(function* () {
        yield* rememberBoth(h);
        yield* h.addClaudeProcess(101, h.setups.claudeAgent!.dir);
        const before = yield* h.readEverything("claudeAgent");
        const result = yield* switchTo(h, "Work");
        assert.deepEqual(result.active, { name: "Work", email: "alice@example.com" });
        assert.deepEqual(yield* h.readEverything("claudeAgent"), before);
      }),
    ),
  );

  it.effect.each(OTHER_SYSTEMS)("AK-30: switching is unavailable on %s", (platform) =>
    run(switchSpec({ platform }), (h) =>
      Effect.gen(function* () {
        const before = yield* h.readEverything("claudeAgent");
        const error = yield* refusal(h, switchTo(h), "unavailable");
        assert.strictEqual(error.message, UNAVAILABLE_MESSAGE);
        assert.deepEqual(yield* h.readEverything("claudeAgent"), before);
        assert.strictEqual(h.check.calls.length, 0);
      }),
    ),
  );

  describe("over the WebSocket RPC", () => {
    const AccountsRpcs = RpcGroup.make(
      WsClaudeAccountsListRpc,
      WsClaudeAccountsRememberRpc,
      WsClaudeAccountsForgetRpc,
      WsClaudeAccountsSwitchRpc,
    );

    // Drives the real handlers through the RPC server without a socket. Every answer is checked
    // for tokens as the JSON a client would receive.
    const makeRpc = Effect.fn("test.makeRpc")(function* (h: Harness) {
      const pending = new Map<string, Deferred.Deferred<Exit.Exit<unknown, unknown>>>();
      const server = yield* RpcServer.makeNoSerialization(AccountsRpcs, {
        disableTracing: true,
        disableFatalDefects: true,
        onFromServer: (response) =>
          response._tag === "Exit"
            ? Deferred.succeed(pending.get(String(response.requestId))!, response.exit)
            : Effect.void,
      }).pipe(Effect.provide(AccountsRpcs.toLayer(claudeAccountsRpcHandlers(h.accounts))));
      let next = 0;
      return Effect.fn("test.rpcCall")(function* (
        tag: (typeof WS_METHODS)[
          | "claudeAccountsList"
          | "claudeAccountsRemember"
          | "claudeAccountsForget"
          | "claudeAccountsSwitch"],
        payload:
          | ClaudeAccountListInput
          | ClaudeAccountRememberInput
          | ClaudeAccountForgetInput
          | ClaudeAccountSwitchInput,
      ) {
        const requestId = String(next++);
        const response = yield* Deferred.make<Exit.Exit<unknown, unknown>>();
        pending.set(requestId, response);
        yield* server.write(0, {
          _tag: "Request",
          id: RpcMessage.RequestId(requestId),
          tag,
          payload,
          headers: Headers.empty,
        });
        const exit = yield* Deferred.await(response);
        const answer = Exit.isSuccess(exit) ? exit.value : Cause.squash(exit.cause);
        assertNoLogin(h, JSON.stringify(answer) ?? "");
        return { exit, answer };
      });
    });

    const succeeded = <A>(result: {
      readonly exit: Exit.Exit<unknown, unknown>;
      answer: unknown;
    }) => {
      assert.isTrue(Exit.isSuccess(result.exit));
      return result.answer as A;
    };

    it.effect("AK-14: remembers the setup's unremembered account and lists it as remembered", () =>
      run(one(alice), (h) =>
        Effect.gen(function* () {
          const call = yield* makeRpc(h);
          const before = succeeded<ClaudeAccountList>(
            yield* call(WS_METHODS.claudeAccountsList, {}),
          );
          assert.strictEqual(before.setups[0]?.active?.rememberedAs, null);

          const remembered = yield* call(WS_METHODS.claudeAccountsRemember, {
            instanceId: "claudeAgent",
            name: "Work",
          });
          assert.deepEqual(succeeded(remembered), { name: "Work", email: "alice@example.com" });

          const list = succeeded<ClaudeAccountList>(yield* call(WS_METHODS.claudeAccountsList, {}));
          assert.strictEqual(list.setups[0]?.active?.rememberedAs, "Work");
        }),
      ),
    );

    it.effect("AK-25 / AK-36: lists every remembered account and the one the setup is on", () =>
      run(two(alice, bob), (h) =>
        Effect.gen(function* () {
          yield* work(h);
          yield* work(h, "claudeWork2", "Private");
          const call = yield* makeRpc(h);
          const list = succeeded<ClaudeAccountList>(yield* call(WS_METHODS.claudeAccountsList, {}));
          assert.deepEqual(list.accounts.map((account) => account.name).toSorted(), [
            "Private",
            "Work",
          ]);
          assert.strictEqual(list.setups[0]?.active?.rememberedAs, "Work");
        }),
      ),
    );

    it.effect("AK-28: a forgotten account is no longer listed", () =>
      run(two(alice, bob), (h) =>
        Effect.gen(function* () {
          yield* work(h);
          yield* work(h, "claudeWork2", "Private");
          const call = yield* makeRpc(h);
          succeeded(yield* call(WS_METHODS.claudeAccountsForget, { name: "Private" }));
          const list = succeeded<ClaudeAccountList>(yield* call(WS_METHODS.claudeAccountsList, {}));
          assert.deepEqual(
            list.accounts.map((account) => account.name),
            ["Work"],
          );
        }),
      ),
    );

    it.effect("AK-30: forgetting the active account leaves the setup's login files untouched", () =>
      run(one(alice), (h) =>
        Effect.gen(function* () {
          yield* work(h);
          const call = yield* makeRpc(h);
          const before = yield* h.readSetupFiles("claudeAgent");
          succeeded(yield* call(WS_METHODS.claudeAccountsForget, { name: "Work" }));
          assert.deepEqual(yield* h.readSetupFiles("claudeAgent"), before);
          const list = succeeded<ClaudeAccountList>(yield* call(WS_METHODS.claudeAccountsList, {}));
          assert.deepEqual(list.setups[0]?.active, {
            email: "alice@example.com",
            rememberedAs: null,
          });
        }),
      ),
    );

    it.effect("refuses a name in use with nameInUse and no setup ID in the message", () =>
      run(one(alice), (h) =>
        Effect.gen(function* () {
          yield* work(h);
          const call = yield* makeRpc(h);
          const { exit, answer } = yield* call(WS_METHODS.claudeAccountsRemember, {
            instanceId: "claudeAgent",
            name: "Work",
          });
          assert.isTrue(Exit.isFailure(exit));
          assert.instanceOf(answer, ClaudeAccountError);
          const error = answer as ClaudeAccountsModule.ClaudeAccountError;
          assert.strictEqual(error.reason, "nameInUse");
          assert.notInclude(error.message, "claudeAgent");
        }),
      ),
    );

    it.effect("refuses listing with unavailable on another system", () =>
      run({ ...one(alice), platform: "darwin" }, (h) =>
        Effect.gen(function* () {
          const call = yield* makeRpc(h);
          const { exit, answer } = yield* call(WS_METHODS.claudeAccountsList, {});
          assert.isTrue(Exit.isFailure(exit));
          assert.instanceOf(answer, ClaudeAccountError);
          assert.strictEqual(
            (answer as ClaudeAccountsModule.ClaudeAccountError).reason,
            "unavailable",
          );
        }),
      ),
    );

    type RpcCall = Effect.Success<ReturnType<typeof makeRpc>>;
    type RpcResult = Effect.Success<ReturnType<RpcCall>>;
    const switchOver = (
      call: RpcCall,
      name: string,
      stopRunningTurns: boolean,
      instanceId = "claudeAgent",
    ) =>
      call(WS_METHODS.claudeAccountsSwitch, {
        instanceId: id(instanceId),
        name,
        stopRunningTurns,
      });
    const failureOf = (result: RpcResult) => {
      assert.isTrue(Exit.isFailure(result.exit));
      assert.instanceOf(result.answer, ClaudeAccountError);
      return result.answer as ClaudeAccountsModule.ClaudeAccountError;
    };
    const setupEmail = Effect.fn("test.setupEmail")(function* (h: Harness) {
      return (yield* h.readJson("claudeAgent", ".claude.json")).oauthAccount?.emailAddress;
    });
    // Work active on claudeAgent, Private remembered, a held turn on a claudeAgent thread.
    const withHeldTurn = Effect.fn("test.withHeldTurn")(function* (h: Harness, name: string) {
      yield* rememberBoth(h);
      const thread = yield* createThread(h, name);
      const { run: held } = yield* startHeldTurn(h, thread, "long task");
      return { thread, held };
    });
    const assertTurnUntouched = Effect.fn("test.assertTurnUntouched")(function* (
      h: Harness,
      thread: TestThread,
      held: { readonly id: RunId },
    ) {
      const records = yield* h.threads.getThreadRecords(thread.threadId, ["runs"]);
      assert.strictEqual(ThreadManagementService.latestActiveRun(records)?.id, held.id);
      assert.deepEqual(interruptsOn(h, thread), []);
    });

    it.effect("AK-2, AK-26: switches the setup to the other account when no turn runs", () =>
      run(switchSpec(), (h) =>
        Effect.gen(function* () {
          yield* rememberBoth(h);
          const login = yield* privateLogin(h);
          const call = yield* makeRpc(h);

          const result = succeeded<ClaudeSwitchResult>(yield* switchOver(call, "Private", false));

          assert.deepEqual(result.active, { name: "Private", email: "bob@example.com" });
          yield* assertSetupHolds(h, "claudeAgent", login);
          assert.strictEqual(yield* setupEmail(h), "bob@example.com");
        }),
      ),
    );

    it.effect("AK-3, AK-4, AK-38: refuses while a turn runs and leaves everything as it was", () =>
      run(switchSpec(), (h) =>
        Effect.gen(function* () {
          const { thread, held } = yield* withHeldTurn(h, "ak3");
          const before = yield* h.readEverything("claudeAgent");
          const call = yield* makeRpc(h);

          const error = failureOf(yield* switchOver(call, "Private", false));

          assert.strictEqual(error.reason, "turnsRunning");
          assert.deepEqual(yield* h.readEverything("claudeAgent"), before);
          yield* assertTurnUntouched(h, thread, held);
          assert.strictEqual(h.check.calls.length, 0);
        }),
      ),
    );

    it.effect("does not stop a turn that starts during the login check without asking", () =>
      run(switchSpec(), (h) =>
        Effect.gen(function* () {
          yield* rememberBoth(h);
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          h.check.respond = () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return { verdict: "Valid", latestClaudeAiOauth: Option.none() } as const;
            });
          const before = yield* h.readEverything("claudeAgent");
          const call = yield* makeRpc(h);
          const switching = yield* Effect.forkChild(switchOver(call, "Private", false), {
            startImmediately: true,
          });
          yield* Deferred.await(entered);
          const thread = yield* createThread(h, "late-turn");
          const { run: held } = yield* startHeldTurn(h, thread, "long task");

          yield* Deferred.succeed(release, undefined);
          const error = failureOf(yield* Fiber.join(switching));

          assert.strictEqual(error.reason, "turnsRunning");
          assert.deepEqual(yield* h.readEverything("claudeAgent"), before);
          yield* assertTurnUntouched(h, thread, held);
        }),
      ),
    );

    it.effect("AK-5, AK-10, AK-11: after the refusal, the confirmed switch stops the turn", () =>
      run(switchSpec(), (h) =>
        Effect.gen(function* () {
          const { thread, held } = yield* withHeldTurn(h, "ak5");
          const call = yield* makeRpc(h);
          assert.strictEqual(
            failureOf(yield* switchOver(call, "Private", false)).reason,
            "turnsRunning",
          );

          const result = succeeded<ClaudeSwitchResult>(yield* switchOver(call, "Private", true));
          const mark = h.fake.opens.length;

          assert.strictEqual(result.active.name, "Private");
          assert.strictEqual(yield* runStatus(h, thread, held.id), "interrupted");
          assert.strictEqual(yield* setupEmail(h), "bob@example.com");
          assert.deepEqual(opensAfter(h, mark, thread), []);
          yield* completeTurn(h, thread, "continue");
          const opens = opensAfter(h, mark, thread);
          assert.strictEqual(opens.length, 1);
          assert.strictEqual(opens[0]?.instanceId, "claudeAgent");
          assert.strictEqual(yield* setupEmail(h), "bob@example.com");
        }),
      ),
    );

    it.effect("switching to the active account is a safe retry that never asks", () =>
      run(switchSpec(), (h) =>
        Effect.gen(function* () {
          const { thread, held } = yield* withHeldTurn(h, "retry");
          const before = yield* h.readEverything("claudeAgent");
          const call = yield* makeRpc(h);

          const result = succeeded<ClaudeSwitchResult>(yield* switchOver(call, "Work", false));

          assert.strictEqual(result.active.name, "Work");
          assert.deepEqual(yield* h.readEverything("claudeAgent"), before);
          assert.strictEqual(yield* runStatus(h, thread, held.id), "running");
        }),
      ),
    );

    it.effect("AK-7: a second switch is refused at once while the first waits in the check", () =>
      run(switchSpec(), (h) =>
        Effect.gen(function* () {
          yield* rememberBoth(h);
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          h.check.respond = () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return { verdict: "Valid", latestClaudeAiOauth: Option.none() } as const;
            });
          const login = yield* privateLogin(h);
          const call = yield* makeRpc(h);
          const first = yield* Effect.forkChild(switchOver(call, "Private", false), {
            startImmediately: true,
          });
          yield* Deferred.await(entered);

          const second = failureOf(yield* switchOver(call, "Private", false));

          assert.strictEqual(second.reason, "switchInProgress");
          assert.strictEqual(h.check.calls.length, 1);
          yield* Deferred.succeed(release, undefined);
          const result = succeeded<ClaudeSwitchResult>(yield* Fiber.join(first));
          assert.strictEqual(result.active.name, "Private");
          yield* assertSetupHolds(h, "claudeAgent", login);
          assert.strictEqual(yield* setupEmail(h), "bob@example.com");
        }),
      ),
    );

    it.effect("a caller that goes away does not cut a switch in half", () =>
      run(switchSpec(), (h) =>
        Effect.gen(function* () {
          yield* rememberBoth(h);
          const thread = yield* createThread(h, "gone");
          yield* startHeldTurn(h, thread, "long task");
          const queued = yield* send(h, thread, "next", "queue");
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          h.check.respond = () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return { verdict: "Valid", latestClaudeAiOauth: Option.none() } as const;
            });
          const login = yield* privateLogin(h);
          const caller = yield* Effect.forkChild(switchTo(h), { startImmediately: true });
          yield* Deferred.await(entered);

          yield* Fiber.interrupt(caller);
          yield* Deferred.succeed(release, undefined);
          // Waits on the accounts lock, so it answers once the switch has finished.
          yield* refusal(h, h.accounts.forget({ name: "Nobody" }), "accountNotFound");

          yield* assertSetupHolds(h, "claudeAgent", login);
          assert.strictEqual(yield* setupEmail(h), "bob@example.com");
          assert.strictEqual((yield* waitForRun(h, thread, queued.id)).status, "completed");
        }),
      ),
    );

    it.effect("AK-31: names no setup and no command when outside Claude programs block it", () =>
      run(switchSpec(), (h) =>
        Effect.gen(function* () {
          yield* rememberBoth(h);
          yield* h.addClaudeProcess(101, h.setups.claudeAgent!.dir);
          const before = yield* h.readEverything("claudeAgent");
          const call = yield* makeRpc(h);

          const error = failureOf(yield* switchOver(call, "Private", true));

          assert.strictEqual(error.reason, "externalClaudePrograms");
          for (const forbidden of ["claudeAgent", "`", "claude auth"]) {
            assert.notInclude(error.message, forbidden);
          }
          assert.deepEqual(yield* h.readEverything("claudeAgent"), before);
        }),
      ),
    );
  });
});

it("explains each refusal in words that carry no login", () => {
  const message = (reason: ClaudeAccountsModule.ClaudeAccountErrorReason) =>
    new ClaudeAccountError({ reason, instanceId: id("claudeAgent"), name: "Work" }).message;
  assert.strictEqual(message("setupNotFound"), "This Claude setup no longer exists.");
  assert.strictEqual(
    message("setupUnreadable"),
    "T3 could not read the login of this Claude setup.",
  );
  assert.strictEqual(
    message("notLoggedIn"),
    "No Claude account is logged in on this Claude setup.",
  );
  assert.strictEqual(
    message("invalidName"),
    "An account name must be 1 to 64 characters long and contain no control characters.",
  );
  assert.strictEqual(message("accountNotFound"), 'No remembered Claude account is named "Work".');
  assert.strictEqual(message("storage"), "Could not read or save the remembered Claude accounts.");
  assert.strictEqual(
    message("sessionStopFailed"),
    "Could not check or stop the running turns on this Claude setup. It is still logged in as before. Try again.",
  );
  assert.strictEqual(
    message("needsFreshLogin"),
    'The saved login of "Work" no longer works. Forget "Work", then add the account again.',
  );
});
