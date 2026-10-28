import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";

const quotePath = Schema.encodeSync(Schema.fromJsonString(Schema.String));

export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    return path.resolve(expandHomePath(homePath, home));
  }
  // Inherited env vars are not shell-expanded, so a literal `~` stays literal.
  const inherited = environment?.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (inherited.length > 0) {
    return path.resolve(inherited);
  }
  return path.resolve(path.join(home, ".claude"));
});

export interface ClaudeSetupPaths {
  readonly configDir: string;
  readonly accountConfigPath: string;
}

/** Where a setup keeps its login (`.credentials.json`) and its account file (`.claude.json`). */
export const resolveClaudeSetupPaths = Effect.fn("resolveClaudeSetupPaths")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ClaudeSetupPaths, never, Path.Path> {
  const path = yield* Path.Path;
  const configDir = yield* resolveClaudeHomePath(config, environment);
  // Without a config dir the Claude CLI keeps `.claude.json` beside `~/.claude`, not inside it.
  const hasConfigDir =
    config.homePath.trim().length > 0 || (environment?.CLAUDE_CONFIG_DIR?.trim() ?? "").length > 0;
  const accountConfigPath = hasConfigDir
    ? path.join(configDir, ".claude.json")
    : path.join(yield* HostProcess.HomeDirectory, ".claude.json");
  return { configDir, accountConfigPath };
});

/**
 * Marks a Claude CLI as spawned by this server, so the account switch can tell
 * T3's own programs from ones the user started. A cooperative tag, not proof of
 * origin: any process of the same user can set it.
 */
export const CLAUDE_OWNER_PID_ENV = "T3CODE_CLAUDE_OWNER_PID";

/** The environment of a Claude CLI that T3 spawns itself, always marked with the owner pid. */
export const makeClaudeEnvironment = Effect.fn("makeClaudeEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const environment = yield* makeClaudeTerminalEnvironment(config, baseEnv);
  return { ...environment, [CLAUDE_OWNER_PID_ENV]: String(yield* HostProcess.ProcessId) };
});

/**
 * The environment for a user's terminal, which is outside T3: never marked, and
 * an inherited marker is dropped.
 */
export const makeClaudeTerminalEnvironment = Effect.fn("makeClaudeTerminalEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  const homePath = config.homePath.trim();
  const { [CLAUDE_OWNER_PID_ENV]: inheritedMarker, ...unmarked } = resolvedBaseEnv;
  if (homePath.length === 0) {
    return inheritedMarker === undefined ? resolvedBaseEnv : unmarked;
  }
  const resolvedHomePath = yield* resolveClaudeHomePath(config);
  return {
    ...unmarked,
    // Changing HOME hides macOS Keychain credentials; use CLAUDE_CONFIG_DIR to keep login access.
    CLAUDE_CONFIG_DIR: resolvedHomePath,
  };
});

/** managed-mcp.json excludes other MCP config and forbids --strict-mcp-config; omit the flag when present. */
export const hasClaudeManagedMcpConfig = Effect.fn("hasClaudeManagedMcpConfig")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const managedMcpConfigPath =
    platform === "darwin"
      ? "/Library/Application Support/ClaudeCode/managed-mcp.json"
      : platform === "win32"
        ? "C:\\Program Files\\ClaudeCode\\managed-mcp.json"
        : "/etc/claude-code/managed-mcp.json";
  return yield* fileSystem.exists(managedMcpConfigPath).pipe(Effect.orElseSucceed(() => false));
});

export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (
    config: Pick<ClaudeSettings, "homePath">,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config, environment);
    return `claude:home:${resolvedHomePath}`;
  },
);

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "homePath">,
    cwd?: string,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config, environment);
    return `${config.binaryPath}\0${resolvedHomePath}\0${cwd ?? ""}`;
  },
);

/** Separate spawn env from login commands to preserve literal paths, including relative inherited values. */
export const claudeSignedOutMessage = (input: {
  readonly configDir: string | undefined;
  readonly cwd: string;
}): string => {
  const configuration =
    input.configDir !== undefined
      ? ` from ${quotePath(input.cwd)}, with CLAUDE_CONFIG_DIR set to ${quotePath(input.configDir)}`
      : "";
  return `Claude could not authenticate. For subscription login, run \`claude auth login\` on this environment's machine${configuration}, then start a new thread. For API-key authentication, check this instance's configured credentials.`;
};
