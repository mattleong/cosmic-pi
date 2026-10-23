import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Path from "effect/Path";
import type * as Types from "effect/Types";
import { invokeHostCallback } from "../host-session.ts";
import { PiApi } from "./pi-api.ts";

export const piHostLoggerLayer = Logger.layer([Logger.tracerLogger]);

const discardLogger = Logger.make<unknown, void>(() => {});

interface PiHostLogTarget {
  readonly agentDirectory: () => string;
  readonly packageName: string;
}

const MAX_HOST_LOG_BYTES = 1_000_000;

const rotateHostLog = Effect.fn("PiHostLogger.rotate")(
  function* (fs: FileSystem.FileSystem, logPath: string) {
    const info = yield* fs.stat(logPath);
    if (ByteSize.toBigInt(info.size) < BigInt(MAX_HOST_LOG_BYTES)) return;
    const previous = `${logPath}.1`;
    yield* fs.remove(previous).pipe(Effect.ignore);
    yield* fs.rename(logPath, previous);
    yield* fs.chmod(previous, 0o600);
  },
  (effect) => Effect.ignoreCause(effect),
);

const makePiHostFileLogger = Effect.fn("PiHostLogger.make")(
  function* (target: PiHostLogTarget) {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const agentDirectory = yield* Effect.try(target.agentDirectory);
    const directory = path.join(agentDirectory, "logs");
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    const logPath = path.join(directory, `${target.packageName}.jsonl`);
    yield* rotateHostLog(fs, logPath);
    return yield* Logger.formatJson.pipe(Logger.toFile(logPath, { mode: 0o600 }));
  },
  Effect.catchCause(() => Effect.succeed(discardLogger)),
);

export const piHostFileLoggerLayer = (target: PiHostLogTarget): Layer.Layer<never> =>
  Logger.layer([Logger.tracerLogger, makePiHostFileLogger(target)]).pipe(
    Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
  );

declare const PiManagedRuntimeRuntimeError: unique symbol;

export interface ForwardedAbortSignal {
  /** Aborts when the source aborts, including when it already had or its listener failed. */
  readonly signal: AbortSignal;
  /** Removes the source listener; idempotent. */
  readonly release: () => void;
}

/**
 * Forwards a host abort signal to a signal this caller owns. The listener is installed before the
 * initial aborted state is read, so an abort in between is not missed; a host signal that throws
 * counts as aborted.
 */
export const forwardAbortSignal = (source: AbortSignal): ForwardedAbortSignal => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  let removePending = true;
  const release = () => {
    if (!removePending) return;
    removePending = false;
    invokeHostCallback(() => source.removeEventListener("abort", abort), undefined);
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

export function makePiRuntime<R, E>(
  pi: ExtensionAPI,
  applicationLayer: Layer.Layer<R, E, PiApi>,
  log?: PiHostLogTarget,
): ManagedRuntime.ManagedRuntime<PiApi | R, E> {
  const loggerLayer = log ? piHostFileLoggerLayer(log) : piHostLoggerLayer;
  return ManagedRuntime.make(
    applicationLayer.pipe(Layer.provideMerge(Layer.merge(PiApi.layer(pi), loggerLayer))),
  );
}

export interface PiManagedRuntime<R, RuntimeError = unknown> {
  readonly [PiManagedRuntimeRuntimeError]?: Types.Covariant<RuntimeError>;
  readonly run: <A, E>(effect: Effect.Effect<A, E, PiApi | R>, signal?: AbortSignal) => Promise<A>;
  readonly fork: <A, E>(
    effect: Effect.Effect<A, E, PiApi | R>,
    signal?: AbortSignal,
  ) => Fiber.Fiber<A, E | RuntimeError>;
  readonly dispose: () => Promise<void>;
}

export function makePiManagedRuntime<R, E>(
  pi: ExtensionAPI,
  applicationLayer: Layer.Layer<R, E, PiApi>,
  log?: PiHostLogTarget,
): PiManagedRuntime<R, E> {
  const runtime = makePiRuntime(pi, applicationLayer, log);
  let disposal: Promise<void> | undefined;
  return {
    run: (effect, signal) => {
      const owned = signal ? forwardAbortSignal(signal) : undefined;
      const result = runtime.runPromise(effect, owned ? { signal: owned.signal } : undefined);
      return owned ? result.finally(owned.release) : result;
    },
    fork: (effect, signal) => {
      const owned = signal ? forwardAbortSignal(signal) : undefined;
      const fiber = runtime.runFork(effect, owned ? { signal: owned.signal } : undefined);
      if (owned) fiber.addObserver(owned.release);
      return fiber;
    },
    dispose: () => {
      disposal ??= Promise.resolve().then(() => runtime.dispose());
      return disposal;
    },
  };
}
