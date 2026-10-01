import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Path from "effect/Path";
import * as Scheduler from "effect/Scheduler";
import { pausedScheduler } from "../testing.ts";
import * as subscriptionRefresh from "../src/coordination/subscription-refresh.ts";
import { vi } from "vitest";
import * as TestClock from "effect/testing/TestClock";
import { provideBuiltLayer } from "../index.ts";
import { AgentDirectory } from "../src/platform/agent-directory.ts";
import { JsonHttpClient, type JsonHttpClientContract } from "../src/platform/json-http.ts";
import { extensionContextFixture } from "../src/testing/host.ts";
import { makeInMemoryDocuments } from "../src/testing/layers.ts";
import { yieldUntil } from "../src/testing/polling.ts";
import {
  makeUsageRefreshController,
  type UsageControllerConfig,
  type UsageRefreshControllerOptions,
} from "../src/usage-controller.ts";
import { initialUsageProjection, type UsageProjectionBase } from "../src/usage-projection.ts";

type Projection = UsageProjectionBase<UsageControllerConfig, number>;
type Options<R> = UsageRefreshControllerOptions<
  Projection,
  UsageControllerConfig,
  number,
  never,
  never,
  R
>;

const config: UsageControllerConfig = {
  configPath: "/agent/usage.json",
  projectConfigPath: "/project/usage.json",
  globalConfigPath: "/agent/usage.json",
  projectConfigExists: false,
  globalConfigExists: true,
  usage: { refreshIntervalMs: 60_000, showOnlyOnSubscriptionModels: true },
};
const unusedHttp = JsonHttpClient.of({
  request: () => Effect.die("unexpected HTTP"),
  requestJson: () => Effect.die("unexpected HTTP"),
});
const testLayer = Layer.mergeAll(
  Path.layer,
  makeInMemoryDocuments().layer,
  AgentDirectory.layer("/agent"),
  Layer.succeed(JsonHttpClient, unusedHttp),
);

const fixture = <R = never>(overrides: Partial<Options<R>> & Pick<Options<R>, "dependencies">) =>
  Effect.gen(function* () {
    const projection = MutableRef.make(initialUsageProjection<UsageControllerConfig, number>());
    const notifications: string[] = [];
    let observedTrust: boolean | undefined;
    const host = { hasUI: true, ui: { notify: (text: string) => void notifications.push(text) } };
    const controller = yield* makeUsageRefreshController<
      Projection,
      UsageControllerConfig,
      number,
      never,
      never,
      R
    >({
      spanPrefix: "test.usage",
      logLabel: "Test",
      context: MutableRef.make(extensionContextFixture(host)),
      cwd: "/project",
      projection,
      onChange: () => undefined,
      startPolling: false,
      initialProjection: () => initialUsageProjection(),
      hiddenStatusText: "ineligible",
      missingCredentialsMessage: () => "missing",
      clearAuthPatch: {},
      store: {
        resolveConfig: (_cwd, _agentDir, projectTrusted) => {
          observedTrust = projectTrusted;
          return Effect.succeed(config);
        },
        readRawConfig: () => Effect.succeed({}),
        resolveCommittedConfig: (current) => current,
        modifyConfig: () => Effect.die("unexpected mutation"),
      },
      decodeSettingUpdate: () => Effect.die("unexpected setting"),
      eligibility: () => Effect.succeed(true),
      fetchOutcome: () => Effect.die("unexpected fetch"),
      formatStatusLine: (snapshot) => String(snapshot),
      formatStatusText: (snapshot) => String(snapshot),
      ...overrides,
    });
    return { controller, projection, notifications, observedTrust: () => observedTrust };
  });

const fetching = (fetch: Effect.Effect<number>) => ({
  fetchOutcome: () =>
    fetch.pipe(Effect.map((snapshot) => ({ _tag: "Success" as const, snapshot, patch: {} }))),
  dependencies: Context.empty(),
});

it.effect(
  "captures dependencies for an escaped refresh and defaults project trust to false",
  () => {
    const conflictingHttp = JsonHttpClient.of({
      request: () => Effect.die("provider HTTP client must not escape"),
      requestJson: () => Effect.die("provider HTTP client must not escape"),
    });
    let observedHttp: JsonHttpClientContract | undefined;
    return Effect.gen(function* () {
      const h = yield* fixture({
        fetchOutcome: () =>
          Effect.gen(function* () {
            observedHttp = yield* JsonHttpClient;
            return { _tag: "Missing" } as const;
          }),
        dependencies: Context.make(JsonHttpClient, conflictingHttp),
      }).pipe(provideBuiltLayer(testLayer));

      // The construction Layer is closed here. The escaped effect uses its captured services.
      yield* h.controller.refresh({ force: true });

      expect(h.observedTrust()).toBe(false);
      expect(observedHttp).toBe(unusedHttp);
      expect(MutableRef.get(h.projection)).toMatchObject({
        config,
        authPath: "/agent/auth.json",
        eligible: true,
        snapshot: undefined,
        error: "missing",
      });
    });
  },
);

