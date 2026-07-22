// Effect execution is confined to explicit Pi/public compatibility boundaries.
// @effect-diagnostics effect/strictEffectProvide:off
import * as NodePath from "@effect/platform-node/NodePath";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { nodeFilePlatformLayer, piHostLoggerLayer } from "pi-cosmic-core";
import { ReadOnlyFileSystem } from "./read-only-fs.ts";

export const advisorPlatformLayer = Layer.mergeAll(
  nodeFilePlatformLayer,
  NodePath.layer,
  ReadOnlyFileSystem.layer,
);
export type AdvisorPlatform = Layer.Success<typeof advisorPlatformLayer>;

/** Standalone runner layer: platform services without TTY console logging. */
const standaloneAdvisorLayer = Layer.merge(advisorPlatformLayer, piHostLoggerLayer);

/** Session-owned capability passed explicitly to every advisor application component. */
export interface AdvisorEffectExecutor {
  readonly run: <A, E>(
    effect: Effect.Effect<A, E, AdvisorPlatform>,
    signal?: AbortSignal,
  ) => Promise<A>;
  readonly fork: <A, E>(effect: Effect.Effect<A, E, AdvisorPlatform>) => Fiber.Fiber<A, E>;
  readonly now: () => number;
}

/**
 * Public/test compatibility boundary for exported Promise APIs.
 * Production advisor services receive the session executor explicitly and never call this.
 */
export const standaloneAdvisorExecutor: AdvisorEffectExecutor = {
  run: (effect, signal) =>
    Effect.runPromise(
      effect.pipe(Effect.provide(standaloneAdvisorLayer)),
      signal ? { signal } : undefined,
    ),
  fork: (effect) => Effect.runFork(effect.pipe(Effect.provide(standaloneAdvisorLayer))),
  now: () => Effect.runSync(Clock.currentTimeMillis),
};
