import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { PiApi } from "./pi-api.ts";

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
  const piLayer = PiApi.layer(pi);
  return ManagedRuntime.make(
    applicationLayer ? applicationLayer.pipe(Layer.provideMerge(piLayer)) : piLayer,
  );
}

/** The only runtime operations exposed to Pi host-boundary adapters. */
export interface PiManagedRuntime<R, RuntimeError = never> {
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
    run: (effect, signal) => runtime.runPromise(effect, signal ? { signal } : undefined),
    fork: (effect, signal) => runtime.runFork(effect, signal ? { signal } : undefined),
    runSync: (effect) => runtime.runSync(effect),
    dispose: () => {
      disposal ??= runtime.dispose();
      return disposal;
    },
  };
}
