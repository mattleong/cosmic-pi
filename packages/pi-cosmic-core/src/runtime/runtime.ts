import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as ManagedRuntime from "effect/ManagedRuntime";
import type * as Types from "effect/Types";
import { PiApi } from "./pi-api.ts";

/**
 * Pi owns the TTY. Effect's default console logger writes with `console.log` and
 * corrupts the TUI editor/input region. Keep only the span-event logger so
 * Effect.log* still contributes to traces without touching stdout/stderr.
 */
const piHostLoggerLayer = Logger.layer([Logger.tracerLogger]);

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
export function makePiRuntime(pi: ExtensionAPI): ManagedRuntime.ManagedRuntime<PiApi, never>;
export function makePiRuntime<R, E>(
  pi: ExtensionAPI,
  applicationLayer: Layer.Layer<R, E, PiApi>,
): ManagedRuntime.ManagedRuntime<PiApi | R, E>;
export function makePiRuntime<R, E>(pi: ExtensionAPI, applicationLayer?: Layer.Layer<R, E, PiApi>) {
  const hostLayer = Layer.merge(PiApi.layer(pi), piHostLoggerLayer);
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
): PiManagedRuntime<R, E> {
  const runtime = makePiRuntime(pi, applicationLayer);
  let disposal: Promise<void> | undefined;
  return {
    run: (effect, signal) => {
      const owned = signal ? ownAbortSignal(signal) : undefined;
      try {
        const result = Promise.resolve(
          runtime.runPromise(effect, owned ? { signal: owned.signal } : undefined),
        );
        return owned ? result.finally(owned.release) : result;
      } catch (error) {
        owned?.release();
        return Promise.reject(error);
      }
    },
    fork: (effect, signal) => {
      const owned = signal ? ownAbortSignal(signal) : undefined;
      try {
        const fiber = runtime.runFork(effect, owned ? { signal: owned.signal } : undefined);
        if (owned) fiber.addObserver(owned.release);
        return fiber;
      } catch (error) {
        owned?.release();
        throw error;
      }
    },
    runSync: (effect) => runtime.runSync(effect),
    dispose: () => {
      disposal ??= Promise.resolve().then(() => runtime.dispose());
      return disposal;
    },
  };
}
