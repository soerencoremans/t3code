import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";

import {
  ClaudeLoginFileError,
  ClaudeLoginWriteError,
  readClaudeAccountConfigIds,
  readClaudeSetupLogin,
  sameClaudeAccount,
  writeClaudeSetupLogin,
  type ClaudeAccountIdentity,
} from "./claudeLoginFiles.ts";

const SECRET = "tok-9f3a7c1e-unique-secret-value";

const claudeAiOauth = {
  accessToken: SECRET,
  refreshToken: "refresh-4b2d-unique",
  expiresAt: 1_900_000_000_000,
  scopes: ["user:inference"],
  futureKey: { nested: [1, 2] },
};
const oauthAccount = {
  emailAddress: "alice@example.com",
  accountUuid: "acc-1",
  organizationUuid: "org-1",
  displayName: "Alice",
};

const setup = (files: { credentials?: string; account?: string }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const configDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-login-files-test-" });
    const accountConfigPath = path.join(configDir, ".claude.json");
    const credentialsPath = path.join(configDir, ".credentials.json");
    if (files.credentials !== undefined)
      yield* fs.writeFileString(credentialsPath, files.credentials);
    if (files.account !== undefined) yield* fs.writeFileString(accountConfigPath, files.account);
    return { paths: { configDir, accountConfigPath }, credentialsPath };
  });

const credentials = (value: unknown) => JSON.stringify({ claudeAiOauth: value, mcpOAuth: {} });
const account = (value: unknown) => JSON.stringify({ oauthAccount: value, numStartups: 3 });

const identity = (accountUuid: string, organizationUuid: string | null): ClaudeAccountIdentity => ({
  email: "x@example.com",
  accountUuid,
  organizationUuid,
});

