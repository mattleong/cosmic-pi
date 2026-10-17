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
import { OpenAIConfigService } from "../src/config/store.ts";
import { initialProjection, type OpenAIProjection } from "../src/usage/projection.ts";
import { makeResolvedConfig, testContext, testModel } from "./helpers.ts";

function makeContext(initialModel: string) {
  let currentModel = testModel(initialModel);
  return {
    ctx: testContext({ model: () => currentModel, oauth: false }),
    setModel(id: string, provider = "openai") {
      currentModel = testModel(id, provider);
    },
  };
}

const fakeConfigLayer = Layer.succeed(OpenAIConfigService, {
  get: Effect.succeed(makeResolvedConfig()),
  observe: () => Effect.void,
  updateSetting: () => Effect.void,
  persistFast: (_desiredActive, afterCommit) => Effect.uninterruptible(afterCommit),
  readConfigDocument: Effect.succeed({}),
});

const PROJECT_CONFIG = "/project/.pi/extensions/pi-better-openai.json";
const GLOBAL_CONFIG = "/agent/extensions/pi-better-openai.json";

const persistedFastLayer = (
  documents: ReturnType<typeof makeInMemoryDocuments>,
  ctx: ExtensionContext,
  projections: {
    readonly fast: MutableRef.MutableRef<FastSnapshot>;
    readonly usage?: MutableRef.MutableRef<OpenAIProjection>;
  },
  http: Parameters<typeof jsonHttpTestLayer>[0] = () => Effect.die("unexpected HTTP request"),
) =>
  Layer.mergeAll(
    FastModeService.layer({ projection: projections.fast }),
    OpenAIUsageService.layer({
      context: MutableRef.make(ctx),
      projection: projections.usage ?? MutableRef.make(initialProjection()),
      onChange: () => undefined,
      startPolling: false,
    }),
  ).pipe(
    Layer.provideMerge(
      OpenAIConfigService.layer({
        cwd: "/project",
        projectTrusted: true,
        projection: MutableRef.make(undefined),
      }),
    ),
    Layer.provide(
      Layer.mergeAll(
        documents.layer,
        Path.layer,
        AgentDirectory.layer("/agent"),
        jsonHttpTestLayer(http),
      ),
    ),
  );

describe("FastModeService", () => {
  it.effect("publishes persisted fast state only from the atomic afterCommit region", () => {
    const documents = makeInMemoryDocuments({
      [GLOBAL_CONFIG]: { unknownField: "keep me", usage: { unknownUsageField: 123 } },
    });
    const fastProjection = MutableRef.make<FastSnapshot>(initialFastSnapshot());
    const current = makeContext("gpt-5.5");
    const fastLayer = persistedFastLayer(documents, current.ctx, { fast: fastProjection });

    return Effect.gen(function* () {
      const fast = yield* FastModeService;
      yield* fast.initialize(current.ctx, makeResolvedConfig(), true);

      const committed = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      documents.blockNextUpdateAtCommit(committed, release);
      const transition = yield* fast.setDesired(current.ctx, false).pipe(Effect.forkScoped);
      yield* Deferred.await(committed);

      const persistedAtCommit = [...documents.documents.values()][0];
      expect(persistedAtCommit).toMatchObject({ desiredActive: false });
      expect(MutableRef.get(fastProjection)).toMatchObject({
        active: true,
        desiredActive: true,
      });

      const interruption = yield* Fiber.interrupt(transition).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(interruption);

      expect(MutableRef.get(fastProjection)).toMatchObject({
        active: false,
        desiredActive: false,
      });
      yield* fast.modelChanged(current.ctx);
      expect(MutableRef.get(fastProjection)).toMatchObject({ active: false, desiredActive: false });
      expect([...documents.documents.values()][0]).toEqual({
        desiredActive: false,
        unknownField: "keep me",
        usage: { unknownUsageField: 123 },
      });
      yield* fast.setDesired(current.ctx, true);
      expect(MutableRef.get(fastProjection).desiredActive).toBe(true);
    }).pipe(provideBuiltLayer(fastLayer));
  });

  it.effect("startup and model switches write config only when --fast changes the intent", () => {
    const projectDocument = { image: { enabled: false } };
    const documents = makeInMemoryDocuments({
      [PROJECT_CONFIG]: projectDocument,
      [GLOBAL_CONFIG]: { desiredActive: true },
    });
    const fastProjection = MutableRef.make<FastSnapshot>(initialFastSnapshot());
    const current = makeContext("gpt-5.5");
    return Effect.gen(function* () {
      const fast = yield* FastModeService;
      yield* fast.initialize(current.ctx, makeResolvedConfig({ desiredActive: true }), false);
      current.setModel("future-model", "other-provider");
      yield* fast.modelChanged(current.ctx);
      expect(MutableRef.get(fastProjection)).toMatchObject({ desiredActive: true, active: false });
      expect(documents.documents.get(PROJECT_CONFIG)).toEqual(projectDocument);

      yield* fast.initialize(current.ctx, makeResolvedConfig(), true);
      expect(documents.documents.get(PROJECT_CONFIG)).toEqual({
        ...projectDocument,
        desiredActive: true,
      });
    }).pipe(
      provideBuiltLayer(persistedFastLayer(documents, current.ctx, { fast: fastProjection })),
    );
  });

  it.effect("tracks desired state across model eligibility and closes synchronous ingress", () => {
    const projection = MutableRef.make<FastSnapshot>(initialFastSnapshot());
    const current = makeContext("gpt-5.5");
    let offer: ((event: { readonly model: string; readonly tier: string }) => void) | undefined;
    const fastLayer = FastModeService.layer({ projection }).pipe(Layer.provide(fakeConfigLayer));

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

          current.setModel("future-model");
          yield* fast.modelChanged(current.ctx);
          expect(MutableRef.get(projection).active).toBe(true);

          current.setModel("future-model", "openai-codex");
          yield* fast.modelChanged(current.ctx);
          expect(MutableRef.get(projection).active).toBe(true);

          current.setModel("future-model", "other-provider");
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
