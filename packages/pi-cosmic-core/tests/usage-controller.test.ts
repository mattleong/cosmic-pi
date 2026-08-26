import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Path from "effect/Path";
import { provideBuiltLayer } from "../index.ts";
import { AgentDirectory } from "../src/platform/agent-directory.ts";
import { JsonHttpClient } from "../src/platform/json-http.ts";
import { makeInMemoryDocuments } from "../src/testing/layers.ts";
import { makeUsageRefreshController, type UsageControllerConfig } from "../src/usage-controller.ts";
import { initialUsageProjection } from "../src/usage-projection.ts";

type TestConfig = UsageControllerConfig;
type TestProjection = ReturnType<typeof initialUsageProjection<TestConfig, never>>;

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
        enabled: true,
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
