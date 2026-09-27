import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { provideBuiltLayer } from "pi-cosmic-core";
import {
  jsonHttpRawResponse,
  jsonHttpTestLayer,
  type JsonHttpTestResponse,
} from "pi-cosmic-core/testing";
import { registryLayer, registryLookupLayer, serializedSnapshot } from "./support/fixtures.ts";
import { requestXaiUsage } from "../src/usage/request.ts";

const emptyBilling = JSON.stringify({ config: {} });

/**
 * Registry lookups answer in order (the last answer repeats). Monthly billing accepts only
 * `acceptedToken` and rejects every other token with a 401; weekly credits always succeed.
 */
const rejectedUsage = (
  registryAnswers: readonly [string, ...Array<string | Error>],
  acceptedToken?: string,
) => {
  const counts = { registry: 0, monthly: 0 };
  const registry = registryLookupLayer(
    () => registryAnswers[Math.min(counts.registry++, registryAnswers.length - 1)],
  );
  const http = jsonHttpTestLayer((request) => {
    if (request.url.includes("format=credits"))
      return Effect.succeed(jsonHttpRawResponse(200, emptyBilling));
    counts.monthly++;
    const accepted =
      acceptedToken !== undefined && request.headers?.Authorization === `Bearer ${acceptedToken}`;
    return Effect.succeed(
      accepted ? jsonHttpRawResponse(200, emptyBilling) : jsonHttpRawResponse(401, "rejected"),
    );
  });
  return { counts, layer: Layer.merge(registry, http) };
};

describe("requestXaiUsage", () => {
  it.effect("retries a 401 once with the changed token the registry re-resolves", () => {
    const rejected = "rejected-access-secret";
    const replacement = "replacement-registry-secret";
    const usage = rejectedUsage([rejected, replacement], replacement);
    return Effect.gen(function* () {
      const result = yield* requestXaiUsage();
      expect(result?.snapshot.monthlyUsed).toBeNull();
      expect(usage.counts).toEqual({ registry: 2, monthly: 2 });
      expect(serializedSnapshot(result)).not.toMatch(/rejected-access|replacement-registry/);
    }).pipe(provideBuiltLayer(usage.layer));
  });

  it.effect("never resends a token the provider rejected", () => {
    const rejected = "unchanged-rejected-secret";
    const usage = rejectedUsage([rejected]);
    return Effect.gen(function* () {
      const error = yield* Effect.flip(requestXaiUsage());
      expect(error.operation).toBe("monthly");
      expect(usage.counts).toEqual({ registry: 2, monthly: 1 });
      expect(serializedSnapshot(error)).not.toContain(rejected);
    }).pipe(provideBuiltLayer(usage.layer));
  });

  it.effect("keeps the 401 usage error when the registry re-resolve fails", () => {
    const rejected = "rejected-before-refresh-secret";
    const usage = rejectedUsage([rejected, new Error("refresh failed: error_description")]);
    return Effect.gen(function* () {
      const error = yield* Effect.flip(requestXaiUsage());
      expect(error.operation).toBe("monthly");
      expect(error.message).toContain("status 401");
      expect(usage.counts).toEqual({ registry: 2, monthly: 1 });
      expect(serializedSnapshot(error)).not.toMatch(/rejected-before-refresh|error_description/);
    }).pipe(provideBuiltLayer(usage.layer));
  });

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
      const fiber = yield* requestXaiUsage().pipe(
        provideBuiltLayer(Layer.merge(registryLayer("registry-owned-test-token"), http)),
        Effect.forkScoped,
      );
      yield* Deferred.await(bothStarted);
      yield* Fiber.interrupt(fiber);
      expect(acquired).toBe(2);
      expect(released).toBe(2);
    });
  });
});
