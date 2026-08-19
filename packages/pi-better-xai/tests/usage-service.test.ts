// @effect-diagnostics effect/strictEffectProvide:off
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Path from "effect/Path";
import { AgentDirectory } from "pi-cosmic-core";
import { jsonHttpTestLayer, makeInMemoryDocuments } from "pi-cosmic-core/testing";
import { XaiUsageService } from "../src/usage/controller.ts";
import type { UsageSnapshot } from "../src/usage/format.ts";
import { makeProjection } from "../src/usage/projection.ts";

type HostModel = NonNullable<ExtensionContext["model"]>;

const model = (provider: HostModel["provider"]): HostModel => ({
  id: provider === "xai" ? "grok-4" : "other-model",
  name: "test model",
  api: "openai-completions",
  provider,
  baseUrl: "https://example.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
});

const context = (provider: HostModel["provider"]): ExtensionContext => {
  const fixture = {
    cwd: "/project",
    hasUI: true as const,
    model: model(provider),
    modelRegistry: {
      getApiKeyForProvider: () => Promise.resolve(undefined),
      isUsingOAuth: () => true,
    },
    ui: { notify() {} },
  };
  // SAFETY: This service test exercises only the context members implemented by the fixture.
  return fixture as typeof fixture & ExtensionContext;
};

const usageSnapshot = (monthlyUsed: number, weeklyUsedPercent: number): UsageSnapshot => ({
  capturedAt: 0,
  weeklyUsedPercent,
  weeklyLeftPercent: 100 - weeklyUsedPercent,
  weeklyResetInSeconds: null,
  monthlyUsed,
  monthlyLimit: 1_000,
  monthlyUsedPercent: monthlyUsed / 10,
  monthlyLeftPercent: 100 - monthlyUsed / 10,
  monthlyResetInSeconds: null,
  onDemandCap: 500,
  onDemandUsed: 100,
  isLimited: false,
});

describe("XaiUsageService", () => {
  it.effect(
    "suppresses an invalidated stale refresh and publishes the next eligible snapshot",
    () => {
      const documents = makeInMemoryDocuments();
      const projection = makeProjection();
      const contextRef = MutableRef.make(context("xai"));
      let changes = 0;

      return Effect.gen(function* () {
        const oldRequestStarted = yield* Deferred.make<void>();
        const releaseOldRequest = yield* Deferred.make<void>();
        let requests = 0;
        const requestUsage = () =>
          Effect.gen(function* () {
            requests++;
            // One refresh resolves one owned usage request. Keep the first request pending so a
            // context transition can invalidate it before it publishes.
            if (requests === 1) {
              yield* Deferred.succeed(oldRequestStarted, undefined);
              yield* Deferred.await(releaseOldRequest);
              return { snapshot: usageSnapshot(100, 10) };
            }
            return { snapshot: usageSnapshot(400, 20) };
          });
        const http = jsonHttpTestLayer(() => Effect.die("unexpected provider request"));
        const serviceLayer = XaiUsageService.layer({
          context: contextRef,
          cwd: "/project",
          projection,
          onChange: () => {
            changes++;
          },
          startPolling: false,
          agentDir: "/agent",
          projectTrusted: false,
          requestUsage,
        }).pipe(
          Layer.provide(
            Layer.mergeAll(documents.layer, http, Path.layer, AgentDirectory.layer("/agent")),
          ),
        );

        yield* Effect.gen(function* () {
          const service = yield* XaiUsageService;
          const stale = yield* service.refresh({ force: true }).pipe(Effect.forkScoped);
          yield* Deferred.await(oldRequestStarted);

          MutableRef.set(contextRef, context("openai"));
          yield* service.contextChanged(true);
          yield* Deferred.succeed(releaseOldRequest, undefined);
          yield* Fiber.join(stale);

          expect(MutableRef.get(projection)).toMatchObject({
            eligible: false,
            snapshot: undefined,
            statusLine: undefined,
          });

          MutableRef.set(contextRef, context("xai"));
          yield* service.contextChanged(true);
          yield* service.refresh({ force: true });
          expect(MutableRef.get(projection)).toMatchObject({
            eligible: true,
            snapshot: {
              monthlyUsed: 400,
              monthlyLimit: 1_000,
              weeklyUsedPercent: 20,
            },
          });
          expect(MutableRef.get(projection).statusLine).toBeDefined();
          expect(changes).toBeGreaterThan(0);
        }).pipe(Effect.provide(serviceLayer));
      });
    },
  );
});