it.layer(NodeServices.layer)("readClaudeSetupLogin", (it) => {
  const notLoggedIn = (name: string, files: { credentials?: string; account?: string }) =>
    it.effect(`returns None when ${name}`, () =>
      Effect.gen(function* () {
        const { paths } = yield* setup(files);
        assert.isTrue(Option.isNone(yield* readClaudeSetupLogin(paths)));
      }).pipe(Effect.scoped),
    );

  notLoggedIn("the credentials file is missing", { account: account(oauthAccount) });
  notLoggedIn("claudeAiOauth is not an object", {
    credentials: credentials("nope"),
    account: account(oauthAccount),
  });
  notLoggedIn("claudeAiOauth is absent", {
    credentials: "{}",
    account: account(oauthAccount),
  });
  notLoggedIn("the access token is empty", {
    credentials: credentials({ ...claudeAiOauth, accessToken: "" }),
    account: account(oauthAccount),
  });
  notLoggedIn("the account file is missing", { credentials: credentials(claudeAiOauth) });
  notLoggedIn("oauthAccount has no emailAddress", {
    credentials: credentials(claudeAiOauth),
    account: account({ ...oauthAccount, emailAddress: undefined }),
  });
  notLoggedIn("oauthAccount has no accountUuid", {
    credentials: credentials(claudeAiOauth),
    account: account({ ...oauthAccount, accountUuid: undefined }),
  });

  it.effect("returns both objects verbatim and the identity", () =>
    Effect.gen(function* () {
      const { paths } = yield* setup({
        credentials: credentials(claudeAiOauth),
        account: account(oauthAccount),
      });
      const login = Option.getOrThrow(yield* readClaudeSetupLogin(paths));
      assert.deepEqual(Redacted.value(login.claudeAiOauth), claudeAiOauth);
      assert.deepEqual(login.oauthAccount, oauthAccount);
      assert.deepEqual(login.identity, {
        email: "alice@example.com",
        accountUuid: "acc-1",
        organizationUuid: "org-1",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("reports a missing organizationUuid as null", () =>
    Effect.gen(function* () {
      const { paths } = yield* setup({
        credentials: credentials(claudeAiOauth),
        account: account({ ...oauthAccount, organizationUuid: undefined }),
      });
      const login = Option.getOrThrow(yield* readClaudeSetupLogin(paths));
      assert.strictEqual(login.identity.organizationUuid, null);
    }).pipe(Effect.scoped),
  );

  const unreadable = (name: string, content: string) =>
    it.effect(`fails without leaking content when the credentials file is ${name}`, () =>
      Effect.gen(function* () {
        const { paths, credentialsPath } = yield* setup({
          credentials: content,
          account: account(oauthAccount),
        });
        const error = yield* readClaudeSetupLogin(paths).pipe(Effect.flip);
        assert.instanceOf(error, ClaudeLoginFileError);
        assert.strictEqual(error.path, credentialsPath);
        assert.notInclude(JSON.stringify(error), SECRET);
        assert.notInclude(error.message, SECRET);
      }).pipe(Effect.scoped),
    );

  unreadable("not JSON", `{"claudeAiOauth": {"accessToken": "${SECRET}"`);
  unreadable("a JSON array", JSON.stringify([SECRET]));
});

it.layer(NodeServices.layer)("readClaudeAccountConfigIds", (it) => {
  const idsOf = (content: string | undefined) =>
    Effect.gen(function* () {
      const { paths } = yield* setup(content === undefined ? {} : { account: content });
      return yield* readClaudeAccountConfigIds(paths.accountConfigPath);
    }).pipe(Effect.scoped);

  it.effect("returns the organization and the account", () =>
    Effect.gen(function* () {
      const ids = yield* idsOf(account({ organizationUuid: "org-a", accountUuid: "acct-work" }));
      assert.deepStrictEqual(ids, { organizationUuid: "org-a", accountUuid: "acct-work" });
    }),
  );

  it.effect("returns an undefined account when the file has no accountUuid", () =>
    Effect.gen(function* () {
      const ids = yield* idsOf(account({ organizationUuid: "org-a" }));
      assert.deepStrictEqual(ids, { organizationUuid: "org-a", accountUuid: undefined });
    }),
  );

  // A missing file is "not logged in", the same as a file without `oauthAccount`.
  it.effect("returns no organization and no account for a missing file", () =>
    Effect.gen(function* () {
      const ids = yield* idsOf(undefined);
      assert.deepStrictEqual(ids, { organizationUuid: undefined, accountUuid: undefined });
    }),
  );

  it.effect("returns undefined for a file that is not JSON", () =>
    Effect.gen(function* () {
      assert.isUndefined(yield* idsOf(`{"oauthAccount": {"accountUuid": "acct-work"`));
    }),
  );
});

it("sameClaudeAccount is true only when account and organization both match", () => {
  assert.isTrue(sameClaudeAccount(identity("a", "o"), identity("a", "o")));
  assert.isTrue(sameClaudeAccount(identity("a", null), identity("a", null)));
  assert.isFalse(sameClaudeAccount(identity("a", "o"), identity("b", "o")));
  assert.isFalse(sameClaudeAccount(identity("a", "o"), identity("a", "p")));
  assert.isFalse(sameClaudeAccount(identity("a", "o"), identity("a", null)));
});

const NEW_SECRET = "tok-2c8e5d0a-unique-new-secret";

const newLogin = {
  claudeAiOauth: Redacted.make({ accessToken: NEW_SECRET, scopes: ["user:inference"] }),
  oauthAccount: { emailAddress: "bob@example.com", accountUuid: "acc-2" },
};

const modeOf = (filePath: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.stat(filePath)),
    Effect.map((info) => info.mode & 0o777),
  );

// Key order matters: the swap must not reshuffle the files the Claude CLI also writes.
const loginFixture = (credentialsMode: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const fixture = yield* setup({
      credentials: JSON.stringify(
        { mcpOAuth: { srv: { accessToken: "mcp-7d1f-unique" } }, claudeAiOauth, extra: [1] },
        null,
        2,
      ),
      account: JSON.stringify({ numStartups: 3, oauthAccount, projects: { "/x": {} } }, null, 2),
    });
    yield* fs.chmod(fixture.credentialsPath, credentialsMode);
    yield* fs.chmod(fixture.paths.accountConfigPath, 0o644);
    return fixture;
  });

const renameFault = (failing: (to: string, renamesToCredentials: number) => boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    let credentialsRenames = 0;
    return FileSystem.make({
      ...fs,
      rename: (from, to) => {
        if (path.basename(to) === ".credentials.json") credentialsRenames += 1;
        return failing(to, credentialsRenames)
          ? Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "rename",
                pathOrDescriptor: to,
                description: `denied ${NEW_SECRET}`,
              }),
            )
          : fs.rename(from, to);
      },
    });
  });

