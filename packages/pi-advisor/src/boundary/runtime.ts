import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Clock from "effect/Clock";
import type * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import { makePiRuntime, type PiApi } from "pi-cosmic-core";

export function makeAdvisorRuntime<R, E>(pi: ExtensionAPI, layer: Layer.Layer<R, E>) {
  const runtime = makePiRuntime(pi, layer);
  return {
    run<A, E2>(effect: Effect.Effect<A, E2, PiApi | R>, signal?: AbortSignal) {
      return runtime.runPromise(effect, signal ? { signal } : undefined);
    },
    fork<A, E2>(effect: Effect.Effect<A, E2, PiApi | R>, signal?: AbortSignal) {
      return runtime.runFork(effect, signal ? { signal } : undefined);
    },
    now() {
      return runtime.runSync(Clock.currentTimeMillis);
    },
    dispose() {
      return runtime.dispose();
    },
  };
}

export type AdvisorManagedRuntime = ReturnType<typeof makeAdvisorRuntime>;
