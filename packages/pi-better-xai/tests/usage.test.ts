// @effect-diagnostics effect/strictEffectProvide:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/preferSchemaOverJson:off
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
  AgentDirectory,
  JsonDocumentError,
  JsonDocumentStore,
  JsonHttpClient,
  JsonHttpError,
  makePiRuntime,
  type JsonDocumentStoreShape,
} from "pi-cosmic-core";
import {
  capturedTelemetrySnapshot,
  jsonHttpTestLayer,
  makeCapturedLogger,
  makeCapturedTracer,
  makeInMemoryDocuments,
} from "pi-cosmic-core/testing";
import { getXaiCredentials, getXaiCredentialsResult } from "../src/auth.ts";
import {
  applySettingToRawConfig,
  readRawConfig,
  resolveConfig,
  writeConfig,
} from "../src/config.ts";
import {
  XaiUsageService,
  formatDebug,
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

const documentHarness = makeInMemoryDocuments;

function httpLayer(request: Parameters<typeof jsonHttpTestLayer>[0]) {
  return jsonHttpTestLayer(request);
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
  return Layer.mergeAll(documents, http, Path.layer, AgentDirectory.layer("/agent"));
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

  it("rejects non-finite, negative, and out-of-range protocol numbers", () => {
    expect(
      parseMonthlyBilling({ config: { monthlyLimit: { val: -1 }, used: { val: 2 } } }, NOW)
        .monthlyLimit,
    ).toBeNull();
    expect(
      parseMonthlyBilling({ config: { monthlyLimit: { val: Number.POSITIVE_INFINITY } } }, NOW)
        .monthlyLimit,
    ).toBeNull();
    expect(parseWeeklyBilling({ config: { creditUsagePercent: 101 } }, NOW).weeklyUsedPercent).toBe(
      null,
    );
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
      const updated = yield* applySettingToRawConfig(raw, "usage.showResetTimes", "false");
      yield* writeConfig(config.globalConfigPath, updated);
      expect(harness.documents.get(config.globalConfigPath)?.unknown).toBe("keep");
    }).pipe(Effect.provide(Layer.merge(harness.layer, Path.layer)));
  });

  it.effect("ignores untrusted project configuration and selects global settings", () => {
    const harness = documentHarness({
      "/agent/extensions/pi-better-xai.json": {
        usage: { enabled: true },
        footer: { mode: "status" },
      },
      "/project/.pi/extensions/pi-better-xai.json": {
        usage: { enabled: false },
        footer: { mode: "replace" },
      },
    });
    return Effect.gen(function* () {
      const config = yield* resolveConfig("/project", "/agent", false);
      expect(config.configPath).toBe("/agent/extensions/pi-better-xai.json");
      expect(config.projectConfigExists).toBe(false);
      expect(config.usage.enabled).toBe(true);
      expect(config.footer.mode).toBe("status");
    }).pipe(Effect.provide(Layer.merge(harness.layer, Path.layer)));
  });

  it.effect("rejects malformed setting values instead of coercing them", () =>
    Effect.gen(function* () {
      expect((yield* Effect.result(applySettingToRawConfig({}, "usage.enabled", "yes")))._tag).toBe(
        "Failure",
      );
      expect(
        (yield* Effect.result(applySettingToRawConfig({}, "usage.refreshIntervalMs", "NaN")))._tag,
      ).toBe("Failure");
      expect((yield* Effect.result(applySettingToRawConfig({}, "footer.mode", "other")))._tag).toBe(
        "Failure",
      );
    }),
  );

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
  it.effect("distinguishes total credential failure from genuine absence", () => {
    const failure = new JsonDocumentError({
      operation: "read",
      path: "/redacted",
      message: "unavailable",
    });
    const documents = Layer.succeed(
      JsonDocumentStore,
      JsonDocumentStore.of({
        exists: () => Effect.fail(failure),
        readObject: () => Effect.fail(failure),
        writeObject: () => Effect.fail(failure),
        modifyObject: () => Effect.fail(failure),
        updateObject: () => Effect.fail(failure),
      }),
    );
    const ctx = registryContext();
    ctx.modelRegistry.getApiKeyForProvider = () => Promise.reject(new Error("registry"));
    return Effect.gen(function* () {
      const result = yield* getXaiCredentialsResult("/auth.json", ctx);
      expect(result._tag).toBe("Unavailable");
      expect("message" in result ? result.message : "").not.toContain("redacted");
    }).pipe(
      Effect.provide(
        providers(
          documents,
          httpLayer(() => Effect.die("unexpected HTTP")),
        ),
      ),
    );
  });

  it.effect("rejects non-positive persisted expiry metadata", () => {
    const harness = documentHarness({
      "/agent/auth.json": {
        xai: { type: "oauth", access: "token", expires: 0 },
      },
    });
    return Effect.gen(function* () {
      const result = yield* getXaiCredentialsResult("/agent/auth.json", registryContext(""));
      expect(result._tag).toBe("Malformed");
    }).pipe(
      Effect.provide(
        providers(
          harness.layer,
          httpLayer(() => Effect.die("unexpected HTTP")),
        ),
      ),
    );
  });

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
          expires: 1,
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
      xai: { type: "oauth", access: "expired", refresh: "refresh", expires: 1 },
    };
    const service: JsonDocumentStoreShape = {
      exists: () => Effect.succeed(true),
      readObject: () => Effect.succeed(original),
      writeObject: () => Effect.die("unexpected direct write"),
      modifyObject: () =>
        Effect.fail(
          new JsonDocumentError({
            operation: "read",
            path: "/agent/auth.json",
            message: "failed reread",
          }),
        ),
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
        xai: { type: "oauth", access: "expired", refresh: "refresh", expires: 1 },
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

  it.effect("fails closed after expired auth refresh fails with no registry token", () => {
    const harness = documentHarness({
      "/agent/auth.json": {
        xai: { type: "oauth", access: "expired", refresh: "refresh", expires: 1 },
      },
    });
    const requests: Array<{ readonly url: string; readonly authorization?: string }> = [];
    const http = httpLayer((request) => {
      requests.push({
        url: request.url,
        ...(request.headers?.Authorization ? { authorization: request.headers.Authorization } : {}),
      });
      return Effect.fail(new JsonHttpError({ operation: "request", message: "refresh failed" }));
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const result = yield* Effect.result(requestXaiUsage("/agent/auth.json", registryContext("")));
      expect(result._tag).toBe("Failure");
      expect(requests).toHaveLength(1);
      expect(requests.some(({ authorization }) => authorization === "Bearer expired")).toBe(false);
    }).pipe(Effect.provide(providers(harness.layer, http)));
  });

  it.effect("treats expired auth without a refresh token as missing", () => {
    const harness = documentHarness({
      "/agent/auth.json": { xai: { type: "oauth", access: "expired", expires: 1 } },
    });
    const requests: string[] = [];
    const http = httpLayer(({ url }) =>
      Effect.sync(() => {
        requests.push(url);
        return { status: 500, body: {} };
      }),
    );
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      expect(yield* requestXaiUsage("/agent/auth.json", registryContext(""))).toBeUndefined();
      expect(requests).toEqual([]);
    }).pipe(Effect.provide(providers(harness.layer, http)));
  });

  it.effect("uses a still-valid skew-window token only after refresh failure", () => {
    const harness = documentHarness({
      "/agent/auth.json": {
        xai: {
          type: "oauth",
          access: "still-valid",
          refresh: "refresh",
          expires: NOW + 60_000,
        },
      },
    });
    const authorizations: string[] = [];
    const http = httpLayer((request) => {
      if (!request.headers?.Authorization) return Effect.fail({ _tag: "refresh-failed" } as never);
      return Effect.sync(() => {
        authorizations.push(request.headers?.Authorization ?? "");
        return {
          status: 200,
          body: request.url.includes("format=credits") ? weeklyFixture : monthlyFixture,
        };
      });
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      expect(yield* requestXaiUsage("/agent/auth.json", registryContext(""))).toBeDefined();
      expect(authorizations).toEqual(["Bearer still-valid", "Bearer still-valid"]);
      expect(authorizations).not.toContain("Bearer expired");
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
    expect(visibleStatusLine(projection)).toBe("Usage: 7d: 82%");
    expect(xaiUsageUiState(apiKeyContext, config, projection).visible).toBe(true);

    const otherModel = {
      ...apiKeyContext,
      model: { provider: "openai", id: "gpt" },
    } as ExtensionContext;
    synchronizeProjectionContext(projection, otherModel, { clearUsage: true });
    expect(visibleStatusLine(projection)).toBeUndefined();
    expect(MutableRef.get(projection).snapshot).toBeUndefined();
    expect(MutableRef.get(projection).error).toBeUndefined();
    expect(Object.isFrozen(MutableRef.get(projection))).toBe(true);
    expect(Object.isFrozen(MutableRef.get(projection).config?.usage)).toBe(true);
    expect(MutableRef.get(projection).config).not.toBe(config);
  });

  it("honors public context and config visibility guards independently of projection", () => {
    const projection = makeProjection();
    const subscriptionContext = registryContext();
    const subscriptionConfig = resolvedConfig(true);
    MutableRef.set(projection, {
      ...MutableRef.get(projection),
      config: subscriptionConfig,
      eligible: true,
      statusLine: "Usage: 7d: 82%",
    });

    expect(xaiUsageUiState(subscriptionContext, subscriptionConfig, projection).visible).toBe(true);
    expect(
      xaiUsageUiState(
        subscriptionContext,
        {
          ...subscriptionConfig,
          usage: { ...subscriptionConfig.usage, enabled: false },
        },
        projection,
      ).visible,
    ).toBe(false);
    expect(
      xaiUsageUiState(
        {
          ...subscriptionContext,
          model: { provider: "openai", id: "gpt" },
        } as ExtensionContext,
        subscriptionConfig,
        projection,
      ).visible,
    ).toBe(false);

    const apiKeyContext = registryContext();
    apiKeyContext.modelRegistry.isUsingOAuth = () => false;
    expect(xaiUsageUiState(apiKeyContext, subscriptionConfig, projection).visible).toBe(false);
    expect(xaiUsageUiState(apiKeyContext, resolvedConfig(false), projection).visible).toBe(true);

    const throwingContext = registryContext();
    throwingContext.modelRegistry.isUsingOAuth = () => {
      throw new Error("oauth-host-secret");
    };
    expect(xaiUsageUiState(throwingContext, subscriptionConfig, projection).visible).toBe(false);
  });

  it("fails closed when OAuth detection throws and renderers use only the projection", () => {
    const projection = makeProjection();
    const ctx = registryContext();
    const config = resolvedConfig(true);
    ctx.modelRegistry.isUsingOAuth = () => {
      throw new Error("oauth-host-secret");
    };
    MutableRef.set(projection, {
      ...MutableRef.get(projection),
      config,
      eligible: true,
      statusLine: "Usage: 7d: 82%",
    });

    expect(() => synchronizeProjectionContext(projection, ctx, { clearUsage: true })).not.toThrow();
    expect(MutableRef.get(projection).eligible).toBe(false);
    expect(visibleStatusLine(projection)).toBeUndefined();
    expect(xaiUsageUiState(ctx, config, projection).visible).toBe(false);
    expect(() => formatDebug(projection, ctx)).not.toThrow();
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

  it.effect("publishes global fallback when an atomic project update removes an override", () => {
    const projectPath = "/project/.pi/extensions/pi-better-xai.json";
    const harness = documentHarness({
      "/agent/extensions/pi-better-xai.json": {
        usage: { enabled: false, showOnlyOnSubscriptionModels: true },
        footer: { mode: "status" },
      },
      [projectPath]: {
        usage: { showOnlyOnSubscriptionModels: false, showResetTimes: true },
      },
    });
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
      const service = yield* XaiUsageService;
      harness.injectBeforeNextUpdate((current) => ({
        ...current,
        usage: { showResetTimes: true },
      }));

      yield* service.updateSetting("usage.showResetTimes", "false");

      expect(harness.documents.get(projectPath)).toMatchObject({
        usage: { showResetTimes: false },
      });
      expect(harness.documents.get(projectPath)?.usage).not.toHaveProperty(
        "showOnlyOnSubscriptionModels",
      );
      expect(MutableRef.get(projection).config?.usage).toMatchObject({
        enabled: false,
        showOnlyOnSubscriptionModels: true,
        showResetTimes: false,
      });
    }).pipe(Effect.provide(serviceLayer));
  });

  it.effect("refreshes scope when a project config appears after startup", () => {
    const globalPath = "/agent/extensions/pi-better-xai.json";
    const projectPath = "/project/.pi/extensions/pi-better-xai.json";
    const harness = documentHarness({
      [globalPath]: {
        usage: { enabled: false, showOnlyOnSubscriptionModels: true },
        footer: { mode: "replace" },
      },
    });
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
      const service = yield* XaiUsageService;
      harness.documents.set(projectPath, {
        usage: { showOnlyOnSubscriptionModels: false },
      });

      yield* service.updateSetting("usage.showResetTimes", "false");

      expect(harness.documents.get(projectPath)).toMatchObject({
        usage: { showOnlyOnSubscriptionModels: false, showResetTimes: false },
      });
      expect(harness.documents.get(globalPath)?.usage).not.toHaveProperty("showResetTimes");
      expect(MutableRef.get(projection).config).toMatchObject({
        configPath: projectPath,
        projectConfigExists: true,
        globalConfigExists: true,
        usage: {
          enabled: false,
          showOnlyOnSubscriptionModels: false,
          showResetTimes: false,
        },
      });
    }).pipe(Effect.provide(serviceLayer));
  });

  it.effect("refreshes scope when a project config disappears after startup", () => {
    const globalPath = "/agent/extensions/pi-better-xai.json";
    const projectPath = "/project/.pi/extensions/pi-better-xai.json";
    const harness = documentHarness({
      [globalPath]: {
        usage: { enabled: false, showOnlyOnSubscriptionModels: true },
        footer: { mode: "replace" },
      },
      [projectPath]: {
        usage: { showOnlyOnSubscriptionModels: false },
      },
    });
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
      const service = yield* XaiUsageService;
      harness.documents.delete(projectPath);

      yield* service.updateSetting("usage.showResetTimes", "false");

      expect(harness.documents.has(projectPath)).toBe(false);
      expect(harness.documents.get(globalPath)).toMatchObject({
        usage: {
          enabled: false,
          showOnlyOnSubscriptionModels: true,
          showResetTimes: false,
        },
      });
      expect(MutableRef.get(projection).config).toMatchObject({
        configPath: globalPath,
        projectConfigExists: false,
        globalConfigExists: true,
        usage: { showOnlyOnSubscriptionModels: true, showResetTimes: false },
      });
    }).pipe(Effect.provide(serviceLayer));
  });

  it.effect("refreshes fallback when a global config appears after startup", () => {
    const globalPath = "/agent/extensions/pi-better-xai.json";
    const projectPath = "/project/.pi/extensions/pi-better-xai.json";
    const harness = documentHarness({
      [projectPath]: {
        usage: { showOnlyOnSubscriptionModels: false },
        footer: { mode: "replace" },
      },
    });
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
          httpLayer(({ url }) =>
            Effect.succeed({
              status: 200,
              body: url.includes("format=credits") ? weeklyFixture : monthlyFixture,
            }),
          ),
        ),
      ),
    );
    return Effect.gen(function* () {
      const service = yield* XaiUsageService;
      harness.documents.set(globalPath, {
        usage: { enabled: false, showOnlyOnSubscriptionModels: true },
        footer: { mode: "status" },
      });

      yield* service.updateSetting("usage.showResetTimes", "false");

      expect(harness.documents.get(projectPath)).toMatchObject({
        usage: { showOnlyOnSubscriptionModels: false, showResetTimes: false },
      });
      expect(MutableRef.get(projection).config).toMatchObject({
        configPath: projectPath,
        projectConfigExists: true,
        globalConfigExists: true,
        usage: {
          enabled: false,
          showOnlyOnSubscriptionModels: false,
          showResetTimes: false,
        },
      });
    }).pipe(Effect.provide(serviceLayer));
  });

  it.effect("serializes concurrent setting changes through projection publication", () => {
    const configPath = "/agent/extensions/pi-better-xai.json";
    const harness = documentHarness({
      [configPath]: {
        usage: { enabled: false, showResetTimes: true },
        footer: { mode: "replace" },
        unknown: "keep",
      },
    });
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
      const service = yield* XaiUsageService;
      const mutationStarted = yield* Deferred.make<void>();
      const releaseMutation = yield* Deferred.make<void>();
      harness.injectBeforeNextUpdate((current) => ({
        ...current,
        usage: { enabled: false, showResetTimes: true, refreshIntervalMs: 120_000 },
      }));
      harness.blockNextUpdateBeforeCommit(mutationStarted, releaseMutation);

      const usage = yield* service
        .updateSetting("usage.showResetTimes", "false")
        .pipe(Effect.forkScoped);
      yield* Deferred.await(mutationStarted);
      const footer = yield* service.updateSetting("footer.mode", "status").pipe(Effect.forkScoped);
      for (let index = 0; index < 100 && harness.updateCount < 2; index++) yield* Effect.yieldNow;
      const writesBeforeRelease = harness.updateCount;

      yield* Deferred.succeed(releaseMutation, undefined);
      yield* Fiber.join(usage);
      yield* Fiber.join(footer);

      expect(writesBeforeRelease).toBe(1);
      const persisted = harness.documents.get(configPath);
      expect(persisted?.usage).toEqual(
        expect.objectContaining({
          enabled: false,
          refreshIntervalMs: 120_000,
          showResetTimes: false,
        }),
      );
      expect(persisted?.footer).toEqual(expect.objectContaining({ mode: "status" }));
      expect(persisted?.unknown).toBe("keep");
      const published = MutableRef.get(projection).config;
      expect(published?.usage.refreshIntervalMs).toBe(120_000);
      expect(published?.usage.showResetTimes).toBe(false);
      expect(published?.footer.mode).toBe("status");
    }).pipe(Effect.scoped, Effect.provide(serviceLayer));
  });

  it.effect("publishes committed config before interruption is observable", () => {
    const configPath = "/agent/extensions/pi-better-xai.json";
    const harness = documentHarness({
      [configPath]: {
        usage: { enabled: false, showResetTimes: true },
        footer: { mode: "replace" },
      },
    });
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
      const service = yield* XaiUsageService;
      const commitStarted = yield* Deferred.make<void>();
      const releaseCommit = yield* Deferred.make<void>();
      harness.blockNextUpdateAtCommit(commitStarted, releaseCommit);

      const setting = yield* service
        .updateSetting("usage.showResetTimes", "false")
        .pipe(Effect.forkScoped);
      yield* Deferred.await(commitStarted);
      const interruption = yield* Fiber.interrupt(setting).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseCommit, undefined);
      yield* Fiber.join(interruption);

      expect(harness.documents.get(configPath)).toMatchObject({
        usage: { enabled: false, showResetTimes: false },
        footer: { mode: "replace" },
      });
      expect(MutableRef.get(projection).config).toMatchObject({
        usage: { enabled: false, showResetTimes: false },
        footer: { mode: "replace" },
      });
    }).pipe(Effect.scoped, Effect.provide(serviceLayer));
  });

  it.effect("does not hold setting serialization while a forced refresh is gated", () => {
    const configPath = "/agent/extensions/pi-better-xai.json";
    const harness = documentHarness({
      [configPath]: {
        usage: { enabled: false },
        footer: { mode: "replace" },
      },
    });
    const refreshStarted = Deferred.makeUnsafe<void>();
    const releaseRefresh = Deferred.makeUnsafe<void>();
    let gateNextRequest = true;
    const http = httpLayer(({ url }) => {
      const response = {
        status: 200,
        body: url.includes("format=credits") ? weeklyFixture : monthlyFixture,
      };
      if (!gateNextRequest) return Effect.succeed(response);
      gateNextRequest = false;
      return Deferred.succeed(refreshStarted, undefined).pipe(
        Effect.andThen(Deferred.await(releaseRefresh)),
        Effect.as(response),
      );
    });
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
      const service = yield* XaiUsageService;
      const enabling = yield* service
        .updateSetting("usage.enabled", "true")
        .pipe(Effect.forkScoped);
      yield* Deferred.await(refreshStarted);

      const footer = yield* service.updateSetting("footer.mode", "status").pipe(Effect.forkScoped);
      for (let index = 0; index < 100 && harness.updateCount < 2; index++) yield* Effect.yieldNow;

      expect(harness.updateCount).toBe(2);
      expect(harness.documents.get(configPath)).toMatchObject({
        usage: { enabled: true },
        footer: { mode: "status" },
      });
      expect(MutableRef.get(projection).config).toMatchObject({
        usage: { enabled: true },
        footer: { mode: "status" },
      });

      yield* Deferred.succeed(releaseRefresh, undefined);
      yield* Fiber.join(enabling);
      yield* Fiber.join(footer);
    }).pipe(Effect.scoped, Effect.provide(serviceLayer));
  });

  it.effect("fails closed when Effect-owned OAuth detection throws", () => {
    const captured = makeCapturedLogger();
    const harness = documentHarness();
    const ctx = registryContext();
    ctx.modelRegistry.isUsingOAuth = () => {
      throw new Error("oauth-host-secret");
    };
    const projection = makeProjection();
    const serviceLayer = XaiUsageService.layer({
      context: MutableRef.make(ctx),
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
      yield* XaiUsageService.use((service) => service.refresh({ force: true }));
      expect(MutableRef.get(projection).eligible).toBe(false);
      expect(MutableRef.get(projection).statusText).toContain("Usage hidden");
      const telemetry = capturedTelemetrySnapshot(captured);
      expect(telemetry).toContain("oauth_status_unavailable");
      expect(telemetry).not.toContain("oauth-host-secret");
    }).pipe(Effect.provide(Layer.merge(serviceLayer, captured.layer)));
  });

  it.effect("moves to an error status after a failed billing request", () => {
    const captured = makeCapturedLogger();
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
      const telemetry = capturedTelemetrySnapshot(captured);
      expect(telemetry).toContain("refresh_failed");
      expect(telemetry).not.toContain("access");
    }).pipe(Effect.provide(Layer.merge(serviceLayer, captured.layer)));
  });

  it.effect("uses current context and captures redacted initialization/refresh spans", () => {
    const captured = makeCapturedTracer();
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
      const names = captured.spans.map((span) => span.name);
      expect(names).toContain("pi-better-xai.usage.initialize");
      expect(names).toContain("pi-better-xai.usage.refresh");
      const telemetry = capturedTelemetrySnapshot(captured);
      expect(telemetry).not.toContain("registry-token");
      expect(telemetry).not.toContain("/project");
      expect(telemetry).not.toContain("/agent");
    }).pipe(Effect.provide(serviceLayer.pipe(Layer.provide(captured.layer))));
  });

  it("interrupts in-flight polling when its runtime is disposed", () => {
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

  it.effect("suppresses every stale commit after model selection", () => {
    const harness = documentHarness();
    type BillingFixture = typeof monthlyFixture | typeof weeklyFixture;
    const monthlyResponse = Deferred.makeUnsafe<{ status: number; body: BillingFixture }>();
    const weeklyResponse = Deferred.makeUnsafe<{ status: number; body: BillingFixture }>();
    let calls = 0;
    const http = httpLayer(() => Deferred.await(calls++ === 0 ? monthlyResponse : weeklyResponse));
    const contextRef = MutableRef.make(registryContext());
    const projection = makeProjection();
    let notifications = 0;
    const ctx = MutableRef.get(contextRef);
    ctx.ui.notify = () => {
      notifications++;
    };
    const serviceLayer = XaiUsageService.layer({
      context: contextRef,
      cwd: "/project",
      projection,
      onChange() {},
      startPolling: false,
      agentDir: "/agent",
    }).pipe(Layer.provide(providers(harness.layer, http)));
    return Effect.gen(function* () {
      const service = yield* XaiUsageService;
      const old = yield* service.refresh({ force: true, notify: true }).pipe(Effect.forkScoped);
      while (calls < 2) yield* Effect.yieldNow;
      MutableRef.set(contextRef, {
        ...MutableRef.get(contextRef),
        model: { provider: "openai", id: "gpt" },
      } as ExtensionContext);
      yield* service.contextChanged(true);
      yield* Deferred.succeed(monthlyResponse, { status: 200, body: monthlyFixture });
      yield* Deferred.succeed(weeklyResponse, { status: 200, body: weeklyFixture });
      yield* Fiber.join(old);
      expect(MutableRef.get(projection).snapshot).toBeUndefined();
      expect(MutableRef.get(projection).authFound).toBe(false);
      expect(MutableRef.get(projection).eligible).toBe(false);
      expect(MutableRef.get(projection).lastFetchAt).toBeUndefined();
      expect(notifications).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(serviceLayer));
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
