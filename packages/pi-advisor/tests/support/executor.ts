// Test-only Effect execution boundary for Promise-shaped assertions.
// @effect-diagnostics effect/strictEffectProvide:off
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { piHostLoggerLayer } from "pi-cosmic-core";
import { advisorPlatformLayer, type AdvisorEffectExecutor } from "../../src/boundary/executor.ts";

/** Standalone runner layer: platform services without TTY console logging. */
const standaloneAdvisorLayer = Layer.merge(advisorPlatformLayer, piHostLoggerLayer);

/** Test-owned standalone executor; production components receive the session executor. */
export const standaloneAdvisorExecutor: AdvisorEffectExecutor = {
  run: (effect, signal) =>
    Effect.runPromise(
      effect.pipe(Effect.provide(standaloneAdvisorLayer)),
      signal ? { signal } : undefined,
    ),
  fork: (effect) => Effect.runFork(effect.pipe(Effect.provide(standaloneAdvisorLayer))),
  now: () => Effect.runSync(Clock.currentTimeMillis),
};
