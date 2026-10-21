import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  claudeSignedOutMessage,
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  makeClaudeTerminalEnvironment,
  resolveClaudeHomePath,
  resolveClaudeSetupPaths,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("treats empty, ~/.claude, and the expanded default as the same Claude home", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(path.join(NodeOS.homedir(), ".claude"));

        expect(yield* resolveClaudeHomePath({ homePath: "" })).toBe(resolved);
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude" })).toBe(resolved);
        expect(yield* resolveClaudeHomePath({ homePath: resolved })).toBe(resolved);
        expect(yield* makeClaudeEnvironment({ homePath: "" })).toEqual({
          ...process.env,
          T3CODE_CLAUDE_OWNER_PID: String(process.pid),
        });

        const key = `claude:home:${resolved}`;
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" })).toBe(key);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "~/.claude" })).toBe(key);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: resolved })).toBe(key);
      }),
    );

    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(`claude:home:${resolved}`);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it.effect("marks the environment of a T3 spawn with the server pid, copying the input", () =>
      Effect.gen(function* () {
        const base = { A: "1" };
        const marked = yield* makeClaudeEnvironment({ homePath: "" }, base).pipe(
          Effect.provideService(HostProcess.ProcessId, 4242),
        );
        expect(marked).toEqual({ A: "1", T3CODE_CLAUDE_OWNER_PID: "4242" });
        expect(base).toEqual({ A: "1" });

        const path = yield* Path.Path;
        const work = yield* makeClaudeEnvironment({ homePath: "~/.claude-work" }, base).pipe(
          Effect.provideService(HostProcess.ProcessId, 4242),
        );
        expect(work.CLAUDE_CONFIG_DIR).toBe(path.resolve(NodeOS.homedir(), ".claude-work"));
        expect(work.T3CODE_CLAUDE_OWNER_PID).toBe("4242");
      }),
    );

    it.effect("never marks a terminal's environment and drops an inherited marker", () =>
      Effect.gen(function* () {
        const base = { A: "1" };
        expect(yield* makeClaudeTerminalEnvironment({ homePath: "" }, base)).toBe(base);

        const inherited = { A: "1", T3CODE_CLAUDE_OWNER_PID: "999" };
        expect(yield* makeClaudeTerminalEnvironment({ homePath: "" }, inherited)).toEqual({
          A: "1",
        });
        expect(inherited.T3CODE_CLAUDE_OWNER_PID).toBe("999");

        const path = yield* Path.Path;
        expect(
          yield* makeClaudeTerminalEnvironment({ homePath: "~/.claude-work" }, inherited),
        ).toEqual({ A: "1", CLAUDE_CONFIG_DIR: path.resolve(NodeOS.homedir(), ".claude-work") });
      }),
    );

    it.effect("uses inherited CLAUDE_CONFIG_DIR when homePath is empty", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const inherited = path.resolve("/tmp/claude-inherited");
        const environment = { CLAUDE_CONFIG_DIR: inherited };

        expect(yield* resolveClaudeHomePath({ homePath: "" }, environment)).toBe(inherited);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" }, environment)).toBe(
          `claude:home:${inherited}`,
        );

        const explicit = path.resolve(NodeOS.homedir(), ".claude-work");
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude-work" }, environment)).toBe(
          explicit,
        );
      }),
    );

    it.effect("resolves a setup's paths inside a configured homePath", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const configDir = path.resolve("/synthetic/claude-work");

        expect(yield* resolveClaudeSetupPaths({ homePath: configDir })).toEqual({
          configDir,
          accountConfigPath: path.join(configDir, ".claude.json"),
        });
      }),
    );

    it.effect("resolves a setup's paths inside an inherited CLAUDE_CONFIG_DIR", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const inherited = path.resolve("/synthetic/claude-inherited");

        expect(
          yield* resolveClaudeSetupPaths({ homePath: "" }, { CLAUDE_CONFIG_DIR: inherited }),
        ).toEqual({
          configDir: inherited,
          accountConfigPath: path.join(inherited, ".claude.json"),
        });
      }),
    );

    it.effect("keeps the default setup's .claude.json beside ~/.claude, not inside it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const home = path.resolve("/synthetic/home");

        expect(
          yield* resolveClaudeSetupPaths({ homePath: "" }, {}).pipe(
            Effect.provideService(HostProcess.HomeDirectory, home),
          ),
        ).toEqual({
          configDir: path.join(home, ".claude"),
          accountConfigPath: path.join(home, ".claude.json"),
        });
      }),
    );

    it("points the signed-out hint at the configured Claude home", () => {
      expect(claudeSignedOutMessage({ configDir: undefined, cwd: "/synthetic" })).toContain(
        "run `claude auth login`",
      );
      const configDir = "/synthetic/Claude work's $literal";
      const message = claudeSignedOutMessage({ configDir, cwd: "/synthetic/project" });
      expect(message).toContain(`CLAUDE_CONFIG_DIR set to "${configDir}"`);
      expect(message).not.toContain("CLAUDE_CONFIG_DIR=");
      expect(message).toContain("then start a new thread");
    });

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );
  });
});
