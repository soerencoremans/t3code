import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as NodeUtil from "node:util";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as ClaudeAccountsModule from "./ClaudeAccounts.ts";
import * as ClaudeExternalProcesses from "./ClaudeExternalProcesses.ts";
import { ClaudeLoginCheck, type ClaudeLoginCheckResult } from "./ClaudeLoginCheck.ts";
import type { JsonObject } from "./claudeLoginFiles.ts";

const { ClaudeAccountError, ClaudeAccounts } = ClaudeAccountsModule;

const UNAVAILABLE_MESSAGE =
  "Claude account switching is unavailable on this system. It is supported on Linux only.";
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

  const context = yield* Layer.build(
    ClaudeAccountsModule.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          ServerSecretStore.layer,
          ServerSettingsService.layerTest({ providerInstances }),
          checkLayer,
          ClaudeExternalProcesses.layerWith({ procRoot }),
        ).pipe(
          Layer.provideMerge(
            ServerConfig.ServerConfig.layerTest(process.cwd(), {
              prefix: "t3-claude-accounts-test-",
            }),
          ),
        ),
      ),
      Layer.provide(Layer.succeed(FileSystem.FileSystem, serviceFileSystem)),
    ),
  );
  const config = Context.get(context, ServerConfig.ServerConfig);
  const secrets = Context.get(context, ServerSecretStore.ServerSecretStore);
  return {
    accounts: Context.get(context, ClaudeAccounts),
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
  body: (harness: Harness) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
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
        assert.strictEqual(error.message, 'No Claude setup "codex" is configured.');
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
    h.accounts.switch({ instanceId: id(instanceId), name });
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
          'The account logged in on setup "claudeAgent" is not remembered. Remember it first, then switch.',
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
          'Switching setup "claudeAgent" failed. The setup is logged in as before.',
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
          'Switching setup "claudeAgent" failed and its login files could not be restored. Log in again with `claude auth login` for this setup.',
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

  it.effect("serialises switches: the second waits, then finds the account already active", () =>
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
        const second = yield* Effect.forkChild(switchTo(h), { startImmediately: true });
        assert.strictEqual(h.check.calls.length, 1);
        assert.deepEqual(yield* h.readEverything("claudeAgent"), before);

        yield* Deferred.succeed(release, undefined);
        const results = [yield* Fiber.join(first), yield* Fiber.join(second)];

        for (const result of results) {
          assert.deepEqual(result.active, { name: "Private", email: "bob@example.com" });
        }
        assert.strictEqual(h.check.calls.length, 1);
        const credentials = yield* h.readJson("claudeAgent", ".credentials.json");
        assert.deepEqual(credentials.claudeAiOauth, p2);
      }),
    ),
  );

  const EXTERNAL_MESSAGE =
    'Claude programs started outside T3 are using setup "claudeAgent". Close them, then switch again.';

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
          'Could not check whether Claude programs outside T3 are using setup "claudeAgent". Try again.',
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
});

it("explains each refusal in words that carry no login", () => {
  const message = (reason: ClaudeAccountsModule.ClaudeAccountErrorReason) =>
    new ClaudeAccountError({ reason, instanceId: id("claudeAgent"), name: "Work" }).message;
  assert.strictEqual(message("setupNotFound"), 'No Claude setup "claudeAgent" is configured.');
  assert.strictEqual(
    message("setupUnreadable"),
    'Could not read the Claude login of setup "claudeAgent".',
  );
  assert.strictEqual(
    message("notLoggedIn"),
    'No Claude account is logged in on setup "claudeAgent".',
  );
  assert.strictEqual(
    message("invalidName"),
    "An account name must be 1 to 64 characters long and contain no control characters.",
  );
  assert.strictEqual(message("accountNotFound"), 'No remembered Claude account is named "Work".');
  assert.strictEqual(message("storage"), "Could not read or save the remembered Claude accounts.");
  assert.strictEqual(
    message("needsFreshLogin"),
    'The saved login of "Work" no longer works. Log in to that account again with `claude auth login`, then forget "Work" and remember it again.',
  );
});
