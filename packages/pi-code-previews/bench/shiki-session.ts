// Benchmark-only scoped runtime; production rendering never creates a runtime.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/unsafeEffectTypeAssertion:off
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { ShikiAdapter } from "../src/boundary/shiki";
import {
  clearCodePreviewSessionCapability,
  installCodePreviewSessionCapability,
  type CodePreviewSessionCapability,
} from "../src/application/capability";
import { CodePreviewEnvironmentService } from "../src/config/environment-service";
import { initializeShikiEffect } from "../src/syntax/shiki";
import { CodePreviewSyntaxService } from "../src/syntax/service";

export async function startBenchmarkShikiSession(theme: string): Promise<() => Promise<void>> {
  const layer = Layer.merge(
    CodePreviewSyntaxService.layer.pipe(Layer.provide(ShikiAdapter.layer)),
    CodePreviewEnvironmentService.layer,
  );
  const runtime = ManagedRuntime.make(layer);
  await runtime.runPromise(initializeShikiEffect(theme));
  const capability = {
    token: 1,
    run: <A, E>(effect: Effect.Effect<A, E, never>, signal?: AbortSignal) =>
      runtime.runPromise(effect, signal ? { signal } : undefined),
    fork: <A, E>(effect: Effect.Effect<A, E, never>, signal?: AbortSignal) =>
      runtime.runFork(effect, signal ? { signal } : undefined),
  } as unknown as CodePreviewSessionCapability;
  installCodePreviewSessionCapability(capability);
  return async () => {
    clearCodePreviewSessionCapability(1);
    await runtime.dispose();
  };
}
