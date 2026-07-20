// @effect-diagnostics effect/strictEffectProvide:off
// @effect-diagnostics effect/newPromise:off
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import {
  JsonDocumentError,
  JsonDocumentStore,
  JsonHttpClient,
  JsonHttpError,
  makePiRuntime,
  type JsonDocumentStoreShape,
  type JsonHttpClientShape,
  type JsonObject,
} from "pi-cosmic-core";
import { getXaiCredentials } from "../src/auth.ts";
import {
  applySettingToRawConfig,
  readRawConfig,
  resolveConfig,
  writeConfig,
} from "../src/config.ts";
import {
  XaiUsageService,
  isXaiSubscriptionModel,
  makeProjection,
  synchronizeProjectionContext,
  visibleStatusLine,
} from "../src/usage-controller.ts";
import type { ResolvedConfig } from "../src/config.ts";
import { xaiUsageUiState } from "../src/ui/primitives.ts";
import {
  formatUsageSnapshot,
  parseMonthlyBilling,
  parseUsageSnapshot,
  parseWeeklyBilling,
  requestXaiUsage,
} from "../src/usage.ts";

const NOW = 1_752_883_200_000;
const monthlyFixture = {
  config: {
    monthlyLimit: { val: 15000 },
    used: { val: 2524 },
    onDemandCap: { val: 0 },
    billingPeriodEnd: "2026-08-01T00:00:00+00:00",
  },
};
const weeklyFixture = {
  config: {
    currentPeriod: { end: "2026-07-20T18:37:17.787360+00:00" },
    creditUsagePercent: 18,
    onDemandUsed: { val: 0 },
    billingPeriodEnd: "2026-07-20T18:37:17.787360+00:00",
  },
};

function documentHarness(initial: Readonly<Record<string, JsonObject>> = {}) {
  const documents = new Map(Object.entries(initial));
  const service: JsonDocumentStoreShape = {
    exists: (path) => Effect.succeed(documents.has(path)),
    readObject: (path) => Effect.succeed(documents.get(path)),
    writeObject: (path, document) => Effect.sync(() => void documents.set(path, document)),
    updateObject: (path, update) =>
      Effect.sync(() => {
        const next = update(documents.get(path) ?? {});
        documents.set(path, next);
        return next;
      }),
  };
  return { documents, layer: Layer.succeed(JsonDocumentStore, service) };
}

function httpLayer(request: JsonHttpClientShape["request"]) {
  return Layer.succeed(JsonHttpClient, JsonHttpClient.of({ request }));
}

function registryContext(token = "registry-token") {
  return {
    modelRegistry: {
      getApiKeyForProvider: () => globalThis.Promise.resolve(token),
      isUsingOAuth: () => true,
    },
    model: { provider: "xai", id: "grok" },
    hasUI: true,
    mode: "tui",
    cwd: "/project",
    ui: { notify() {} },
  } as unknown as ExtensionContext;
}

function providers(documents: Layer.Layer<JsonDocumentStore>, http: Layer.Layer<JsonHttpClient>) {
  return Layer.merge(Layer.merge(documents, http), Path.layer);
}

function resolvedConfig(showOnlyOnSubscriptionModels = true): ResolvedConfig {
  return {
    configPath: "/agent/extensions/pi-better-xai.json",
    projectConfigPath: "/project/.pi/extensions/pi-better-xai.json",
    globalConfigPath: "/agent/extensions/pi-better-xai.json",
    projectConfigExists: false,
    globalConfigExists: true,
    usage: {
      enabled: true,
      refreshIntervalMs: 60_000,
      showOnlyOnSubscriptionModels,
      showResetTimes: true,
    },
    footer: { mode: "status" },
  };
}

const monthly = parseMonthlyBilling(monthlyFixture, NOW);

