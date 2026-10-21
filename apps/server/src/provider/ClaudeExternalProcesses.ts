import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { CLAUDE_OWNER_PID_ENV } from "./Drivers/ClaudeHome.ts";

export class ClaudeProcessScanError extends Schema.TaggedError<ClaudeProcessScanError>()(
  "ClaudeProcessScanError",
  {
    // listFailed: procRoot could not be listed; processUnreadable: a same-user Claude program's
    // environ could not be read; timeout: the scan exceeded CLAUDE_PROCESS_SCAN_TIMEOUT
    reason: Schema.Literals(["listFailed", "processUnreadable", "timeout"]),
  },
) {
  override get message(): string {
    return "Could not check the running processes.";
  }
}

export const CLAUDE_PROCESS_SCAN_TIMEOUT = Duration.seconds(5);

export class ClaudeExternalProcesses extends Context.Service<
  ClaudeExternalProcesses,
  {
    /** Pids, ascending, of Claude programs not spawned by this server whose config dir resolves to `configDir`. */
    readonly findUsing: (
      configDir: string,
    ) => Effect.Effect<ReadonlyArray<number>, ClaudeProcessScanError>;
  }
>()("t3/provider/ClaudeExternalProcesses") {}

const PID_ENTRY = /^[1-9][0-9]*$/;
const CLAUDE_PACKAGE = "@anthropic-ai/claude-code";
const OWNER_PREFIX = `${CLAUDE_OWNER_PID_ENV}=`;
const CONFIG_DIR_PREFIX = "CLAUDE_CONFIG_DIR=";
const HOME_PREFIX = "HOME=";

const splitNul = (text: string) => {
  const parts = text.split("\0");
  if (parts.at(-1) === "") parts.pop();
  return parts;
};

const isClaudeProgram = (argv: ReadonlyArray<string>, basename: (p: string) => string) =>
  basename(argv[0]!) === "claude" || argv.slice(0, 2).some((arg) => arg.includes(CLAUDE_PACKAGE));

// Only the three keys are taken; the rest of the buffer holds the user's API keys.
const extractClaudeEnvironment = (environ: string) => {
  let owner: string | undefined;
  let configDir: string | undefined;
  let home: string | undefined;
  for (const entry of environ.split("\0")) {
    if (entry.startsWith(OWNER_PREFIX)) owner = entry.slice(OWNER_PREFIX.length);
    else if (entry.startsWith(CONFIG_DIR_PREFIX)) configDir = entry.slice(CONFIG_DIR_PREFIX.length);
    else if (entry.startsWith(HOME_PREFIX)) home = entry.slice(HOME_PREFIX.length);
  }
  return { owner, configDir, home };
};

export const layerWith = (options: {
  readonly procRoot: string;
}): Layer.Layer<ClaudeExternalProcesses, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    ClaudeExternalProcesses,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { procRoot } = options;

      const canonical = (p: string) => {
        const resolved = path.resolve(p);
        return fileSystem.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved));
      };

      const unreadable = () => new ClaudeProcessScanError({ reason: "processUnreadable" });

      // Another user's process cannot use this user's login files; anything else fails closed.
      const skipIfOtherUser = Effect.fn("ClaudeExternalProcesses.skipIfOtherUser")(function* (
        pidDir: string,
      ) {
        const userId = yield* HostProcess.UserId;
        const owner = yield* fileSystem.stat(pidDir).pipe(
          Effect.map((info) => Option.getOrUndefined(info.uid)),
          Effect.orElseSucceed(() => undefined),
        );
        if (userId === undefined || owner === undefined || owner === userId) {
          return yield* unreadable();
        }
        return Option.none<string>();
      });

      const configDirOf = Effect.fn("ClaudeExternalProcesses.configDirOf")(function* (pid: string) {
        const pidDir = path.join(procRoot, pid);
        const argv = yield* fileSystem.readFileString(path.join(pidDir, "cmdline")).pipe(
          Effect.map(splitNul),
          Effect.orElseSucceed((): ReadonlyArray<string> => []),
        );
        if (argv.length === 0 || !isClaudeProgram(argv, path.basename)) return Option.none();
        const environ = yield* fileSystem.readFileString(path.join(pidDir, "environ")).pipe(
          Effect.map(Option.some),
          Effect.catch((error) =>
            error.reason._tag === "NotFound"
              ? Effect.succeed(Option.none<string>())
              : skipIfOtherUser(pidDir),
          ),
        );
        if (Option.isNone(environ)) return Option.none();
        const { owner, configDir, home } = extractClaudeEnvironment(environ.value);
        if (owner === String(yield* HostProcess.ProcessId)) return Option.none();
        if (configDir !== undefined && configDir.trim().length > 0) {
          return Option.some(yield* canonical(configDir));
        }
        const homeDir =
          home !== undefined && home.length > 0 ? home : yield* HostProcess.HomeDirectory;
        return Option.some(yield* canonical(path.join(homeDir, ".claude")));
      });

      const findUsing = Effect.fn("ClaudeExternalProcesses.findUsing")(
        function* (configDir: string) {
          const target = yield* canonical(configDir);
          const entries = yield* fileSystem
            .readDirectory(procRoot)
            .pipe(Effect.mapError(() => new ClaudeProcessScanError({ reason: "listFailed" })));
          const pids = entries.filter((entry) => PID_ENTRY.test(entry));
          const matches = yield* Effect.forEach(
            pids,
            (pid) =>
              Effect.map(configDirOf(pid), (dir) =>
                Option.isSome(dir) && dir.value === target ? [Number(pid)] : [],
              ),
            { concurrency: 16 },
          );
          return matches.flat().sort((a, b) => a - b) as ReadonlyArray<number>;
        },
        // A read of a stuck process's /proc files can block, and the scan runs inside the accounts lock.
        Effect.timeoutOrElse({
          duration: CLAUDE_PROCESS_SCAN_TIMEOUT,
          orElse: () => Effect.fail(new ClaudeProcessScanError({ reason: "timeout" })),
        }),
      );

      return ClaudeExternalProcesses.of({ findUsing });
    }),
  );

export const layer = layerWith({ procRoot: "/proc" });
