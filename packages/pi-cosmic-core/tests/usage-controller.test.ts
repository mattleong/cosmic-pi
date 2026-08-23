import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Path from "effect/Path";
import {
  makeUsageRefreshController,
  type UsageControllerConfig,
  type UsageProviderRequirements,
} from "../src/usage-controller.ts";
import { AgentDirectory } from "../src/platform/agent-directory.ts";
import { provideBuiltLayer } from "../src/runtime/layers.ts";
import { JsonDocumentStore } from "../src/platform/json-document.ts";
import { JsonHttpClient } from "../src/platform/json-http.ts";
import { initialUsageProjection } from "../src/usage-projection.ts";
import { makeInMemoryDocuments } from "../src/testing/layers.ts";

type TestProjection = ReturnType<typeof initialUsageProjection<TestConfig, never>>;
type TestConfig = UsageControllerConfig;

const config: TestConfig = {
  configPath: "/agent/extensions/test.json",
  projectConfigPath: "/project/.pi/extensions/test.json",
  globalConfigPath: "/agent/extensions/test.json",
  projectConfigExists: false,
  globalConfigExists: true,
  usage: {
    enabled: false,
    refreshIntervalMs: 60_000,
    showOnlyOnSubscriptionModels: true,
  },
};

it.effect("usage controller treats omitted project trust as untrusted", () => {
  let observedTrust: boolean | undefined;
  const memory = makeInMemoryDocuments();
  const dependencies = Layer.mergeAll(
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
  // SAFETY: This minimal host fixture is only observed by callbacks that ignore its fields.
  const context = MutableRef.make({ hasUI: false } as ExtensionContext);
  const projection = MutableRef.make<TestProjection>(initialUsageProjection<TestConfig, never>());
  const store = {
    resolveConfig: (_cwd: string, _agentDir: string, projectTrusted?: boolean) => {
      observedTrust = projectTrusted;
      return Effect.succeed(config);
    },
    readRawConfig: () => Effect.succeed({}),
    resolveCommittedConfig: (current: TestConfig) => current,
    modifyConfig: () => Effect.die("unused config mutation"),
  };

  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const documents = yield* JsonDocumentStore;
    const http = yield* JsonHttpClient;
    const provideDependencies = <A, E>(
      effect: Effect.Effect<A, E, UsageProviderRequirements>,
    ): Effect.Effect<A, E> =>
      effect.pipe(
        Effect.provideService(Path.Path, path),
        Effect.provideService(JsonDocumentStore, documents),
        Effect.provideService(JsonHttpClient, http),
      );
    yield* makeUsageRefreshController<TestProjection, TestConfig, never, never, never>({
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
      missingCredentialsMessage: () => "missing",
      clearAuthPatch: { authFound: false },
      store,
      decodeSettingUpdate: () => Effect.die("unused setting update"),
      eligibility: () => Effect.succeed(false),
      synchronizeState: (current) => Effect.succeed(current),
      fetchOutcome: () => Effect.succeed({ _tag: "Missing" }),
      formatStatusLine: () => "",
      formatStatusText: () => "",
      provideDependencies,
    });
    expect(observedTrust).toBe(false);
  }).pipe(provideBuiltLayer(dependencies));
});
