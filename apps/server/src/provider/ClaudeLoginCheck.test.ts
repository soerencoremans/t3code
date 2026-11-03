import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ClaudeLoginCheck from "./ClaudeLoginCheck.ts";
import type { probeClaudeCapabilities } from "./ClaudeProvider.ts";
import type { JsonObject } from "./claudeLoginFiles.ts";

const NOW = 1_800_000_000_000;
const PAST = NOW - 60_000;
const FUTURE = NOW + 60_000;

const savedOauth = {
  accessToken: "access-saved-7c1e-unique",
  refreshToken: "refresh-saved-4b2d-unique",
  expiresAt: PAST,
  scopes: ["user:inference"],
};
const renewedOauth = {
  accessToken: "access-renewed-9a5f-unique",
  refreshToken: "refresh-renewed-1e8c-unique",
  expiresAt: FUTURE,
  scopes: ["user:inference"],
};
const oauthAccount = {
  emailAddress: "alice@example.com",
  accountUuid: "acc-1",
  organizationUuid: "org-1",
};

const settings = Schema.decodeSync(ClaudeSettings)({
  binaryPath: "/opt/claude/bin/claude",
  homePath: "/home/setup/.claude-original",
});
const environment: NodeJS.ProcessEnv = { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/somewhere/else" };

type Probe = typeof probeClaudeCapabilities;
type ProbeSuccess = Effect.Success<ReturnType<Probe>>;

interface ProbeScript {
  /** What the probe does to the throwaway dir's `.credentials.json` before it returns. */
  readonly rewriteCredentials?: (
    configDir: string,
  ) => Effect.Effect<void, never, FileSystem.FileSystem | Path.Path>;
  readonly outcome: "usage" | "noUsage" | "failure";
}

interface ProbeCall {
  readonly settings: ClaudeSettings;
  readonly environment: NodeJS.ProcessEnv | undefined;
  readonly cwd: string | undefined;
  readonly includeUsage: boolean | undefined;
  readonly homePath: string;
  readonly credentialsText: string;
  readonly credentialsMode: number;
  readonly accountText: string;
}

const baseProbeSuccess = {
  email: undefined,
  subscriptionType: undefined,
  tokenSource: undefined,
  apiKeySource: undefined,
  apiProvider: undefined,
  slashCommands: [],
} as const;

const makeFakeProbe = (script: ProbeScript) => {
  const calls: Array<ProbeCall> = [];
  const probe: Probe = (probeSettings, probeEnvironment, cwd, includeUsage) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homePath = probeSettings.homePath;
      const credentialsPath = path.join(homePath, ".credentials.json");
      const call = yield* Effect.gen(function* () {
        return {
          settings: probeSettings,
          environment: probeEnvironment,
          cwd,
          includeUsage,
          homePath,
          credentialsText: yield* fs.readFileString(credentialsPath),
          credentialsMode: (yield* fs.stat(credentialsPath)).mode & 0o777,
          accountText: yield* fs.readFileString(path.join(homePath, ".claude.json")),
        } satisfies ProbeCall;
      }).pipe(Effect.orDie);
      calls.push(call);
      if (script.rewriteCredentials) yield* script.rewriteCredentials(homePath);
      if (script.outcome === "failure") {
        return yield* Effect.fail(new Error("probe failed") as never);
      }
      return (
        script.outcome === "usage"
          ? {
              ...baseProbeSuccess,
              usage: { rate_limits_available: true, rate_limits: [] },
              usageCheckedAt: "2027-01-15T08:00:00.000Z",
            }
          : baseProbeSuccess
      ) as ProbeSuccess;
    }) as ReturnType<Probe>;
  return { probe, calls };
};

const writeCredentials = (oauth: JsonObject | string) => (configDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(
      path.join(configDir, ".credentials.json"),
      typeof oauth === "string" ? oauth : JSON.stringify({ claudeAiOauth: oauth }),
    );
  }).pipe(Effect.orDie);

const runCheck = (script: ProbeScript) => {
  const { probe, calls } = makeFakeProbe(script);
  return Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const service = yield* ClaudeLoginCheck.ClaudeLoginCheck;
    const result = yield* service.check({
      claudeAiOauth: Redacted.make(savedOauth),
      oauthAccount,
      settings,
      environment,
    });
    return { result, calls };
  }).pipe(Effect.provide(ClaudeLoginCheck.layerWithProbe(probe)));
};

const latest = (result: ClaudeLoginCheck.ClaudeLoginCheckResult) =>
  Option.map(result.latestClaudeAiOauth, Redacted.value);

