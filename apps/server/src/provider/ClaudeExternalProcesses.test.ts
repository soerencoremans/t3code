import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import * as NodeUtil from "node:util";

import {
  ClaudeExternalProcesses,
  ClaudeProcessScanError,
  layerWith,
} from "./ClaudeExternalProcesses.ts";

const SERVER_PID = 4242;
const currentUid = process.getuid!();

interface FakeProcess {
  readonly cmdline?: ReadonlyArray<string>;
  readonly environ?: ReadonlyArray<string>;
}

const nul = (parts: ReadonlyArray<string>) => parts.map((part) => `${part}\0`).join("");

// The real NodeFileSystem, with its reads recorded (`FileSystem.make` derives readFileString from readFile); `failRead` paths are denied and `hangRead` paths never complete.
const recordingFileSystem = (options: {
  readonly failRead: ReadonlyArray<string> | undefined;
  readonly hangRead: ReadonlyArray<string> | undefined;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const seen: Array<string> = [];
    const guard =
      (method: string) =>
      <A>(target: string, read: Effect.Effect<A, PlatformError.PlatformError>) => {
        seen.push(target);
        if (options.hangRead?.includes(target)) return Effect.never;
        if (options.failRead?.includes(target)) {
          return Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method,
              pathOrDescriptor: target,
              description: "denied",
            }),
          );
        }
        return read;
      };
    const fileSystem = FileSystem.make({
      ...fs,
      readFile: (target) => guard("readFile")(target, fs.readFile(target)),
      readDirectory: (target, opts) =>
        guard("readDirectory")(target, fs.readDirectory(target, opts)),
    });
    return { fileSystem, seen };
  });

const harness = Effect.fn("test.harness")(function* (
  dirs: { readonly home: string; readonly setup: string },
  processes: Record<string, FakeProcess>,
  options: {
    readonly failRead?: (proc: string) => ReadonlyArray<string>;
    readonly hangRead?: (proc: string) => ReadonlyArray<string>;
    readonly procRoot?: (proc: string) => string;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { home, setup } = dirs;
  const proc = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fake-proc-" });
  yield* fs.makeDirectory(path.join(proc, "self"));
  yield* fs.writeFileString(path.join(proc, "meminfo"), "MemTotal: 1 kB\n");
  for (const [pid, fake] of Object.entries(processes)) {
    yield* fs.makeDirectory(path.join(proc, pid));
    if (fake.cmdline) yield* fs.writeFileString(path.join(proc, pid, "cmdline"), nul(fake.cmdline));
    if (fake.environ) yield* fs.writeFileString(path.join(proc, pid, "environ"), nul(fake.environ));
  }
  const recording = yield* recordingFileSystem({
    failRead: options.failRead?.(proc),
    hangRead: options.hangRead?.(proc),
  });
  const context = yield* Layer.build(
    layerWith({ procRoot: options.procRoot?.(proc) ?? proc }).pipe(
      Layer.provide(Layer.succeed(FileSystem.FileSystem, recording.fileSystem)),
    ),
  );
  const service = Context.get(context, ClaudeExternalProcesses);
  return {
    proc,
    home,
    setup,
    seen: recording.seen,
    findUsing: (configDir: string, userId: number | undefined = currentUid) =>
      service
        .findUsing(configDir)
        .pipe(
          Effect.provideService(HostProcess.ProcessId, SERVER_PID),
          Effect.provideService(HostProcess.HomeDirectory, home),
          Effect.provideService(HostProcess.UserId, userId),
        ),
  };
});

// Writes the fake tree only after the temp dirs exist, since the entries name them.
const scan = <A, E>(
  processes: (dirs: {
    readonly home: string;
    readonly setup: string;
  }) => Effect.Effect<Record<string, FakeProcess>, never, FileSystem.FileSystem | Path.Path>,
  body: (h: Effect.Success<ReturnType<typeof harness>>) => Effect.Effect<A, E>,
  options: Parameters<typeof harness>[2] = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-home-test-" });
    const setup = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-setup-test-" });
    return yield* body(yield* harness({ home, setup }, yield* processes({ home, setup }), options));
  }).pipe(Effect.scoped);

const claudeOn = (configDir: string, ...extra: ReadonlyArray<string>): FakeProcess => ({
  cmdline: ["claude", "--resume", "x"],
  environ: [`CLAUDE_CONFIG_DIR=${configDir}`, ...extra],
});

