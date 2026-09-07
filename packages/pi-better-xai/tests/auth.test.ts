import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import { provideBuiltLayer } from "pi-cosmic-core";
import {
  capturedTelemetrySnapshot,
  jsonHttpRawResponse,
  jsonHttpTestLayer,
  makeCapturedLogger,
  makeCapturedTracer,
  makeInMemoryDocuments,
} from "pi-cosmic-core/testing";
import { extractTeamIdFromJwt, getXaiCredentials, readXaiCredentials } from "../src/auth/auth.ts";
import { registryLayer, serializedSnapshot } from "./support/fixtures.ts";

type JwtFixturePayload = { readonly team_id?: string | number };

const jwtPayload = (value: JwtFixturePayload) => {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `header.${payload}.signature`;
};
const jwt = (teamId: string) => jwtPayload({ team_id: teamId });

const pausedRefresh = (
  access: string,
  refresh: string,
  response: { readonly access_token: string; readonly refresh_token?: string },
) =>
  Effect.gen(function* () {
    const authPath = "/agent/auth.json";
    const documents = makeInMemoryDocuments({
      [authPath]: { xai: { type: "oauth", access, refresh, expires: 1 } },
    });
    const refreshStarted = yield* Deferred.make<void>();
    const releaseRefresh = yield* Deferred.make<void>();
    const http = jsonHttpTestLayer(() =>
      Deferred.succeed(refreshStarted, undefined).pipe(
        Effect.andThen(Deferred.await(releaseRefresh)),
        Effect.as(jsonHttpRawResponse(200, JSON.stringify({ ...response, expires_in: 3_600 }))),
      ),
    );
    return {
      authPath,
      documents,
      refreshStarted,
      releaseRefresh,
      layer: Layer.mergeAll(documents.layer, registryLayer(), http),
    };
  });