describe("xAI usage parsing", () => {
  it("parses monthly and weekly billing", () => {
    const snapshot = parseUsageSnapshot(monthlyFixture, weeklyFixture, NOW);
    expect(snapshot.weeklyLeftPercent).toBe(82);
    expect(snapshot.monthlyUsed).toBe(2524);
    expect(snapshot.monthlyUsedPercent).toBeCloseTo(16.8266, 3);
    expect(snapshot.monthlyLeftPercent).toBeCloseTo(83.1733, 3);
  });

  it("treats missing weekly percent as unused", () => {
    const weekly = parseWeeklyBilling(
      { config: { billingPeriodEnd: "2026-07-20T18:37:17.787360+00:00" } },
      NOW,
    );
    expect(weekly.weeklyUsedPercent).toBe(0);
    expect(weekly.weeklyLeftPercent).toBe(100);
  });

  it("keeps monthly-only snapshots", () => {
    const snapshot = parseUsageSnapshot(monthlyFixture, null, NOW);
    expect(snapshot.monthlyUsed).toBe(monthly.monthlyUsed);
    expect(snapshot.weeklyLeftPercent).toBeNull();
  });

  it("formats progress-bar-compatible text", () => {
    const snapshot = parseUsageSnapshot(monthlyFixture, weeklyFixture, NOW);
    expect(formatUsageSnapshot(snapshot, { showResetTimes: false }, NOW)).toBe(
      "Usage: 7d: 82% | mo: 83%",
    );
  });

  it.effect("rejects malformed monthly payloads in the request workflow", () => {
    const documents = documentHarness();
    const http = httpLayer(({ url }) =>
      Effect.succeed({ status: 200, body: url.includes("format=credits") ? weeklyFixture : {} }),
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const result = yield* Effect.result(requestXaiUsage("/agent/auth.json", registryContext()));
      expect(result._tag).toBe("Failure");
    }).pipe(Effect.provide(providers(documents.layer, http)));
  });
});

describe("xAI configuration", () => {
  it.effect("merges project overrides and preserves unknown fields on write", () => {
    const harness = documentHarness({
      "/agent/extensions/pi-better-xai.json": {
        usage: { enabled: true, refreshIntervalMs: 30000 },
        unknown: "keep",
      },
      "/project/.pi/extensions/pi-better-xai.json": {
        usage: { enabled: false },
      },
    });
    return Effect.gen(function* () {
      const config = yield* resolveConfig("/project", "/agent");
      expect(config.usage.enabled).toBe(false);
      expect(config.usage.refreshIntervalMs).toBe(30000);
      const raw = yield* readRawConfig(config.globalConfigPath);
      const updated = applySettingToRawConfig(raw, "usage.showResetTimes", "false");
      yield* writeConfig(config.globalConfigPath, updated);
      expect(harness.documents.get(config.globalConfigPath)?.unknown).toBe("keep");
    }).pipe(Effect.provide(Layer.merge(harness.layer, Path.layer)));
  });

  it.effect("falls back to defaults for malformed config", () => {
    const harness = documentHarness({
      "/agent/extensions/pi-better-xai.json": { usage: { enabled: "invalid" } },
    });
    return Effect.gen(function* () {
      const config = yield* resolveConfig("/project", "/agent");
      expect(config.usage.enabled).toBe(true);
      expect(config.usage.refreshIntervalMs).toBe(60000);
    }).pipe(Effect.provide(Layer.merge(harness.layer, Path.layer)));
  });

  it.effect("defaults invalid fields independently while retaining valid siblings", () => {
    const harness = documentHarness({
      "/agent/extensions/pi-better-xai.json": {
        usage: { enabled: "invalid", refreshIntervalMs: 12000, showResetTimes: false },
        footer: { mode: "status" },
      },
      "/project/.pi/extensions/pi-better-xai.json": {
        usage: { enabled: true, refreshIntervalMs: "invalid", showOnlyOnSubscriptionModels: false },
        footer: { mode: "invalid" },
        unknown: "keep",
      },
    });
    return Effect.gen(function* () {
      const config = yield* resolveConfig("/project", "/agent");
      expect(config.usage).toEqual({
        enabled: true,
        refreshIntervalMs: 12000,
        showOnlyOnSubscriptionModels: false,
        showResetTimes: false,
      });
      expect(config.footer.mode).toBe("status");
      expect((yield* readRawConfig(config.projectConfigPath)).unknown).toBe("keep");
    }).pipe(Effect.provide(Layer.merge(harness.layer, Path.layer)));
  });
});

