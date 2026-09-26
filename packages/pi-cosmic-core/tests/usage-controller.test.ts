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
