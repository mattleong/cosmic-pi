// @effect-diagnostics effect/strictEffectProvide:off
// @effect-diagnostics effect/preferSchemaOverJson:off
// @effect-diagnostics effect/newPromise:off
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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
  JsonHttpError,
  type JsonDocumentStoreShape,
  type JsonObject,
} from "pi-cosmic-core";
import {
  capturedTelemetrySnapshot,
  jsonHttpTestLayer,
  makeCapturedLogger,
  makeCapturedTracer,
  type JsonHttpTestRequest,
} from "pi-cosmic-core/testing";
import {
  extractAccountIdFromJwt,
  getCodexCredentials,
  getCodexCredentialsResult,
  parseCodexRegistryCredentials,
  readCodexAuth,
} from "../src/codex-auth.ts";
import {
  DEFAULT_IMAGE_CONFIG,
  applySettingToRawConfig,
  readConfig,
  resolveConfig,
} from "../src/config.ts";
import {
  initialFastSnapshot,
  injectProviderPayload,
  type FastSnapshot,
} from "../src/fast-controller.ts";
import { FastModeService } from "../src/fast-service.ts";
import { openAIUsageUiState } from "../src/ui/primitives.ts";
import {
  OpenAIUsageService,
  isOpenAISubscriptionModel,
  makeProjection,
  synchronizeProjectionContext,
} from "../src/usage-controller.ts";
import {
  USAGE_URL,
  formatUsageSnapshot,
  parseUsageSnapshot,
  requestCodexUsage,
} from "../src/usage.ts";

const NOW = 1_752_883_200_000;
function documents(initial: Readonly<Record<string, JsonObject>> = {}) {
  const values = new Map(Object.entries(initial));
  let beforeNextUpdate: ((current: JsonObject) => JsonObject) | undefined;
  let nextUpdateGate:
    | {
        readonly _tag: "BeforeCommit" | "Committed";
        readonly started: Deferred.Deferred<void>;
        readonly release: Deferred.Deferred<void>;
      }
    | undefined;
  let updateCount = 0;
  const modifyObject: NonNullable<JsonDocumentStoreShape["modifyObject"]> = (path, modify) =>
    Effect.gen(function* () {
      updateCount++;
      const current = values.get(path) ?? {};
      const lockedCurrent = beforeNextUpdate ? beforeNextUpdate(current) : current;
      beforeNextUpdate = undefined;
      const modification = yield* modify(lockedCurrent);
      const gate = nextUpdateGate;
      nextUpdateGate = undefined;
      if (gate?._tag === "BeforeCommit") {
        yield* Deferred.succeed(gate.started, undefined);
        yield* Deferred.await(gate.release);
      }
      return yield* Effect.gen(function* () {
        values.set(path, modification.document);
        if (gate?._tag === "Committed") {
          yield* Deferred.succeed(gate.started, undefined);
          yield* Deferred.await(gate.release);
        }
        yield* modification.afterCommit ?? Effect.void;
        return modification.value;
      }).pipe(Effect.uninterruptible);
    });
  const service: JsonDocumentStoreShape = {
    exists: (path) => Effect.succeed(values.has(path)),
    readObject: (path) => Effect.succeed(values.get(path)),
    writeObject: (path, value) => Effect.sync(() => void values.set(path, value)),
    modifyObject,
    updateObject: (path, update) =>
      modifyObject(path, (current) => {
        const next = update(current);
        return Effect.succeed({ value: next, document: next });
      }),
  };
  return {
    values,
    layer: Layer.succeed(JsonDocumentStore, service),
    beforeNextUpdate(update: (current: JsonObject) => JsonObject) {
      beforeNextUpdate = update;
    },
    blockNextUpdateBeforeCommit(
      started: Deferred.Deferred<void>,
      release: Deferred.Deferred<void>,
    ) {
      nextUpdateGate = { _tag: "BeforeCommit", started, release };
    },
    blockNextUpdateAtCommit(started: Deferred.Deferred<void>, release: Deferred.Deferred<void>) {
      nextUpdateGate = { _tag: "Committed", started, release };
    },
    get updateCount() {
      return updateCount;
    },
  };
}
const context = (token?: string, oauth = true) =>
  ({
    cwd: "/project",
    hasUI: true,
    model: { provider: "openai", id: "gpt-5.5" },
    modelRegistry: {
      getApiKeyForProvider: () => globalThis.Promise.resolve(token),
      isUsingOAuth: () => oauth,
    },
    ui: { notify() {} },
  }) as unknown as ExtensionContext;
const jwt = (accountId: string) => {
  const body = Buffer.from(
    `{"https://api.openai.com/auth":{"chatgpt_account_id":"${accountId}"}}`,
  ).toString("base64url");
  return `header.${body}.signature`;
};

