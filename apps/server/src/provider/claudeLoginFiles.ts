import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

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
