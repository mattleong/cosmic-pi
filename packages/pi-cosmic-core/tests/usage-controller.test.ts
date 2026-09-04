import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, it } from "@effect/vitest";
import { expectTypeOf } from "vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Path from "effect/Path";
import { provideBuiltLayer } from "../index.ts";
import { AgentDirectory } from "../src/platform/agent-directory.ts";
import {
  JsonDocumentStore,
  type JsonDocumentModification,
  type JsonObject,
} from "../src/platform/json-document.ts";
import { JsonHttpClient } from "../src/platform/json-http.ts";
import { makeInMemoryDocuments } from "../src/testing/layers.ts";
import {
  makeUsageRefreshController,
  type UsageControllerConfig,
  type UsageControllerStore,
} from "../src/usage-controller.ts";
import { initialUsageProjection } from "../src/usage-projection.ts";

type TestConfig = UsageControllerConfig;
type TestProjection = ReturnType<typeof initialUsageProjection<TestConfig, never>>;

type UnscopedResolved = { readonly value: string };
type UnscopedStoreError = { readonly _tag: "UnscopedStoreError" };
interface ExpectedUnscopedStore {
  readonly resolveConfig: (
    cwd: string,
    agentDir: string,
    projectTrusted?: boolean,
  ) => Effect.Effect<UnscopedResolved, UnscopedStoreError, JsonDocumentStore | Path.Path>;
  readonly readRawConfig: (
    path: string,
  ) => Effect.Effect<JsonObject, UnscopedStoreError, JsonDocumentStore>;
  readonly resolveCommittedConfig: (
    current: UnscopedResolved,
    committed: JsonObject,
    globalFallback: JsonObject | undefined,
  ) => UnscopedResolved;
  readonly modifyConfig: <A, AfterCommitR = never>(
    path: string,
    modify: (document: JsonObject) => JsonDocumentModification<A, AfterCommitR>,
  ) => Effect.Effect<A, UnscopedStoreError, JsonDocumentStore | AfterCommitR>;
}

it("keeps the exported store structural for unscoped resolved values", () => {
  expectTypeOf<
    UsageControllerStore<UnscopedResolved, UnscopedStoreError>
  >().toEqualTypeOf<ExpectedUnscopedStore>();
});

it.effect(
  "captures dependencies for an escaped refresh and defaults project trust to false",
  () => {
    const sharedHttp = JsonHttpClient.of({
      request: () => Effect.die("unused HTTP request"),
      requestJson: () => Effect.die("unused HTTP request"),
    });
    const conflictingHttp = JsonHttpClient.of({
      request: () => Effect.die("provider HTTP client must not escape"),
      requestJson: () => Effect.die("provider HTTP client must not escape"),
    });
    let observedTrust: boolean | undefined;
    let observedHttp: typeof sharedHttp | undefined;
    const memory = makeInMemoryDocuments();
    const constructionLayer = Layer.mergeAll(
      Path.layer,
      memory.layer,
      AgentDirectory.layer("/agent"),
      Layer.succeed(JsonHttpClient, sharedHttp),
    );
    const config: TestConfig = {
      configPath: "/agent/extensions/test.json",
      projectConfigPath: "/project/.pi/extensions/test.json",
      globalConfigPath: "/agent/extensions/test.json",
      projectConfigExists: false,
      globalConfigExists: true,
      usage: {
        refreshIntervalMs: 60_000,
        showOnlyOnSubscriptionModels: true,
      },
    };
    // SAFETY: This minimal host fixture is only observed by callbacks that ignore its fields.
    const context = MutableRef.make({ hasUI: true } as ExtensionContext);
    const projection = MutableRef.make<TestProjection>(initialUsageProjection<TestConfig, never>());

    return Effect.gen(function* () {
      const controller = yield* makeUsageRefreshController<
        TestProjection,
        TestConfig,
        never,
        never,
        never,
        JsonHttpClient
      >({
        spanPrefix: "test.usage",
        logLabel: "Test",
        context,
        cwd: "/project",
        projection,
        onChange() {},
        startPolling: false,
        agentDir: "/agent",
        initialProjection: () => initialUsageProjection<TestConfig, never>(),
        hiddenStatusText: "hidden",
        missingCredentialsMessage: () => "credentials missing",
        clearAuthPatch: { authFound: false },
        store: {
          resolveConfig: (_cwd, _agentDir, projectTrusted) => {
            observedTrust = projectTrusted;
            return Effect.succeed(config);
          },
          readRawConfig: () => Effect.succeed({}),
          resolveCommittedConfig: (current) => current,
          modifyConfig: () => Effect.die("unused config mutation"),
        },
        decodeSettingUpdate: () => Effect.die("unused setting update"),
        eligibility: () => Effect.succeed(true),
        synchronizeState: (current) => Effect.succeed(current),
        fetchOutcome: () =>
          Effect.gen(function* () {
            observedHttp = yield* JsonHttpClient;
            return { _tag: "Missing" } as const;
          }),
        formatStatusLine: () => "",
        formatStatusText: () => "",
        dependencies: Context.make(JsonHttpClient, conflictingHttp),
      }).pipe(provideBuiltLayer(constructionLayer));

      // The construction Layer is closed here. The escaped effect uses its captured services.
      yield* controller.refresh({ force: true });

      expect(observedTrust).toBe(false);
      expect(observedHttp).toBe(sharedHttp);
      expect(observedHttp).not.toBe(conflictingHttp);
      expect(MutableRef.get(projection)).toMatchObject({
        config,
        authPath: "/agent/auth.json",
        eligible: true,
        snapshot: undefined,
        error: "credentials missing",
        statusText: "Usage unavailable: credentials missing",
      });
    });
  },
);