// Pure leak-check serialization stays outside Effect code on purpose: it scans opaque
// runtime values (tagged errors, redacted credentials) for secret fragments.
describe("xAI authentication", () => {
  it("extracts trimmed team metadata and ignores invalid, missing, or blank claims", () => {
    const invalidJson = `header.${Buffer.from("{").toString("base64url")}.signature`;
    for (const token of [
      "not-a-jwt",
      "header.!!!!.signature",
      invalidJson,
      jwtPayload({}),
      jwtPayload({ team_id: 42 }),
      jwt("  \t  "),
    ])
      expect(extractTeamIdFromJwt(token)).toBeUndefined();
    expect(extractTeamIdFromJwt(jwt("  team-owned  "))).toBe("team-owned");
  });

  it.effect("distinguishes missing, malformed, and valid redacted auth documents", () => {
    const authPath = "/agent/auth.json";
    const missing = makeInMemoryDocuments();
    const malformed = makeInMemoryDocuments({
      [authPath]: {
        xai: {
          type: "oauth",
          access: 42,
          refresh: "refresh-secret-malformed",
        },
      },
    });
    const accessToken = jwt("team-owned");
    const valid = makeInMemoryDocuments({
      [authPath]: {
        xai: {
          type: "oauth",
          access: accessToken,
          refresh: "refresh-secret-valid",
          expires: 3_600_000,
        },
      },
    });

    return Effect.gen(function* () {
      expect(
        yield* readXaiCredentials(authPath).pipe(provideBuiltLayer(missing.layer)),
      ).toBeUndefined();

      const malformedAttempt = yield* readXaiCredentials(authPath).pipe(
        provideBuiltLayer(malformed.layer),
        Effect.result,
      );
      expect(malformedAttempt._tag).toBe("Failure");
      if (malformedAttempt._tag === "Failure")
        expect(malformedAttempt.failure.operation).toBe("decode");
      expect(serializedSnapshot(malformedAttempt)).not.toContain("refresh-secret-malformed");

      const validCredentials = yield* readXaiCredentials(authPath).pipe(
        provideBuiltLayer(valid.layer),
      );
      expect(validCredentials).toBeDefined();
      if (validCredentials !== undefined) {
        expect(Redacted.value(validCredentials.accessToken)).toBe(accessToken);
        expect(validCredentials.teamId).toBe("team-owned");
        expect(serializedSnapshot(validCredentials)).not.toContain(accessToken);
        expect(serializedSnapshot(validCredentials)).not.toContain("refresh-secret-valid");
      }
    });
  });

  it.effect("falls back from an expired refresh failure without exposing either secret", () => {
    const authPath = "/agent/auth.json";
    const expiredAccess = "expired-access-secret";
    const refreshSecret = "expired-refresh-secret";
    const registrySecret = "registry-fallback-secret";
    const documents = makeInMemoryDocuments({
      [authPath]: {
        xai: {
          type: "oauth",
          access: expiredAccess,
          refresh: refreshSecret,
          expires: 3_600_000,
        },
      },
    });
    let refreshAttempts = 0;
    const logger = makeCapturedLogger();
    const tracer = makeCapturedTracer();
    const layer = Layer.mergeAll(
      documents.layer,
      registryLayer(registrySecret),
      jsonHttpTestLayer(() => {
        refreshAttempts += 1;
        return Effect.succeed(jsonHttpRawResponse(503, "provider-secret-body"));
      }),
      logger.layer,
      tracer.layer,
    );

    return Effect.gen(function* () {
      // Advance past expiry (plus skew) so the refresh fires and the still-valid-token
      // guard cannot mask the registry fallback.
      yield* TestClock.setTime(4_000_000);
      const credentials = yield* getXaiCredentials(authPath);
      expect(refreshAttempts).toBe(1);
      expect(credentials).toBeDefined();
      if (credentials !== undefined)
        expect(Redacted.value(credentials.accessToken)).toBe(registrySecret);
      const serialized = `${serializedSnapshot(credentials)}\n${capturedTelemetrySnapshot({
        entries: logger.entries,
        spans: tracer.spans,
      })}`;
      for (const secret of [expiredAccess, refreshSecret, registrySecret, "provider-secret-body"])
        expect(serialized).not.toContain(secret);
    }).pipe(provideBuiltLayer(layer));
  });

  it.effect("preserves fields added while an OAuth refresh request is in flight", () =>
    Effect.gen(function* () {
      const h = yield* pausedRefresh("expiring-access-secret", "refresh-secret", {
        access_token: "refreshed-access-secret",
      });
      const fiber = yield* getXaiCredentials(h.authPath).pipe(
        provideBuiltLayer(h.layer),
        Effect.forkScoped,
      );
      yield* Deferred.await(h.refreshStarted);
      yield* h.documents.service.updateObject(h.authPath, (document) => ({
        ...document,
        concurrentRootField: "preserved",
        xai: {
          type: "oauth",
          access: "expiring-access-secret",
          refresh: "refresh-secret",
          expires: 1,
          concurrentEntryField: "preserved",
        },
      }));
      yield* Deferred.succeed(h.releaseRefresh, undefined);
      const credentials = yield* Fiber.join(fiber);

      expect(credentials).toBeDefined();
      if (credentials !== undefined) {
        expect(Redacted.value(credentials.accessToken)).toBe("refreshed-access-secret");
        expect(credentials.refreshToken).toBeDefined();
        if (credentials.refreshToken !== undefined)
          expect(Redacted.value(credentials.refreshToken)).toBe("refresh-secret");
      }
      expect(h.documents.documents.get(h.authPath)).toMatchObject({
        concurrentRootField: "preserved",
        xai: {
          concurrentEntryField: "preserved",
          access: "refreshed-access-secret",
          refresh: "refresh-secret",
        },
      });
    }),
  );

  it.effect("keeps a new login that lands while an OAuth refresh request is paused", () => {
    const capturedAccess = "captured-access-secret";
    const capturedRefresh = "captured-refresh-secret";
    const staleAccess = "stale-refreshed-access-secret";
    const staleRefresh = "stale-rotated-refresh-secret";
    const loginAccess = "new-login-access-secret";
    const loginRefresh = "new-login-refresh-secret";
    const loginExpires = 7_200_000;
    const logger = makeCapturedLogger();
    const tracer = makeCapturedTracer();

    return Effect.gen(function* () {
      const h = yield* pausedRefresh(capturedAccess, capturedRefresh, {
        access_token: staleAccess,
        refresh_token: staleRefresh,
      });
      const layer = Layer.mergeAll(h.layer, logger.layer, tracer.layer);
      const fiber = yield* getXaiCredentials(h.authPath).pipe(
        provideBuiltLayer(layer),
        Effect.forkScoped,
      );
      yield* Deferred.await(h.refreshStarted);
      yield* h.documents.service.updateObject(h.authPath, (document) => ({
        ...document,
        xai: {
          type: "oauth",
          access: loginAccess,
          refresh: loginRefresh,
          expires: loginExpires,
        },
      }));
      yield* Deferred.succeed(h.releaseRefresh, undefined);
      const credentials = yield* Fiber.join(fiber);

      expect(credentials).toBeDefined();
      if (credentials !== undefined) {
        expect(Redacted.value(credentials.accessToken)).toBe(loginAccess);
        expect(credentials.refreshToken).toBeDefined();
        if (credentials.refreshToken !== undefined)
          expect(Redacted.value(credentials.refreshToken)).toBe(loginRefresh);
        expect(credentials.expires).toBe(loginExpires);
      }
      expect(h.documents.documents.get(h.authPath)?.xai).toEqual({
        type: "oauth",
        access: loginAccess,
        refresh: loginRefresh,
        expires: loginExpires,
      });
      const diagnostics = `${serializedSnapshot(credentials)}\n${capturedTelemetrySnapshot({
        entries: logger.entries,
        spans: tracer.spans,
      })}`;
      for (const secret of [
        capturedAccess,
        capturedRefresh,
        staleAccess,
        staleRefresh,
        loginAccess,
        loginRefresh,
      ])
        expect(diagnostics).not.toContain(secret);
    });
  });

  it.effect("prefers a registry token when the file token does not need refresh", () => {
    const authPath = "/agent/auth.json";
    const documents = makeInMemoryDocuments({
      [authPath]: {
        xai: {
          type: "oauth",
          access: "file-access-secret",
          expires: 3_600_000,
        },
      },
    });
    const layer = Layer.mergeAll(
      documents.layer,
      registryLayer("registry-access-secret"),
      jsonHttpTestLayer(() => Effect.die("unexpected refresh request")),
    );

    return Effect.gen(function* () {
      const credentials = yield* getXaiCredentials(authPath);
      expect(credentials).toBeDefined();
      if (credentials !== undefined)
        expect(Redacted.value(credentials.accessToken)).toBe("registry-access-secret");
    }).pipe(provideBuiltLayer(layer));
  });

  it.effect("keeps a still-valid file token when its refresh fails", () => {
    const authPath = "/agent/auth.json";
    // Expires inside the refresh-skew window relative to the frozen TestClock (t=0):
    // the refresh fires early, fails, and the still-unexpired access token must stay
    // in use instead of silently downgrading to the model-registry credential.
    const documents = makeInMemoryDocuments({
      [authPath]: {
        xai: {
          type: "oauth",
          access: "valid-access-secret",
          refresh: "stale-refresh-secret",
          expires: 60_000,
        },
      },
    });
    let refreshAttempts = 0;
    const layer = Layer.mergeAll(
      documents.layer,
      registryLayer("registry-fallback-secret"),
      jsonHttpTestLayer(() => {
        refreshAttempts += 1;
        return Effect.succeed(jsonHttpRawResponse(503, "provider-secret-body"));
      }),
    );
    return Effect.gen(function* () {
      const credentials = yield* getXaiCredentials(authPath);
      expect(refreshAttempts).toBe(1);
      expect(credentials).toBeDefined();
      if (credentials !== undefined)
        expect(Redacted.value(credentials.accessToken)).toBe("valid-access-secret");
    }).pipe(provideBuiltLayer(layer));
  });
});
