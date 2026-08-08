import * as NodePath from "@effect/platform-node/NodePath";
import type * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { ReadOnlyFileSystem } from "./read-only-fs.ts";

export const advisorPlatformLayer = Layer.mergeAll(
  nodeFilePlatformLayer,
  NodePath.layer,
  ReadOnlyFileSystem.layer,
);
export type AdvisorPlatform = Layer.Success<typeof advisorPlatformLayer>;

/** Session-owned capability passed explicitly to every advisor application component. */
export interface AdvisorEffectExecutor {
  readonly run: <A, E>(
    effect: Effect.Effect<A, E, AdvisorPlatform>,
    signal?: AbortSignal,
  ) => Promise<A>;
  readonly fork: <A, E>(effect: Effect.Effect<A, E, AdvisorPlatform>) => Fiber.Fiber<A, E>;
  readonly now: () => number;
}
