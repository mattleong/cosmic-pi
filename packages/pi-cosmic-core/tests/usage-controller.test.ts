import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Path from "effect/Path";
import { provideBuiltLayer } from "../index.ts";
import { AgentDirectory } from "../src/platform/agent-directory.ts";
import { JsonHttpClient } from "../src/platform/json-http.ts";
import { extensionContextFixture } from "../src/testing/host.ts";
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
    const host = { hasUI: true, ui: { notify: (text: string) => void notifications.push(text) } };
    const controller = yield* makeUsageRefreshController<
      Projection,
      UsageControllerConfig,
      number,
      R
    >({
      spanPrefix: "test.usage",
      logLabel: "Test",
      context: MutableRef.make(extensionContextFixture(host)),
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