it.effect("composes the default synchronizeState from eligibility and hiddenStatusText", () =>
  Effect.gen(function* () {
    const h = yield* fixture({
      eligibility: () => Effect.succeed(false),
      dependencies: Context.empty(),
    });
    // Construction-time synchronize(true) applied the default synchronizeState path.
    expect(MutableRef.get(h.projection)).toMatchObject({
      config,
      authPath: "/agent/auth.json",
      eligible: false,
      snapshot: undefined,
      statusLine: undefined,
      error: undefined,
      statusText: "ineligible",
    });
  }).pipe(provideBuiltLayer(testLayer)),
);

it.effect("hidden usage skips automatic requests but permits an explicit one-time fetch", () =>
  Effect.gen(function* () {
    let visible = false;
    let requests = 0;
    const h = yield* fixture({
      backgroundEnabled: () => visible,
      ...fetching(Effect.sync(() => ++requests)),
    });
    yield* h.controller.refresh({ force: true });
    expect(requests).toBe(0);
    expect(MutableRef.get(h.projection).snapshot).toBeUndefined();

    yield* h.controller.refresh({ notify: true, force: true });
    expect(requests).toBe(1);
    expect(h.notifications).toEqual(["1"]);
    yield* h.controller.refresh({ force: true });
    expect(requests).toBe(1);
    expect(MutableRef.get(h.projection).snapshot).toBeUndefined();

    visible = true;
    yield* h.controller.contextChanged(true);
    yield* h.controller.refresh({ force: true });
    expect(requests).toBe(2);
    expect(MutableRef.get(h.projection).snapshot).toBe(2);
  }).pipe(provideBuiltLayer(testLayer)),
);

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

for (const invalidation of ["context", "settings"] as const) {
  it.effect(`serializes ${invalidation} clearing after the refresh's final key validation`, () =>
    Effect.gen(function* () {
      const paused = pausedScheduler();
      let validated = false;
      let stopped = false;
      const makeRefresh = subscriptionRefresh.makeSubscriptionRefresh;
      const observedRefresh: typeof makeRefresh = (options) =>
        makeRefresh({
          ...options,
          commit: (value, request) => {
            validated = true;
            return options.commit(value, request);
          },
        });
      const boundary = vi
        .spyOn(subscriptionRefresh, "makeSubscriptionRefresh")
        .mockImplementation(observedRefresh);
      const scheduler = {
        ...paused.scheduler,
        shouldYield: () => {
          if (!validated || stopped) return false;
          stopped = true;
          return true;
        },
      };
      let durableConfig = config;
      const nextConfig = {
        ...config,
        usage: { ...config.usage, refreshIntervalMs: 30_000 },
      };
      let mutations = 0;
      let requests = 0;
      const h = yield* fixture({
        ...fetching(Effect.sync(() => ++requests)),
        decodeSettingUpdate: () => Effect.succeed((raw) => raw),
        store: {
          resolveConfig: () => Effect.succeed(durableConfig),
          readRawConfig: () => Effect.succeed({}),
          resolveCommittedConfig: () => nextConfig,
          modifyConfig: (_path, modify) =>
            Effect.suspend(() => {
              const modification = modify({});
              return Effect.uninterruptible(
                Effect.sync(() => {
                  mutations++;
                  durableConfig = nextConfig;
                }).pipe(
                  Effect.andThen(modification.afterCommit ?? Effect.void),
                  Effect.as(modification.value),
                ),
              );
            }),
        },
      });
      yield* h.controller.updateState((current) => ({ ...current, snapshot: 7 }));
      const refresh = yield* h.controller
        .refresh({ force: true })
        .pipe(
          Effect.provideService(Scheduler.Scheduler, scheduler),
          Effect.forkScoped({ startImmediately: true }),
        );
      try {
        yield* yieldUntil(() => stopped);
        const invalidated = yield* Deferred.make<void>();
        const action =
          invalidation === "context"
            ? h.controller.contextChanged(true)
            : h.controller.updateSetting("usage.refreshIntervalMs", "30000");
        const competing = yield* action.pipe(
          Effect.andThen(Deferred.succeed(invalidated, undefined)),
          Effect.forkScoped,
        );
        for (let turn = 0; turn < 10; turn++) yield* Effect.yieldNow;
        if (invalidation === "settings") expect(mutations).toBe(1);
        expect(yield* Deferred.isDone(invalidated)).toBe(false);
        // The engine gate is still held: consumer state must not clear ahead of it.
        expect(MutableRef.get(h.projection).snapshot).toBe(7);
        const interruption =
          invalidation === "settings"
            ? yield* Fiber.interrupt(competing).pipe(Effect.forkScoped)
            : undefined;
        paused.resume();
        yield* Fiber.join(refresh);
        if (interruption) yield* Fiber.join(interruption);
        else yield* Fiber.join(competing);
        expect(MutableRef.get(h.projection).snapshot).toBeUndefined();
        expect((yield* h.controller.getState).snapshot).toBeUndefined();
        if (invalidation === "settings")
          expect(MutableRef.get(h.projection).config?.usage.refreshIntervalMs).toBe(30_000);
        // The interrupted durable commit and invalidation leave refresh reusable.
        yield* h.controller.refresh({ force: true });
        expect(MutableRef.get(h.projection).snapshot).toBe(2);
      } finally {
        paused.resume();
        boundary.mockRestore();
      }
    }).pipe(provideBuiltLayer(testLayer)),
  );
}

