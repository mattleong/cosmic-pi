import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Predicate from "effect/Predicate";
import * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";
import type { Duplex, Readable, Writable } from "node:stream";
import { nodeSpawn } from "./node-builtins.ts";
import { signalProcessGroup } from "./process-tree.ts";
import {
  closeDuplexProcess,
  duplexProcessError,
  DuplexProcessError,
  type DuplexProcessExit,
} from "./duplex-process-close.ts";
import {
  makeDuplexProcessIo,
  type DuplexProcessIo,
  type DuplexProcessStreams,
} from "./duplex-process-io.ts";

export { DuplexProcessError, duplexProcessError } from "./duplex-process-close.ts";
export type { DuplexProcessExit } from "./duplex-process-close.ts";

export const DUPLEX_PROCESS_DEFAULTS = Object.freeze({
  maxReadQueueBytes: 8 * 1024 * 1024,
  maxStderrBytes: 16 * 1024,
  maxStderrQueueBytes: 16 * 1024,
  maxWriteBytes: 8 * 1024 * 1024,
  maxWriteQueueBytes: 8 * 1024 * 1024,
  writeTimeoutMs: 10_000,
  startTimeoutMs: 15_000,
  gracefulTimeoutMs: 500,
  forceTimeoutMs: 1_500,
  cleanupTimeoutMs: 2_000,
  pollIntervalMs: 10,
});

type DuplexProcessLimits = { readonly [K in keyof typeof DUPLEX_PROCESS_DEFAULTS]: number };

/** Omitted limits use `DUPLEX_PROCESS_DEFAULTS`; the stderr queue defaults to `maxStderrBytes`. */
export interface DuplexProcessOptions extends Partial<DuplexProcessLimits> {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  /** Exact child environment. The adapter never fills this from process.env. */
  readonly environment: Readonly<Record<string, string>>;
  /** Called once when process-group cleanup is either confirmed or unconfirmed. */
  readonly onCleanup?: (confirmed: boolean) => void;
  /**
   * Moves the duplex channel to a full-duplex socket on fd 3 and leaves stdin closed. The
   * handle's `stdout` and `write` then carry fd 3, and `stderr` retains the child's stdout and
   * stderr together. fd 4 is a lifetime lease the child may watch: it reaches EOF once this
   * process exits, even abruptly.
   */
  readonly sideChannel?: boolean;
}

export type DuplexProcessCleanupState = "pending" | "confirmed" | "unconfirmed";

export interface DuplexProcessHandle {
  readonly pid: number;
  readonly stdout: Stream.Stream<Uint8Array, DuplexProcessError>;
  readonly stderr: Stream.Stream<Uint8Array>;
  readonly write: (bytes: Uint8Array) => Effect.Effect<void, DuplexProcessError>;
  readonly exit: Effect.Effect<DuplexProcessExit>;
  readonly close: Effect.Effect<void, DuplexProcessError>;
  /** Read after explicit close or scope release to distinguish confirmed cleanup. */
  readonly cleanupState: Effect.Effect<DuplexProcessCleanupState>;
}

interface NormalizedDuplexProcessOptions extends DuplexProcessLimits {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string | undefined;
  readonly environment: Readonly<Record<string, string>>;
  readonly onCleanup: ((confirmed: boolean) => void) | undefined;
  readonly sideChannel: boolean;
}

interface AcquiredDuplexProcess extends DuplexProcessHandle {
  readonly ready: Effect.Effect<void, DuplexProcessError>;
}

const invalidOptions = (): DuplexProcessError =>
  duplexProcessError("spawn", "failed", "Invalid child process options.");

const positiveInteger = (
  value: number | undefined,
  fallback: number,
  allowZero = false,
): number => {
  const candidate = value ?? fallback;
  if (!Number.isFinite(candidate)) throw invalidOptions();
  const normalized = Math.floor(candidate);
  if (!Number.isSafeInteger(normalized) || normalized < (allowZero ? 0 : 1)) {
    throw invalidOptions();
  }
  return normalized;
};

