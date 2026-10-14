import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { provideBuiltLayer } from "pi-cosmic-core";
import { capturedTelemetrySnapshot, makeCapturedLogger } from "pi-cosmic-core/testing";
import { resolveNamedProfileSet, type ResolvedSubagentConfig } from "../src/config/options.ts";
import {
  decodeProfileCandidate,
  decodeSubagentConfig,
  subagentConfigDecoder,
  type DecodedSubagentConfig,
} from "../src/config/schema.ts";
import { SubagentConfigStore, type SubagentConfigStoreContract } from "../src/config/store.ts";
import { resolvePiModelSelector } from "../src/run/model-catalog.ts";
import { PROFILE_DEFINITIONS } from "../src/profiles/definitions.ts";
import {
  isLocalPiProfileCandidate,
  isNativeProfileModelSelector,
  normalizeProfileCandidate,
  PROFILE_CANDIDATE_VALIDATION_ISSUE_CODES,
  PROFILE_IDS,
  profileCandidateValidationIssues,
  sameProfileCandidate,
  type ProfileCandidate,
} from "../src/profiles/model.ts";
import { resolveProfileContinuationPlan, resolveProfilePlan } from "../src/profiles/resolve.ts";
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
  it("does not hide duplicate catalog entries", () => {
    for (const selector of ["Model", "p/Model"])
      expect(resolvePiModelSelector(selector, [catalog[0]!, catalog[0]!])).toEqual({
        kind: "ambiguous",
        candidates: ["p/Model", "p/Model"],
      });
  });
  it("returns bounded sorted near matches without resolving a substring", () => {
    const models = Array.from({ length: 10 }, (_, index) => ({
      provider: "p",
      id: `model-${9 - index}`,
    }));
    expect(resolvePiModelSelector("model", models)).toEqual({
      kind: "unknown",
      nearMatches: models
        .map(({ provider, id }) => `${provider}/${id}`)
        .toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0))
        .slice(0, 6),
    });
    expect(resolvePiModelSelector("unrelated", models)).toEqual({
      kind: "unknown",
      nearMatches: [],
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

const rawDocument = <Profiles>(profiles: Profiles) => ({
  version: 6,
  defaultProfileSet: "default",
  profileSets: { default: { profiles } },
});

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

const forkedPi = (id: string) => ({
  host: "local",
  runtime: "pi",
  model: `openai/${id}`,
  effort: "default",
  context: "fork",
  writeIntent: "read-only",
});

describe("subagent v6 profile configuration and resolution", () => {
  it("skips a forked Pi candidate whose window can't hold the inherited conversation", () => {
    const config = resolveTestConfig(
      document({
        profileSets: {
          main: { profiles: { oracle: [forkedPi("gpt-small"), forkedPi("gpt-large")] } },
        },
        defaultProfileSet: "main",
      }),
    );
    const forkEnvironment = {
      ...environment,
      availablePiModels: [
        { provider: "openai", id: "gpt-small", contextWindow: 128_000 },
        { provider: "openai", id: "gpt-large", contextWindow: 1_000_000 },
      ],
      parentContextTokens: 150_000,
    };
    expect(resolveProfilePlan("oracle", config, forkEnvironment)).toMatchObject({
      kind: "resolved",
      attempts: [{ model: "openai/gpt-large" }],
      skippedCandidates: [{ code: "fork_context_too_large" }],
    });
  });
  it("requires local host and close-after-report in candidate decoding", () => {
    for (const runtime of ["pi", "claude", "codex"] as const) {
      const input = {
        host: "local",
        runtime,
        model: runtime === "pi" ? "openai/local" : "native",
        effort: "default",
        context: "fresh",
        writeIntent: "read-only",
      };
      expect(decodeProfileCandidate(input)).toMatchObject({
        host: "local",
        closeOnReport: true,
      });
      expect(decodeProfileCandidate({ ...input, closeOnReport: true })).toBeDefined();
      expect(decodeProfileCandidate({ ...input, closeOnReport: false })).toBeUndefined();
      expect(decodeProfileCandidate({ ...input, host: "herdr" })).toBeUndefined();
      const { host: _host, ...missingHost } = input;
      expect(decodeProfileCandidate(missingHost)).toBeUndefined();
    }
  });

  it("ships seven explicit local Pi parent routes preserving profile defaults", () => {
    const config = resolveTestConfig(document());
    for (const id of PROFILE_IDS) {
      expect(config.profiles[id]).toEqual({
        candidates: [
          {
            host: "local",
            runtime: "pi",
            model: "parent",
            effort: "default",
            context: PROFILE_DEFINITIONS[id].defaultContext,
            writeIntent: PROFILE_DEFINITIONS[id].defaultWriteIntent,
            closeOnReport: true,
          },
        ],
      });
      expect(config.profileSources[id]).toBe("builtin");
    }
    expect(config.fallbackProfile).toBe("generalist");
    const explicitFalse = normalizeProfileCandidate(candidate());
    const { openaiFastMode: _omitted, ...withoutFastMode } = explicitFalse;
    expect(sameProfileCandidate(explicitFalse, normalizeProfileCandidate(withoutFastMode))).toBe(
      true,
    );
  });

  it("rejects removed configuration fields and profile aliases", () => {
    const removedField = subagentConfigDecoder("global")(
      document({ defaultProfile: "generalist", denied: [], discouraged: [], execution: "x" }),
    );
    expect(removedField.diagnostics).toContain("global.<unknown>");
    expect(removedField.file).toEqual({ version: 6 });

    const removedAlias = subagentConfigDecoder("global")(
      document({ profiles: { delegate: candidate() } }),
    );
    expect(removedAlias.diagnostics).toContain("global.profileSets[0].profiles.<unknown>");
    expect(removedAlias.file.profileSets?.default?.profiles?.generalist).toBeUndefined();
  });

  it("decodes disabled, one candidate, and ordered candidates with closeOnReport defaulting true", () => {
    const decoded = subagentConfigDecoder("global")(
      document({
        profiles: {
          scout: candidate(),
          worker: [
            candidate({ model: "openai/gpt-review", effort: "medium", writeIntent: "writer" }),
            candidate({ runtime: "claude", model: "sonnet", closeOnReport: true }),
          ],
          reviewer: "disabled",
        },
      }),
    );
    expect(invalidRoutes(decoded)).toEqual([]);
    expect(decoded.file.profileSets?.default?.profiles?.scout).toMatchObject({
      closeOnReport: true,
    });
    expect(decoded.file.profileSets?.default?.profiles?.worker).toEqual([
      candidate({
        model: "openai/gpt-review",
        effort: "medium",
        writeIntent: "writer",
        closeOnReport: true,
      }),
      candidate({ runtime: "claude", model: "sonnet", closeOnReport: true }),
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

  it("fails a malformed profiles container closed as its invalid default set", () => {
    for (const profiles of [[], null, "broken"]) {
      const config = resolveTestConfig(rawDocument(profiles));
      expect(config.currentProfileSet).toEqual({ scope: "global", name: "default", invalid: true });
      expect(PROFILE_IDS.map((id) => config.profileSources[id])).toEqual(
        PROFILE_IDS.map(() => "global-invalid"),
      );
      expect(config.diagnostics).toEqual([
        "global.profileSets[0].profiles",
        "global.defaultProfileSet",
      ]);
    }
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

  it("resolves named global and project sets with explicit invalid selection states", () => {
    const global = subagentConfigDecoder("global")(
      document({
        defaultProfileSet: "selected",
        profileSets: {
          selected: { profiles: { reviewer: candidate({ model: "openai/global-default" }) } },
          saved: { profiles: { scout: candidate({ model: "openai/global-saved" }) } },
          invalidRoute: { profiles: { worker: null } },
          broken: { profiles: {}, extra: true },
        },
      }),
    );
    const project = subagentConfigDecoder("project")(
      document({
        profileSets: {
          saved: { profiles: { scout: candidate({ model: "openai/project-saved" }) } },
        },
      }),
    );

    const namedGlobal = resolveNamedProfileSet({ scope: "global", name: "saved", global });
    expect(namedGlobal).toMatchObject({
      status: "resolved",
      origin: { scope: "global", name: "saved" },
      invalidProfiles: [],
    });
    expect(namedGlobal.profiles.scout.candidates[0]?.model).toBe("openai/global-saved");
    expect(namedGlobal.profileSources.reviewer).toBe("builtin");

    const namedProject = resolveNamedProfileSet({
      scope: "project",
      name: "saved",
      global,
      project,
    });
    expect(namedProject.status).toBe("resolved");
    expect(namedProject.profiles.scout.candidates[0]?.model).toBe("openai/project-saved");
    expect(namedProject.profiles.reviewer.candidates[0]?.model).toBe("openai/global-default");
    expect(namedProject.profileSources.reviewer).toBe("global");

    const invalidRoute = resolveNamedProfileSet({
      scope: "global",
      name: "invalidRoute",
      global,
    });
    expect(invalidRoute.status).toBe("invalid-routes");
    expect(invalidRoute.invalidProfiles).toEqual(["worker"]);
    expect(invalidRoute.profileSources.worker).toBe("global-invalid");
    expect(resolveNamedProfileSet({ scope: "global", name: "broken", global }).status).toBe(
      "structurally-invalid",
    );
    expect(resolveNamedProfileSet({ scope: "global", name: "missing", global }).status).toBe(
      "missing",
    );
  });

  it.each([
    ["pi", "openai/future-model", true],
    ["pi", "openai-codex/future-model", true],
    ["pi", "parent", true],
    ["pi", "other-provider/not-priority", false],
    ["codex", "future-codex", true],
    ["codex", "-option", false],
    ["claude", "sonnet", false],
  ] as const)(
    "accepts a persisted %s %s fast route only when eligible (%s)",
    (runtime, model, eligible) => {
      const decoded = decodeSubagentConfig(
        document({ profiles: { generalist: candidate({ runtime, model, openaiFastMode: true }) } }),
      );
      expect(decoded.file.profileSets?.default?.profiles?.generalist).toEqual(
        eligible ? expect.objectContaining({ openaiFastMode: true }) : undefined,
      );
      expect(invalidRoutes(decoded)).toEqual(eligible ? [] : ["generalist"]);
    },
  );

  it("owns ordered issues and requires closure for readers and writers", () => {
    const issues = profileCandidateValidationIssues(
      normalizeProfileCandidate(
        candidate({
          runtime: "claude",
          model: "parent",
          effort: "minimal",
          context: "fork",
          writeIntent: "writer",
          openaiFastMode: true,
          closeOnReport: false,
        }),
      ),
    );
    expect(issues.map((issue) => issue.code)).toEqual(PROFILE_CANDIDATE_VALIDATION_ISSUE_CODES);

    const localPi = normalizeProfileCandidate(candidate({ context: "fork" }));
    expect(isLocalPiProfileCandidate(localPi)).toBe(true);
    expect(profileCandidateValidationIssues(localPi)).toEqual([]);
  });

  it.each([
    ["pi", "openai/gpt-5", true],
    ["pi", "parent", true],
    ["pi", "cursor/gpt-5.5@1m", true],
    ["pi", "cursor/gpt-5.5@272k:fast", true],
    ["pi", "cursor@team/gpt-5.5@1m", true],
    ["pi", "cursor/@1m", false],
    ["pi", "bare", false],
    ["claude", "claude-opus-5", true],
    ["claude", "opus[1m]", true],
    ["claude", "claude-fable-5[200k]", true],
    ["claude", "model[abc]", false],
    ["claude", "-dangerous-option", false],
    ["claude", "model,other", false],
    ["claude", " model ", false],
    ["claude", "bad\u001bmodel", false],
    ["claude", "x".repeat(257), false],
    ["codex", "gpt-5.4", true],
    ["codex", "gpt-5.6-codex", true],
    ["codex", "-dangerous-option", false],
    ["codex", "model/(glob)", false],
    ["codex", "model,(glob)*", false],
  ] as const)("classifies %s native selector case %#", (runtime, selector, valid) => {
    expect(isNativeProfileModelSelector(runtime, selector)).toBe(valid);
  });

  it("rejects unknown candidate keys and forbidden cross-field combinations as whole routes", () => {
    const decoded = subagentConfigDecoder("global")(
      document({
        profiles: {
          scout: { ...candidate(), execution: "background" },
          researcher: { ...candidate(), host: "herdr" },
          planner: candidate({ runtime: "claude", model: "sonnet", context: "fork" }),
          worker: candidate({ closeOnReport: false, writeIntent: "writer" }),
          reviewer: candidate({ closeOnReport: false }),
        },
      }),
    );
    expect(invalidRoutes(decoded)).toEqual([
      "scout",
      "researcher",
      "planner",
      "worker",
      "reviewer",
    ]);
    expect(decoded.diagnostics).toEqual(
      expect.arrayContaining([
        "global.profileSets[0].profiles.scout",
        "global.profileSets[0].profiles.researcher",
        "global.profileSets[0].profiles.planner",
        "global.profileSets[0].profiles.worker",
        "global.profileSets[0].profiles.reviewer",
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

  it("plans local runtimes without claiming adapter availability", () => {
    const config = resolveTestConfig(
      document({
        profiles: {
          reviewer: [
            candidate({ host: "local", runtime: "claude", model: "sonnet" }),
            candidate({ runtime: "codex", model: "gpt-5.4" }),
            candidate({ model: "openai/gpt-review", effort: "medium" }),
          ],
        },
      }),
    );
    expect(resolveProfilePlan("reviewer", config, environment)).toMatchObject({
      kind: "resolved",
      attempts: [
        { candidateIndex: 0, host: "local", runtime: "claude", model: "sonnet" },
        { candidateIndex: 1, host: "local", runtime: "codex", model: "gpt-5.4" },
        { candidateIndex: 2, host: "local", runtime: "pi", model: "openai/gpt-review" },
      ],
    });
  });

  it("continues a frozen route strictly after the failed candidate and preserves original indexes", () => {
    const config = resolveTestConfig(
      document({
        profiles: {
          reviewer: [
            candidate(),
            candidate({ model: "openai/missing" }),
            candidate({ model: "openai/gpt-review", effort: "medium" }),
          ],
        },
      }),
    );
    const continuation = {
      profile: "reviewer" as const,
      routeSource: config.profileSources.reviewer,
      candidates: config.profiles.reviewer.candidates,
      selectedCandidateIndex: 0,
      skippedCandidates: [],
    };
    expect(resolveProfileContinuationPlan(continuation, environment)).toMatchObject({
      kind: "resolved",
      attempts: [
        {
          candidateIndex: 2,
          model: "openai/gpt-review",
          skippedBefore: [{ candidateIndex: 1, code: "pi_model_unknown" }],
        },
      ],
    });
    expect(
      resolveProfileContinuationPlan(continuation, {
        ...environment,
        availablePiModels: environment.availablePiModels.slice(0, 1),
      }),
    ).toMatchObject({
      kind: "failed",
      code: "retry_route_exhausted",
      skippedCandidates: [
        { candidateIndex: 1, code: "pi_model_unknown" },
        { candidateIndex: 2, code: "pi_model_unknown" },
      ],
    });
  });

  it("uses default effort softly and concrete candidate effort hard", () => {
    expect(resolveProfilePlan("scout", resolveTestConfig(document()), environment)).toMatchObject({
      kind: "resolved",
      attempts: [{ effort: "low", effortWasExplicit: false }],
    });
    const config = resolveTestConfig(
      document({
        profiles: {
          worker: candidate({ model: "openai/gpt-review", effort: "high", writeIntent: "writer" }),
        },
      }),
    );
    expect(resolveProfilePlan("worker", config, environment)).toMatchObject({
      kind: "resolved",
      attempts: [{ effort: "high", effortWasExplicit: true, writeIntent: "writer" }],
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

  it("pairs parent and explicit local-Pi model resolution with failure codes", () => {
    const parentRoute = resolveTestConfig(
      document({ profiles: { scout: candidate({ model: "parent" }) } }),
    );
    expect(resolveProfilePlan("scout", parentRoute, environment)).toMatchObject({
      kind: "resolved",
      attempts: [{ source: "profile-parent-candidate", model: "openai/gpt-parent", effort: "low" }],
    });
    expect(
      resolveProfilePlan("scout", parentRoute, { ...environment, parentModel: undefined }),
    ).toMatchObject({
      kind: "failed",
      code: "profile_no_eligible_model",
      skippedCandidates: [{ code: "parent_model_missing" }],
    });
    expect(
      resolveProfilePlan("scout", parentRoute, {
        ...environment,
        parentModel: { model: "openai/gpt", effort: "high" },
      }),
    ).toMatchObject({
      kind: "failed",
      code: "profile_no_eligible_model",
      skippedCandidates: [
        {
          code: "parent_model_unavailable",
        },
      ],
    });
    const ambiguousEnvironment = {
      ...environment,
      availablePiModels: [
        ...environment.availablePiModels,
        { provider: "anthropic", id: "gpt-parent", supportedEfforts: ["high"] as const },
      ],
    };
    expect(
      resolveProfilePlan("scout", parentRoute, {
        ...ambiguousEnvironment,
        parentModel: { model: "gpt-parent", effort: "high" },
      }),
    ).toMatchObject({
      kind: "failed",
      code: "profile_no_eligible_model",
      skippedCandidates: [
        {
          code: "parent_model_ambiguous",
        },
      ],
    });

    const explicitRoute = resolveTestConfig(
      document({ profiles: { scout: candidate({ model: "openai/gpt" }) } }),
    );
    expect(resolveProfilePlan("scout", explicitRoute, environment)).toMatchObject({
      kind: "failed",
      code: "profile_no_eligible_model",
      skippedCandidates: [
        {
          code: "pi_model_unknown",
        },
      ],
    });
  });

  it("rejects persisted candidate getters without invoking them and guards hostile proxies", () => {
    let candidateReads = 0;
    let unknownRead = false;
    const accessorCandidate = { ...candidate() };
    Object.defineProperty(accessorCandidate, "model", {
      enumerable: true,
      get: () => {
        candidateReads += 1;
        return "parent";
      },
    });
    const getterDecoded = subagentConfigDecoder("project")(
      rawDocument({ worker: accessorCandidate }),
    );
    expect(invalidRoutes(getterDecoded)).toEqual(["worker"]);
    expect(getterDecoded.diagnostics).toContain("project.profileSets[0].profiles.worker");
    expect(candidateReads).toBe(0);

    const unknownCandidate = { ...candidate() };
    Object.defineProperty(unknownCandidate, "unknown", {
      enumerable: true,
      get: () => {
        unknownRead = true;
        return "private";
      },
    });
    expect(invalidRoutes(decodeSubagentConfig(rawDocument({ scout: unknownCandidate })))).toEqual([
      "scout",
    ]);
    expect(unknownRead).toBe(false);

    const revoked = Proxy.revocable([candidate()], {});
    revoked.revoke();
    const proxyDecoded = subagentConfigDecoder("global")(rawDocument({ reviewer: revoked.proxy }));
    expect(invalidRoutes(proxyDecoded)).toEqual(["reviewer"]);
    expect(proxyDecoded.diagnostics).toContain("global.profileSets[0].profiles.reviewer");
  });

  it("bounds route arrays before traversal", () => {
    let accesses = 0;
    const candidates: unknown[] = [];
    candidates.length = 10_000;
    Object.defineProperty(candidates, 0, {
      get: () => {
        accesses += 1;
        return candidate();
      },
    });
    const decoded = subagentConfigDecoder("global")(rawDocument({ worker: candidates }));
    expect(accesses).toBe(0);
    expect(invalidRoutes(decoded)).toEqual(["worker"]);
    expect(decoded.diagnostics).toContain("global.profileSets[0].profiles.worker[32+]");
  });

  it("accepts version 6 while rejecting other declared versions", () => {
    expect(subagentConfigDecoder("global")({ version: 6 }).unsupportedVersion).toBe(false);
    const v3 = subagentConfigDecoder("global")({ version: 3, denied: [] });
    expect(v3).toMatchObject({ unsupportedVersion: true });
    expect(v3.diagnostics).toEqual(expect.arrayContaining(["global.version", "global.<unknown>"]));
    for (const version of [1, 2, 4, 5, "6", null, false, 6.5])
      expect(subagentConfigDecoder("global")({ version }).unsupportedVersion).toBe(true);
  });

  it("reads candidate optional fields descriptor-safely without invoking accessors", () => {
    for (const [input, field, value] of [
      [candidate({ model: "openai-codex/gpt-5.6-sol" }), "openaiFastMode", true],
      [candidate(), "closeOnReport", false],
    ] as const) {
      let reads = 0;
      Object.defineProperty(input, field, {
        enumerable: true,
        get: () => {
          reads += 1;
          return value;
        },
      });
      expect(decodeProfileCandidate(input)).toBeUndefined();
      expect(reads).toBe(0);
    }

    const requiredOnly = {
      host: "local",
      runtime: "pi",
      model: "parent",
      effort: "default",
      context: "fresh",
      writeIntent: "read-only",
    } as const;
    expect(decodeProfileCandidate(requiredOnly)).toMatchObject({ closeOnReport: true });
    expect(decodeProfileCandidate(requiredOnly)).not.toHaveProperty("openaiFastMode");
  });

  it("validates root bodies strictly", () => {
    const nesting = { maxDirectChildren: 2, maxDepth: 1 };

    const rootProfiles = subagentConfigDecoder("global")({
      version: 6,
      profiles: { worker: candidate() },
    });
    expect(rootProfiles.unsupportedVersion).toBe(false);
    expect(rootProfiles.diagnostics).toContain("global.<unknown>");
    expect(rootProfiles.file.profileSets).toBeUndefined();
    expect(invalidRoutes(rootProfiles)).toEqual([]);

    const v6Current = subagentConfigDecoder("global")({
      version: 6,
      defaultProfileSet: "default",
      profileSets: { default: { profiles: { worker: candidate() } } },
      nesting,
    });
    expect(v6Current.diagnostics).not.toContain("global.<unknown>");
    expect(v6Current.file.nesting).toMatchObject(nesting);
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
