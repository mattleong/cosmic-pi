import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Path from "effect/Path";
import * as Scheduler from "effect/Scheduler";
import { AgentDirectory, provideBuiltLayer } from "pi-cosmic-core";
import {
  interruptingScheduler,
  jsonHttpTestLayer,
  makeInMemoryDocuments,
  yieldUntil,
} from "pi-cosmic-core/testing";
import { FastModeService } from "../src/fast/service.ts";
import { initialFastSnapshot, type FastSnapshot } from "../src/fast/controller.ts";
import { OpenAIUsageService } from "../src/usage/controller.ts";
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

const fakeUsageLayer = Layer.succeed(OpenAIUsageService, {
  refresh: () => Effect.void,
  contextChanged: () => Effect.void,
  updateSetting: () => Effect.void,
  persistFast: (_active, _desiredActive, afterCommit) => Effect.uninterruptible(afterCommit),
  readConfigDocument: Effect.succeed({}),
});

const PROJECT_CONFIG = "/project/.pi/extensions/pi-better-openai.json";
const GLOBAL_CONFIG = "/agent/extensions/pi-better-openai.json";

/** Fast mode over the real usage service and config store for a trusted `/project`. */
const persistedFastLayer = (
  documents: ReturnType<typeof makeInMemoryDocuments>,
  ctx: ExtensionContext,
  projections: {
    readonly fast: MutableRef.MutableRef<FastSnapshot>;
    readonly usage?: MutableRef.MutableRef<OpenAIProjection>;
  },
  http: Parameters<typeof jsonHttpTestLayer>[0] = () => Effect.die("unexpected HTTP request"),
) =>
  FastModeService.layer({ projection: projections.fast }).pipe(
    Layer.provideMerge(
      OpenAIUsageService.layer({
        context: MutableRef.make(ctx),
        cwd: "/project",
        projection: projections.usage ?? MutableRef.make(initialProjection()),
        onChange: () => undefined,
        startPolling: false,
        projectTrusted: true,
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
      expect(persistedAtCommit).toMatchObject({ active: false, desiredActive: false });
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
      // Fast persistence rewrites only its own keys and preserves unknown fields.
      expect([...documents.documents.values()][0]).toEqual({
        active: false,
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
      // The resolved intent came from the global document; the project file must stay untouched.
      yield* fast.initialize(current.ctx, makeResolvedConfig({ desiredActive: true }), false);
      current.setModel("future-model", "other-provider");
      yield* fast.modelChanged(current.ctx);
      expect(MutableRef.get(fastProjection)).toMatchObject({ desiredActive: true, active: false });
      expect(documents.documents.get(PROJECT_CONFIG)).toEqual(projectDocument);

      yield* fast.initialize(current.ctx, makeResolvedConfig(), true);
      expect(documents.documents.get(PROJECT_CONFIG)).toEqual({
        ...projectDocument,
        active: false,
        desiredActive: true,
      });
    }).pipe(
      provideBuiltLayer(persistedFastLayer(documents, current.ctx, { fast: fastProjection })),
    );
  });

  it.effect("a fast-only commit keeps an in-flight usage result", () => {
    const usageProjection = MutableRef.make(initialProjection());
    const requested = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    const ctx = testContext({ token: JSON.stringify({ access: "token", accountId: "acct" }) });
    const layer = persistedFastLayer(
      makeInMemoryDocuments(),
      ctx,
      { fast: MutableRef.make(initialFastSnapshot()), usage: usageProjection },
      () =>
        Deferred.succeed(requested, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as({
            status: 200,
            body: { rate_limit: { primary_window: { used_percent: 25 } } },
          }),
        ),
    );
    return Effect.gen(function* () {
      const usage = yield* OpenAIUsageService;
      const refresh = yield* usage.refresh({ force: true }).pipe(Effect.forkScoped);
      yield* Deferred.await(requested);
      yield* (yield* FastModeService).setDesired(ctx, true);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(refresh);
      expect(MutableRef.get(usageProjection).snapshot?.sevenDayLeftPercent).toBe(75);
    }).pipe(provideBuiltLayer(layer));
  });

  it.effect(
    "a fast-only commit recomputes eligibility from usage settings changed elsewhere",
    () => {
      const usageProjection = MutableRef.make(initialProjection());
      const documents = makeInMemoryDocuments();
      const ctx = testContext({ oauth: false });
      const layer = persistedFastLayer(documents, ctx, {
        fast: MutableRef.make(initialFastSnapshot()),
        usage: usageProjection,
      });
      return Effect.gen(function* () {
        // An API-key model is eligible only once another session stops requiring subscriptions.
        expect(MutableRef.get(usageProjection).eligible).toBe(false);
        documents.documents.set(GLOBAL_CONFIG, { usage: { showOnlyOnSubscriptionModels: false } });
        yield* (yield* FastModeService).setDesired(ctx, true);
        expect(MutableRef.get(usageProjection)).toMatchObject({
          eligible: true,
          config: { usage: { showOnlyOnSubscriptionModels: false } },
        });
      }).pipe(provideBuiltLayer(layer));
    },
  );

  it.effect(
    "in-memory publication and private state commit together at an interruption checkpoint",
    () => {
      const projection = MutableRef.make<FastSnapshot>(initialFastSnapshot());
      const current = makeContext("gpt-5.5");
      return Effect.gen(function* () {
        let interrupted = false;
        const scheduler = interruptingScheduler(
          () =>
            MutableRef.get(projection).lastInjectedTier === "priority" &&
            !interrupted &&
            (interrupted = true),
        );
        // The ingress worker inherits this scheduler and is interrupted exactly after publication.
        yield* Effect.scoped(
          FastModeService.make({ projection }).pipe(
            Effect.tap((service) =>
              Effect.gen(function* () {
                yield* service.setDesired(current.ctx, true);
                service.recordInjection({ model: "first", tier: "priority" });
                yield* yieldUntil(() => interrupted);
                yield* service.modelChanged(current.ctx);
                expect(MutableRef.get(projection)).toMatchObject({
                  desiredActive: true,
                  lastInjectedModel: "first",
                  lastInjectedTier: "priority",
                });
              }),
            ),
            Effect.provideService(Scheduler.Scheduler, scheduler),
          ),
        );
      }).pipe(provideBuiltLayer(fakeUsageLayer));
    },
  );

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
