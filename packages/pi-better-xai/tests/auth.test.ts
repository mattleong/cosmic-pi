// @effect-diagnostics effect/strictEffectProvide:off
// @effect-diagnostics effect/preferSchemaOverJson:off
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
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
      expect(yield* readXaiAuthResult(authPath).pipe(Effect.provide(missing.layer))).toEqual({
        _tag: "Missing",
      });

      const malformedResult = yield* readXaiAuthResult(authPath).pipe(
        Effect.provide(malformed.layer),
      );
      expect(malformedResult).toMatchObject({ _tag: "Malformed", operation: "decode" });
      expect(JSON.stringify(malformedResult)).not.toContain("refresh-secret-malformed");

      const validResult = yield* readXaiAuthResult(authPath).pipe(Effect.provide(valid.layer));
      expect(validResult._tag).toBe("Found");
      if (validResult._tag === "Found") {
        expect(Redacted.value(validResult.credentials.accessToken)).toBe(accessToken);
        expect(validResult.credentials.teamId).toBe("team-owned");
        expect(JSON.stringify(validResult.credentials)).not.toContain(accessToken);
        expect(JSON.stringify(validResult.credentials)).not.toContain("refresh-secret-valid");
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
          expires: 1,
        },
      },
    });
    const logger = makeCapturedLogger();
    const tracer = makeCapturedTracer();
    const layer = Layer.mergeAll(
      documents.layer,
      registryLayer(registrySecret),
      jsonHttpTestLayer(() => Effect.succeed(jsonHttpRawResponse(503, "provider-secret-body"))),
      logger.layer,
      tracer.layer,
    );

    return Effect.gen(function* () {
      const result = yield* getXaiCredentialsResult(authPath);
      expect(result._tag).toBe("Found");
      if (result._tag === "Found") {
        expect(result.credentials.source).toBe("modelRegistry");
        expect(Redacted.value(result.credentials.accessToken)).toBe(registrySecret);
      }
      const serialized = `${JSON.stringify(result)}\n${capturedTelemetrySnapshot({
        entries: logger.entries,
        spans: tracer.spans,
      })}`;
      for (const secret of [expiredAccess, refreshSecret, registrySecret, "provider-secret-body"])
        expect(serialized).not.toContain(secret);
    }).pipe(Effect.provide(layer));
  });
});