describe("xAI credentials", () => {
  it.effect("extracts the team identifier from an OAuth JWT", () => {
    const payload = Buffer.from('{"team_id":"team-42"}').toString("base64url");
    const harness = documentHarness({
      "/agent/auth.json": {
        xai: {
          type: "oauth",
          access: `header.${payload}.signature`,
          refresh: "refresh",
          expires: NOW + 3_600_000,
        },
      },
    });
    const http = httpLayer(() => Effect.die("unexpected HTTP"));
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const credentials = yield* getXaiCredentials(
        "/agent/auth.json",
        registryContext(`header.${payload}.signature`),
      );
      expect(credentials?.teamId).toBe("team-42");
    }).pipe(Effect.provide(providers(harness.layer, http)));
  });

  it.effect("refreshes expired auth and persists unknown auth fields", () => {
    const harness = documentHarness({
      "/agent/auth.json": {
        xai: {
          type: "oauth",
          access: "expired",
          refresh: "refresh-token",
          expires: 0,
          unknown: "keep",
        },
      },
    });
    const http = httpLayer(() =>
      Effect.succeed({
        status: 200,
        body: { access_token: "next-access", refresh_token: "next-refresh", expires_in: 3600 },
      }),
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const credentials = yield* getXaiCredentials("/agent/auth.json", registryContext());
      expect(credentials?.accessToken).toBe("next-access");
      const xai = harness.documents.get("/agent/auth.json")?.xai as Record<string, unknown>;
      expect(xai.unknown).toBe("keep");
      expect(xai.refresh).toBe("next-refresh");
      expect(xai.expires).toBe(NOW + 3_600_000);
    }).pipe(Effect.provide(providers(harness.layer, http)));
  });

  it.effect("fails closed when auth reread/update cannot be completed", () => {
    const original = {
      otherProvider: { access: "keep" },
      xai: { type: "oauth", access: "expired", refresh: "refresh", expires: 0 },
    };
    const service: JsonDocumentStoreShape = {
      exists: () => Effect.succeed(true),
      readObject: () => Effect.succeed(original),
      writeObject: () => Effect.die("unexpected direct write"),
      updateObject: () =>
        Effect.fail(
          new JsonDocumentError({
            operation: "read",
            path: "/agent/auth.json",
            message: "failed reread",
          }),
        ),
    };
    const http = httpLayer(() =>
      Effect.succeed({ status: 200, body: { access_token: "next", expires_in: 600 } }),
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const credentials = yield* getXaiCredentials("/agent/auth.json", registryContext("registry"));
      expect(credentials?.accessToken).toBe("registry");
      expect(original.otherProvider.access).toBe("keep");
    }).pipe(
      Effect.provide(
        providers(Layer.succeed(JsonDocumentStore, JsonDocumentStore.of(service)), http),
      ),
    );
  });

  it.effect("applies refresh skew only at the refresh decision boundary", () => {
    const harness = documentHarness({
      "/agent/auth.json": {
        xai: {
          type: "oauth",
          access: "current-access",
          refresh: "refresh-token",
          expires: NOW + 600_000,
        },
      },
    });
    let refreshes = 0;
    const http = httpLayer(() =>
      Effect.sync(() => {
        refreshes += 1;
        return {
          status: 200,
          body: { access_token: "next-access", expires_in: 600 },
        };
      }),
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW + 299_999);
      const before = yield* getXaiCredentials("/agent/auth.json", registryContext(""));
      expect(before?.accessToken).toBe("current-access");
      expect(refreshes).toBe(0);

      yield* TestClock.setTime(NOW + 300_000);
      const atBoundary = yield* getXaiCredentials("/agent/auth.json", registryContext(""));
      expect(atBoundary?.accessToken).toBe("next-access");
      expect(refreshes).toBe(1);
    }).pipe(Effect.provide(providers(harness.layer, http)));
  });

  it.effect("cancels in-flight billing requests", () => {
    const harness = documentHarness({
      "/agent/auth.json": {
        xai: { type: "oauth", access: "access", refresh: "refresh", expires: NOW + 60_000 },
      },
    });
    const http = httpLayer(() => Effect.never);
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const fiber = yield* requestXaiUsage("/agent/auth.json", registryContext()).pipe(
        Effect.provide(providers(harness.layer, http)),
        Effect.forkChild,
      );
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      expect(exit._tag).toBe("Failure");
    });
  });

  it.effect("falls back to model registry when refresh fails", () => {
    const harness = documentHarness({
      "/agent/auth.json": {
        xai: { type: "oauth", access: "expired", refresh: "refresh", expires: 0 },
      },
    });
    const http = httpLayer(() => Effect.fail({ _tag: "test" } as never));
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const credentials = yield* getXaiCredentials("/agent/auth.json", registryContext("registry"));
      expect(credentials?.source).toBe("modelRegistry");
      expect(credentials?.accessToken).toBe("registry");
    }).pipe(Effect.provide(providers(harness.layer, http)));
  });

  it.effect("is interruptible while model registry credentials are pending", () => {
    const harness = documentHarness();
    const http = httpLayer(() => Effect.die("unexpected HTTP"));
    const ctx = registryContext();
    const pending = new Promise<string | undefined>(() => undefined);
    ctx.modelRegistry.getApiKeyForProvider = () => pending;
    return Effect.gen(function* () {
      const fiber = yield* getXaiCredentials("/agent/auth.json", ctx).pipe(
        Effect.provide(providers(harness.layer, http)),
        Effect.forkChild,
      );
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      expect(exit._tag).toBe("Failure");
    });
  });
});

