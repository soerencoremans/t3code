import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { resolveSymlinkTarget } from "@t3tools/shared/symlink";

import type { ClaudeSetupPaths } from "./Drivers/ClaudeHome.ts";

export type JsonObject = { readonly [key: string]: unknown };

export interface ClaudeAccountIdentity {
  readonly email: string;
  readonly accountUuid: string;
  readonly organizationUuid: string | null;
}

export interface ClaudeSetupLogin {
  /** The whole `claudeAiOauth` value from `.credentials.json`, verbatim. */
  readonly claudeAiOauth: Redacted.Redacted<JsonObject>;
  /** The whole `oauthAccount` value from `.claude.json`, verbatim. */
  readonly oauthAccount: JsonObject;
  readonly identity: ClaudeAccountIdentity;
}

// Carries only the path: a parse cause can quote the file's content, which is a login.
export class ClaudeLoginFileError extends Schema.TaggedError<ClaudeLoginFileError>()(
  "ClaudeLoginFileError",
  { path: Schema.String },
) {
  override get message(): string {
    return `Could not read the Claude login file ${this.path}.`;
  }
}

export const sameClaudeAccount = (a: ClaudeAccountIdentity, b: ClaudeAccountIdentity): boolean =>
  a.accountUuid === b.accountUuid && a.organizationUuid === b.organizationUuid;

const decodeJsonObject = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

// A missing file is "not logged in"; any other failure is an error that names only the path.
const readJsonObject = Effect.fn("claudeLoginFiles.readJsonObject")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const text = yield* fileSystem.readFileString(path).pipe(
    Effect.asSome,
    Effect.catch((cause) =>
      cause.reason._tag === "NotFound"
        ? Effect.succeedNone
        : Effect.fail(new ClaudeLoginFileError({ path })),
    ),
  );
  if (Option.isNone(text)) return Option.none<JsonObject>();
  return Option.some(
    yield* decodeJsonObject(text.value).pipe(
      Effect.mapError(() => new ClaudeLoginFileError({ path })),
    ),
  );
});

const asObject = (value: unknown): JsonObject | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

export const claudeAccountIdentity = (
  oauthAccount: JsonObject,
): Option.Option<ClaudeAccountIdentity> => {
  const email = nonEmptyString(oauthAccount.emailAddress);
  const accountUuid = nonEmptyString(oauthAccount.accountUuid);
  return email === undefined || accountUuid === undefined
    ? Option.none()
    : Option.some({
        email,
        accountUuid,
        organizationUuid: nonEmptyString(oauthAccount.organizationUuid) ?? null,
      });
};

export interface ClaudeAccountConfigIds {
  readonly organizationUuid: string | undefined;
  readonly accountUuid: string | undefined;
}

// `undefined` means the file could not be read or parsed, so it says nothing about the account.
export const readClaudeAccountConfigIds = (
  accountConfigPath: string,
): Effect.Effect<ClaudeAccountConfigIds | undefined, never, FileSystem.FileSystem> =>
  readJsonObject(accountConfigPath).pipe(
    Effect.map((file): ClaudeAccountConfigIds => {
      const account = Option.isSome(file) ? asObject(file.value.oauthAccount) : undefined;
      return {
        organizationUuid: nonEmptyString(account?.organizationUuid)?.trim() || undefined,
        accountUuid: nonEmptyString(account?.accountUuid),
      };
    }),
    Effect.orElseSucceed(() => undefined),
  );

export const readClaudeSetupLogin = Effect.fn("claudeLoginFiles.readClaudeSetupLogin")(function* (
  paths: ClaudeSetupPaths,
) {
  const credentials = yield* readJsonObject(`${paths.configDir}/.credentials.json`);
  const claudeAiOauth = Option.isSome(credentials)
    ? asObject(credentials.value.claudeAiOauth)
    : undefined;
  if (claudeAiOauth === undefined || nonEmptyString(claudeAiOauth.accessToken) === undefined) {
    return Option.none<ClaudeSetupLogin>();
  }
  const accountFile = yield* readJsonObject(paths.accountConfigPath);
  const oauthAccount = Option.isSome(accountFile)
    ? asObject(accountFile.value.oauthAccount)
    : undefined;
  const identity = oauthAccount === undefined ? Option.none() : claudeAccountIdentity(oauthAccount);
  if (oauthAccount === undefined || Option.isNone(identity)) return Option.none<ClaudeSetupLogin>();
  return Option.some<ClaudeSetupLogin>({
    claudeAiOauth: Redacted.make(claudeAiOauth),
    oauthAccount,
    identity: identity.value,
  });
});

// Never carries a cause: a write error's cause can quote the file's content, which is a login.
export class ClaudeLoginWriteError extends Schema.TaggedError<ClaudeLoginWriteError>()(
  "ClaudeLoginWriteError",
  {
    /** The file whose read or write failed first. */
    path: Schema.String,
    /** True when every file already written was put back. */
    restored: Schema.Boolean,
  },
) {
  override get message(): string {
    return `Could not write the Claude login file ${this.path}.`;
  }
}

// Matches the Claude CLI's own two-space layout.
const serializeLoginFile = (value: JsonObject) => JSON.stringify(value, null, 2);

interface LoginFile {
  readonly path: string;
  readonly text: string;
  readonly parsed: JsonObject;
  readonly mode: number;
}

const readLoginFile = Effect.fn("claudeLoginFiles.readLoginFile")(function* (filePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* resolveSymlinkTarget(filePath);
  const text = yield* fileSystem.readFileString(path);
  const info = yield* fileSystem.stat(path);
  const parsed = yield* decodeJsonObject(text);
  return { path, text, parsed, mode: info.mode } satisfies LoginFile;
});

export const writeClaudeSetupLogin = Effect.fn("claudeLoginFiles.writeClaudeSetupLogin")(function* (
  paths: ClaudeSetupPaths,
  login: {
    readonly claudeAiOauth: Redacted.Redacted<JsonObject>;
    readonly oauthAccount: JsonObject;
  },
) {
  const path = yield* Path.Path;
  const credentialsPath = path.join(paths.configDir, ".credentials.json");
  // Reads and writes drop their cause: it can quote the file's content, which is a login.
  const failed = (failedPath: string, restored: boolean) =>
    Effect.fail(new ClaudeLoginWriteError({ path: failedPath, restored }));
  const read = (filePath: string) =>
    readLoginFile(filePath).pipe(Effect.catch(() => failed(filePath, true)));
  const credentials = yield* read(credentialsPath);
  const account = yield* read(paths.accountConfigPath);

  // `.credentials.json` is never wider than 0o600, whatever it was before.
  const credentialsMode = credentials.mode & 0o600;
  yield* writeFileStringAtomically({
    filePath: credentialsPath,
    contents: serializeLoginFile({
      ...credentials.parsed,
      claudeAiOauth: Redacted.value(login.claudeAiOauth),
    }),
    mode: credentialsMode,
  }).pipe(Effect.catch(() => failed(credentialsPath, true)));

  yield* writeFileStringAtomically({
    filePath: paths.accountConfigPath,
    contents: serializeLoginFile({ ...account.parsed, oauthAccount: login.oauthAccount }),
    mode: account.mode & 0o777,
  }).pipe(
    Effect.catch(() =>
      writeFileStringAtomically({
        filePath: credentialsPath,
        contents: credentials.text,
        mode: credentialsMode,
      }).pipe(
        Effect.matchEffect({
          onSuccess: () => failed(paths.accountConfigPath, true),
          onFailure: () => failed(paths.accountConfigPath, false),
        }),
      ),
    ),
  );
});
