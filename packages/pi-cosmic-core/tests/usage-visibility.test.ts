import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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
import { JsonHttpClient } from "../src/platform/json-http.ts";
import { makeInMemoryDocuments } from "../src/testing/layers.ts";
import { yieldUntil } from "../src/testing/polling.ts";
import { makeUsageRefreshController, type UsageControllerConfig } from "../src/usage-controller.ts";
import { initialUsageProjection } from "../src/usage-projection.ts";

const config: UsageControllerConfig = {
  configPath: "/agent/usage.json",
  projectConfigPath: "/project/usage.json",
  globalConfigPath: "/agent/usage.json",
  projectConfigExists: false,
  globalConfigExists: true,
  usage: { refreshIntervalMs: 60_000, showOnlyOnSubscriptionModels: true },
};
const testLayer = Layer.mergeAll(
  Path.layer,
  makeInMemoryDocuments().layer,
  AgentDirectory.layer("/agent"),
  Layer.succeed(
    JsonHttpClient,
    JsonHttpClient.of({
      request: () => Effect.die("unexpected HTTP"),
      requestJson: () => Effect.die("unexpected HTTP"),
    }),
  ),
);

const fixture = (options: {
  visible: () => boolean;
  fetch: Effect.Effect<number>;
  polling?: boolean;
}) =>
  Effect.gen(function* () {
    const projection = MutableRef.make(initialUsageProjection<UsageControllerConfig, number>());
    const notifications: string[] = [];
    const host = {
      hasUI: true,
      ui: {
        notify: (text: string) => {
          notifications.push(text);
        },
      },
    };
    // SAFETY: The owned host fixture provides every field used by this controller.
    const ctx = host as typeof host & ExtensionContext;
    const controller = yield* makeUsageRefreshController({
      spanPrefix: "test.usage",
      logLabel: "Test",
      context: MutableRef.make(ctx),
      cwd: "/project",
      projection,
      onChange: () => undefined,
      startPolling: options.polling ?? false,
      backgroundEnabled: options.visible,
      initialProjection: () => initialUsageProjection<UsageControllerConfig, number>(),
      hiddenStatusText: "ineligible",
      missingCredentialsMessage: () => "missing",
      clearAuthPatch: {},
      store: {
        resolveConfig: () => Effect.succeed(config),
        readRawConfig: () => Effect.succeed({}),
        resolveCommittedConfig: (current: UsageControllerConfig) => current,
        modifyConfig: () => Effect.die("unexpected mutation"),
      },
      decodeSettingUpdate: () => Effect.die("unexpected setting"),
      eligibility: () => Effect.succeed(true),
      fetchOutcome: () =>
        options.fetch.pipe(
          Effect.map((snapshot) => ({ _tag: "Success" as const, snapshot, patch: {} })),
        ),
      formatStatusLine: (snapshot) => String(snapshot),
      formatStatusText: (snapshot) => String(snapshot),
      dependencies: Context.empty(),
    });
    return { controller, projection, notifications };
  });

it.effect("hidden usage skips automatic requests but permits an explicit one-time fetch", () =>
  Effect.gen(function* () {
    let visible = false;
    let requests = 0;
    const h = yield* fixture({ visible: () => visible, fetch: Effect.sync(() => ++requests) });
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
      visible: () => visible,
      fetch: Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finish))),
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
      visible: () => visible,
      fetch: Effect.sync(() => ++requests),
      polling: true,
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
