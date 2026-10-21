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
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as NodeUtil from "node:util";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as ClaudeAccountsModule from "./ClaudeAccounts.ts";

const { ClaudeAccountError, ClaudeAccounts } = ClaudeAccountsModule;

const UNAVAILABLE_MESSAGE =
  "Claude account switching is unavailable on this system. It is supported on Linux only.";
const STORAGE_NAME = "claude-accounts";

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
}
interface HarnessSpec {
  readonly setups: ReadonlyArray<SetupSpec>;
  readonly platform?: NodeJS.Platform;
  readonly withCodexInstance?: boolean;
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

const randomToken = Effect.fn("test.randomToken")(function* (label: string) {
  const crypto = yield* Crypto.Crypto;
  return `${label}-${yield* crypto.randomUUIDv4()}`;
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
  const accessToken = yield* randomToken("access");
  const refreshToken = yield* randomToken("refresh");
  tokens.push(accessToken, refreshToken);
  yield* fileSystem.writeFileString(
    credentialsPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken,
        refreshToken,
        expiresAt: 1_900_000_000_000,
        scopes: ["user:inference"],
      },
      mcpOAuth: { server: { token: "mcp" } },
    }),
  );
  yield* fileSystem.writeFileString(
    path.join(dir, ".claude.json"),
    JSON.stringify({
      oauthAccount: {
        emailAddress: state.email,
        accountUuid: state.accountUuid,
        ...(state.organizationUuid === undefined
          ? {}
          : { organizationUuid: state.organizationUuid }),
      },
      numStartups: 3,
      projects: {},
    }),
  );
  return { dir, tokens };
});

const buildHarness = Effect.fn("test.buildHarness")(function* (spec: HarnessSpec) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const setups: Record<string, { readonly dir: string }> = {};
  const tokens: Array<string> = [];
  const providerInstances: Record<string, ProviderInstanceConfig> = {};
  for (const setup of spec.setups) {
    const written = yield* writeSetup(setup.state);
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

  const context = yield* Layer.build(
    ClaudeAccountsModule.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          ServerSecretStore.layer,
          ServerSettingsService.layerTest({ providerInstances }),
        ).pipe(
          Layer.provideMerge(
            ServerConfig.ServerConfig.layerTest(process.cwd(), {
              prefix: "t3-claude-accounts-test-",
            }),
          ),
        ),
      ),
    ),
  );
  const config = Context.get(context, ServerConfig.ServerConfig);
  return {
    accounts: Context.get(context, ClaudeAccounts),
    secrets: Context.get(context, ServerSecretStore.ServerSecretStore),
    baseDir: config.baseDir,
    secretsDir: config.secretsDir,
    setups,
    tokens,
    readSetupFiles: (instance: string) =>
      Effect.all([
        fileSystem.readFile(path.join(setups[instance]!.dir, ".credentials.json")),
        fileSystem.readFile(path.join(setups[instance]!.dir, ".claude.json")),
      ]),
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
          return (annotation as { operation?: string } | undefined)?.operation
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
});