const snapshotOptions = (
  input: DuplexProcessOptions,
): Effect.Effect<NormalizedDuplexProcessOptions, DuplexProcessError> =>
  Effect.try({
    try: () => {
      if (!Predicate.isObject(input)) throw invalidOptions();
      if (!Predicate.isString(input.command) || input.command.length === 0) throw invalidOptions();
      if (input.cwd !== undefined && !Predicate.isString(input.cwd)) throw invalidOptions();
      const args = [...input.args];
      if (!args.every(Predicate.isString)) throw invalidOptions();
      const environment: Record<string, string> = {};
      for (const [key, value] of Object.entries(input.environment)) {
        if (key.length === 0 || !Predicate.isString(value)) throw invalidOptions();
        environment[key] = value;
      }
      if (input.onCleanup !== undefined && !Predicate.isFunction(input.onCleanup)) {
        throw invalidOptions();
      }
      if (input.sideChannel !== undefined && !Predicate.isBoolean(input.sideChannel)) {
        throw invalidOptions();
      }

      const limit = (
        key: keyof DuplexProcessLimits,
        allowZero = false,
        value: number | undefined = input[key],
      ) => positiveInteger(value, DUPLEX_PROCESS_DEFAULTS[key], allowZero);
      return {
        command: input.command,
        args,
        cwd: input.cwd,
        environment,
        maxReadQueueBytes: limit("maxReadQueueBytes"),
        maxStderrBytes: limit("maxStderrBytes", true),
        maxStderrQueueBytes: limit(
          "maxStderrQueueBytes",
          true,
          input.maxStderrQueueBytes ?? input.maxStderrBytes,
        ),
        maxWriteBytes: limit("maxWriteBytes"),
        maxWriteQueueBytes: limit("maxWriteQueueBytes"),
        writeTimeoutMs: limit("writeTimeoutMs"),
        startTimeoutMs: limit("startTimeoutMs"),
        gracefulTimeoutMs: limit("gracefulTimeoutMs"),
        forceTimeoutMs: limit("forceTimeoutMs"),
        cleanupTimeoutMs: limit("cleanupTimeoutMs"),
        pollIntervalMs: limit("pollIntervalMs"),
        onCleanup: input.onCleanup,
        sideChannel: input.sideChannel === true,
      } satisfies NormalizedDuplexProcessOptions;
    },
    catch: (error) => (error instanceof DuplexProcessError ? error : invalidOptions()),
  });

const startFailure = (): DuplexProcessError =>
  duplexProcessError("start", "failed", "Unable to start child process.");

const unsupportedPlatform = (): DuplexProcessError =>
  duplexProcessError(
    "spawn",
    "unsupported-platform",
    "Duplex child processes require macOS or Linux.",
  );

const unexpectedExit = (): DuplexProcessError =>
  duplexProcessError("start", "failed", "Child process exited before startup completed.");

const childExit = (code: number | null, signal: NodeJS.Signals | null): DuplexProcessExit => ({
  code,
  signal,
});

const callCleanupObserver = (
  observer: ((confirmed: boolean) => void) | undefined,
  confirmed: boolean,
): void => {
  if (observer === undefined) return;
  try {
    observer(confirmed);
  } catch {
    // Cleanup observers cannot change process ownership or cleanup evidence.
  }
};

