import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { runCodePreviewSessionEffect } from "../application/capability";

type NodePlatform = Layer.Success<typeof nodeFilePlatformLayer>;

export function runPlatformEffect<A, E>(
  effect: Effect.Effect<A, E, NodePlatform>,
  signal?: AbortSignal,
): Promise<A> {
  return runCodePreviewSessionEffect(effect, signal);
}
