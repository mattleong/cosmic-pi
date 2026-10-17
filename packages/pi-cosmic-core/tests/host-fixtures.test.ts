import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vitest";
import { modelFixture, modelRegistryFixture } from "../testing.ts";

it.effect("never resolves host credentials from the environment", () =>
  Effect.gen(function* () {
    vi.stubEnv("OPENAI_API_KEY", "sk-fixture");
    yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
    const registry = modelRegistryFixture();
    const model = modelFixture({ provider: "openai", id: "gpt-5.5" });
    expect(yield* Effect.promise(() => registry.getApiKeyAndHeaders(model))).toMatchObject({
      ok: false,
    });
    expect(registry.hasConfiguredAuth(model)).toBe(false);
  }).pipe(Effect.scoped),
);
