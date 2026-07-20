// Effect.provide is intentionally confined to this public application boundary.
// @effect-diagnostics effect/strictEffectProvide:off
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import type * as Layer from "effect/Layer";
import type * as Semaphore from "effect/Semaphore";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { ShikiAdapter } from "./shiki";

type NodePlatform = Layer.Success<typeof nodeFilePlatformLayer>;

export interface ActivePlatformRunner {
  readonly run: <A, E>(
    effect: Effect.Effect<A, E, NodePlatform>,
    signal?: AbortSignal,
  ) => Promise<A>;
  readonly runShiki: <A, E>(
    effect: Effect.Effect<A, E, ShikiAdapter>,
    signal?: AbortSignal,
  ) => Promise<A>;
  readonly forkShiki: <A, E>(effect: Effect.Effect<A, E, ShikiAdapter>) => Fiber.Fiber<A, unknown>;
}

let activeRunner: ActivePlatformRunner | undefined;

function hostAbortMessage<A>(promise: Promise<A>, signal: AbortSignal | undefined): Promise<A> {
  if (!signal) return promise;
  return promise.catch((error: unknown) => {
    if (signal.aborted) throw new Error("Operation aborted");
    throw error;
  });
}

/** Installed only while a session ManagedRuntime owns package work. */
export function setActivePlatformRunner(runner: ActivePlatformRunner | undefined): void {
  activeRunner = runner;
}

export function runShikiEffect<A, E>(
  effect: Effect.Effect<A, E, ShikiAdapter>,
  signal?: AbortSignal,
): Promise<A> {
  if (activeRunner) return hostAbortMessage(activeRunner.runShiki(effect, signal), signal);
  return hostAbortMessage(
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(ShikiAdapter, ShikiAdapter.live),
        Effect.timeout("30 seconds"),
      ),
      signal ? { signal } : undefined,
    ),
    signal,
  );
}

export function forkShikiEffect<A, E>(
  effect: Effect.Effect<A, E, ShikiAdapter>,
): Fiber.Fiber<A, E> {
  if (activeRunner) return activeRunner.forkShiki(effect) as Fiber.Fiber<A, E>;
  return Effect.runFork(
    effect.pipe(
      Effect.provideService(ShikiAdapter, ShikiAdapter.live),
      Effect.timeout("30 seconds"),
      Effect.catch(() => Effect.void),
    ),
  ) as Fiber.Fiber<A, E>;
}

export function runSerializedPlatformEffect<A, E>(
  semaphore: Semaphore.Semaphore,
  effect: Effect.Effect<A, E, NodePlatform>,
  signal?: AbortSignal,
): Promise<A> {
  const serialized = semaphore.withPermits(1)(effect);
  if (activeRunner) return hostAbortMessage(activeRunner.run(serialized, signal), signal);
  return hostAbortMessage(
    Effect.runPromise(
      serialized.pipe(Effect.provide(nodeFilePlatformLayer)),
      signal ? { signal } : undefined,
    ),
    signal,
  );
}

export function runPlatformEffect<A, E>(
  effect: Effect.Effect<A, E, NodePlatform>,
  signal?: AbortSignal,
): Promise<A> {
  if (activeRunner) return hostAbortMessage(activeRunner.run(effect, signal), signal);
  return hostAbortMessage(
    Effect.runPromise(
      effect.pipe(Effect.provide(nodeFilePlatformLayer)),
      signal ? { signal } : undefined,
    ),
    signal,
  );
}
