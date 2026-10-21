import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";

import {
  ClaudeLoginFileError,
  readClaudeSetupLogin,
  sameClaudeAccount,
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

it("sameClaudeAccount is true only when account and organization both match", () => {
  assert.isTrue(sameClaudeAccount(identity("a", "o"), identity("a", "o")));
  assert.isTrue(sameClaudeAccount(identity("a", null), identity("a", null)));
  assert.isFalse(sameClaudeAccount(identity("a", "o"), identity("b", "o")));
  assert.isFalse(sameClaudeAccount(identity("a", "o"), identity("a", "p")));
  assert.isFalse(sameClaudeAccount(identity("a", "o"), identity("a", null)));
});
