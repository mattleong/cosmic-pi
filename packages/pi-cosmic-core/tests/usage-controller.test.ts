import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { provideBuiltLayer } from "../index.ts";
import { capturedTelemetrySnapshot, makeCapturedLogger, yieldUntil } from "../testing.ts";
import { AgentDirectory } from "../src/platform/agent-directory.ts";
import { JsonHttpClient } from "../src/platform/json-http.ts";
import { extensionContextFixture, type ExtensionContextOverrides } from "../src/testing/host.ts";
import { modelFixture } from "../src/testing/model.ts";
import {
  makeUsageRefreshController,
  UsageFetchOutcome,
  type UsageControllerConfig,
  type UsageRefreshControllerOptions,
} from "../src/usage-controller.ts";
import { initialUsageProjection, type UsageProjectionBase } from "../src/usage-projection.ts";

type Projection = UsageProjectionBase<UsageControllerConfig, number>;
type Options<R> = UsageRefreshControllerOptions<Projection, UsageControllerConfig, number, R>;

const config: UsageControllerConfig = {
  usage: { refreshIntervalMs: 60_000, showOnlyOnSubscriptionModels: true },
};
const unusedHttp = JsonHttpClient.of({
  request: () => Effect.die("unexpected HTTP"),
  requestJson: () => Effect.die("unexpected HTTP"),
});
const testLayer = Layer.mergeAll(
  Path.layer,
  AgentDirectory.layer("/agent"),
  Layer.succeed(JsonHttpClient, unusedHttp),
);

const fixture = <R = never>(overrides: Partial<Options<R>> & Pick<Options<R>, "dependencies">) =>
  Effect.gen(function* () {
    const projection = MutableRef.make(initialUsageProjection<UsageControllerConfig, number>());
    const notifications: string[] = [];
    const controller = yield* makeUsageRefreshController<
      Projection,
      UsageControllerConfig,
      number,
      R
    >({
      spanPrefix: "test.usage",
      logLabel: "Test",
      context: MutableRef.make(hostContext(notifications)),
      projection,
      onChange: () => undefined,
      initialConfig: config,
      initialProjection: () => initialUsageProjection(),
      hiddenStatusText: "ineligible",
      missingCredentialsMessage: "missing",
      clearAuthPatch: {},
      eligibility: () => Effect.succeed(true),
      fetchOutcome: () => Effect.die("unexpected fetch"),
      formatStatusLine: (snapshot) => String(snapshot),
      formatStatusText: (snapshot) => String(snapshot),
      ...overrides,
    });
    return { controller, projection, notifications };
  });

const hostContext = (notifications: string[], overrides: ExtensionContextOverrides = {}) =>
  extensionContextFixture({
    hasUI: true,
    ui: { notify: (text: string) => void notifications.push(text) },
    ...overrides,
  });

const nextConfig: UsageControllerConfig = {
  ...config,
  usage: { ...config.usage, refreshIntervalMs: 30_000 },
};

const fetching = (fetch: Effect.Effect<number>) => ({
  fetchOutcome: () =>
    fetch.pipe(Effect.map((snapshot) => UsageFetchOutcome.Success({ snapshot, patch: {} }))),
  dependencies: Context.empty(),
});

it.effect("a request completing after usage is hidden cannot publish its stale result", () =>
  Effect.gen(function* () {
    let visible = true;
    const started = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<number>();
    const h = yield* fixture({
      backgroundEnabled: () => visible,
      ...fetching(
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finish))),
      ),
    });
    const pending = yield* h.controller.refresh({ force: true }).pipe(Effect.forkScoped);
    yield* Deferred.await(started);
    visible = false;
    yield* Deferred.succeed(finish, 42);
    yield* Fiber.join(pending);
    expect(MutableRef.get(h.projection).snapshot).toBeUndefined();
  }).pipe(provideBuiltLayer(testLayer)),
);

