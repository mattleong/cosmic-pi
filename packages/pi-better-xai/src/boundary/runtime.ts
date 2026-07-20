import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import { makePiRuntime, type PiApi } from "pi-cosmic-core";

export function makeXaiRuntime<R, E>(pi: ExtensionAPI, layer: Layer.Layer<R, E>) {
  const runtime = makePiRuntime(pi, layer);
  return {
    run<A, E2>(effect: Effect.Effect<A, E2, PiApi | R>, signal?: AbortSignal) {
      return runtime.runPromise(effect, signal ? { signal } : undefined);
    },
    fork<A, E2>(effect: Effect.Effect<A, E2, PiApi | R>, signal?: AbortSignal) {
      return runtime.runFork(effect, signal ? { signal } : undefined);
    },
    dispose() {
      return runtime.dispose();
    },
  };
}
