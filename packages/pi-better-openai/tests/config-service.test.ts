import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Path from "effect/Path";
import { AgentDirectory, provideBuiltLayer } from "pi-cosmic-core";
import { jsonHttpTestLayer, makeInMemoryDocuments, yieldUntil } from "pi-cosmic-core/testing";
import type { ResolvedConfig } from "../src/config/schema.ts";
import { OpenAIConfigService } from "../src/config/store.ts";
import { OpenAIUsageService } from "../src/usage/controller.ts";
import { initialProjection } from "../src/usage/projection.ts";
import { testContext } from "./helpers.ts";

const globalPath = "/agent/extensions/pi-better-openai.json";

const fixture = () => {
  const documents = makeInMemoryDocuments({
    [globalPath]: { persistState: true, unknown: "preserve", image: { extra: 42 } },
  });
  const projection = MutableRef.make<ResolvedConfig | undefined>(undefined);
  let active = true;
  const layer = OpenAIConfigService.layer({
    cwd: "/project",
    projection,
    canPublish: () => active,
  }).pipe(
    Layer.provide(Layer.mergeAll(documents.layer, Path.layer, AgentDirectory.layer("/agent"))),
  );
  return {
    documents,
    projection,
    layer,
    retire: () => {
      active = false;
      MutableRef.set(projection, undefined);
    },
  };
};

it.effect("serializes fast and settings commits without losing unknown fields", () => {
  const h = fixture();
  return Effect.gen(function* () {
    const config = yield* OpenAIConfigService;
    const committed = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    h.documents.blockNextUpdateAtCommit(committed, release);
    const fast = yield* config.persistFast(true, Effect.void).pipe(Effect.forkScoped);
    yield* Deferred.await(committed);
    const settingsDone = yield* Deferred.make<void>();
    const settings = yield* config
      .updateSetting("image.outputFormat", "webp")
      .pipe(Effect.andThen(Deferred.succeed(settingsDone, undefined)), Effect.forkScoped);
    yield* Effect.yieldNow;
    expect(yield* Deferred.isDone(settingsDone)).toBe(false);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(fast);
    yield* Fiber.join(settings);
    expect(h.documents.documents.get(globalPath)).toEqual({
      persistState: true,
      desiredActive: true,
      unknown: "preserve",
      image: { extra: 42, outputFormat: "webp" },
    });
    expect(yield* config.get).toMatchObject({
      desiredActive: true,
      image: { outputFormat: "webp" },
    });
    expect(MutableRef.get(h.projection)).toEqual(yield* config.get);
  }).pipe(provideBuiltLayer(h.layer));
});

it.effect("observer registration cannot miss a concurrent configuration commit", () => {
  const h = fixture();
  return Effect.gen(function* () {
    const config = yield* OpenAIConfigService;
    const loading = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let observed: ResolvedConfig | undefined;
    const observer = yield* config
      .observe({
        commit: ({ config: next, reason }) =>
          (reason === "load"
            ? Deferred.succeed(loading, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void
          ).pipe(
            Effect.andThen(
              Effect.sync(() => {
                observed = next;
              }),
            ),
          ),
      })
      .pipe(Effect.andThen(Effect.never), Effect.scoped, Effect.forkScoped);
    yield* Deferred.await(loading);
    const write = yield* config.updateSetting("image.enabled", "false").pipe(Effect.forkScoped);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(write);
    expect(observed).toEqual(yield* config.get);
    expect(observed?.image.enabled).toBe(false);
    yield* Fiber.interrupt(observer);
    const detached = observed;
    yield* config.updateSetting("image.enabled", "true");
    expect(observed).toBe(detached);
    expect((yield* config.get).image.enabled).toBe(true);
  }).pipe(provideBuiltLayer(h.layer));
});

it.effect("cancelling initial observer admission releases the configuration gate", () => {
  const h = fixture();
  return Effect.gen(function* () {
    const config = yield* OpenAIConfigService;
    const loading = yield* Deferred.make<void>();
    const observer = yield* config
      .observe({
        commit: () => Deferred.succeed(loading, undefined).pipe(Effect.andThen(Effect.never)),
      })
      .pipe(Effect.scoped, Effect.forkScoped);
    yield* Deferred.await(loading);
    yield* Fiber.interrupt(observer);
    yield* config.updateSetting("image.enabled", "false");
    expect((yield* config.get).image.enabled).toBe(false);
  }).pipe(provideBuiltLayer(h.layer));
});

it.effect(
  "retirement during durable commit preserves private configuration without republishing",
  () => {
    const h = fixture();
    return Effect.gen(function* () {
      const config = yield* OpenAIConfigService;
      let observed: ResolvedConfig | undefined;
      yield* config.observe({
        commit: ({ config: next }) =>
          Effect.sync(() => {
            observed = next;
          }),
      });
      const committed = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      h.documents.blockNextUpdateAtCommit(committed, release);
      const update = yield* config
        .updateSetting("image.outputFormat", "webp")
        .pipe(Effect.forkScoped);
      yield* Deferred.await(committed);
      h.retire();
      const cancellation = yield* Fiber.interrupt(update).pipe(Effect.forkScoped);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(cancellation);
      expect((yield* config.get).image.outputFormat).toBe("webp");
      expect(observed).toEqual(yield* config.get);
      expect(h.documents.documents.get(globalPath)).toMatchObject({
        image: { outputFormat: "webp" },
      });
      expect(MutableRef.get(h.projection)).toBeUndefined();
    }).pipe(provideBuiltLayer(h.layer));
  },
);

it.effect("initial usage polling publishes after subscribing to configuration", () => {
  const h = fixture();
  const projection = MutableRef.make(initialProjection());
  const usageLayer = OpenAIUsageService.layer({
    context: MutableRef.make(
      testContext({ token: JSON.stringify({ access: "token", accountId: "acct" }) }),
    ),
    projection,
    onChange: () => undefined,
  }).pipe(
    Layer.provideMerge(h.layer),
    Layer.provide(
      Layer.mergeAll(
        Path.layer,
        AgentDirectory.layer("/agent"),
        jsonHttpTestLayer(() =>
          Effect.succeed({
            status: 200,
            body: { rate_limit: { primary_window: { used_percent: 25 } } },
          }),
        ),
      ),
    ),
  );
  return Effect.gen(function* () {
    yield* yieldUntil(() => MutableRef.get(projection).snapshot !== undefined);
    expect(MutableRef.get(projection).snapshot?.sevenDayLeftPercent).toBe(75);
    expect(MutableRef.get(projection).config).toEqual(yield* (yield* OpenAIConfigService).get);
  }).pipe(provideBuiltLayer(usageLayer));
});
