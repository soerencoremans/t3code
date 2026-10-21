import type { ClaudeSettings } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";

import { probeClaudeCapabilities } from "./ClaudeProvider.ts";
import { readClaudeSetupLogin, type JsonObject } from "./claudeLoginFiles.ts";

export interface ClaudeLoginCheckResult {
  readonly verdict: "Valid" | "NeedsLogin" | "Unknown";
  /** What the throwaway dir holds after the probe, renewed or not. */
  readonly latestClaudeAiOauth: Option.Option<Redacted.Redacted<JsonObject>>;
}

export class ClaudeLoginCheck extends Context.Service<
  ClaudeLoginCheck,
  {
    readonly check: (input: {
      readonly claudeAiOauth: Redacted.Redacted<JsonObject>;
      readonly oauthAccount: JsonObject;
      /** The setup's settings; `homePath` is replaced by the throwaway dir. */
      readonly settings: ClaudeSettings;
      /** The setup's merged environment. */
      readonly environment: NodeJS.ProcessEnv;
    }) => Effect.Effect<ClaudeLoginCheckResult>;
  }
>()("t3/provider/ClaudeLoginCheck") {}

export type ClaudeLoginCheckProbeRequirements = Effect.Services<
  ReturnType<typeof probeClaudeCapabilities>
>;

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

type CheckInput = Parameters<(typeof ClaudeLoginCheck)["Service"]["check"]>[0];

const hasFutureExpiry = (claudeAiOauth: JsonObject, nowMillis: number) =>
  typeof claudeAiOauth.expiresAt === "number" && claudeAiOauth.expiresAt > nowMillis;

// A failed usage request on a fresh access token is not a rejected login, so it stays Unknown.
const judge = (input: {
  readonly probeSucceeded: boolean;
  readonly hasUsage: boolean;
  readonly latest: Option.Option<Redacted.Redacted<JsonObject>>;
  readonly nowMillis: number;
}): ClaudeLoginCheckResult["verdict"] => {
  if (!input.probeSucceeded) return "Unknown";
  if (input.hasUsage) return Option.isSome(input.latest) ? "Valid" : "Unknown";
  return Option.isSome(input.latest) &&
    hasFutureExpiry(Redacted.value(input.latest.value), input.nowMillis)
    ? "Unknown"
    : "NeedsLogin";
};

export const layerWithProbe = (
  probe: typeof probeClaudeCapabilities,
): Layer.Layer<
  ClaudeLoginCheck,
  never,
  FileSystem.FileSystem | Path.Path | ClaudeLoginCheckProbeRequirements
> =>
  Layer.effect(
    ClaudeLoginCheck,
    Effect.gen(function* () {
      const services = yield* Effect.context<
        FileSystem.FileSystem | Path.Path | ClaudeLoginCheckProbeRequirements
      >();

      const check = Effect.fn("ClaudeLoginCheck.check")(function* (input: CheckInput) {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-login-check-",
        });
        const accountConfigPath = path.join(tempDir, ".claude.json");
        yield* writeFileStringAtomically({
          filePath: path.join(tempDir, ".credentials.json"),
          contents: encodeJson({ claudeAiOauth: Redacted.value(input.claudeAiOauth) }),
          mode: 0o600,
        });
        yield* writeFileStringAtomically({
          filePath: accountConfigPath,
          contents: encodeJson({ oauthAccount: input.oauthAccount }),
          mode: 0o600,
        });

        const probed = yield* probe(
          { ...input.settings, homePath: tempDir },
          input.environment,
          undefined,
          true,
        ).pipe(Effect.result);
        const latest = yield* readClaudeSetupLogin({
          configDir: tempDir,
          accountConfigPath,
        }).pipe(
          Effect.map(Option.map((login) => login.claudeAiOauth)),
          Effect.orElseSucceed(() => Option.none<Redacted.Redacted<JsonObject>>()),
        );
        const now = yield* DateTime.now;
        const verdict = judge({
          probeSucceeded: Result.isSuccess(probed),
          hasUsage: Result.isSuccess(probed) && probed.success.usage !== undefined,
          latest,
          nowMillis: DateTime.toEpochMillis(now),
        });
        yield* Effect.logInfo("Claude login check finished.", { verdict });
        return { verdict, latestClaudeAiOauth: latest } satisfies ClaudeLoginCheckResult;
      });

      return ClaudeLoginCheck.of({
        check: (input) =>
          check(input).pipe(
            Effect.scoped,
            // The check never fails: a throwaway dir it cannot prepare is an Unknown verdict.
            Effect.catch(() =>
              Effect.succeed<ClaudeLoginCheckResult>({
                verdict: "Unknown",
                latestClaudeAiOauth: Option.none(),
              }),
            ),
            Effect.provideContext(services),
          ),
      });
    }),
  );

export const layer = layerWithProbe(probeClaudeCapabilities);
