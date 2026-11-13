import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { AgentDirectory } from "pi-cosmic-core/platform/agent-directory";
import {
  capturedTelemetrySnapshot,
  extensionContextFixture,
  makeCapturedLogger,
  modelFixture,
  yieldUntil,
  type ExtensionContextOverrides,
} from "pi-cosmic-core/testing";
import type { ResolvedConfig } from "../src/config/schema.ts";
import {
  makeUsageRefreshController,
  UsageFetchOutcome,
  type UsageRefreshControllerOptions,
} from "../src/usage/controller.ts";
import { formatUsageSnapshot, type UsageSnapshot } from "../src/usage/format.ts";
import { HIDDEN_USAGE_STATUS_TEXT, initialProjection } from "../src/usage/projection.ts";
import { makeResolvedConfig, testModel, unusedHttpLayer } from "./helpers.ts";

const config = makeResolvedConfig();
const nextConfig: ResolvedConfig = {
  ...config,
  usage: { ...config.usage, refreshIntervalMs: 30_000, showResetTimes: false },
};
const testLayer = Layer.mergeAll(Path.layer, AgentDirectory.layer("/agent"), unusedHttpLayer);

/** A usage reading identified by its five-hour percentage. */
const usage = (fiveHourLeftPercent: number): UsageSnapshot => ({
  capturedAt: 0,
  fiveHourLeftPercent,
  sevenDayLeftPercent: 90,
  fiveHourResetInSeconds: 3_600,
  sevenDayResetInSeconds: 86_400,
});

/** A context whose model is eligible for subscription usage unless overridden. */
const hostContext = (
  notifications: string[],
  overrides: ExtensionContextOverrides = {},
  levels: string[] = [],
) =>
  extensionContextFixture({
    hasUI: true,
    model: testModel(),
    modelRegistry: { isUsingOAuth: () => true },
    ui: {
      notify: (text: string, level?: string) => {
        notifications.push(text);
        levels.push(level ?? "info");
      },
    },
    ...overrides,
  });

const fixture = (overrides: Partial<UsageRefreshControllerOptions>) =>
  Effect.gen(function* () {
    const projection = MutableRef.make(initialProjection());
    const notifications: string[] = [];
    const levels: string[] = [];
    const controller = yield* makeUsageRefreshController({
      context: MutableRef.make(hostContext(notifications, {}, levels)),
      projection,
      onChange: () => undefined,
      initialConfig: config,
      fetchOutcome: () => Effect.die("unexpected fetch"),
      ...overrides,
    });
    return { controller, projection, notifications, levels };
  });

const fetching = (fetch: Effect.Effect<UsageSnapshot>) => ({
  fetchOutcome: () =>
    fetch.pipe(
      Effect.map((snapshot) =>
        UsageFetchOutcome.Success({
          snapshot,
          patch: { authFound: true, accountId: "account" },
        }),
      ),
    ),
});

/** A fetch that reports when it starts and settles only when the test finishes it. */
const gatedFetch = Effect.gen(function* () {
  const started = yield* Deferred.make<void>();
  const finish = yield* Deferred.make<UsageSnapshot>();
  const fetch = Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finish)));
  return { started, finish, fetch };
});

it.effect("a request completing after usage is hidden cannot publish its stale result", () =>
  Effect.gen(function* () {
    let visible = true;
    const gate = yield* gatedFetch;
    const h = yield* fixture({ backgroundEnabled: () => visible, ...fetching(gate.fetch) });
    const pending = yield* h.controller.refresh({ force: true }).pipe(Effect.forkScoped);
    yield* Deferred.await(gate.started);
    visible = false;
    yield* Deferred.succeed(gate.finish, usage(42));
    yield* Fiber.join(pending);
    expect(MutableRef.get(h.projection).snapshot).toBeUndefined();
  }).pipe(Effect.provide(testLayer)),
);

for (const invalidate of [true, false]) {
  it.effect(
    `configuration changes ${invalidate ? "invalidate" : "preserve"} an in-flight usage result`,
    () =>
      Effect.gen(function* () {
        const gate = yield* gatedFetch;
        const h = yield* fixture(fetching(gate.fetch));
        const pending = yield* h.controller.refresh({ force: true }).pipe(Effect.forkScoped);
        yield* Deferred.await(gate.started);
        yield* h.controller.configure(nextConfig, invalidate ? undefined : { invalidate: false });
        yield* Deferred.succeed(gate.finish, usage(42));
        yield* Fiber.join(pending);
        // A preserved result is rendered with the configuration installed while it was in flight.
        const preservedLine = formatUsageSnapshot(usage(42), nextConfig.usage, 0);
        expect(preservedLine).not.toBe(formatUsageSnapshot(usage(42), config.usage, 0));
        const expected = {
          config: nextConfig,
          snapshot: invalidate ? undefined : usage(42),
          statusLine: invalidate ? undefined : preservedLine,
        };
        expect(MutableRef.get(h.projection)).toMatchObject(expected);
        expect(yield* h.controller.getState).toMatchObject(expected);
      }).pipe(Effect.provide(testLayer)),
  );
}

