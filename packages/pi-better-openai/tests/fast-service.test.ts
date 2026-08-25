import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Path from "effect/Path";
import { AgentDirectory, provideBuiltLayer } from "pi-cosmic-core";
import { jsonHttpTestLayer, makeInMemoryDocuments, yieldUntil } from "pi-cosmic-core/testing";
import { FastModeService } from "../src/fast/service.ts";
import { initialFastSnapshot, type FastSnapshot } from "../src/fast/controller.ts";
import { OpenAIUsageService } from "../src/usage/controller.ts";
import { initialProjection } from "../src/usage/projection.ts";
import { makeResolvedConfig } from "./helpers.ts";

const model = (id: string): Model<Api> => ({
  id,
  name: id,
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://example.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
});

function makeContext(initialModel: string) {
  let currentModel = model(initialModel);
  const fixture = {
    cwd: "/project",
    hasUI: true as const,
    get model() {
      return currentModel;
    },
    modelRegistry: {
      isUsingOAuth: () => false,
      getApiKeyForProvider: () => Promise.resolve(undefined),
    },
    ui: { notify() {} },
  };
  return {
    // SAFETY: These tests exercise only the context members implemented by the fixture.
    ctx: fixture as typeof fixture & ExtensionContext,
    setModel(id: string) {
      currentModel = model(id);
    },
  };
}

const fakeUsageLayer = Layer.succeed(OpenAIUsageService, {
  refresh: () => Effect.void,
  contextChanged: () => Effect.void,
  updateSetting: () => Effect.void,
  persistFast: (_active, _desiredActive, afterCommit = Effect.void) =>
    Effect.uninterruptible(afterCommit),
  readConfigDocument: () => Effect.succeed({}),
});

describe("FastModeService", () => {
  it.effect("publishes persisted fast state only from the atomic afterCommit region", () => {
    const documents = makeInMemoryDocuments();
    const usageProjection = MutableRef.make(initialProjection());
    const fastProjection = MutableRef.make<FastSnapshot>(initialFastSnapshot());
    const current = makeContext("gpt-5.5");
    const usageLayer = OpenAIUsageService.layer({
      context: MutableRef.make(current.ctx),
      cwd: "/project",
      projection: usageProjection,
      onChange: () => undefined,
      startPolling: false,
      agentDir: "/agent",
      projectTrusted: true,
    });
    const fastLayer = FastModeService.layer({ projection: fastProjection }).pipe(
      Layer.provide(usageLayer),
      Layer.provide(
        Layer.mergeAll(
          documents.layer,
          Path.layer,
          AgentDirectory.layer("/agent"),
          jsonHttpTestLayer(() => Effect.die("unexpected HTTP request")),
        ),
      ),
    );

    return Effect.gen(function* () {
      const fast = yield* FastModeService;
      yield* fast.initialize(current.ctx, makeResolvedConfig(), false);

      const committed = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      documents.blockNextUpdateAtCommit(committed, release);
      const transition = yield* fast.setDesired(current.ctx, true).pipe(Effect.forkScoped);
      yield* Deferred.await(committed);

      const persistedAtCommit = [...documents.documents.values()][0];
      expect(persistedAtCommit).toMatchObject({ active: true, desiredActive: true });
      expect(MutableRef.get(fastProjection)).toMatchObject({
        active: false,
        desiredActive: false,
      });

      const interruption = yield* Fiber.interrupt(transition).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(interruption);

      expect(MutableRef.get(fastProjection)).toMatchObject({
        active: true,
        desiredActive: true,
      });
      expect([...documents.documents.values()][0]).toMatchObject({
        active: true,
        desiredActive: true,
      });
    }).pipe(provideBuiltLayer(fastLayer));
  });

  it.effect("tracks desired state across model eligibility and closes synchronous ingress", () => {
    const projection = MutableRef.make<FastSnapshot>(initialFastSnapshot());
    const current = makeContext("gpt-5.5");
    let offer: ((event: { readonly model: string; readonly tier: string }) => void) | undefined;
    const fastLayer = FastModeService.layer({ projection }).pipe(Layer.provide(fakeUsageLayer));

    return Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const fast = yield* FastModeService;
          offer = fast.recordInjection;
          yield* fast.initialize(current.ctx, makeResolvedConfig(), true);
          expect(MutableRef.get(projection)).toMatchObject({
            active: true,
            desiredActive: true,
          });

          current.setModel("unsupported-model");
          yield* fast.modelChanged(current.ctx);
          expect(MutableRef.get(projection)).toMatchObject({
            active: false,
            desiredActive: true,
          });

          current.setModel("gpt-5.5");
          yield* fast.modelChanged(current.ctx);
          expect(MutableRef.get(projection).active).toBe(true);

          offer?.({ model: "openai/gpt-5.5", tier: "priority" });
          yield* yieldUntil(
            () => MutableRef.get(projection).lastInjectedModel === "openai/gpt-5.5",
          );
        }).pipe(provideBuiltLayer(fastLayer)),
      );

      const closedSnapshot = MutableRef.get(projection);
      offer?.({ model: "openai/gpt-5.5", tier: "after-close" });
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      expect(MutableRef.get(projection)).toEqual(closedSnapshot);
    });
  });
});