for (const invalidate of [true, false]) {
  it.effect(
    `configuration changes ${invalidate ? "invalidate" : "preserve"} an in-flight usage result`,
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<number>();
        const h = yield* fixture({
          ...fetching(
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finish))),
          ),
          formatStatusLine: (snapshot, cfg) => `${snapshot}:${cfg.usage.refreshIntervalMs}`,
        });
        const pending = yield* h.controller.refresh({ force: true }).pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        yield* h.controller.configure(nextConfig, invalidate ? undefined : { invalidate: false });
        yield* Deferred.succeed(finish, 42);
        yield* Fiber.join(pending);
        const expected = {
          config: nextConfig,
          snapshot: invalidate ? undefined : 42,
          statusLine: invalidate ? undefined : "42:30000",
        };
        expect(MutableRef.get(h.projection)).toMatchObject(expected);
        expect(yield* h.controller.getState).toMatchObject(expected);
      }).pipe(provideBuiltLayer(testLayer)),
  );
}

it.effect(
  "revoked publication authority accepts private configuration without republishing or notifying",
  () =>
    Effect.gen(function* () {
      let live = true;
      let changes = 0;
      const h = yield* fixture({
        ...fetching(Effect.succeed(42)),
        canPublish: () => live,
        onChange: () => {
          changes++;
        },
      });
      live = false;
      const reset = initialUsageProjection<UsageControllerConfig, number>();
      MutableRef.set(h.projection, reset);
      yield* h.controller.configure(nextConfig);
      expect((yield* h.controller.getState).config?.usage.refreshIntervalMs).toBe(30_000);
      yield* h.controller.refresh({ notify: true, force: true });
      expect(MutableRef.get(h.projection)).toBe(reset);
      expect(changes).toBe(0);
      expect(h.notifications).toEqual([]);
    }).pipe(provideBuiltLayer(testLayer)),
);

it.effect("polling starts even when the initial forced refresh dies", () => {
  const logger = makeCapturedLogger();
  return Effect.gen(function* () {
    let calls = 0;
    const h = yield* fixture(
      fetching(
        Effect.suspend(() =>
          ++calls === 1 ? Effect.die("usage-poison /secret/auth.json") : Effect.succeed(7),
        ),
      ),
    );
    yield* h.controller.startPolling();
    yield* yieldUntil(() => calls === 1);
    for (let turn = 0; turn < 10; turn++) yield* Effect.yieldNow;
    yield* TestClock.adjust("1 minute");
    yield* yieldUntil(() => MutableRef.get(h.projection).snapshot === 7);
    expect(capturedTelemetrySnapshot(logger)).not.toContain("poison");
  }).pipe(provideBuiltLayer(Layer.merge(testLayer, logger.layer)));
});

it.effect("a retired host context's model getter does not break a refresh", () =>
  Effect.gen(function* () {
    const context = MutableRef.make(
      extensionContextFixture({
        hasUI: true,
        get model(): never {
          throw new Error("stale extension context");
        },
      }),
    );
    const h = yield* fixture({ ...fetching(Effect.succeed(5)), context });
    yield* h.controller.refresh({ force: true });
    expect(MutableRef.get(h.projection).snapshot).toBe(5);
  }).pipe(provideBuiltLayer(testLayer)),
);

it.effect("a model change cannot be overwritten by an in-flight refresh for the old model", () =>
  Effect.gen(function* () {
    let renders = 0;
    let fetches = 0;
    const started = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<number>();
    const context = MutableRef.make(hostContext([], { model: modelFixture({ id: "old" }) }));
    const h = yield* fixture({
      ...fetching(
        Effect.suspend(() =>
          ++fetches === 1
            ? Effect.succeed(1)
            : Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finish))),
        ),
      ),
      context,
      onChange: () => {
        renders++;
      },
    });
    yield* h.controller.refresh({ force: true });
    expect(MutableRef.get(h.projection).snapshot).toBe(1);

    const pending = yield* h.controller.refresh({ force: true }).pipe(Effect.forkScoped);
    yield* Deferred.await(started);
    MutableRef.set(context, hostContext([], { model: modelFixture({ id: "new" }) }));
    const rendersBefore = renders;
    yield* h.controller.contextChanged(true);
    expect(MutableRef.get(h.projection)).toMatchObject({
      snapshot: undefined,
      statusLine: undefined,
    });
    expect(renders).toBeGreaterThan(rendersBefore);

    yield* Deferred.succeed(finish, 2);
    yield* Fiber.join(pending);
    expect(MutableRef.get(h.projection).snapshot).toBeUndefined();
    expect(MutableRef.get(h.projection)).toEqual(yield* h.controller.getState);
  }).pipe(provideBuiltLayer(testLayer)),
);