it.effect(
  "revoked publication authority accepts private configuration without republishing or notifying",
  () =>
    Effect.gen(function* () {
      let live = true;
      let changes = 0;
      const h = yield* fixture({
        ...fetching(Effect.succeed(usage(42))),
        canPublish: () => live,
        onChange: () => {
          changes++;
        },
      });
      live = false;
      const reset = initialProjection();
      MutableRef.set(h.projection, reset);
      yield* h.controller.configure(nextConfig);
      expect((yield* h.controller.getState).config?.usage.refreshIntervalMs).toBe(30_000);
      yield* h.controller.refresh({ notify: true, force: true });
      expect(MutableRef.get(h.projection)).toBe(reset);
      expect(changes).toBe(0);
      expect(h.notifications).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("asking for usage on a model without it informs instead of warning", () =>
  Effect.gen(function* () {
    const notifications: string[] = [];
    const levels: string[] = [];
    const h = yield* fixture({
      context: MutableRef.make(hostContext(notifications, { model: modelFixture() }, levels)),
    });
    yield* h.controller.refresh({ notify: true, force: true });
    expect(notifications).toEqual([HIDDEN_USAGE_STATUS_TEXT]);
    expect(levels).toEqual(["info"]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("polling starts even when the initial forced refresh dies", () => {
  const logger = makeCapturedLogger();
  return Effect.gen(function* () {
    let calls = 0;
    const h = yield* fixture(
      fetching(
        Effect.suspend(() =>
          ++calls === 1 ? Effect.die("usage-poison /secret/auth.json") : Effect.succeed(usage(7)),
        ),
      ),
    );
    yield* h.controller.startPolling();
    yield* yieldUntil(() => calls === 1);
    for (let turn = 0; turn < 10; turn++) yield* Effect.yieldNow;
    yield* TestClock.adjust("1 minute");
    yield* yieldUntil(() => MutableRef.get(h.projection).snapshot?.fiveHourLeftPercent === 7);
    expect(capturedTelemetrySnapshot(logger)).not.toContain("poison");
  }).pipe(Effect.provide(Layer.merge(testLayer, logger.layer)));
});

it.effect("a host context retired during a refresh settles it without publishing or failing", () =>
  Effect.gen(function* () {
    const gate = yield* gatedFetch;
    const context = MutableRef.make(hostContext([]));
    const h = yield* fixture({ ...fetching(gate.fetch), context });
    const pending = yield* h.controller.refresh({ force: true }).pipe(Effect.forkScoped);
    yield* Deferred.await(gate.started);
    MutableRef.set(
      context,
      extensionContextFixture({
        hasUI: true,
        get model(): never {
          throw new Error("stale extension context");
        },
      }),
    );
    yield* Deferred.succeed(gate.finish, usage(5));
    yield* Fiber.join(pending);
    expect(MutableRef.get(h.projection).snapshot).toBeUndefined();

    yield* h.controller.contextChanged();
    expect(MutableRef.get(h.projection)).toMatchObject({ eligible: false, snapshot: undefined });
  }).pipe(Effect.provide(testLayer)),
);

it.effect("a model change cannot be overwritten by an in-flight refresh for the old model", () =>
  Effect.gen(function* () {
    let renders = 0;
    let fetches = 0;
    const gate = yield* gatedFetch;
    const context = MutableRef.make(hostContext([], { model: testModel("old") }));
    const h = yield* fixture({
      ...fetching(Effect.suspend(() => (++fetches === 1 ? Effect.succeed(usage(1)) : gate.fetch))),
      context,
      onChange: () => {
        renders++;
      },
    });
    yield* h.controller.refresh({ force: true });
    expect(MutableRef.get(h.projection).snapshot).toEqual(usage(1));

    const pending = yield* h.controller.refresh({ force: true }).pipe(Effect.forkScoped);
    yield* Deferred.await(gate.started);
    MutableRef.set(context, hostContext([], { model: testModel("new") }));
    const rendersBefore = renders;
    yield* h.controller.contextChanged(true);
    expect(MutableRef.get(h.projection)).toMatchObject({
      snapshot: undefined,
      statusLine: undefined,
    });
    expect(renders).toBeGreaterThan(rendersBefore);

    yield* Deferred.succeed(gate.finish, usage(2));
    yield* Fiber.join(pending);
    expect(MutableRef.get(h.projection).snapshot).toBeUndefined();
    expect(MutableRef.get(h.projection)).toEqual(yield* h.controller.getState);
  }).pipe(Effect.provide(testLayer)),
);
