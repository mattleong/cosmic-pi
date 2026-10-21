import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { provideBuiltLayer } from "pi-cosmic-core";
import { capturedTelemetrySnapshot, makeCapturedLogger } from "pi-cosmic-core/testing";
import { type ResolvedSubagentConfig } from "../src/config/options.ts";
import {
  decodeSubagentConfig,
  subagentConfigDecoder,
  type DecodedSubagentConfig,
} from "../src/config/schema.ts";
import { SubagentConfigStore, type SubagentConfigStoreContract } from "../src/config/store.ts";
import { resolvePiModelSelector } from "../src/run/model-catalog.ts";
import { isNativeProfileModelSelector, type ProfileCandidate } from "../src/profiles/model.ts";
import { resolveProfilePlan } from "../src/profiles/resolve.ts";
import {
  SubagentProfileService,
  subagentProfileServiceLayer,
  type SubagentProfileLayerOptions,
} from "../src/profiles/service.ts";
import {
  resolveTestConfig,
  type ConfigDocumentValue,
} from "./fixtures/profile-settings-inspection.ts";
import { profileCandidate } from "./fixtures/profiles.ts";

describe("Pi catalog selector classification", () => {
  const catalog = [
    { provider: "p", id: "Model" },
    { provider: "p", id: "model" },
  ];
  it("prefers exact spelling and reports case-insensitive collisions", () => {
    expect(resolvePiModelSelector("p/Model", catalog)).toMatchObject({
      kind: "resolved",
      id: "Model",
    });
    expect(resolvePiModelSelector("Model", catalog)).toMatchObject({
      kind: "resolved",
      id: "Model",
    });
    for (const selector of ["MODEL", "P/MODEL"])
      expect(resolvePiModelSelector(selector, catalog)).toEqual({
        kind: "ambiguous",
        candidates: ["p/Model", "p/model"],
      });
  });
});

const decodeDocument = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.MutableJson));

const document = (value?: {
  readonly [key: string]: ConfigDocumentValue;
}): Schema.MutableJsonObject => {
  const root = { version: 6, ...value };
  if (!("profiles" in root) || root.profiles === undefined) return decodeDocument(root);
  const { profiles, ...rest } = root;
  return decodeDocument({
    ...rest,
    defaultProfileSet: "default",
    profileSets: { default: { profiles } },
  });
};

const candidate = (value: Partial<ProfileCandidate> = {}) =>
  profileCandidate("parent", { effort: "default", ...value });
const invalidRoutes = (decoded: DecodedSubagentConfig) =>
  decoded.invalidProfileSetRoutes.default ?? [];

const unexpectedStoreCall = () =>
  Effect.die(new Error("Profile service tests only load configuration."));

const loadedConfigStore = (config: ResolvedSubagentConfig): SubagentConfigStoreContract => {
  return {
    load: () => Effect.succeed(config),
    inspect: unexpectedStoreCall,
    patchProfile: unexpectedStoreCall,
    restoreProfileDeclaration: unexpectedStoreCall,
    patchDefaultProfileSet: unexpectedStoreCall,
    createProfileSetFromSnapshot: unexpectedStoreCall,
    copyProfileSet: unexpectedStoreCall,
    renameProfileSet: unexpectedStoreCall,
    deleteProfileSet: unexpectedStoreCall,
    patchWriterWorkspace: unexpectedStoreCall,
    patchNesting: unexpectedStoreCall,
    patchDelegation: unexpectedStoreCall,
  };
};

const captureLoaded = (
  config: ResolvedSubagentConfig,
  options: Partial<SubagentProfileLayerOptions> = {},
  telemetry: Layer.Layer<never> = Layer.empty,
) =>
  SubagentProfileService.use((service) => service.capture).pipe(
    provideBuiltLayer(
      subagentProfileServiceLayer({
        cwd: "/repo",
        agentDirectory: "/agent",
        projectTrusted: true,
        ...options,
      }).pipe(
        Layer.provide(
          Layer.merge(
            Layer.succeed(SubagentConfigStore, SubagentConfigStore.of(loadedConfigStore(config))),
            telemetry,
          ),
        ),
      ),
    ),
  );

const environment = {
  availablePiModels: [
    { provider: "openai", id: "gpt-parent", supportedEfforts: ["off", "low", "high"] as const },
    { provider: "openai", id: "gpt-review", supportedEfforts: ["off", "medium", "high"] as const },
  ],
  parentModel: { model: "openai/gpt-parent", effort: "high" as const },
  forkAvailable: true,
};

