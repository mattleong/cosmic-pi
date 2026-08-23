import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
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
import { getXaiCredentialsResult, readXaiAuthResult } from "../src/auth/auth.ts";
import { ModelRegistryAuth } from "../src/boundary/model-registry-auth.ts";

const jwt = (teamId: string) => {
  const payload = Buffer.from(JSON.stringify({ team_id: teamId })).toString("base64url");
  return `header.${payload}.signature`;
};

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

describe("xAI authentication", () => {
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
      expect(yield* readXaiAuthResult(authPath).pipe(provideBuiltLayer(missing.layer))).toEqual({
        _tag: "Missing",
      });

      const malformedResult = yield* readXaiAuthResult(authPath).pipe(
        provideBuiltLayer(malformed.layer),
      );
      expect(malformedResult).toMatchObject({ _tag: "Malformed", operation: "decode" });
      expect(serializedSnapshot(malformedResult)).not.toContain("refresh-secret-malformed");

      const validResult = yield* readXaiAuthResult(authPath).pipe(provideBuiltLayer(valid.layer));
      expect(validResult._tag).toBe("Found");
      if (validResult._tag === "Found") {
        expect(Redacted.value(validResult.credentials.accessToken)).toBe(accessToken);
        expect(validResult.credentials.teamId).toBe("team-owned");
        expect(serializedSnapshot(validResult.credentials)).not.toContain(accessToken);
        expect(serializedSnapshot(validResult.credentials)).not.toContain("refresh-secret-valid");
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
      const result = yield* getXaiCredentialsResult(authPath);
      expect(refreshAttempts).toBe(1);
      expect(result._tag).toBe("Found");
      if (result._tag === "Found") {
        expect(result.credentials.source).toBe("modelRegistry");
        expect(Redacted.value(result.credentials.accessToken)).toBe(registrySecret);
      }
      const serialized = `${serializedSnapshot(result)}\n${capturedTelemetrySnapshot({
        entries: logger.entries,
        spans: tracer.spans,
      })}`;
      for (const secret of [expiredAccess, refreshSecret, registrySecret, "provider-secret-body"])
        expect(serialized).not.toContain(secret);
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
      const result = yield* getXaiCredentialsResult(authPath);
      expect(refreshAttempts).toBe(1);
      expect(result._tag).toBe("Found");
      if (result._tag === "Found") {
        expect(result.credentials.source).toBe("authFile");
        expect(Redacted.value(result.credentials.accessToken)).toBe("valid-access-secret");
      }
    }).pipe(provideBuiltLayer(layer));
  });
});