describe("xAI visibility", () => {
  it("honors API-key visibility configuration and clears stale model usage synchronously", () => {
    const projection = makeProjection();
    const apiKeyContext = registryContext();
    apiKeyContext.modelRegistry.isUsingOAuth = () => false;
    const config = resolvedConfig(false);
    MutableRef.set(projection, {
      ...MutableRef.get(projection),
      config,
      eligible: true,
      statusLine: "Usage: 7d: 82%",
    });

    expect(isXaiSubscriptionModel(apiKeyContext, config)).toBe(true);
    expect(visibleStatusLine(apiKeyContext, config, projection)).toBe("Usage: 7d: 82%");
    expect(xaiUsageUiState(apiKeyContext, config, projection).visible).toBe(true);

    const otherModel = {
      ...apiKeyContext,
      model: { provider: "openai", id: "gpt" },
    } as ExtensionContext;
    synchronizeProjectionContext(projection, otherModel, { clearUsage: true });
    expect(visibleStatusLine(otherModel, config, projection)).toBeUndefined();
    expect(MutableRef.get(projection).snapshot).toBeUndefined();
    expect(MutableRef.get(projection).error).toBeUndefined();
  });
});

describe("xAI refresh lifecycle", () => {
  it.effect("persists settings and exposes the disabled status", () => {
    const harness = documentHarness();
    const projection = makeProjection();
    const serviceLayer = XaiUsageService.layer({
      context: MutableRef.make(registryContext()),
      cwd: "/project",
      projection,
      onChange() {},
      startPolling: false,
      agentDir: "/agent",
    }).pipe(
      Layer.provide(
        providers(
          harness.layer,
          httpLayer(() => Effect.die("unexpected HTTP")),
        ),
      ),
    );
    return Effect.gen(function* () {
      yield* XaiUsageService.use((service) => service.updateSetting("usage.enabled", "false"));
      const persisted = harness.documents.get("/agent/extensions/pi-better-xai.json");
      expect(persisted?.usage).toEqual(expect.objectContaining({ enabled: false }));
      expect(MutableRef.get(projection).statusText).toBe("Usage display is disabled.");
      expect(MutableRef.get(projection).error).toBeUndefined();
    }).pipe(Effect.provide(serviceLayer));
  });

  it.effect("moves to an error status after a failed billing request", () => {
    const harness = documentHarness({
      "/agent/auth.json": {
        xai: { type: "oauth", access: "access", refresh: "refresh", expires: NOW + 60_000 },
      },
    });
    const projection = makeProjection();
    const http = httpLayer(() =>
      Effect.fail(
        new JsonHttpError({
          operation: "request",
          message: "Billing request failed.",
        }),
      ),
    );
    const serviceLayer = XaiUsageService.layer({
      context: MutableRef.make(registryContext()),
      cwd: "/project",
      projection,
      onChange() {},
      startPolling: false,
      agentDir: "/agent",
    }).pipe(Layer.provide(providers(harness.layer, http)));
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* XaiUsageService.use((service) => service.refresh({ force: true }));
      expect(MutableRef.get(projection).statusText).toContain("Usage unavailable");
      expect(MutableRef.get(projection).error).not.toContain("access");
    }).pipe(Effect.provide(serviceLayer));
  });

  it.effect("uses the latest event context for eligibility and requests", () => {
    const harness = documentHarness();
    const initial = registryContext();
    initial.model = { provider: "openai", id: "gpt" } as typeof initial.model;
    const context = MutableRef.make(initial);
    const projection = makeProjection();
    const http = httpLayer(({ url }) =>
      Effect.succeed({
        status: 200,
        body: url.includes("format=credits") ? weeklyFixture : monthlyFixture,
      }),
    );
    const serviceLayer = XaiUsageService.layer({
      context,
      cwd: "/project",
      projection,
      onChange() {},
      startPolling: false,
      agentDir: "/agent",
    }).pipe(Layer.provide(providers(harness.layer, http)));

    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      MutableRef.set(context, registryContext());
      yield* XaiUsageService.use((service) => service.refresh({ force: true }));
      expect(MutableRef.get(projection).snapshot?.weeklyLeftPercent).toBe(82);
    }).pipe(Effect.provide(serviceLayer));
  });

  it("interrupts polling and queued work when its runtime is disposed", () => {
    const harness = documentHarness();
    const projection = makeProjection();
    const requestStarted = Deferred.makeUnsafe<void>();
    let interrupted = 0;
    const http = httpLayer(() =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.sync(() => void (interrupted += 1)));
        yield* Deferred.succeed(requestStarted, undefined);
        return yield* Effect.never;
      }).pipe(Effect.scoped),
    );
    const serviceLayer = XaiUsageService.layer({
      context: MutableRef.make(registryContext()),
      cwd: "/project",
      projection,
      onChange() {},
      agentDir: "/agent",
    }).pipe(Layer.provide(providers(harness.layer, http)));
    const runtime = makePiRuntime({} as ExtensionAPI, serviceLayer);

    return runtime
      .runPromise(XaiUsageService.use(() => Effect.void))
      .then(() => runtime.runPromise(Deferred.await(requestStarted)))
      .then(() => runtime.dispose())
      .then(() => expect(interrupted).toBeGreaterThan(0))
      .finally(() => runtime.dispose());
  });

  it.effect("coalesces concurrent refresh bursts into one follow-up", () => {
    const harness = documentHarness({
      "/agent/extensions/pi-better-xai.json": { usage: { refreshIntervalMs: 5000 } },
    });
    let active = 0;
    let maximum = 0;
    let requests = 0;
    const http = httpLayer(({ url }) =>
      Effect.gen(function* () {
        requests += 1;
        active += 1;
        maximum = Math.max(maximum, active);
        yield* Effect.sleep("1 second");
        active -= 1;
        return {
          status: 200,
          body: url.includes("format=credits") ? weeklyFixture : monthlyFixture,
        };
      }),
    );
    const projection = makeProjection();
    const serviceLayer = XaiUsageService.layer({
      context: MutableRef.make(registryContext()),
      cwd: "/project",
      projection,
      onChange() {},
      startPolling: false,
      agentDir: "/agent",
    }).pipe(Layer.provide(providers(harness.layer, http)));

    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const fiber = yield* Effect.all(
        Array.from({ length: 8 }, () =>
          XaiUsageService.use((service) => service.refresh({ force: true })),
        ),
        { concurrency: "unbounded" },
      ).pipe(Effect.provide(serviceLayer), Effect.forkChild);
      yield* TestClock.adjust("3 seconds");
      yield* Fiber.join(fiber);
      // One active refresh plus at most one coalesced follow-up. Each refresh
      // issues monthly and weekly requests concurrently.
      expect(maximum).toBe(2);
      expect(requests).toBe(4);
      expect(MutableRef.get(projection).snapshot?.weeklyLeftPercent).toBe(82);
    });
  });
});
