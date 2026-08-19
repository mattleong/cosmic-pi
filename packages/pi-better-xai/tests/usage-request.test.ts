// @effect-diagnostics effect/strictEffectProvide:off
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import {
  jsonHttpTestLayer,
  makeInMemoryDocuments,
  type JsonHttpTestResponse,
} from "pi-cosmic-core/testing";
import { ModelRegistryAuth } from "../src/boundary/model-registry-auth.ts";
import { requestXaiUsage } from "../src/usage/format.ts";

const authPath = "/agent/auth.json";

const registryLayer = Layer.succeed(
  ModelRegistryAuth,
  ModelRegistryAuth.of({
    getApiKey: Effect.succeed("registry-owned-test-token"),
    isUsingOAuth: () => Effect.succeed(true),
  }),
);

const provideRequest = (http: ReturnType<typeof jsonHttpTestLayer>) =>
  Layer.mergeAll(makeInMemoryDocuments().layer, registryLayer, http);

describe("requestXaiUsage resources", () => {
  it.effect("releases both concurrent HTTP resources when the usage request is interrupted", () => {
    let acquired = 0;
    let released = 0;
    return Effect.gen(function* () {
      const bothStarted = yield* Deferred.make<void>();
      const pending = yield* Deferred.make<JsonHttpTestResponse>();
      const http = jsonHttpTestLayer(() =>
        Effect.acquireUseRelease(
          Effect.gen(function* () {
            acquired++;
            if (acquired === 2) yield* Deferred.succeed(bothStarted, undefined);
          }),
          () => Deferred.await(pending),
          () =>
            Effect.sync(() => {
              released++;
            }),
        ),
      );
      const fiber = yield* requestXaiUsage(authPath).pipe(
        Effect.provide(provideRequest(http)),
        Effect.forkScoped,
      );
      yield* Deferred.await(bothStarted);
      yield* Fiber.interrupt(fiber);
      expect(acquired).toBe(2);
      expect(released).toBe(2);
    });
  });
});