it.layer(NodeServices.layer)("ClaudeLoginCheck", (it) => {
  it.effect("probes with usage in a fresh temp dir holding the saved login", () =>
    Effect.gen(function* () {
      const { calls } = yield* runCheck({ outcome: "usage" });
      assert.strictEqual(calls.length, 1);
      const [call] = calls;
      assert.strictEqual(call?.includeUsage, true);
      assert.notStrictEqual(call?.homePath, settings.homePath);
      assert.deepStrictEqual(JSON.parse(call?.credentialsText ?? ""), {
        claudeAiOauth: savedOauth,
      });
      assert.strictEqual(call?.credentialsMode, 0o600);
      assert.deepStrictEqual(JSON.parse(call?.accountText ?? ""), { oauthAccount });
    }),
  );

  it.effect("removes the temp dir after the check", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { calls } = yield* runCheck({ outcome: "usage" });
      assert.isFalse(yield* fs.exists(calls[0]?.homePath ?? ""));
    }),
  );

  it.effect("removes the temp dir when the probe fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { calls } = yield* runCheck({ outcome: "failure" });
      assert.strictEqual(calls.length, 1);
      assert.isFalse(yield* fs.exists(calls[0]?.homePath ?? ""));
    }),
  );

  it.effect("hands the probe the setup's binary and environment, replacing only homePath", () =>
    Effect.gen(function* () {
      const { calls } = yield* runCheck({ outcome: "usage" });
      const call = calls[0];
      assert.deepStrictEqual(call?.settings, { ...settings, homePath: call?.homePath });
      assert.deepStrictEqual(call?.environment, environment);
      assert.isUndefined(call?.cwd);
    }),
  );

  it.effect("is Valid with the renewed login when the probe returns usage after a renewal", () =>
    Effect.gen(function* () {
      const { result } = yield* runCheck({
        outcome: "usage",
        rewriteCredentials: writeCredentials(renewedOauth),
      });
      assert.strictEqual(result.verdict, "Valid");
      assert.deepStrictEqual(latest(result), Option.some(renewedOauth));
    }),
  );

  it.effect("is Valid with the saved login when the probe left the files alone", () =>
    Effect.gen(function* () {
      const { result } = yield* runCheck({ outcome: "usage" });
      assert.strictEqual(result.verdict, "Valid");
      assert.deepStrictEqual(latest(result), Option.some(savedOauth));
    }),
  );

  it.effect("needs a login when there is no usage and the login is expired", () =>
    Effect.gen(function* () {
      const { result } = yield* runCheck({ outcome: "noUsage" });
      assert.strictEqual(result.verdict, "NeedsLogin");
      assert.deepStrictEqual(latest(result), Option.some(savedOauth));
    }),
  );

  it.effect(
    "is Unknown, with the renewed login, when there is no usage but the login is fresh",
    () =>
      Effect.gen(function* () {
        const { result } = yield* runCheck({
          outcome: "noUsage",
          rewriteCredentials: writeCredentials(renewedOauth),
        });
        assert.strictEqual(result.verdict, "Unknown");
        assert.deepStrictEqual(latest(result), Option.some(renewedOauth));
      }),
  );

  it.effect("needs a login when there is no usage and expiresAt is missing", () =>
    Effect.gen(function* () {
      const { expiresAt: _expiresAt, ...withoutExpiry } = renewedOauth;
      const { result } = yield* runCheck({
        outcome: "noUsage",
        rewriteCredentials: writeCredentials(withoutExpiry),
      });
      assert.strictEqual(result.verdict, "NeedsLogin");
    }),
  );

  it.effect("needs a login when there is no usage and expiresAt is not a number", () =>
    Effect.gen(function* () {
      const { result } = yield* runCheck({
        outcome: "noUsage",
        rewriteCredentials: writeCredentials({ ...renewedOauth, expiresAt: String(FUTURE) }),
      });
      assert.strictEqual(result.verdict, "NeedsLogin");
    }),
  );

  it.effect("is Unknown when the probe fails, and still reports what the dir holds", () =>
    Effect.gen(function* () {
      const { result } = yield* runCheck({
        outcome: "failure",
        rewriteCredentials: writeCredentials(renewedOauth),
      });
      assert.strictEqual(result.verdict, "Unknown");
      assert.deepStrictEqual(latest(result), Option.some(renewedOauth));
    }),
  );

  it.effect("reports no login and Unknown when the read-back fails after a failed probe", () =>
    Effect.gen(function* () {
      const { result } = yield* runCheck({
        outcome: "failure",
        rewriteCredentials: writeCredentials("{ not json"),
      });
      assert.strictEqual(result.verdict, "Unknown");
      assert.isTrue(Option.isNone(result.latestClaudeAiOauth));
    }),
  );

  it.effect("is Unknown, not Valid, when usage came back but the read-back fails", () =>
    Effect.gen(function* () {
      const { result } = yield* runCheck({
        outcome: "usage",
        rewriteCredentials: writeCredentials("{ not json"),
      });
      assert.strictEqual(result.verdict, "Unknown");
      assert.isTrue(Option.isNone(result.latestClaudeAiOauth));
    }),
  );

  it.effect("is Unknown without probing when the temp dir cannot be prepared", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const noTempDir = FileSystem.make({
        ...fs,
        makeTempDirectory: (options) =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "makeTempDirectory",
              pathOrDescriptor: options?.prefix ?? "",
            }),
          ),
      });
      const { result, calls } = yield* runCheck({ outcome: "usage" }).pipe(
        Effect.provideService(FileSystem.FileSystem, noTempDir),
      );
      assert.strictEqual(calls.length, 0);
      assert.strictEqual(result.verdict, "Unknown");
      assert.isTrue(Option.isNone(result.latestClaudeAiOauth));
    }),
  );
});
