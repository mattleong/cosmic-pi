import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Predicate from "effect/Predicate";
import * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";
import { nodeSpawn } from "./node-builtins.ts";
import {
  closeDuplexProcess,
  duplexProcessError,
  DuplexProcessError,
  type DuplexProcessExit,
} from "./duplex-process-close.ts";
import { makeDuplexProcessIo, type DuplexProcessIo } from "./duplex-process-io.ts";

export { DuplexProcessError, duplexProcessError } from "./duplex-process-close.ts";
export type { DuplexProcessExit } from "./duplex-process-close.ts";

export const DUPLEX_PROCESS_DEFAULTS = Object.freeze({
  maxBufferBytes: 8 * 1024 * 1024,
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

export interface DuplexProcessOptions {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  /** Exact child environment. The adapter never fills this from process.env. */
  readonly environment: Readonly<Record<string, string>>;
  readonly maxBufferBytes?: number;
  readonly maxReadQueueBytes?: number;
  readonly maxStderrBytes?: number;
  readonly maxStderrQueueBytes?: number;
  readonly maxWriteBytes?: number;
  readonly maxWriteQueueBytes?: number;
  readonly writeTimeoutMs?: number;
  readonly startTimeoutMs?: number;
  readonly gracefulTimeoutMs?: number;
  readonly forceTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  /** Called once when process-group cleanup is either confirmed or unconfirmed. */
  readonly onCleanup?: (confirmed: boolean) => void;
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

interface NormalizedDuplexProcessOptions {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string | undefined;
  readonly environment: Readonly<Record<string, string>>;
  readonly maxBufferBytes: number;
  readonly maxReadQueueBytes: number;
  readonly maxStderrBytes: number;
  readonly maxStderrQueueBytes: number;
  readonly maxWriteBytes: number;
  readonly maxWriteQueueBytes: number;
  readonly writeTimeoutMs: number;
  readonly startTimeoutMs: number;
  readonly gracefulTimeoutMs: number;
  readonly forceTimeoutMs: number;
  readonly cleanupTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly onCleanup: ((confirmed: boolean) => void) | undefined;
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

      const maxBufferBytes = positiveInteger(
        input.maxBufferBytes,
        DUPLEX_PROCESS_DEFAULTS.maxBufferBytes,
      );
      return {
        command: input.command,
        args,
        cwd: input.cwd,
        environment,
        maxBufferBytes,
        maxReadQueueBytes: positiveInteger(
          input.maxReadQueueBytes ?? input.maxBufferBytes,
          DUPLEX_PROCESS_DEFAULTS.maxReadQueueBytes,
        ),
        maxStderrBytes: positiveInteger(
          input.maxStderrBytes,
          DUPLEX_PROCESS_DEFAULTS.maxStderrBytes,
          true,
        ),
        maxStderrQueueBytes: positiveInteger(
          input.maxStderrQueueBytes ?? input.maxStderrBytes,
          DUPLEX_PROCESS_DEFAULTS.maxStderrQueueBytes,
          true,
        ),
        maxWriteBytes: positiveInteger(
          input.maxWriteBytes ?? input.maxBufferBytes,
          DUPLEX_PROCESS_DEFAULTS.maxWriteBytes,
        ),
        maxWriteQueueBytes: positiveInteger(
          input.maxWriteQueueBytes,
          DUPLEX_PROCESS_DEFAULTS.maxWriteQueueBytes,
        ),
        writeTimeoutMs: positiveInteger(
          input.writeTimeoutMs,
          DUPLEX_PROCESS_DEFAULTS.writeTimeoutMs,
        ),
        startTimeoutMs: positiveInteger(
          input.startTimeoutMs,
          DUPLEX_PROCESS_DEFAULTS.startTimeoutMs,
        ),
        gracefulTimeoutMs: positiveInteger(
          input.gracefulTimeoutMs,
          DUPLEX_PROCESS_DEFAULTS.gracefulTimeoutMs,
        ),
        forceTimeoutMs: positiveInteger(
          input.forceTimeoutMs,
          DUPLEX_PROCESS_DEFAULTS.forceTimeoutMs,
        ),
        cleanupTimeoutMs: positiveInteger(
          input.cleanupTimeoutMs,
          DUPLEX_PROCESS_DEFAULTS.cleanupTimeoutMs,
        ),
        pollIntervalMs: positiveInteger(
          input.pollIntervalMs,
          DUPLEX_PROCESS_DEFAULTS.pollIntervalMs,
        ),
        onCleanup: input.onCleanup,
      } satisfies NormalizedDuplexProcessOptions;
    },
    catch: (error) => (error instanceof DuplexProcessError ? error : invalidOptions()),
  });

const startFailure = (): DuplexProcessError =>
  duplexProcessError("start", "failed", "Unable to start child process.");

const unsupportedPlatform = (): DuplexProcessError =>
  duplexProcessError("spawn", "unsupported-platform", "Duplex child processes require macOS.");

const unexpectedExit = (): DuplexProcessError =>
  duplexProcessError("start", "failed", "Child process exited before startup completed.");

const childExit = (code: number | null, signal: NodeJS.Signals | null): DuplexProcessExit => ({
  code,
  signal,
});

const requestGroupTermination = (pid: number | undefined): void => {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // closeDuplexProcess performs the authoritative signal and group confirmation.
  }
};

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
    if (process.platform !== "darwin") return yield* unsupportedPlatform();

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
          stdio: ["pipe", "pipe", "pipe"],
        });
        // Even ENOENT returns a child before emitting error. Install handlers in
        // the same synchronous operation as spawn, before inspecting its pid.
        for (const stream of [child.stdin, child.stdout, child.stderr]) {
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

    let cleanupState: DuplexProcessCleanupState = "pending";
    const cachedClose = yield* Effect.cached(
      Effect.uninterruptible(
        Effect.suspend(() => io?.stop ?? Effect.void).pipe(
          Effect.andThen(
            closeDuplexProcess(child, {
              gracefulTimeoutMs: options.gracefulTimeoutMs,
              forceTimeoutMs: options.forceTimeoutMs,
              cleanupTimeoutMs: options.cleanupTimeoutMs,
              pollIntervalMs: options.pollIntervalMs,
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

    io = yield* makeDuplexProcessIo(child, {
      maxReadQueueBytes: options.maxReadQueueBytes,
      maxStderrBytes: options.maxStderrBytes,
      maxStderrQueueBytes: options.maxStderrQueueBytes,
      maxWriteBytes: options.maxWriteBytes,
      maxWriteQueueBytes: options.maxWriteQueueBytes,
      writeTimeoutMs: options.writeTimeoutMs,
      onProcessFailure: () => requestGroupTermination(child.pid),
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

/** Opens an Effect-scoped detached macOS process with duplex stdin/stdout. */
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