describe("OpenAI configuration and credentials", () => {
  it.effect("decodes fields independently and merges project over global", () => {
    const store = documents({
      "/agent/extensions/pi-better-openai.json": {
        usage: { enabled: false, refreshIntervalMs: 30_000, showResetTimes: false },
        image: { defaultSave: "global", timeoutMs: 40_000 },
      },
      "/project/.pi/extensions/pi-better-openai.json": {
        usage: { enabled: true, refreshIntervalMs: "bad" },
        footer: { mode: "status" },
        image: { outputFormat: "webp", defaultSave: "invalid" },
      },
    });
    return Effect.gen(function* () {
      const cfg = yield* resolveConfig("/project", "/agent");
      expect(cfg.usage).toMatchObject({
        enabled: true,
        refreshIntervalMs: 30_000,
        showResetTimes: false,
      });
      expect(cfg.footer.mode).toBe("status");
      expect(cfg.image).toMatchObject({
        defaultSave: "global",
        outputFormat: "webp",
        timeoutMs: 40_000,
      });
      const parsed = yield* readConfig("/project/.pi/extensions/pi-better-openai.json");
      expect(parsed?.usage?.enabled).toBe(true);
      expect(parsed?.usage?.refreshIntervalMs).toBeUndefined();
    }).pipe(Effect.provide(Layer.merge(store.layer, Path.layer)));
  });

  it.effect("preserves unknown fields through settings patches", () =>
    Effect.gen(function* () {
      expect(
        yield* applySettingToRawConfig(
          { unknown: 1, usage: { other: true } },
          "usage.enabled",
          "false",
        ),
      ).toEqual({ unknown: 1, usage: { other: true, enabled: false } });
      expect(DEFAULT_IMAGE_CONFIG.defaultSave).toBe("project");
    }),
  );

  it.effect("distinguishes total credential failure from genuine absence", () => {
    const failure = new JsonDocumentError({
      operation: "read",
      path: "/redacted",
      message: "unavailable",
    });
    const layer = Layer.succeed(
      JsonDocumentStore,
      JsonDocumentStore.of({
        exists: () => Effect.fail(failure),
        readObject: () => Effect.fail(failure),
        writeObject: () => Effect.fail(failure),
        modifyObject: () => Effect.fail(failure),
        updateObject: () => Effect.fail(failure),
      }),
    );
    const ctx = context();
    ctx.modelRegistry.getApiKeyForProvider = () => Promise.reject(new Error("registry"));
    return Effect.gen(function* () {
      const result = yield* getCodexCredentialsResult("/auth.json", ctx);
      expect(result._tag).toBe("Unavailable");
      expect(JSON.stringify(result)).not.toContain("redacted");
    }).pipe(Effect.provide(layer));
  });

  it.effect("interrupts a pending model-registry credential lookup", () => {
    const pending = new globalThis.Promise<string | undefined>(() => undefined);
    const store = documents();
    const ctx = context();
    ctx.modelRegistry.getApiKeyForProvider = () => pending;
    return Effect.gen(function* () {
      const fiber = yield* getCodexCredentials("/auth.json", ctx).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
      expect(true).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(store.layer));
  });

  it.effect("extracts JWT and registry credentials with auth-file fallback and expiry", () => {
    const authPath = "/agent/auth.json";
    const store = documents({
      [authPath]: {
        "openai-codex": {
          type: "oauth",
          access: "file-token",
          accountId: "acct_file",
          expires: 1_000,
        },
      },
    });
    return Effect.gen(function* () {
      expect(yield* extractAccountIdFromJwt(jwt("acct_jwt"))).toBe("acct_jwt");
      expect(
        yield* parseCodexRegistryCredentials(
          JSON.stringify({ access: "registry", accountId: "acct_registry" }),
        ),
      ).toEqual({ accessToken: "registry", accountId: "acct_registry" });
      expect(yield* readCodexAuth(authPath)).toEqual({
        accessToken: "file-token",
        accountId: "acct_file",
      });
      expect((yield* getCodexCredentials(authPath, context()))?.source).toBe("authFile");
      expect(
        (yield* getCodexCredentials(
          authPath,
          context(JSON.stringify({ access: "registry", accountId: "acct_registry" })),
        ))?.source,
      ).toBe("modelRegistry");
      yield* TestClock.adjust("2 seconds");
      expect(yield* readCodexAuth(authPath)).toBeUndefined();
    }).pipe(Effect.provide(store.layer));
  });
});

describe("usage payloads, visibility, and fast mode", () => {
  const payload = {
    rate_limit: {
      allowed: true,
      primary_window: { used_percent: 10, reset_after_seconds: 60 },
      secondary_window: { used_percent: 20, reset_after_seconds: 3600 },
    },
  };
  it.effect("parses standard, weekly-only, Spark, and malformed payloads", () =>
    Effect.sync(() => {
      const standard = parseUsageSnapshot(payload, "gpt-5.5", NOW);
      expect(standard.fiveHourLeftPercent).toBe(90);
      expect(standard.sevenDayLeftPercent).toBe(80);
      expect(formatUsageSnapshot(standard, { showResetTimes: false }, NOW)).toBe(
        "Usage: 5h: 90% | 7d: 80%",
      );
      expect(
        parseUsageSnapshot({ rate_limit: { primary_window: { used_percent: 30 } } }, "gpt-5.5", NOW)
          .sevenDayLeftPercent,
      ).toBe(70);
      expect(
        parseUsageSnapshot(
          {
            rate_limit: payload.rate_limit,
            additional_rate_limits: [
              {
                limit_name: "GPT-5.3-Codex-Spark",
                rate_limit: { primary_window: { used_percent: 40 } },
              },
            ],
          },
          "gpt-5.3-codex-spark",
          NOW,
        ).sevenDayLeftPercent,
      ).toBe(60);
      expect(
        parseUsageSnapshot({ rate_limit: "bad" }, undefined, NOW).sevenDayLeftPercent,
      ).toBeNull();
    }),
  );

  it.effect("uses credential headers and rejects malformed provider payloads", () => {
    const store = documents();
    let request: JsonHttpTestRequest | undefined;
    const http = jsonHttpTestLayer((input) => {
      request = input;
      return Effect.succeed({ status: 200, body: payload });
    });
    return Effect.gen(function* () {
      const snapshot = yield* requestCodexUsage(
        "/auth.json",
        context(JSON.stringify({ access: "token", accountId: "acct" })),
        "gpt-5.5",
      );
      expect(snapshot?.fiveHourLeftPercent).toBe(90);
      expect(request?.url).toBe(USAGE_URL);
      expect(request?.headers).toMatchObject({
        authorization: "Bearer token",
        "chatgpt-account-id": "acct",
      });
    }).pipe(Effect.provide(Layer.merge(store.layer, http)));
  });

  it.effect("coalesces refreshes and captures redacted initialization/refresh spans", () => {
    const captured = makeCapturedTracer();
    const store = documents({
      "/project/.pi/extensions/pi-better-openai.json": {
        usage: { enabled: true, refreshIntervalMs: 60_000 },
        footer: { mode: "off" },
        image: { enabled: false },
      },
    });
    let calls = 0;
    const http = jsonHttpTestLayer(() =>
      Effect.gen(function* () {
        calls++;
        yield* Effect.yieldNow;
        return { status: 200, body: payload };
      }),
    );
    const ctx = context(JSON.stringify({ access: "token", accountId: "acct" }));
    const contextRef = MutableRef.make(ctx);
    const projection = makeProjection();
    const providers = Layer.mergeAll(store.layer, http, Path.layer, AgentDirectory.layer("/agent"));
    const layer = OpenAIUsageService.layer({
      context: contextRef,
      cwd: "/project",
      agentDir: "/agent",
      projection,
      onChange() {},
      startPolling: false,
    }).pipe(Layer.provide(providers));
    return Effect.gen(function* () {
      const fiber = yield* Effect.all(
        Array.from({ length: 20 }, () =>
          OpenAIUsageService.use((service) => service.refresh({ force: true })),
        ),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkScoped);
      yield* Fiber.join(fiber);
      expect(calls).toBeLessThanOrEqual(2);
      expect(calls).toBeGreaterThan(0);
      expect(MutableRef.get(projection)).toMatchObject({
        authFound: true,
        authSource: "modelRegistry",
        accountId: "acct",
      });
      const names = captured.spans.map((span) => span.name);
      expect(names).toContain("pi-better-openai.usage.initialize");
      expect(names).toContain("pi-better-openai.usage.refresh");
      const telemetry = JSON.stringify(
        captured.spans.map((span) => ({ name: span.name, attributes: [...span.attributes] })),
      );
      expect(telemetry).not.toContain("token");
      expect(telemetry).not.toContain("acct");
      expect(telemetry).not.toContain("/project");
    }).pipe(Effect.scoped, Effect.provide(layer.pipe(Layer.provide(captured.layer))));
  });

  it.effect("times out credential lookup and releases the refresh coordinator", () => {
    const store = documents({
      "/project/.pi/extensions/pi-better-openai.json": {
        usage: { enabled: true, refreshIntervalMs: 60_000 },
        footer: { mode: "off" },
        image: { enabled: false },
      },
    });
    let lookupStarted = false;
    let requests = 0;
    const ctx = context();
    ctx.modelRegistry.getApiKeyForProvider = () => {
      lookupStarted = true;
      return new globalThis.Promise<string | undefined>(() => undefined);
    };
    const http = jsonHttpTestLayer(() => {
      requests++;
      return Effect.succeed({ status: 200, body: payload });
    });
    const projection = makeProjection();
    const layer = OpenAIUsageService.layer({
      context: MutableRef.make(ctx),
      cwd: "/project",
      agentDir: "/agent",
      projection,
      onChange() {},
      startPolling: false,
    }).pipe(
      Layer.provide(Layer.mergeAll(store.layer, http, Path.layer, AgentDirectory.layer("/agent"))),
    );
    return Effect.gen(function* () {
      const service = yield* OpenAIUsageService;
      const timedOut = yield* service.refresh({ force: true }).pipe(Effect.forkScoped);
      while (!lookupStarted) yield* Effect.yieldNow;
      yield* TestClock.adjust("11 seconds");
      yield* Fiber.join(timedOut);
      expect(MutableRef.get(projection).error).toBeDefined();
      expect(requests).toBe(0);

      ctx.modelRegistry.getApiKeyForProvider = () =>
        globalThis.Promise.resolve(JSON.stringify({ access: "token", accountId: "acct" }));
      yield* service.refresh({ force: true });
      expect(requests).toBe(1);
      expect(MutableRef.get(projection).snapshot).toBeDefined();
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("wakes one production poller when a long interval is shortened", () => {
    const store = documents({
      "/project/.pi/extensions/pi-better-openai.json": {
        usage: { enabled: true, refreshIntervalMs: 600_000 },
        footer: { mode: "off" },
        image: { enabled: false },
      },
    });
    let calls = 0;
    const http = jsonHttpTestLayer(() =>
      Effect.sync(() => ({ status: 200, body: payload })).pipe(
        Effect.tap(() => Effect.sync(() => calls++)),
      ),
    );
    const contextRef = MutableRef.make(
      context(JSON.stringify({ access: "token", accountId: "acct" })),
    );
    const projection = makeProjection();
    const layer = OpenAIUsageService.layer({
      context: contextRef,
      cwd: "/project",
      agentDir: "/agent",
      projection,
      onChange() {},
    }).pipe(
      Layer.provide(Layer.mergeAll(store.layer, http, Path.layer, AgentDirectory.layer("/agent"))),
    );
    return Effect.gen(function* () {
      const service = yield* OpenAIUsageService;
      while (calls < 1) yield* Effect.yieldNow;
      yield* service.updateSetting("usage.refreshIntervalMs", "15000");
      for (let index = 0; index < 50; index++) yield* Effect.yieldNow;
      expect(calls).toBe(2);
      yield* TestClock.adjust("14999 millis");
      expect(calls).toBe(2);
      yield* TestClock.adjust("1 millis");
      while (calls < 3) yield* Effect.yieldNow;
      expect(calls).toBe(3);
    }).pipe(Effect.provide(layer));
  });

  it.effect("applies setting patches to the document snapshot held by the update lock", () => {
    const configPath = "/project/.pi/extensions/pi-better-openai.json";
    const globalConfigPath = "/agent/extensions/pi-better-openai.json";
    const store = documents({
      [configPath]: {
        unknown: { preserved: true },
        active: false,
        desiredActive: false,
        usage: { enabled: false, sibling: "preserved" },
        footer: { mode: "off" },
        image: { enabled: false },
      },
      [globalConfigPath]: {
        footer: { mode: "status" },
      },
    });
    const projection = makeProjection();
    const layer = OpenAIUsageService.layer({
      context: MutableRef.make(context()),
      cwd: "/project",
      agentDir: "/agent",
      projection,
      onChange() {},
      startPolling: false,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          store.layer,
          jsonHttpTestLayer(() => Effect.die("usage request was not expected")),
          Path.layer,
          AgentDirectory.layer("/agent"),
        ),
      ),
    );
    return Effect.gen(function* () {
      const service = yield* OpenAIUsageService;
      store.beforeNextUpdate((current) => {
        const withoutFooterOverride = { ...current };
        delete withoutFooterOverride.footer;
        return {
          ...withoutFooterOverride,
          active: true,
          desiredActive: true,
          concurrentField: "preserved",
        };
      });

      yield* service.updateSetting("usage.showResetTimes", "true");

      expect(store.values.get(configPath)).toEqual({
        unknown: { preserved: true },
        active: true,
        desiredActive: true,
        concurrentField: "preserved",
        usage: { enabled: false, sibling: "preserved", showResetTimes: true },
        image: { enabled: false },
      });
      expect(MutableRef.get(projection).config).toMatchObject({
        active: true,
        desiredActive: true,
        usage: { enabled: false, showResetTimes: true },
        footer: { mode: "status" },
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("refreshes global fallback appearance and removal before project commits", () => {
    const configPath = "/project/.pi/extensions/pi-better-openai.json";
    const globalConfigPath = "/agent/extensions/pi-better-openai.json";
    const store = documents({
      [configPath]: {
        usage: { enabled: false },
        footer: { mode: "off" },
        image: { enabled: false },
      },
    });
    const projection = makeProjection();
    const layer = OpenAIUsageService.layer({
      context: MutableRef.make(context()),
      cwd: "/project",
      agentDir: "/agent",
      projection,
      onChange() {},
      startPolling: false,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          store.layer,
          jsonHttpTestLayer(() => Effect.die("usage request was not expected")),
          Path.layer,
          AgentDirectory.layer("/agent"),
        ),
      ),
    );

    return Effect.gen(function* () {
      const service = yield* OpenAIUsageService;
      store.values.set(globalConfigPath, { footer: { mode: "status" } });
      store.beforeNextUpdate((current) => {
        const next = { ...current };
        delete next.footer;
        return next;
      });

      yield* service.updateSetting("usage.showResetTimes", "false");

      expect(store.values.get(configPath)).not.toHaveProperty("footer");
      expect(MutableRef.get(projection).config).toMatchObject({
        configPath,
        globalConfigExists: true,
        footer: { mode: "status" },
        usage: { enabled: false, showResetTimes: false },
      });

      store.values.delete(globalConfigPath);
      yield* service.updateSetting("usage.showOnlyOnSubscriptionModels", "false");

      expect(MutableRef.get(projection).config).toMatchObject({
        configPath,
        globalConfigExists: false,
        footer: { mode: "replace" },
        usage: {
          enabled: false,
          showOnlyOnSubscriptionModels: false,
          showResetTimes: false,
        },
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("switches to a newly appeared project scope before committing", () => {
    const configPath = "/project/.pi/extensions/pi-better-openai.json";
    const globalConfigPath = "/agent/extensions/pi-better-openai.json";
    const store = documents({
      [globalConfigPath]: {
        persistState: true,
        usage: { enabled: true, showResetTimes: true },
        footer: { mode: "status" },
        image: { enabled: false },
      },
    });
    const projection = makeProjection();
    const layer = OpenAIUsageService.layer({
      context: MutableRef.make(context()),
      cwd: "/project",
      agentDir: "/agent",
      projection,
      onChange() {},
      startPolling: false,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          store.layer,
          jsonHttpTestLayer(() => Effect.die("usage request was not expected")),
          Path.layer,
          AgentDirectory.layer("/agent"),
        ),
      ),
    );

    return Effect.gen(function* () {
      const service = yield* OpenAIUsageService;
      store.values.set(configPath, {
        usage: { enabled: false },
        footer: { mode: "off" },
      });

      yield* service.updateSetting("usage.showResetTimes", "false");

      expect(store.values.get(globalConfigPath)).toMatchObject({
        usage: { enabled: true, showResetTimes: true },
      });
      expect(store.values.get(configPath)).toMatchObject({
        usage: { enabled: false, showResetTimes: false },
        footer: { mode: "off" },
      });
      expect(MutableRef.get(projection).config).toMatchObject({
        configPath,
        projectConfigExists: true,
        footer: { mode: "off" },
        usage: { enabled: false, showResetTimes: false },
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("publishes concurrent known-field edits from a persisted fast-mode commit", () => {
    const configPath = "/project/.pi/extensions/pi-better-openai.json";
    const store = documents({
      [configPath]: {
        persistState: true,
        active: false,
        desiredActive: false,
        usage: { enabled: true, showResetTimes: true },
        footer: { mode: "off" },
        image: { enabled: false },
      },
    });
    const projection = makeProjection();
    const layer = OpenAIUsageService.layer({
      context: MutableRef.make(context(JSON.stringify({ access: "token", accountId: "acct" }))),
      cwd: "/project",
      agentDir: "/agent",
      projection,
      onChange() {},
      startPolling: false,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          store.layer,
          jsonHttpTestLayer(() => Effect.succeed({ status: 200, body: payload })),
          Path.layer,
          AgentDirectory.layer("/agent"),
        ),
      ),
    );
    return Effect.gen(function* () {
      const service = yield* OpenAIUsageService;
      yield* service.refresh({ force: true });
      expect(MutableRef.get(projection).snapshot).toBeDefined();
      store.beforeNextUpdate((current) => ({
        ...current,
        usage: { enabled: true, showResetTimes: false },
        footer: { mode: "status" },
      }));

      yield* service.persistFast(true, true);

      expect(store.values.get(configPath)).toMatchObject({
        active: true,
        desiredActive: true,
        usage: { enabled: true, showResetTimes: false },
        footer: { mode: "status" },
      });
      expect(MutableRef.get(projection).config).toMatchObject({
        active: true,
        desiredActive: true,
        usage: { enabled: true, showResetTimes: false },
        footer: { mode: "status" },
      });
      expect(MutableRef.get(projection).snapshot).toBeUndefined();
      expect(MutableRef.get(projection).statusLine).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.effect("serializes config mutation through resolved-config publication", () => {
    const configPath = "/project/.pi/extensions/pi-better-openai.json";
    const store = documents({
      [configPath]: {
        unknown: { preserved: true },
        persistState: true,
        active: false,
        desiredActive: false,
        usage: { enabled: false, sibling: "preserved" },
        footer: { mode: "off" },
        image: { enabled: false },
      },
    });
    const projection = makeProjection();
    const layer = OpenAIUsageService.layer({
      context: MutableRef.make(context()),
      cwd: "/project",
      agentDir: "/agent",
      projection,
      onChange() {},
      startPolling: false,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          store.layer,
          jsonHttpTestLayer(() => Effect.die("usage request was not expected")),
          Path.layer,
          AgentDirectory.layer("/agent"),
        ),
      ),
    );
    return Effect.gen(function* () {
      const service = yield* OpenAIUsageService;
      const commitStarted = yield* Deferred.make<void>();
      const releaseCommit = yield* Deferred.make<void>();
      store.blockNextUpdateAtCommit(commitStarted, releaseCommit);

      const setting = yield* service
        .updateSetting("usage.showResetTimes", "true")
        .pipe(Effect.forkScoped);
      yield* Deferred.await(commitStarted);
      const fast = yield* service.persistFast(true, true).pipe(Effect.forkScoped);
      for (let index = 0; index < 100 && store.updateCount < 2; index++) yield* Effect.yieldNow;
      const writesBeforeRelease = store.updateCount;

      yield* Deferred.succeed(releaseCommit, undefined);
      yield* Fiber.join(setting);
      yield* Fiber.join(fast);

      expect(writesBeforeRelease).toBe(1);
      expect(store.values.get(configPath)).toEqual({
        unknown: { preserved: true },
        persistState: true,
        active: true,
        desiredActive: true,
        usage: { enabled: false, sibling: "preserved", showResetTimes: true },
        footer: { mode: "off" },
        image: { enabled: false },
      });
      expect(MutableRef.get(projection).config).toMatchObject({
        persistState: true,
        active: true,
        desiredActive: true,
        usage: { enabled: false, showResetTimes: true },
      });
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("publishes committed config before interruption is observable", () => {
    const configPath = "/project/.pi/extensions/pi-better-openai.json";
    const store = documents({
      [configPath]: {
        persistState: true,
        active: false,
        desiredActive: false,
        usage: { enabled: false, sibling: "preserved" },
        footer: { mode: "off" },
        image: { enabled: false },
      },
    });
    const projection = makeProjection();
    const layer = OpenAIUsageService.layer({
      context: MutableRef.make(context()),
      cwd: "/project",
      agentDir: "/agent",
      projection,
      onChange() {},
      startPolling: false,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          store.layer,
          jsonHttpTestLayer(() => Effect.die("usage request was not expected")),
          Path.layer,
          AgentDirectory.layer("/agent"),
        ),
      ),
    );
    return Effect.gen(function* () {
      const service = yield* OpenAIUsageService;
      const commitStarted = yield* Deferred.make<void>();
      const releaseCommit = yield* Deferred.make<void>();
      store.blockNextUpdateAtCommit(commitStarted, releaseCommit);
      expect(MutableRef.get(projection).config?.usage.showResetTimes).toBe(true);

      const setting = yield* service
        .updateSetting("usage.showResetTimes", "false")
        .pipe(Effect.forkScoped);
      yield* Deferred.await(commitStarted);
      const interruption = yield* Fiber.interrupt(setting).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseCommit, undefined);
      yield* Fiber.join(interruption);

      expect(store.values.get(configPath)).toMatchObject({
        usage: { enabled: false, sibling: "preserved", showResetTimes: false },
      });
      expect(MutableRef.get(projection).config).toMatchObject({
        usage: { enabled: false, showResetTimes: false },
      });
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("commits persisted and in-memory fast state before interruption is observable", () => {
    const configPath = "/project/.pi/extensions/pi-better-openai.json";
    const store = documents({
      [configPath]: {
        persistState: true,
        active: false,
        desiredActive: false,
        usage: { enabled: false },
        footer: { mode: "off" },
        image: { enabled: false },
      },
    });
    const projection = makeProjection();
    const fastProjection = MutableRef.make(initialFastSnapshot());
    const usageLayer = OpenAIUsageService.layer({
      context: MutableRef.make(context()),
      cwd: "/project",
      agentDir: "/agent",
      projection,
      onChange() {},
      startPolling: false,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          store.layer,
          jsonHttpTestLayer(() => Effect.die("usage request was not expected")),
          Path.layer,
          AgentDirectory.layer("/agent"),
        ),
      ),
    );
    const layer = FastModeService.layer({
      serviceTier: "priority",
      projection: fastProjection,
      registerInjectionIngress() {},
    }).pipe(Layer.provide(usageLayer));

    return Effect.gen(function* () {
      const service = yield* FastModeService;
      const commitStarted = yield* Deferred.make<void>();
      const releaseCommit = yield* Deferred.make<void>();
      store.blockNextUpdateAtCommit(commitStarted, releaseCommit);

      const transition = yield* service.setDesired(context(), true).pipe(Effect.forkScoped);
      yield* Deferred.await(commitStarted);
      expect(MutableRef.get(fastProjection)).toMatchObject({
        active: false,
        desiredActive: false,
      });
      expect(MutableRef.get(projection).config).toMatchObject({
        active: false,
        desiredActive: false,
      });

      const interruption = yield* Fiber.interrupt(transition).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      expect(interruption.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(releaseCommit, undefined);
      yield* Fiber.join(interruption);
      expect((yield* Fiber.await(transition))._tag).toBe("Failure");

      expect(store.values.get(configPath)).toMatchObject({
        active: true,
        desiredActive: true,
      });
      expect(MutableRef.get(projection).config).toMatchObject({
        active: true,
        desiredActive: true,
      });
      expect(MutableRef.get(fastProjection)).toMatchObject({
        active: true,
        desiredActive: true,
      });
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("interrupts pre-commit config I/O and releases serialization", () => {
    const configPath = "/project/.pi/extensions/pi-better-openai.json";
    const store = documents({
      [configPath]: {
        persistState: true,
        active: false,
        desiredActive: false,
        usage: { enabled: false, sibling: "preserved" },
        footer: { mode: "off" },
        image: { enabled: false },
      },
    });
    const projection = makeProjection();
    const layer = OpenAIUsageService.layer({
      context: MutableRef.make(context()),
      cwd: "/project",
      agentDir: "/agent",
      projection,
      onChange() {},
      startPolling: false,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          store.layer,
          jsonHttpTestLayer(() => Effect.die("usage request was not expected")),
          Path.layer,
          AgentDirectory.layer("/agent"),
        ),
      ),
    );
    return Effect.gen(function* () {
      const service = yield* OpenAIUsageService;
      const writeStarted = yield* Deferred.make<void>();
      const abandonedWrite = yield* Deferred.make<void>();
      store.blockNextUpdateBeforeCommit(writeStarted, abandonedWrite);

      const setting = yield* service.updateSetting("usage.enabled", "true").pipe(Effect.forkScoped);
      yield* Deferred.await(writeStarted);
      yield* Fiber.interrupt(setting);

      expect(store.values.get(configPath)).toMatchObject({ usage: { enabled: false } });
      expect(MutableRef.get(projection).config?.usage.enabled).toBe(false);

      yield* service.persistFast(true, true);
      expect(store.updateCount).toBe(2);
      expect(store.values.get(configPath)).toMatchObject({
        active: true,
        desiredActive: true,
        usage: { enabled: false, sibling: "preserved" },
      });
      expect(MutableRef.get(projection).config).toMatchObject({
        active: true,
        desiredActive: true,
        usage: { enabled: false },
      });
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect(
    "records registry auth before a failed usage request and interrupts polling on release",
    () => {
      const store = documents({
        "/project/.pi/extensions/pi-better-openai.json": {
          usage: { enabled: true, refreshIntervalMs: 60_000 },
          footer: { mode: "off" },
          image: { enabled: false },
        },
      });
      let started = false;
      let released = 0;
      const http = jsonHttpTestLayer(() =>
        Effect.sync(() => {
          started = true;
        }).pipe(Effect.andThen(Effect.never), Effect.ensuring(Effect.sync(() => released++))),
      );
      const contextRef = MutableRef.make(
        context(JSON.stringify({ access: "registry-secret", accountId: "acct_registry" })),
      );
      const projection = makeProjection();
      const layer = OpenAIUsageService.layer({
        context: contextRef,
        cwd: "/project",
        agentDir: "/agent",
        projection,
        onChange() {},
      }).pipe(
        Layer.provide(
          Layer.mergeAll(store.layer, http, Path.layer, AgentDirectory.layer("/agent")),
        ),
      );
      const program = Effect.gen(function* () {
        yield* OpenAIUsageService;
        while (!started) yield* Effect.yieldNow;
        const state = MutableRef.get(projection);
        expect(state.authFound).toBe(false);
        expect(state.authSource).toBeUndefined();
        expect(state.accountId).toBeUndefined();
        expect(state).not.toHaveProperty("accessToken");
      }).pipe(Effect.provide(layer));
      return program.pipe(
        Effect.andThen(
          Effect.sync(() => {
            expect(released).toBe(1);
          }),
        ),
      );
    },
  );

  it.effect("transitions polling failures while retaining safe registry diagnostics", () => {
    const captured = makeCapturedLogger();
    const store = documents({
      "/project/.pi/extensions/pi-better-openai.json": {
        usage: { enabled: true, refreshIntervalMs: 60_000 },
        footer: { mode: "off" },
        image: { enabled: false },
      },
    });
    let calls = 0;
    const http = jsonHttpTestLayer(() => {
      calls++;
      return Effect.fail(
        new JsonHttpError({ operation: "request", message: "provider unavailable" }),
      );
    });
    const projection = makeProjection();
    const layer = OpenAIUsageService.layer({
      context: MutableRef.make(
        context(JSON.stringify({ access: "registry-secret", accountId: "acct_registry" })),
      ),
      cwd: "/project",
      agentDir: "/agent",
      projection,
      onChange() {},
    }).pipe(
      Layer.provide(Layer.mergeAll(store.layer, http, Path.layer, AgentDirectory.layer("/agent"))),
    );
    return Effect.gen(function* () {
      yield* OpenAIUsageService;
      while (calls < 1 || !MutableRef.get(projection).error) yield* Effect.yieldNow;
      const state = MutableRef.get(projection);
      expect(state.statusText).toContain("unavailable");
      expect(state.authFound).toBe(true);
      expect(state.authSource).toBe("modelRegistry");
      expect(state.accountId).toBe("acct_registry");
      expect(state.statusText).not.toContain("registry-secret");
      const telemetry = capturedTelemetrySnapshot(captured);
      expect(telemetry).toContain("refresh_failed");
      expect(telemetry).not.toContain("registry-secret");
      expect(telemetry).not.toContain("acct_registry");
    }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(captured.layer))));
  });

  it.effect("suppresses stale usage and notification commits after model selection", () => {
    const store = documents({
      "/project/.pi/extensions/pi-better-openai.json": {
        usage: { enabled: true },
        footer: { mode: "off" },
        image: { enabled: false },
      },
    });
    const response = Deferred.makeUnsafe<{ status: number; body: typeof payload }>();
    let started = false;
    const http = jsonHttpTestLayer(() =>
      Effect.sync(() => {
        started = true;
      }).pipe(Effect.andThen(Deferred.await(response))),
    );
    const ctx = context(JSON.stringify({ access: "token", accountId: "acct" }));
    let notifications = 0;
    ctx.ui.notify = () => {
      notifications++;
    };
    const contextRef = MutableRef.make(ctx);
    const projection = makeProjection();
    const layer = OpenAIUsageService.layer({
      context: contextRef,
      cwd: "/project",
      agentDir: "/agent",
      projection,
      onChange() {},
      startPolling: false,
    }).pipe(
      Layer.provide(Layer.mergeAll(store.layer, http, Path.layer, AgentDirectory.layer("/agent"))),
    );
    return Effect.gen(function* () {
      const service = yield* OpenAIUsageService;
      const old = yield* service.refresh({ force: true, notify: true }).pipe(Effect.forkScoped);
      while (!started) yield* Effect.yieldNow;
      MutableRef.set(contextRef, {
        ...MutableRef.get(contextRef),
        model: { provider: "anthropic", id: "claude" },
      } as ExtensionContext);
      yield* service.contextChanged(true);
      yield* Deferred.succeed(response, { status: 200, body: payload });
      yield* Fiber.join(old);
      const state = MutableRef.get(projection);
      expect(state.snapshot).toBeUndefined();
      expect(state.authFound).toBe(false);
      expect(state.eligible).toBe(false);
      expect(state.error).toBeUndefined();
      expect(state.lastFetchAt).toBeUndefined();
      expect(notifications).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("gates usage and fast injection by model/auth", () =>
    Effect.sync(() => {
      const ctx = context(undefined, false);
      const cfg = {
        configPath: "/c",
        projectConfigPath: "/p",
        globalConfigPath: "/g",
        projectConfigExists: true,
        globalConfigExists: false,
        persistState: true,
        active: false,
        desiredActive: false,
        usage: {
          enabled: true,
          refreshIntervalMs: 60_000,
          showOnlyOnSubscriptionModels: true,
          showResetTimes: false,
        },
        footer: { mode: "status" as const },
        image: DEFAULT_IMAGE_CONFIG,
      };
      expect(isOpenAISubscriptionModel(ctx, cfg)).toBe(false);
      ctx.modelRegistry.isUsingOAuth = () => {
        throw new Error("host registry failed");
      };
      expect(isOpenAISubscriptionModel(ctx, cfg)).toBe(false);
      const projection = makeProjection();
      MutableRef.set(projection, { ...MutableRef.get(projection), config: cfg });
      expect(() =>
        synchronizeProjectionContext(projection, ctx, { clearUsage: true }),
      ).not.toThrow();
      expect(openAIUsageUiState(ctx, cfg, projection).visible).toBe(false);
      expect(Object.isFrozen(MutableRef.get(projection))).toBe(true);
      expect(Object.isFrozen(MutableRef.get(projection).config?.usage)).toBe(true);
      expect(MutableRef.get(projection).config).not.toBe(cfg);
      const fast: FastSnapshot = { desiredActive: true, active: true };
      expect(
        injectProviderPayload(
          { payload: { model: "gpt-5.5" } },
          ctx,
          fast,
          "priority",
          () => undefined,
        ),
      ).toMatchObject({ service_tier: "priority" });
      ctx.model = { provider: "openai", id: "gpt-4.1" } as ExtensionContext["model"];
      expect(
        injectProviderPayload({ payload: {} }, ctx, fast, "priority", () => undefined),
      ).toBeUndefined();
    }),
  );
});