it.layer(NodeServices.layer)("writeClaudeSetupLogin", (it) => {
  it.effect.each([0o600, 0o644])(
    "replaces both logins, keeps other keys in order and narrows credentials (from mode %o)",
    (credentialsMode) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { paths, credentialsPath } = yield* loginFixture(credentialsMode);
        const beforeCredentials = JSON.parse(yield* fs.readFileString(credentialsPath));
        const beforeAccount = JSON.parse(yield* fs.readFileString(paths.accountConfigPath));

        yield* writeClaudeSetupLogin(paths, newLogin);

        const afterCredentials = JSON.parse(yield* fs.readFileString(credentialsPath));
        const afterAccount = JSON.parse(yield* fs.readFileString(paths.accountConfigPath));
        assert.deepStrictEqual(afterCredentials, {
          ...beforeCredentials,
          claudeAiOauth: Redacted.value(newLogin.claudeAiOauth),
        });
        assert.deepStrictEqual(afterAccount, {
          ...beforeAccount,
          oauthAccount: newLogin.oauthAccount,
        });
        assert.deepStrictEqual(Object.keys(afterCredentials), Object.keys(beforeCredentials));
        assert.deepStrictEqual(Object.keys(afterAccount), Object.keys(beforeAccount));
        assert.strictEqual(yield* modeOf(credentialsPath), 0o600);
        assert.strictEqual(yield* modeOf(paths.accountConfigPath), 0o644);
        assert.deepStrictEqual((yield* fs.readDirectory(paths.configDir)).toSorted(), [
          ".claude.json",
          ".credentials.json",
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect("writes through a symlinked .claude.json and keeps the link", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { paths } = yield* loginFixture(0o600);
      const other = yield* fs.makeTempDirectoryScoped({ prefix: "t3-login-files-other-" });
      const destination = path.join(other, "claude.json");
      yield* fs.rename(paths.accountConfigPath, destination);
      yield* fs.symlink(destination, paths.accountConfigPath);

      yield* writeClaudeSetupLogin(paths, newLogin);

      assert.strictEqual(yield* fs.readLink(paths.accountConfigPath), destination);
      assert.deepStrictEqual(JSON.parse(yield* fs.readFileString(destination)).oauthAccount, {
        ...newLogin.oauthAccount,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("fails before writing when a file is missing or not a JSON object", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { paths, credentialsPath } = yield* loginFixture(0o600);
      const before = yield* fs.readFileString(credentialsPath);
      yield* fs.writeFileString(paths.accountConfigPath, "[1]");

      const notObject = yield* Effect.flip(writeClaudeSetupLogin(paths, newLogin));
      yield* fs.remove(paths.accountConfigPath);
      const missing = yield* Effect.flip(writeClaudeSetupLogin(paths, newLogin));

      assert.deepStrictEqual(
        [notObject, missing].map((error) => [error.path, error.restored]),
        [
          [paths.accountConfigPath, true],
          [paths.accountConfigPath, true],
        ],
      );
      assert.strictEqual(yield* fs.readFileString(credentialsPath), before);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "restores .credentials.json byte-identically when .claude.json cannot be replaced",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { paths, credentialsPath } = yield* loginFixture(0o644);
        const before = yield* fs.readFileString(credentialsPath);
        const faulty = yield* renameFault((to) => to.endsWith(".claude.json"));

        const error = yield* writeClaudeSetupLogin(paths, newLogin).pipe(
          Effect.provideService(FileSystem.FileSystem, faulty),
          Effect.flip,
        );

        assert.instanceOf(error, ClaudeLoginWriteError);
        assert.strictEqual(error.path, paths.accountConfigPath);
        assert.isTrue(error.restored);
        assert.strictEqual(yield* fs.readFileString(credentialsPath), before);
        assert.strictEqual(yield* modeOf(credentialsPath), 0o600);
        assert.notInclude(JSON.stringify(error), NEW_SECRET);
        assert.notInclude(error.message, NEW_SECRET);
        assert.deepStrictEqual((yield* fs.readDirectory(paths.configDir)).toSorted(), [
          ".claude.json",
          ".credentials.json",
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect("reports restored: false when the rollback fails too", () =>
    Effect.gen(function* () {
      const { paths } = yield* loginFixture(0o600);
      const faulty = yield* renameFault(
        (to, credentialsRenames) =>
          to.endsWith(".claude.json") ||
          (to.endsWith(".credentials.json") && credentialsRenames > 1),
      );

      const error = yield* writeClaudeSetupLogin(paths, newLogin).pipe(
        Effect.provideService(FileSystem.FileSystem, faulty),
        Effect.flip,
      );

      assert.strictEqual(error.path, paths.accountConfigPath);
      assert.isFalse(error.restored);
      assert.notInclude(JSON.stringify(error), NEW_SECRET);
      assert.notInclude(error.message, NEW_SECRET);
    }).pipe(Effect.scoped),
  );
});