it.effect("composes the default synchronizeState from eligibility and hiddenStatusText", () => {
  const memory = makeInMemoryDocuments();
  const constructionLayer = Layer.mergeAll(
    Path.layer,
    memory.layer,
    AgentDirectory.layer("/agent"),
    Layer.succeed(
      JsonHttpClient,
      JsonHttpClient.of({
        request: () => Effect.die("unused HTTP request"),
        requestJson: () => Effect.die("unused HTTP request"),
      }),
    ),
  );
  const config: TestConfig = {
    configPath: "/agent/extensions/test.json",
    projectConfigPath: "/project/.pi/extensions/test.json",
    globalConfigPath: "/agent/extensions/test.json",
    projectConfigExists: false,
    globalConfigExists: true,
    usage: {
      refreshIntervalMs: 60_000,
      showOnlyOnSubscriptionModels: true,
    },
  };
  // SAFETY: This minimal host fixture is only observed by callbacks that ignore its fields.
  const context = MutableRef.make({ hasUI: true } as ExtensionContext);
  const projection = MutableRef.make<TestProjection>(initialUsageProjection<TestConfig, never>());

  return Effect.gen(function* () {
    yield* makeUsageRefreshController<TestProjection, TestConfig, never, never, never, never>({
      spanPrefix: "test.usage",
      logLabel: "Test",
      context,
      cwd: "/project",
      projection,
      onChange() {},
      startPolling: false,
      agentDir: "/agent",
      initialProjection: () => initialUsageProjection<TestConfig, never>(),
      hiddenStatusText: "hidden: model not eligible for usage display",
      missingCredentialsMessage: () => "credentials missing",
      clearAuthPatch: { authFound: false },
      store: {
        resolveConfig: () => Effect.succeed(config),
        readRawConfig: () => Effect.succeed({}),
        resolveCommittedConfig: (current) => current,
        modifyConfig: () => Effect.die("unused config mutation"),
      },
      decodeSettingUpdate: () => Effect.die("unused setting update"),
      eligibility: () => Effect.succeed(false),
      fetchOutcome: () => Effect.die("unused fetch"),
      formatStatusLine: () => "",
      formatStatusText: () => "",
      dependencies: Context.empty(),
    }).pipe(provideBuiltLayer(constructionLayer));

    // Construction-time synchronize(true) applied the default synchronizeState path.
    expect(MutableRef.get(projection)).toMatchObject({
      config,
      authPath: "/agent/auth.json",
      eligible: false,
      snapshot: undefined,
      statusLine: undefined,
      error: undefined,
      statusText: "hidden: model not eligible for usage display",
    });
  });
});
