import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { provideBuiltLayer } from "pi-cosmic-core";
import {
  jsonHttpRawResponse,
  jsonHttpTestLayer,
  makeInMemoryDocuments,
  type JsonHttpTestResponse,
} from "pi-cosmic-core/testing";
import { readXaiAuthResult } from "../src/auth/auth.ts";
import { ModelRegistryAuth } from "../src/boundary/model-registry-auth.ts";
import { requestXaiUsage } from "../src/usage/format.ts";

const authPath = "/agent/auth.json";

// Pure leak-check serialization stays outside Effect code on purpose: it scans opaque
// runtime values (tagged errors, redacted credentials) for secret fragments.
const serializedSnapshot = <Value>(value: Value): string => JSON.stringify(value) ?? "";

const registryLayer = (token?: string) =>
  Layer.succeed(
    ModelRegistryAuth,
    ModelRegistryAuth.of({
      getApiKey: Effect.succeed(token),
      isUsingOAuth: () => Effect.succeed(true),
    }),
  );

const provideRequest = (http: ReturnType<typeof jsonHttpTestLayer>) =>
  Layer.mergeAll(makeInMemoryDocuments().layer, registryLayer("registry-owned-test-token"), http);

describe("requestXaiUsage resources", () => {
  it.effect("refreshes a file token with unknown expiry once after a 401", () => {
    const expiredAccess = "expired-access-secret";
    const refreshSecret = "refresh-secret";
    const refreshedAccess = "refreshed-access-secret";
    const documents = makeInMemoryDocuments({
      [authPath]: {
        xai: {
          type: "oauth",
          access: expiredAccess,
          refresh: refreshSecret,
        },
      },
    });
    let initialBillingResponses = 0;
    const http = jsonHttpTestLayer((request) => {
      if (request.method === "POST")
        return Effect.succeed(
          jsonHttpRawResponse(
            200,
            JSON.stringify({ access_token: refreshedAccess, expires_in: 3_600 }),
          ),
        );
      initialBillingResponses++;
      return Effect.succeed(
        initialBillingResponses <= 2
          ? jsonHttpRawResponse(401, "expired")
          : jsonHttpRawResponse(200, JSON.stringify({ config: {} })),
      );
    });
    // Pi's registry commonly returns the same stored OAuth token without file provenance.
    const layer = Layer.mergeAll(documents.layer, registryLayer(expiredAccess), http);

    return Effect.gen(function* () {
      const result = yield* requestXaiUsage(authPath);
      expect(result?.snapshot.monthlyUsed).toBeNull();
      const persisted = yield* readXaiAuthResult(authPath);
      expect(persisted._tag).toBe("Found");
      if (persisted._tag === "Found") {
        expect(persisted.credentials.expires).toBeGreaterThan(0);
      }
      expect(serializedSnapshot(result)).not.toContain(expiredAccess);
      expect(serializedSnapshot(result)).not.toContain(refreshSecret);
      expect(serializedSnapshot(result)).not.toContain(refreshedAccess);
    }).pipe(provideBuiltLayer(layer));
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
      const fiber = yield* requestXaiUsage(authPath).pipe(
        provideBuiltLayer(provideRequest(http)),
        Effect.forkScoped,
      );
      yield* Deferred.await(bothStarted);
      yield* Fiber.interrupt(fiber);
      expect(acquired).toBe(2);
      expect(released).toBe(2);
    });
  });
});
