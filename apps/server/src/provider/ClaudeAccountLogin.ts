import {
  ClaudeAccountError,
  type ClaudeAccountAddAttemptInput,
  type ClaudeAccountAddRespondInput,
  type ClaudeAccountAddStartInput,
  type ClaudeAccountAddState,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "../config.ts";
import { ClaudeAccounts, type ClaudeAddAccountTarget } from "./ClaudeAccounts.ts";
import { makeClaudeEnvironment, resolveClaudeSetupPaths } from "./Drivers/ClaudeHome.ts";
import { readClaudeSetupLogin } from "./claudeLoginFiles.ts";

export const CLAUDE_ACCOUNT_LOGIN_TIMEOUT = Duration.minutes(5);
const LOGINS_DIR_NAME = "claude-account-logins";
const OUTPUT_LIMIT = 16_384;

export interface ClaudeAccountLoginConnection {
  readonly start: (
    input: ClaudeAccountAddStartInput,
  ) => Effect.Effect<ClaudeAccountAddState, ClaudeAccountError>;
  readonly respond: (
    input: ClaudeAccountAddRespondInput,
  ) => Effect.Effect<void, ClaudeAccountError>;
  readonly cancel: (input: ClaudeAccountAddAttemptInput) => Effect.Effect<void, ClaudeAccountError>;
  readonly subscribe: (
    input: ClaudeAccountAddAttemptInput,
  ) => Stream.Stream<ClaudeAccountAddState, ClaudeAccountError>;
}

export class ClaudeAccountLogin extends Context.Service<
  ClaudeAccountLogin,
  {
    /** The attempts of a connection end when the scope closes, as when its WebSocket closes. */
    readonly openConnection: Effect.Effect<ClaudeAccountLoginConnection, never, Scope.Scope>;
  }
>()("t3/provider/ClaudeAccountLogin") {}

// Names the step that ended an attempt, for the log only; the client sees `error`.
class AttemptEnded extends Data.TaggedError("AttemptEnded")<{
  readonly outcome: string;
  readonly error: ClaudeAccountError;
  readonly exitCode?: number;
}> {}

interface Attempt {
  readonly id: string;
  readonly owner: string;
  readonly instanceId: ProviderInstanceId;
  readonly name: string;
  readonly state: SubscriptionRef.SubscriptionRef<ClaudeAccountAddState>;
  fiber: Fiber.Fiber<void> | undefined;
  terminal: PtyAdapter.PtyProcess | undefined;
  /** Set the moment the CLI exits 0, so a cancel waits for the true outcome instead of racing it. */
  loginExited: boolean;
}

const loginFailed = () => new ClaudeAccountError({ reason: "loginFailed" });
const loginNotFound = () => new ClaudeAccountError({ reason: "loginNotFound" });

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const accounts = yield* ClaudeAccounts;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pty = yield* PtyAdapter.PtyAdapter;
  const crypto = yield* Crypto.Crypto;
  // Attempts outlive the RPC call that started them; they run in the service's scope.
  const layerScope = yield* Scope.Scope;
  const attemptsLock = yield* Semaphore.make(1);
  const attempts = new Map<string, Attempt>();
  const loginsDir = path.join(serverConfig.stateDir, LOGINS_DIR_NAME);

  // No attempt exists yet, so everything in the folder was left behind by an earlier run.
  yield* Effect.gen(function* () {
    yield* fileSystem.remove(loginsDir, { recursive: true, force: true });
    if ((yield* HostProcess.Platform) !== "linux") return;
    yield* fileSystem.makeDirectory(loginsDir, { recursive: true });
    yield* fileSystem.chmod(loginsDir, 0o700);
  }).pipe(
    Effect.catch(() =>
      Effect.logWarning("Claude account login folder could not be prepared", {
        operation: "addAccount",
        outcome: "sweepFailed",
      }),
    ),
  );

  const logFinished = (attempt: Attempt, outcome: string, exitCode?: number) =>
    Effect.logInfo("Claude account login finished", {
      operation: "addAccount",
      outcome,
      instanceId: attempt.instanceId,
      name: attempt.name,
      ...(exitCode === undefined ? {} : { exitCode }),
    });

  const removeFolder = (attempt: Attempt, dir: string) =>
    fileSystem.remove(dir, { recursive: true, force: true }).pipe(
      Effect.catch(() =>
        Effect.logWarning("Claude account login folder could not be removed", {
          operation: "addAccount",
          outcome: "cleanupFailed",
          instanceId: attempt.instanceId,
          name: attempt.name,
        }),
      ),
    );

  const ended = (outcome: string, error: ClaudeAccountError = loginFailed(), exitCode?: number) =>
    new AttemptEnded({ outcome, error, ...(exitCode === undefined ? {} : { exitCode }) });

  const openTerminal = Effect.fn("ClaudeAccountLogin.openTerminal")(function* (
    attempt: Attempt,
    target: ClaudeAddAccountTarget,
    dir: string,
    env: NodeJS.ProcessEnv,
  ) {
    const terminal = yield* Effect.acquireRelease(
      pty
        .spawn({
          shell: target.binaryPath,
          args: ["auth", "login"],
          cwd: dir,
          cols: 80,
          rows: 24,
          env,
        })
        .pipe(Effect.mapError(() => ended("spawnFailed"))),
      (process) =>
        Effect.sync(() => {
          attempt.terminal = undefined;
          try {
            process.kill();
          } catch {}
        }),
    );
    const exited = yield* Deferred.make<number>();
    const chunks = yield* Queue.sliding<string>(64);
    const detachData = terminal.onData((data) => {
      Queue.offerUnsafe(chunks, data.slice(-OUTPUT_LIMIT));
    });
    const detachExit = terminal.onExit(({ exitCode }) => {
      attempt.loginExited = exitCode === 0;
      Deferred.doneUnsafe(exited, Effect.succeed(exitCode));
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        detachData();
        detachExit();
      }),
    );
    yield* Queue.take(chunks).pipe(
      Effect.flatMap((data) =>
        SubscriptionRef.update(attempt.state, (state) => ({
          ...state,
          output: (state.output + data).slice(-OUTPUT_LIMIT),
          outputOffset: state.outputOffset + data.length,
        })),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
    attempt.terminal = terminal;
    return exited;
  });

  const runLogin = Effect.fn("ClaudeAccountLogin.runLogin")(function* (
    attempt: Attempt,
    target: ClaudeAddAccountTarget,
    spawned: Deferred.Deferred<void, ClaudeAccountError>,
    restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
  ) {
    const dir = path.join(loginsDir, attempt.id);
    yield* Effect.addFinalizer(() => removeFolder(attempt, dir));
    yield* restore(
      fileSystem.makeDirectory(dir).pipe(
        Effect.andThen(fileSystem.chmod(dir, 0o700)),
        Effect.mapError(() => ended("folderFailed")),
      ),
    );
    const env = yield* makeClaudeEnvironment({ homePath: dir }, target.environment);
    const exited = yield* restore(openTerminal(attempt, target, dir, env));
    yield* Deferred.succeed(spawned, undefined);
    const exitCode = yield* restore(
      Deferred.await(exited).pipe(
        Effect.timeoutOrElse({
          duration: CLAUDE_ACCOUNT_LOGIN_TIMEOUT,
          orElse: () =>
            Effect.fail(ended("timedOut", new ClaudeAccountError({ reason: "loginTimedOut" }))),
        }),
      ),
    );
    if (exitCode !== 0) return yield* ended("exitNonZero", loginFailed(), exitCode);
    // The CLI exited 0, so a login exists: from here on a cancel waits for the true outcome.
    const paths = yield* resolveClaudeSetupPaths({ homePath: dir }, env);
    const login = yield* readClaudeSetupLogin(paths).pipe(
      Effect.mapError(() => ended("readFailed")),
    );
    if (Option.isNone(login)) return yield* ended("noLogin");
    return yield* accounts
      .rememberLogin({ instanceId: target.instanceId, name: target.name, login: login.value })
      .pipe(Effect.mapError((error) => ended(error.reason ?? "loginFailed", error)));
  });

  const runAttempt = (
    attempt: Attempt,
    target: ClaudeAddAccountTarget,
    spawned: Deferred.Deferred<void, ClaudeAccountError>,
  ) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        // The scope closes before the final state is published, so the folder is already gone.
        const result = yield* Effect.scoped(runLogin(attempt, target, spawned, restore)).pipe(
          Effect.catchDefect(() => Effect.fail(ended("loginFailed"))),
          Effect.result,
        );
        if (Result.isSuccess(result)) {
          yield* SubscriptionRef.update(attempt.state, (state) => ({
            ...state,
            phase: "succeeded" as const,
            account: result.success,
          }));
          return yield* logFinished(attempt, "succeeded");
        }
        const failure = result.failure;
        yield* Deferred.fail(spawned, failure.error);
        yield* SubscriptionRef.update(attempt.state, (state) => ({
          ...state,
          phase: "failed" as const,
          error: failure.error,
        }));
        yield* logFinished(attempt, failure.outcome, failure.exitCode);
      }),
    ).pipe(
      Effect.onExit(() => Deferred.fail(spawned, loginFailed())),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  /** Ends an attempt once its terminal and folder are gone; a finished login is remembered first. */
  const stopAttempt = Effect.fn("ClaudeAccountLogin.stopAttempt")(function* (attempt: Attempt) {
    if (attempt.fiber !== undefined) {
      yield* attempt.loginExited ? Fiber.await(attempt.fiber) : Fiber.interrupt(attempt.fiber);
    }
    const state = yield* SubscriptionRef.get(attempt.state);
    if (state.phase !== "running") return;
    yield* SubscriptionRef.set(attempt.state, { ...state, phase: "cancelled" as const });
    yield* logFinished(attempt, "cancelled");
  });

  const openConnection = Effect.gen(function* () {
    const owner = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    let closed = false;

    yield* Effect.addFinalizer(() =>
      attemptsLock
        .withPermits(1)(
          Effect.sync(() => {
            closed = true;
            const owned = [...attempts.values()].filter((attempt) => attempt.owner === owner);
            for (const attempt of owned) attempts.delete(attempt.id);
            return owned;
          }),
        )
        .pipe(Effect.flatMap((owned) => Effect.forEach(owned, stopAttempt, { discard: true }))),
    );

    const lookup = (attemptId: string) =>
      Effect.suspend(() => {
        const attempt = attempts.get(attemptId);
        return attempt === undefined || attempt.owner !== owner
          ? Effect.fail(loginNotFound())
          : Effect.succeed(attempt);
      });

    const start = Effect.fn("ClaudeAccountLogin.start")(function* (
      input: ClaudeAccountAddStartInput,
    ) {
      const target = yield* accounts.prepareAddAccount(input);
      const attemptId = yield* crypto.randomUUIDv4().pipe(Effect.mapError(loginFailed));
      const initial: ClaudeAccountAddState = {
        attemptId,
        instanceId: target.instanceId,
        name: target.name,
        phase: "running",
        output: "",
        outputOffset: 0,
        account: null,
        error: null,
      };
      const attempt: Attempt = {
        id: attemptId,
        owner,
        instanceId: target.instanceId,
        name: target.name,
        state: yield* SubscriptionRef.make(initial),
        fiber: undefined,
        terminal: undefined,
        loginExited: false,
      };
      const spawned = yield* Deferred.make<void, ClaudeAccountError>();
      // The record and its fiber enter the map in one step, so the connection's finalizer always finds it.
      const previous = yield* attemptsLock.withPermits(1)(
        Effect.gen(function* () {
          if (closed) return yield* loginNotFound();
          const previous = [...attempts.values()].find((candidate) => candidate.owner === owner);
          if (previous !== undefined) attempts.delete(previous.id);
          attempt.fiber = yield* runAttempt(attempt, target, spawned).pipe(
            Effect.forkIn(layerScope),
          );
          attempts.set(attemptId, attempt);
          return previous;
        }).pipe(Effect.uninterruptible),
      );
      if (previous !== undefined) yield* stopAttempt(previous);
      yield* Deferred.await(spawned).pipe(
        Effect.tapError(() =>
          attemptsLock.withPermits(1)(Effect.sync(() => attempts.delete(attemptId))),
        ),
      );
      return initial;
    });

    const respond = Effect.fn("ClaudeAccountLogin.respond")(function* (
      input: ClaudeAccountAddRespondInput,
    ) {
      const attempt = yield* lookup(input.attemptId);
      const state = yield* SubscriptionRef.get(attempt.state);
      const terminal = attempt.terminal;
      if (state.phase !== "running" || terminal === undefined) return yield* loginNotFound();
      yield* Effect.try({
        try: () => {
          if (input.size) terminal.resize(input.size.cols, input.size.rows);
          terminal.write(input.data);
        },
        catch: loginNotFound,
      });
    });

    const cancel = Effect.fn("ClaudeAccountLogin.cancel")(function* (
      input: ClaudeAccountAddAttemptInput,
    ) {
      const attempt = yield* lookup(input.attemptId);
      yield* stopAttempt(attempt);
      yield* attemptsLock.withPermits(1)(Effect.sync(() => attempts.delete(attempt.id)));
    });

    const subscribe = (input: ClaudeAccountAddAttemptInput) =>
      Stream.unwrap(
        lookup(input.attemptId).pipe(
          Effect.map((attempt) =>
            SubscriptionRef.changes(attempt.state).pipe(
              Stream.takeUntil((state) => state.phase !== "running"),
            ),
          ),
        ),
      );

    return { start, respond, cancel, subscribe } satisfies ClaudeAccountLoginConnection;
  });

  return ClaudeAccountLogin.of({ openConnection });
});

export const layer: Layer.Layer<
  ClaudeAccountLogin,
  never,
  | ClaudeAccounts
  | ServerConfig.ServerConfig
  | FileSystem.FileSystem
  | Path.Path
  | PtyAdapter.PtyAdapter
  | Crypto.Crypto
> = Layer.effect(ClaudeAccountLogin, make);
