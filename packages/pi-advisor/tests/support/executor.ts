// Test-only Effect execution boundary for Promise-shaped assertions.
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { piHostLoggerLayer, provideBuiltLayer } from "pi-cosmic-core";
import { advisorPlatformLayer, type AdvisorEffectExecutor } from "../../src/boundary/executor.ts";
import type { ReadOnlyFileSystem } from "../../src/boundary/read-only-fs.ts";

/** Standalone runner layer: platform services without TTY console logging. */
const standaloneAdvisorLayer = Layer.merge(advisorPlatformLayer, piHostLoggerLayer);

/** Test-owned standalone executor; production components receive the session executor. */
export const makeStandaloneAdvisorExecutor = (
  readOnlyFileSystem?: Layer.Layer<ReadOnlyFileSystem>,
): AdvisorEffectExecutor => {
  const layer = readOnlyFileSystem
    ? Layer.merge(standaloneAdvisorLayer, readOnlyFileSystem)
    : standaloneAdvisorLayer;
  return {
    run: (effect, signal) =>
      Effect.runPromise(effect.pipe(provideBuiltLayer(layer)), signal ? { signal } : undefined),
    fork: (effect) => Effect.runFork(effect.pipe(provideBuiltLayer(layer))),
    now: () => Effect.runSync(Clock.currentTimeMillis),
  };
};

export const standaloneAdvisorExecutor = makeStandaloneAdvisorExecutor();
