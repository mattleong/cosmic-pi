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
import { readXaiCredentials } from "../src/auth/auth.ts";
import { ModelRegistryAuth } from "../src/boundary/model-registry-auth.ts";
import { requestXaiUsage } from "../src/usage/format.ts";

const authPath = "/agent/auth.json";

// Pure leak-check serialization stays outside Effect code on purpose: it scans opaque
// runtime values (tagged errors, redacted credentials) for secret fragments.
const serializedSnapshot = <Value>(value: Value): string => JSON.stringify(value) ?? "";

const registryEffectLayer = (getApiKey: Effect.Effect<string | undefined>) =>
  Layer.succeed(
    ModelRegistryAuth,
    ModelRegistryAuth.of({
      getApiKey,
      isUsingOAuth: () => Effect.succeed(true),
    }),
  );

const registryLayer = (token?: string) => registryEffectLayer(Effect.succeed(token));

const provideRequest = (http: ReturnType<typeof jsonHttpTestLayer>) =>
  Layer.mergeAll(makeInMemoryDocuments().layer, registryLayer("registry-owned-test-token"), http);

describe("requestXaiUsage resources", () => {
  it.effect("refreshes a file token with unknown expiry once after a 401", () => {
    const expiredAccess = "expired-access-secret";
    const refreshSecret = "refresh-secret";
    const refreshedAccess = "refreshed-access-secret";
    const documents = makeInMemoryDocuments({
      [authPath]: {
        other: "preserved-root-field",
        xai: {
          type: "oauth",
          access: expiredAccess,
          refresh: refreshSecret,
          future: "preserved-entry-field",
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
      const persisted = yield* readXaiCredentials(authPath);
      expect(persisted?.expires).toBeGreaterThan(0);
      expect(documents.updateCount).toBe(1);
      expect(documents.documents.get(authPath)).toMatchObject({
        other: "preserved-root-field",
        xai: {
          future: "preserved-entry-field",
          access: refreshedAccess,
          refresh: refreshSecret,
        },
      });
      expect(serializedSnapshot(result)).not.toContain(expiredAccess);
      expect(serializedSnapshot(result)).not.toContain(refreshSecret);
      expect(serializedSnapshot(result)).not.toContain(refreshedAccess);
    }).pipe(provideBuiltLayer(layer));
  });

  it.effect(
    "falls back to a changed registry token when the rejected file token cannot refresh",
    () => {
      const rejectedAccess = "rejected-file-access-secret";
      const refreshSecret = "failed-refresh-secret";
      const registryAccess = "replacement-registry-secret";
      const documents = makeInMemoryDocuments({
        [authPath]: {
          xai: {
            type: "oauth",
            access: rejectedAccess,
            refresh: refreshSecret,
          },
        },
      });
      let registryLookups = 0;
      let refreshAttempts = 0;
      let monthlyRequests = 0;
      const registry = registryEffectLayer(
        Effect.sync(() => {
          registryLookups++;
          return registryLookups === 1 ? rejectedAccess : registryAccess;
        }),
      );
      const http = jsonHttpTestLayer((request) => {
        if (request.method === "POST") {
          refreshAttempts++;
          return Effect.succeed(jsonHttpRawResponse(503, "refresh unavailable"));
        }
        if (request.url.includes("format=credits"))
          return Effect.succeed(jsonHttpRawResponse(200, JSON.stringify({ config: {} })));
        monthlyRequests++;
        return Effect.succeed(
          request.headers?.Authorization === `Bearer ${registryAccess}`
            ? jsonHttpRawResponse(200, JSON.stringify({ config: {} }))
            : jsonHttpRawResponse(401, "rejected"),
        );
      });
      const layer = Layer.mergeAll(documents.layer, registry, http);

      return Effect.gen(function* () {
        const result = yield* requestXaiUsage(authPath);
        expect(result?.snapshot.monthlyUsed).toBeNull();
        expect(refreshAttempts).toBe(1);
        expect(registryLookups).toBe(2);
        expect(monthlyRequests).toBe(2);
        for (const secret of [rejectedAccess, refreshSecret, registryAccess])
          expect(serializedSnapshot(result)).not.toContain(secret);
      }).pipe(provideBuiltLayer(layer));
    },
  );

  it.effect("does not retry when the registry still returns the rejected token", () => {
    const rejectedAccess = "unchanged-rejected-secret";
    const documents = makeInMemoryDocuments({
      [authPath]: {
        xai: {
          type: "oauth",
          access: rejectedAccess,
        },
      },
    });
    let registryLookups = 0;
    let refreshAttempts = 0;
    let monthlyRequests = 0;
    const registry = registryEffectLayer(
      Effect.sync(() => {
        registryLookups++;
        return rejectedAccess;
      }),
    );
    const http = jsonHttpTestLayer((request) => {
      if (request.method === "POST") {
        refreshAttempts++;
        return Effect.succeed(jsonHttpRawResponse(500, "unexpected refresh"));
      }
      if (request.url.includes("format=credits"))
        return Effect.succeed(jsonHttpRawResponse(200, JSON.stringify({ config: {} })));
      monthlyRequests++;
      return Effect.succeed(jsonHttpRawResponse(401, "rejected"));
    });
    const layer = Layer.mergeAll(documents.layer, registry, http);

    return Effect.gen(function* () {
      const result = yield* requestXaiUsage(authPath).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.operation).toBe("monthly");
      expect(refreshAttempts).toBe(0);
      expect(registryLookups).toBe(2);
      expect(monthlyRequests).toBe(1);
      expect(serializedSnapshot(result)).not.toContain(rejectedAccess);
    }).pipe(provideBuiltLayer(layer));
  });

  it.effect("does not overwrite credentials replaced while a rejected request is in flight", () => {
    const rejectedAccess = "raced-rejected-access-secret";
    const rejectedRefresh = "raced-rejected-refresh-secret";
    const replacementAccess = "concurrent-replacement-access-secret";
    const replacementRefresh = "concurrent-replacement-refresh-secret";
    const documents = makeInMemoryDocuments({
      [authPath]: {
        xai: {
          type: "oauth",
          access: rejectedAccess,
          refresh: rejectedRefresh,
        },
      },
    });
    let refreshAttempts = 0;
    let registryLookups = 0;

    return Effect.gen(function* () {
      const monthlyStarted = yield* Deferred.make<void>();
      const releaseMonthly = yield* Deferred.make<void>();
      const registry = registryEffectLayer(
        Effect.sync(() => {
          registryLookups++;
          return rejectedAccess;
        }),
      );
      const http = jsonHttpTestLayer((request) => {
        if (request.method === "POST") {
          refreshAttempts++;
          return Effect.succeed(jsonHttpRawResponse(500, "unexpected refresh"));
        }
        if (request.url.includes("format=credits"))
          return Effect.succeed(jsonHttpRawResponse(200, JSON.stringify({ config: {} })));
        return Deferred.succeed(monthlyStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseMonthly)),
          Effect.as(jsonHttpRawResponse(401, "rejected")),
        );
      });
      const layer = Layer.mergeAll(documents.layer, registry, http);
      const fiber = yield* requestXaiUsage(authPath).pipe(
        Effect.result,
        provideBuiltLayer(layer),
        Effect.forkScoped,
      );
      yield* Deferred.await(monthlyStarted);
      yield* documents.service.updateObject(authPath, (document) => ({
        ...document,
        xai: {
          type: "oauth",
          access: replacementAccess,
          refresh: replacementRefresh,
        },
      }));
      yield* Deferred.succeed(releaseMonthly, undefined);
      const result = yield* Fiber.join(fiber);

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.operation).toBe("monthly");
      expect(refreshAttempts).toBe(0);
      expect(registryLookups).toBe(2);
      expect(documents.documents.get(authPath)).toMatchObject({
        xai: { access: replacementAccess, refresh: replacementRefresh },
      });
    });
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