const createAcquired = (options: NormalizedDuplexProcessOptions) =>
  Effect.gen(function* () {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      return yield* unsupportedPlatform();
    }

    const started = Deferred.makeUnsafe<void, DuplexProcessError>();
    const exited = Deferred.makeUnsafe<DuplexProcessExit>();
    const nativeClosed = Deferred.makeUnsafe<void>();
    const ioScope = Scope.makeUnsafe();
    let didStart = false;
    let didExit = false;
    let didError = false;
    let io: DuplexProcessIo | undefined;

    const onSpawn = (): void => {
      if (didStart || didExit || didError) return;
      didStart = true;
      Deferred.doneUnsafe(started, Effect.void);
    };
    const onError = (): void => {
      didError = true;
      if (!didStart) Deferred.doneUnsafe(started, Effect.fail(startFailure()));
      io?.fail(startFailure());
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (didExit) return;
      didExit = true;
      Deferred.doneUnsafe(exited, Effect.succeed(childExit(code, signal)));
      io?.processExit();
      if (!didStart) Deferred.doneUnsafe(started, Effect.fail(unexpectedExit()));
    };
    const child = yield* Effect.try({
      try: () => {
        const child = nodeSpawn(options.command, [...options.args], {
          cwd: options.cwd,
          env: { ...options.environment },
          detached: true,
          shell: false,
          windowsHide: true,
          stdio: options.sideChannel
            ? ["ignore", "pipe", "pipe", "pipe", "pipe"]
            : ["pipe", "pipe", "pipe"],
        });
        // Even ENOENT returns a child before emitting error. Install handlers in
        // the same synchronous operation as spawn, before inspecting its pid.
        for (const stream of child.stdio) {
          if (stream === null || stream === undefined) continue;
          const guard = (): void => undefined;
          stream.on("error", guard);
          stream.once("close", () => stream.off("error", guard));
        }
        child.once("spawn", onSpawn);
        child.on("error", onError);
        child.once("exit", onExit);
        child.once("close", (code, signal) => {
          onExit(code, signal);
          Deferred.doneUnsafe(nativeClosed, Effect.void);
          child.off("spawn", onSpawn);
          child.off("error", onError);
          child.off("exit", onExit);
        });
        return child;
      },
      catch: () => startFailure(),
    });

    // Every stdio entry configured as "pipe" is a Node stream once spawn returns, even when the
    // spawn later fails.
    // SAFETY: stdout is a pipe in both modes.
    const stdout = child.stdout as Readable;
    // SAFETY: stderr is a pipe in both modes.
    const stderr = child.stderr as Readable;
    const streams: DuplexProcessStreams = options.sideChannel
      ? {
          // SAFETY: in side-channel mode fd 3 is a pipe, which Node opens as a duplex socket.
          input: child.stdio[3] as Duplex,
          // SAFETY: the same fd 3 socket.
          output: child.stdio[3] as Duplex,
          diagnostics: [stdout, stderr],
        }
      : // SAFETY: without the side channel, stdin is a pipe.
        { input: child.stdin as Writable, output: stdout, diagnostics: [stderr] };
    const cleanupChild = {
      pid: child.pid,
      get exitCode() {
        return child.exitCode;
      },
      get signalCode() {
        return child.signalCode;
      },
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      stdio: child.stdio,
      input: streams.input,
    };

    let cleanupState: DuplexProcessCleanupState = "pending";
    const cachedClose = yield* Effect.cached(
      Effect.uninterruptible(
        Effect.suspend(() => io?.stop ?? Effect.void).pipe(
          Effect.andThen(
            closeDuplexProcess(cleanupChild, {
              ...options,
              nativeClosed: Deferred.await(nativeClosed),
            }),
          ),
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.sync(() => {
                cleanupState = "unconfirmed";
                callCleanupObserver(options.onCleanup, false);
              }).pipe(Effect.andThen(Effect.fail(error))),
            onSuccess: () =>
              Effect.sync(() => {
                cleanupState = "confirmed";
                callCleanupObserver(options.onCleanup, true);
              }),
          }),
          Effect.ensuring(Scope.close(ioScope, Exit.void)),
        ),
      ),
    );
    // Mask cache admission and result publication as well as cleanup itself.
    // Otherwise an interrupted first caller can leave a pending or interrupted cache.
    const close = Effect.uninterruptible(cachedClose);
    // One finalizer owns both partial acquisition and the returned handle.
    yield* Effect.addFinalizer(() => close.pipe(Effect.ignore));

    io = yield* makeDuplexProcessIo(streams, {
      ...options,
      // closeDuplexProcess performs the authoritative signal and group confirmation.
      onProcessFailure: () => void signalProcessGroup(child.pid, "SIGTERM"),
    }).pipe(Effect.provideService(Scope.Scope, ioScope));
    if (didExit) io.processExit();
    if (didError) io.fail(startFailure());

    const ready = Deferred.await(started).pipe(
      Effect.timeoutOrElse({
        duration: options.startTimeoutMs,
        orElse: () =>
          Effect.fail(
            duplexProcessError(
              "start",
              "timeout",
              "Child process did not start before its deadline.",
            ),
          ),
      }),
      Effect.andThen(
        Effect.suspend(() =>
          child.pid && Number.isSafeInteger(child.pid) && child.pid > 0
            ? Effect.void
            : Effect.fail(startFailure()),
        ),
      ),
    );

    return {
      pid: child.pid ?? 0,
      stdout: io.stdout,
      stderr: io.stderr,
      write: io.write,
      exit: Deferred.await(exited),
      close,
      cleanupState: Effect.sync(() => cleanupState),
      ready,
    } satisfies AcquiredDuplexProcess;
  });

/**
 * Opens an Effect-scoped detached macOS or Linux process with a duplex channel: stdin/stdout by
 * default, or fd 3 in side-channel mode.
 */
export const openDuplexProcess = (
  request: DuplexProcessOptions,
): Effect.Effect<DuplexProcessHandle, DuplexProcessError, Scope.Scope> =>
  snapshotOptions(request).pipe(
    Effect.flatMap((options) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const acquired = yield* createAcquired(options);
          yield* restore(acquired.ready).pipe(
            Effect.catchCause((cause) => {
              // Unconfirmed cleanup takes precedence over a startup failure.
              // External interruption still propagates; onCleanup retains its evidence.
              const cleanup = Cause.hasInterrupts(cause)
                ? acquired.close.pipe(Effect.ignore)
                : acquired.close;
              return cleanup.pipe(Effect.andThen(Effect.failCause(cause)));
            }),
          );
          return acquired;
        }),
      ),
    ),
  );