describe("subagent v6 profile configuration and resolution", () => {
  it("decodes disabled, one candidate, and ordered candidates", () => {
    const scout = candidate();
    const worker = [
      candidate({ model: "openai/gpt-review", effort: "medium", writeIntent: "writer" }),
      candidate({ runtime: "claude", model: "sonnet" }),
    ];
    const global = document({ profiles: { scout, worker, reviewer: "disabled" } });
    const decoded = subagentConfigDecoder("global")(global);
    expect(invalidRoutes(decoded)).toEqual([]);
    expect(decoded.file.profileSets?.default?.profiles).toEqual({
      scout,
      worker,
      reviewer: "disabled",
    });
    const config = resolveTestConfig(global);
    expect(config.profiles.scout.candidates).toEqual([
      profileCandidate("parent", { effort: "default" }),
    ]);
  });

  it("bounds and redacts named profile sets and fails invalid defaults closed", () => {
    const secretName = "bad/secret-name";
    const names = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`set-${index}`, { profiles: {} }]),
    );
    const tooMany = decodeSubagentConfig({
      version: 6,
      defaultProfileSet: "set-0",
      profileSets: names,
    });
    expect(tooMany.diagnostics).toContain("config.profileSets[32+]");
    expect(tooMany.invalidDefaultProfileSet).toBe(true);

    const redacted = decodeSubagentConfig({
      version: 6,
      defaultProfileSet: "missing",
      profileSets: {
        [secretName]: { profiles: {} },
        repairable: { profiles: {}, extra: true },
      },
    });
    expect(redacted.invalidDefaultProfileSet).toBe(true);
    expect(redacted.diagnostics.join(" ")).not.toContain(secretName);
    expect(redacted.diagnostics).toEqual(
      expect.arrayContaining([
        "config.profileSets[0].name",
        "config.profileSets[1]",
        "config.defaultProfileSet",
      ]),
    );
  });

  it("layers partial selected sets route by route across project, global, and built-ins", () => {
    const global = document({
      defaultProfileSet: "selected",
      profileSets: {
        ignored: { profiles: { scout: "disabled" } },
        selected: {
          profiles: {
            reviewer: candidate({ model: "openai/global-reviewer" }),
            worker: "disabled",
          },
        },
      },
    });
    const project = document({
      defaultProfileSet: "project",
      profileSets: {
        project: { profiles: { reviewer: candidate({ model: "openai/project-reviewer" }) } },
      },
    });
    const config = resolveTestConfig(global, project);
    expect(config.profiles.reviewer.candidates[0]?.model).toBe("openai/project-reviewer");
    expect(config.profileSources.reviewer).toBe("project");
    expect(config.profiles.worker.candidates).toEqual([]);
    expect(config.profileSources.worker).toBe("global");
    expect(config.profiles.scout.candidates).toHaveLength(1);
    expect(config.profileSources.scout).toBe("builtin");
  });

  it.each([
    ["claude", "claude-opus-5", true],
    ["claude", "-dangerous-option", false],
    ["claude", "bad\u001bmodel", false],
    ["codex", "model,(glob)*", false],
  ] as const)("classifies %s native selector case %#", (runtime, selector, valid) => {
    expect(isNativeProfileModelSelector(runtime, selector)).toBe(valid);
  });

  it("rejects unknown candidate keys and forbidden cross-field combinations as whole routes", () => {
    const decoded = subagentConfigDecoder("global")(
      document({
        profiles: {
          scout: { ...candidate(), execution: "background" },
          researcher: { ...candidate(), host: "local" },
          planner: candidate({ runtime: "claude", model: "sonnet", context: "fork" }),
          worker: { ...candidate({ writeIntent: "writer" }), closeOnReport: true },
        },
      }),
    );
    expect(invalidRoutes(decoded)).toEqual(["scout", "researcher", "planner", "worker"]);
    expect(decoded.diagnostics).toEqual(
      expect.arrayContaining([
        "global.profileSets[0].profiles.scout",
        "global.profileSets[0].profiles.researcher",
        "global.profileSets[0].profiles.planner",
        "global.profileSets[0].profiles.worker",
      ]),
    );
  });

  it("inherits missing project routes, uses builtins for missing global routes, and fails invalid present routes closed", () => {
    const global = document({
      profiles: {
        worker: [
          candidate({ model: "openai/gpt-review", effort: "medium", writeIntent: "writer" }),
          candidate({ writeIntent: "writer" }),
        ],
      },
    });
    const inherited = resolveTestConfig(global, document());
    expect(inherited.profiles.worker.candidates).toHaveLength(2);
    expect(inherited.profileSources.worker).toBe("global");
    expect(inherited.profileSources.scout).toBe("builtin");
    const invalid = resolveTestConfig(global, document({ profiles: { worker: null } }));
    expect(invalid.profiles.worker).toEqual({ candidates: [] });
    expect(invalid.profileSources.worker).toBe("project-invalid");
    const untrusted = resolveTestConfig(
      global,
      document({ profiles: { worker: "disabled" } }),
      false,
    );
    expect(untrusted.profiles.worker.candidates).toHaveLength(2);
  });

  it("moves soft efforts to the nearest level the runtime and model support", () => {
    const routed = (runtime: "claude" | "codex", parentEffort: "off" | "minimal" | "max") =>
      resolveProfilePlan(
        "generalist",
        resolveTestConfig(
          document({
            profiles: {
              generalist: candidate({
                runtime,
                model: runtime === "claude" ? "sonnet" : "gpt-5.4",
              }),
            },
          }),
        ),
        { ...environment, parentModel: { model: "openai/gpt-parent", effort: parentEffort } },
      );
    expect(routed("claude", "off")).toMatchObject({
      attempts: [{ effort: "low", effortWasExplicit: false }],
    });
    expect(routed("claude", "minimal")).toMatchObject({ attempts: [{ effort: "low" }] });
    expect(routed("codex", "off")).toMatchObject({ attempts: [{ effort: "minimal" }] });
    expect(routed("codex", "max")).toMatchObject({ attempts: [{ effort: "max" }] });
    const planner = resolveTestConfig(
      document({ profiles: { planner: candidate({ model: "openai/gpt-review" }) } }),
    );
    expect(resolveProfilePlan("planner", planner, environment)).toMatchObject({
      attempts: [{ effort: "high", effortWasExplicit: false }],
    });
  });

  it("requires stable fork context for local Pi and never degrades to fresh", () => {
    expect(resolveProfilePlan("oracle", resolveTestConfig(document()), environment)).toMatchObject({
      kind: "resolved",
      attempts: [{ effectiveContext: "fork" }],
    });
    expect(
      resolveProfilePlan("oracle", resolveTestConfig(document()), {
        ...environment,
        forkAvailable: false,
      }),
    ).toMatchObject({
      kind: "failed",
      code: "fork_context_unavailable",
      skippedCandidates: [{ code: "fork_context_unavailable" }],
    });
  });

  it("accepts version 6 while rejecting other declared versions", () => {
    expect(subagentConfigDecoder("global")({ version: 6 }).unsupportedVersion).toBe(false);
    const v3 = subagentConfigDecoder("global")({ version: 3, denied: [] });
    expect(v3).toMatchObject({ unsupportedVersion: true });
    expect(v3.diagnostics).toEqual(expect.arrayContaining(["global.version", "global.<unknown>"]));
    for (const version of [1, 2, 4, 5, "6", null, false, 6.5])
      expect(subagentConfigDecoder("global")({ version }).unsupportedVersion).toBe(true);
  });

  it.effect("activates loaded base configuration when publication throws", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const snapshot = yield* captureLoaded(
        resolveTestConfig(
          document({ profiles: { reviewer: candidate({ model: "openai/base-after-throw" }) } }),
        ),
        {
          publishSessionBaseConfig: () => {
            attempts += 1;
            throw new Error("hostile base publication");
          },
        },
      );
      expect(attempts).toBe(1);
      expect(snapshot.effectiveConfig.profiles.reviewer.candidates[0]?.model).toBe(
        "openai/base-after-throw",
      );
    }),
  );

  it.effect("logs only path-safe diagnostics from loaded configuration", () =>
    Effect.gen(function* () {
      const captured = makeCapturedLogger();
      const config = resolveTestConfig(document({ denied: "secret-policy-value" }));
      const snapshot = yield* captureLoaded(config, {}, captured.layer);
      expect(snapshot.effectiveConfig.diagnostics).toContain("global.<unknown>");
      expect(capturedTelemetrySnapshot(captured)).toContain("global.<unknown>");
      expect(capturedTelemetrySnapshot(captured)).not.toContain("secret-policy-value");
    }),
  );
});