it.effect(
  "revoked publication authority leaves durable/private settings reusable but never republishes or notifies",
  () =>
    Effect.gen(function* () {
      let live = true;
      let durable = config;
      const nextConfig = {
        ...config,
        usage: { ...config.usage, refreshIntervalMs: 30_000 },
      };
      let changes = 0;
      const committed = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const h = yield* fixture({
        ...fetching(Effect.succeed(42)),
        canPublish: () => live,
        onChange: () => {
          changes++;
        },
        decodeSettingUpdate: () => Effect.succeed((raw) => raw),
        store: {
          resolveConfig: () => Effect.succeed(durable),
          readRawConfig: () => Effect.succeed({}),
          resolveCommittedConfig: () => nextConfig,
          modifyConfig: (_path, modify) =>
            Effect.suspend(() => {
              const modification = modify({});
              return Effect.uninterruptible(
                Effect.sync(() => {
                  durable = nextConfig;
                }).pipe(
                  Effect.andThen(Deferred.succeed(committed, undefined)),
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(modification.afterCommit ?? Effect.void),
                  Effect.as(modification.value),
                ),
              );
            }),
        },
      });
      const pending = yield* h.controller
        .updateSetting("usage.refreshIntervalMs", "30000")
        .pipe(Effect.forkScoped);
      yield* Deferred.await(committed);
      live = false;
      const reset = initialUsageProjection<UsageControllerConfig, number>();
      MutableRef.set(h.projection, reset);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(pending);
      expect(durable.usage.refreshIntervalMs).toBe(30_000);
      expect((yield* h.controller.getState).config?.usage.refreshIntervalMs).toBe(30_000);
      yield* h.controller.refresh({ notify: true, force: true });
      expect(MutableRef.get(h.projection)).toBe(reset);
      expect(changes).toBe(0);
      expect(h.notifications).toEqual([]);
    }).pipe(provideBuiltLayer(testLayer)),
);

it.effect("publication authority is checked adjacent to the actual host callback", () =>
  Effect.gen(function* () {
    let live = true;
    let checked = false;
    let revoked = false;
    const liveAtNotification: boolean[] = [];
    let published: MutableRef.MutableRef<Projection> | undefined;
    const paused = pausedScheduler();
    const h = yield* fixture({
      ...fetching(Effect.succeed(42)),
      canPublish: () => {
        if (published && MutableRef.get(published).snapshot === 42) checked = true;
        return live;
      },
      onChange: () => {
        liveAtNotification.push(live);
      },
    });
    published = h.projection;
    const scheduler = {
      ...paused.scheduler,
      shouldYield: () => {
        if (!checked || revoked) return false;
        live = false;
        revoked = true;
        return true;
      },
    };
    const pending = yield* h.controller
      .refresh({ force: true })
      .pipe(
        Effect.provideService(Scheduler.Scheduler, scheduler),
        Effect.forkScoped({ startImmediately: true }),
      );
    try {
      yield* yieldUntil(() => revoked);
      paused.resume();
      yield* Fiber.join(pending);
      expect(liveAtNotification.every(Boolean)).toBe(true);
    } finally {
      paused.resume();
    }
  }).pipe(provideBuiltLayer(testLayer)),
);

it.effect("polling makes no requests while hidden and resumes after visibility changes", () =>
  Effect.gen(function* () {
    let visible = false;
    let requests = 0;
    const h = yield* fixture({
      backgroundEnabled: () => visible,
      startPolling: true,
      ...fetching(Effect.sync(() => ++requests)),
    });
    yield* TestClock.adjust("2 minutes");
    expect(requests).toBe(0);
    visible = true;
    yield* h.controller.contextChanged(true);
    yield* yieldUntil(() => requests > 0);
    expect(requests).toBe(1);
    visible = false;
    yield* h.controller.contextChanged(true);
    yield* TestClock.adjust("2 minutes");
    expect(requests).toBe(1);
  }).pipe(provideBuiltLayer(testLayer)),
);
