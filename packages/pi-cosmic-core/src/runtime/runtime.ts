import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Path from "effect/Path";
import type * as Types from "effect/Types";
import { PiApi } from "./pi-api.ts";

/**
 * Pi owns the TTY. Effect's default console logger writes with `console.log` and
 * corrupts the TUI editor/input region. Keep only the span-event logger so
 * Effect.log* still contributes to traces without touching stdout/stderr.
 *
 * This layer has no diagnostic sink of its own: tracer log events are only observable
 * through a span exporter, and no extension owns one. Prefer
 * {@link piHostFileLoggerLayer} wherever an agent directory is available.
 */
export const piHostLoggerLayer = Logger.layer([Logger.tracerLogger]);

/** Log delivery is best effort; a missing sink must never take down a Pi session. */
const discardLogger = Logger.make<unknown, void>(() => {});

/**
 * Host log destination for one package: `<agentDirectory>/logs/<packageName>.jsonl`.
 *
 * The directory is a thunk because the Pi host resolves it lazily and may throw;
 * resolution happens inside the layer's fail-safe region.
 */
export interface PiHostLogTarget {
  readonly agentDirectory: () => string;
  readonly packageName: string;
}

/** One retained generation, matching the advisor failure log's bound. */
const MAX_HOST_LOG_BYTES = 1_000_000;

/**
 * Rotates at session start rather than per write: `Logger.toFile` has no size bound, and a
 * once-per-runtime check keeps growth bounded without adding work to the logging path.
 *
 * Failure is absorbed separately from the open below. Concurrent sessions of the same package
 * can race here, and a lost race must not cost that session its log sink.
 */
const rotateHostLog = (fs: FileSystem.FileSystem, logPath: string) =>
  Effect.gen(function* () {
    if (!(yield* fs.exists(logPath))) return;
    const info = yield* fs.stat(logPath);
    if (info.size < BigInt(MAX_HOST_LOG_BYTES)) return;
    const previous = `${logPath}.1`;
    yield* fs.remove(previous).pipe(Effect.ignore);
    yield* fs.rename(logPath, previous);
    yield* fs.chmod(previous, 0o600);
  }).pipe(Effect.ignoreCause);

/**
 * Opens the package's JSONL host log, degrading to a discarding logger when the
 * directory cannot be resolved, created, or opened. The handle closes with the scope.
 */
const makePiHostFileLogger = (target: PiHostLogTarget) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const agentDirectory = yield* Effect.try(target.agentDirectory);
    const directory = path.join(agentDirectory, "logs");
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    const logPath = path.join(directory, `${target.packageName}.jsonl`);
    yield* rotateHostLog(fs, logPath);
    return yield* Logger.formatJson.pipe(Logger.toFile(logPath, { mode: 0o600 }));
  }).pipe(Effect.catchCause(() => Effect.succeed(discardLogger)));

/**
 * TTY-safe host logging: span events plus a JSONL file sink so `Effect.log*` and
 * recovered boundary failures are actually observable.
 *
 * Requirements and failures are absorbed here on purpose. The layer stays
 * `Layer<never, never, never>` so adding a log sink never widens the `Layer.Error`
 * that Pi session-runtime facades carry.
 */
export const piHostFileLoggerLayer = (target: PiHostLogTarget): Layer.Layer<never> =>
  Logger.layer([Logger.tracerLogger, makePiHostFileLogger(target)]).pipe(
    Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
  );

declare const PiManagedRuntimeRuntimeError: unique symbol;

interface OwnedAbortSignal {
  readonly signal: AbortSignal;
  readonly release: () => void;
}

/** Never exposes a guarded host signal to Effect's runner after the fiber has started. */
const ownAbortSignal = (source: AbortSignal): OwnedAbortSignal => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  let removePending = true;
  const release = () => {
    if (!removePending) return;
    removePending = false;
    try {
      source.removeEventListener("abort", abort);
    } catch {
      // A hostile host signal cannot prevent Effect-owned fiber cleanup.
    }
  };
  try {
    source.addEventListener("abort", abort, { once: true });
    if (source.aborted) {
      controller.abort();
      release();
    }
  } catch {
    controller.abort();
    release();
  }
  return { signal: controller.signal, release };
};

/**
 * Creates one host-owned Effect runtime for a pi extension.
 *
 * Construct this from `session_start` (or lazily from the first session-bound
 * operation) and dispose it during `session_shutdown`. Application code should
 * not create nested runtimes.
 */
export function makePiRuntime(
  pi: ExtensionAPI,
  applicationLayer?: undefined,
  log?: PiHostLogTarget,
): ManagedRuntime.ManagedRuntime<PiApi, never>;
export function makePiRuntime<R, E>(
  pi: ExtensionAPI,
  applicationLayer: Layer.Layer<R, E, PiApi>,
  log?: PiHostLogTarget,
): ManagedRuntime.ManagedRuntime<PiApi | R, E>;
export function makePiRuntime<R, E>(
  pi: ExtensionAPI,
  applicationLayer?: Layer.Layer<R, E, PiApi>,
  log?: PiHostLogTarget,
) {
  const loggerLayer = log ? piHostFileLoggerLayer(log) : piHostLoggerLayer;
  const hostLayer = Layer.merge(PiApi.layer(pi), loggerLayer);
  return ManagedRuntime.make(
    applicationLayer ? applicationLayer.pipe(Layer.provideMerge(hostLayer)) : hostLayer,
  );
}

/** The only runtime operations exposed to Pi host-boundary adapters. */
export interface PiManagedRuntime<R, RuntimeError = unknown> {
  readonly [PiManagedRuntimeRuntimeError]?: Types.Covariant<RuntimeError>;
  readonly run: <A, E>(effect: Effect.Effect<A, E, PiApi | R>, signal?: AbortSignal) => Promise<A>;
  readonly fork: <A, E>(
    effect: Effect.Effect<A, E, PiApi | R>,
    signal?: AbortSignal,
  ) => Fiber.Fiber<A, E | RuntimeError>;
  readonly runSync: <A, E>(effect: Effect.Effect<A, E, PiApi | R>) => A;
  readonly dispose: () => Promise<void>;
}

/** Wraps the raw ManagedRuntime so packages share one stable Pi-boundary facade. */
export function makePiManagedRuntime<R, E>(
  pi: ExtensionAPI,
  applicationLayer: Layer.Layer<R, E, PiApi>,
  log?: PiHostLogTarget,
): PiManagedRuntime<R, E> {
  const runtime = makePiRuntime(pi, applicationLayer, log);
  let disposal: Promise<void> | undefined;
  return {
    run: (effect, signal) => {
      const owned = signal ? ownAbortSignal(signal) : undefined;
      const result = runtime.runPromise(effect, owned ? { signal: owned.signal } : undefined);
      return owned ? result.finally(owned.release) : result;
    },
    fork: (effect, signal) => {
      const owned = signal ? ownAbortSignal(signal) : undefined;
      const fiber = runtime.runFork(effect, owned ? { signal: owned.signal } : undefined);
      if (owned) fiber.addObserver(owned.release);
      return fiber;
    },
    runSync: (effect) => runtime.runSync(effect),
    dispose: () => {
      disposal ??= Promise.resolve().then(() => runtime.dispose());
      return disposal;
    },
  };
}