const scanError = Effect.fn("test.scanError")(function* (
  effect: Effect.Effect<ReadonlyArray<number>, ClaudeProcessScanError>,
) {
  const error = yield* Effect.flip(effect);
  assert.instanceOf(error, ClaudeProcessScanError);
  return error;
});

it.layer(NodeServices.layer)("ClaudeExternalProcesses", (it) => {
  it.effect("finds a claude process on the config dir", () =>
    scan(
      ({ setup }) => Effect.succeed({ "101": claudeOn(setup) }),
      (h) => Effect.map(h.findUsing(h.setup), (pids) => assert.deepEqual(pids, [101])),
    ),
  );

  it.effect("finds a node-run Claude CLI", () =>
    scan(
      ({ setup }) =>
        Effect.succeed({
          "101": {
            cmdline: ["node", "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"],
            environ: [`CLAUDE_CONFIG_DIR=${setup}`],
          },
        }),
      (h) => Effect.map(h.findUsing(h.setup), (pids) => assert.deepEqual(pids, [101])),
    ),
  );

  it.effect("finds an absolute claude binary through its HOME", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const otherHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-other-home-" });
      yield* scan(
        () =>
          Effect.succeed({
            "101": { cmdline: ["/home/u/.local/bin/claude"], environ: [`HOME=${otherHome}`] },
          }),
        (h) =>
          Effect.map(h.findUsing(path.join(otherHome, ".claude")), (pids) =>
            assert.deepEqual(pids, [101]),
          ),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("falls back to the server's home without HOME or CLAUDE_CONFIG_DIR", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      yield* scan(
        () =>
          Effect.succeed({
            "101": { cmdline: ["/home/u/.local/bin/claude"], environ: ["LANG=C"] },
          }),
        (h) =>
          Effect.map(h.findUsing(path.join(h.home, ".claude")), (pids) =>
            assert.deepEqual(pids, [101]),
          ),
      );
    }),
  );

  it.effect("compares config dirs after path.resolve", () =>
    scan(
      ({ setup }) => Effect.succeed({ "101": claudeOn(`${setup}/`) }),
      (h) => Effect.map(h.findUsing(`${h.setup}/./`), (pids) => assert.deepEqual(pids, [101])),
    ),
  );

  it.effect("ignores T3's own, other setups' and exited or kernel processes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const elsewhere = yield* fs.makeTempDirectoryScoped({ prefix: "t3-elsewhere-" });
      yield* scan(
        ({ setup }) =>
          Effect.succeed({
            "101": claudeOn(setup, `T3CODE_CLAUDE_OWNER_PID=${SERVER_PID}`),
            "102": claudeOn(elsewhere),
            "103": { cmdline: ["claude"], environ: ["CLAUDE_CONFIG_DIR=", `HOME=${elsewhere}`] },
            "104": { environ: [`CLAUDE_CONFIG_DIR=${setup}`] },
            "105": { cmdline: ["claude"] },
            "106": { cmdline: [], environ: [`CLAUDE_CONFIG_DIR=${setup}`] },
          }),
        (h) => Effect.map(h.findUsing(h.setup), (pids) => assert.deepEqual(pids, [])),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("skips another user's claude process whose environ cannot be read", () =>
    scan(
      ({ setup }) => Effect.succeed({ "101": claudeOn(setup) }),
      (h) => Effect.map(h.findUsing(h.setup, currentUid + 1), (pids) => assert.deepEqual(pids, [])),
      { failRead: (proc) => [`${proc}/101/environ`] },
    ),
  );

  it.effect("returns a claude process marked by another T3 server", () =>
    scan(
      ({ setup }) => Effect.succeed({ "101": claudeOn(setup, "T3CODE_CLAUDE_OWNER_PID=999") }),
      (h) => Effect.map(h.findUsing(h.setup), (pids) => assert.deepEqual(pids, [101])),
    ),
  );

  it.effect("matches a symlinked config dir in both directions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const links = yield* fs.makeTempDirectoryScoped({ prefix: "t3-links-" });
      const link = path.join(links, "setup-link");
      yield* scan(
        ({ setup }) =>
          Effect.as(fs.symlink(setup, link).pipe(Effect.orDie), { "101": claudeOn(link) }),
        (h) => Effect.map(h.findUsing(h.setup), (pids) => assert.deepEqual(pids, [101])),
      );
      yield* fs.remove(link);
      yield* scan(
        ({ setup }) =>
          Effect.as(fs.symlink(setup, link).pipe(Effect.orDie), { "101": claudeOn(setup) }),
        (h) => Effect.map(h.findUsing(link), (pids) => assert.deepEqual(pids, [101])),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("compares a missing CLAUDE_CONFIG_DIR by path.resolve", () =>
    scan(
      ({ setup }) => Effect.succeed({ "101": claudeOn(`${setup}-missing`) }),
      (h) => Effect.map(h.findUsing(h.setup), (pids) => assert.deepEqual(pids, [])),
    ),
  );

  it.effect("returns every match in ascending numeric order", () =>
    scan(
      ({ setup }) =>
        Effect.succeed({ "100": claudeOn(setup), "9": claudeOn(setup), "10": claudeOn(setup) }),
      (h) => Effect.map(h.findUsing(h.setup), (pids) => assert.deepEqual(pids, [9, 10, 100])),
    ),
  );

  it.effect("fails closed when a same-user claude process's environ cannot be read", () =>
    scan(
      ({ setup }) => Effect.succeed({ "101": claudeOn(setup) }),
      (h) =>
        Effect.map(scanError(h.findUsing(h.setup)), (error) =>
          assert.strictEqual(error.reason, "processUnreadable"),
        ),
      { failRead: (proc) => [`${proc}/101/environ`] },
    ),
  );

  it.effect("bounds a hung read at five seconds", () =>
    scan(
      ({ setup }) => Effect.succeed({ "101": claudeOn(setup) }),
      (h) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(h.findUsing(h.setup), { startImmediately: true });
          yield* TestClock.adjust("5 seconds");
          const exit = yield* Fiber.await(fiber);
          assert.isTrue(Exit.isFailure(exit));
          const error = yield* scanError(Fiber.join(fiber));
          assert.strictEqual(error.reason, "timeout");
        }),
      { hangRead: (proc) => [`${proc}/101/cmdline`] },
    ),
  );

  it.effect("reads the environ only of Claude programs", () =>
    scan(
      ({ setup }) =>
        Effect.succeed({
          "101": claudeOn(setup),
          "202": { cmdline: ["bash"], environ: [`CLAUDE_CONFIG_DIR=${setup}`] },
        }),
      (h) =>
        Effect.gen(function* () {
          assert.deepEqual(yield* h.findUsing(h.setup), [101]);
          assert.include(h.seen, `${h.proc}/101/environ`);
          assert.notInclude(h.seen, `${h.proc}/202/environ`);
          for (const seen of h.seen) {
            assert.isFalse(seen.startsWith(`${h.proc}/self`), seen);
            assert.isFalse(seen.startsWith(`${h.proc}/meminfo`), seen);
          }
        }),
    ),
  );

  it.effect("fails with listFailed when procRoot does not exist", () =>
    scan(
      ({ setup }) => Effect.succeed({ "101": claudeOn(setup, "ANTHROPIC_API_KEY=sk-unlisted") }),
      (h) =>
        Effect.gen(function* () {
          const error = yield* scanError(h.findUsing(h.setup));
          assert.strictEqual(error.reason, "listFailed");
        }),
      { procRoot: (proc) => `${proc}/missing` },
    ),
  );

  it.effect("fails with listFailed when procRoot cannot be read, naming no environ", () =>
    scan(
      ({ setup }) => Effect.succeed({ "101": claudeOn(setup, "ANTHROPIC_API_KEY=sk-denied") }),
      (h) =>
        Effect.gen(function* () {
          const error = yield* scanError(h.findUsing(h.setup));
          assert.strictEqual(error.reason, "listFailed");
          assert.notInclude(JSON.stringify(error), h.setup);
          assert.notInclude(JSON.stringify(error), "sk-denied");
          assert.notInclude(error.message, h.setup);
          assert.strictEqual(error.message, "Could not check the running processes.");
        }),
      { failRead: (proc) => [proc] },
    ),
  );

  it.effect("keeps every environ value out of the result and the logs", () => {
    const lines: Array<unknown> = [];
    const logger = Logger.make(({ message }) => {
      lines.push(message);
    });
    return Effect.gen(function* () {
      const secret = `sk-ant-${yield* (yield* Crypto.Crypto).randomUUIDv4()}`;
      return yield* scan(
        ({ setup }) => Effect.succeed({ "101": claudeOn(setup, `ANTHROPIC_API_KEY=${secret}`) }),
        (h) =>
          Effect.gen(function* () {
            const pids = yield* h.findUsing(h.setup);
            assert.deepEqual(pids, [101]);
            assert.notInclude(JSON.stringify(pids), secret);
            assert.notInclude(NodeUtil.inspect(lines, { depth: 8 }), secret);
          }),
      );
    }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  });
});
