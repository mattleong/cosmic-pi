// Promise assertions are test-runner boundaries.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { provideBuiltLayer } from "pi-cosmic-core";
import { makeCapturedLogger } from "pi-cosmic-core/testing";
import { describe, expect, it } from "vitest";
import { resolveSubagentConfig } from "../src/config/options.ts";
import { decodeSubagentConfig, SUBAGENT_CONFIG_VERSION } from "../src/config/schema.ts";
import { SubagentConfigStore } from "../src/config/store.ts";
import { PROFILE_DEFINITIONS } from "../src/profiles/definitions.ts";
import {
  isLocalPiProfileCandidate,
  isNativeProfileModelSelector,
  isRetainableProfileCandidate,
  normalizeProfileCandidate,
  PROFILE_CANDIDATE_VALIDATION_ISSUE_CODES,
  PROFILE_IDS,
  profileCandidateValidationIssues,
  sameProfileCandidate,
  type DeclaredProfileCandidate,
} from "../src/profiles/model.ts";
import { resolveProfileContinuationPlan, resolveProfilePlan } from "../src/profiles/resolve.ts";
import { SubagentProfileService, subagentProfileServiceLayer } from "../src/profiles/service.ts";

const document = <Value extends object>(value?: Value): Schema.MutableJsonObject => {
  // SAFETY: Call sites provide JSON-shaped test fixtures; the schema below owns their decode.
  const input = (value ?? {}) as Value & { readonly profiles?: Schema.MutableJson };
  const { profiles, ...rest } = input;
  return Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.MutableJson))({
    version: 6,
    ...rest,
    ...(profiles !== undefined && {
      defaultProfileSet: "default",
      profileSets: { default: { profiles } },
    }),
  });
};

const hostileDocument = <Value extends object>(value: Value): Value & Schema.MutableJsonObject => {
  // SAFETY: This fixture deliberately exercises the config decoder with non-JSON hostile input.
  return value as Value & Schema.MutableJsonObject;
};
const candidate = (value: Partial<DeclaredProfileCandidate> = {}): DeclaredProfileCandidate => ({
  host: "local",
  runtime: "pi",
  model: "parent",
  effort: "default",
  context: "fresh",
  writeIntent: "read-only",
  openaiFastMode: false,
  ...value,
});

const legacyCandidate = (value: Partial<DeclaredProfileCandidate> = {}) => {
  const current = candidate(value);
  const { openaiFastMode, ...base } = current;
  return {
    ...base,
    ...(openaiFastMode !== undefined && { fastMode: openaiFastMode }),
  };
};
const resolved = <Project>(global = document(), project?: Project, projectTrusted = true) =>
  resolveSubagentConfig(
    (() => {
      const baseResult = {
        globalConfigPath: "/agent/pi-subagents.json",
        projectConfigPath: "/repo/.pi/pi-subagents.json",
        projectTrusted,
        globalConfigExists: true,
        projectConfigExists: project !== undefined,
        global: decodeSubagentConfig(global, "global"),
      };
      const withProject =
        project === undefined
          ? baseResult
          : { ...baseResult, project: decodeSubagentConfig(project, "project") };
      return withProject;
    })(),
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
  it("ships seven explicit local Pi parent routes preserving profile defaults", () => {
    expect(SUBAGENT_CONFIG_VERSION).toBe(6);
    expect(PROFILE_IDS).toHaveLength(7);
    const config = resolved();
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
    const removedField = decodeSubagentConfig(document({ defaultProfile: "generalist" }), "global");
    expect(removedField.diagnostics).toContain("global.<unknown>");

    const removedAlias = decodeSubagentConfig(
      document({ profiles: { delegate: candidate() } }),
      "global",
    );
    expect(removedAlias.diagnostics).toContain("global.profileSets[0].profiles.<unknown>");
    expect(removedAlias.file.profileSets?.default?.profiles?.generalist).toBeUndefined();
  });

  it("decodes disabled, one candidate, and ordered candidates with closeOnReport defaulting true", () => {
    const decoded = decodeSubagentConfig(
      document({
        profiles: {
          scout: candidate(),
          worker: [
            candidate({ model: "openai/gpt-review", effort: "medium", writeIntent: "writer" }),
            candidate({ host: "herdr", runtime: "claude", model: "sonnet", closeOnReport: false }),
          ],
          reviewer: "disabled",
        },
      }),
      "global",
    );
    expect(decoded.invalidProfileRoutes).toEqual([]);
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
      candidate({ host: "herdr", runtime: "claude", model: "sonnet", closeOnReport: false }),
    ]);
  });

  it("decodes fast mode by declared version without accepting cross-version keys", () => {
    for (const version of [4, 5] as const) {
      const legacy = decodeSubagentConfig({
        version,
        profiles: {
          generalist: legacyCandidate({
            model: "openai-codex/gpt-5.6-sol",
            openaiFastMode: true,
          }),
        },
      });
      expect(legacy.file.profileSets?.default?.profiles.generalist).toMatchObject({
        openaiFastMode: true,
      });
      expect(
        decodeSubagentConfig({
          version,
          profiles: {
            generalist: candidate({
              model: "openai-codex/gpt-5.6-sol",
              openaiFastMode: true,
            }),
          },
        }).invalidProfileRoutes,
      ).toEqual(["generalist"]);
    }
    const currentRejectsLegacy = decodeSubagentConfig({
      version: 6,
      defaultProfileSet: "default",
      profileSets: {
        default: {
          profiles: {
            generalist: legacyCandidate({
              model: "openai-codex/gpt-5.6-sol",
              openaiFastMode: true,
            }),
          },
        },
      },
    });
    expect(currentRejectsLegacy.invalidProfileRoutes).toEqual(["generalist"]);
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

    const config = resolved(
      document({
        defaultProfileSet: "missing",
        profileSets: { valid: { profiles: {} } },
      }),
    );
    expect(config.currentProfileSet).toEqual({
      scope: "global",
      name: "missing",
      invalid: true,
    });
    expect(PROFILE_IDS.map((id) => config.profileSources[id])).toEqual(
      PROFILE_IDS.map(() => "global-invalid"),
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
    const config = resolved(global, project);
    expect(config.profiles.reviewer.candidates[0]?.model).toBe("openai/project-reviewer");
    expect(config.profileSources.reviewer).toBe("project");
    expect(config.profiles.worker.candidates).toEqual([]);
    expect(config.profileSources.worker).toBe("global");
    expect(config.profiles.scout.candidates).toHaveLength(1);
    expect(config.profileSources.scout).toBe("builtin");
  });

  it("defaults fast mode off and accepts only eligible persisted fast routes", () => {
    const supportedPi = decodeSubagentConfig(
      document({
        profiles: {
          generalist: candidate({ model: "openai-codex/gpt-5.6-sol", openaiFastMode: true }),
        },
      }),
    );
    expect(supportedPi.file.profileSets?.default?.profiles?.generalist).toMatchObject({
      openaiFastMode: true,
    });

    const parent = decodeSubagentConfig(
      document({ profiles: { generalist: candidate({ model: "parent", openaiFastMode: true }) } }),
    );
    expect(parent.file.profileSets?.default?.profiles?.generalist).toMatchObject({
      openaiFastMode: true,
    });

    const unsupportedPi = decodeSubagentConfig(
      document({
        profiles: {
          generalist: candidate({ model: "other-provider/not-priority", openaiFastMode: true }),
        },
      }),
    );
    expect(unsupportedPi.file.profileSets?.default?.profiles?.generalist).toBeUndefined();
    expect(unsupportedPi.invalidProfileRoutes).toEqual(["generalist"]);

    const futureCodex = decodeSubagentConfig(
      document({
        profiles: {
          generalist: candidate({ runtime: "codex", model: "future-codex", openaiFastMode: true }),
        },
      }),
    );
    expect(futureCodex.file.profileSets?.default?.profiles?.generalist).toMatchObject({
      openaiFastMode: true,
    });

    const unsafeCodex = decodeSubagentConfig(
      document({
        profiles: {
          generalist: candidate({ runtime: "codex", model: "-option", openaiFastMode: true }),
        },
      }),
    );
    expect(unsafeCodex.file.profileSets?.default?.profiles?.generalist).toBeUndefined();

    const unsupportedClaude = decodeSubagentConfig(
      document({
        profiles: {
          generalist: candidate({ runtime: "claude", model: "sonnet", openaiFastMode: true }),
        },
      }),
    );
    expect(unsupportedClaude.file.profileSets?.default?.profiles?.generalist).toBeUndefined();
    expect(unsupportedClaude.invalidProfileRoutes).toEqual(["generalist"]);
  });

  it("owns exhaustive ordered candidate issues and accepts valid local/retained shapes", () => {
    const issues = profileCandidateValidationIssues(
      normalizeProfileCandidate(
        candidate({
          host: "herdr",
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

    const retained = normalizeProfileCandidate(
      candidate({
        host: "herdr",
        runtime: "claude",
        model: "sonnet",
        effort: "high",
        closeOnReport: false,
      }),
    );
    expect(isRetainableProfileCandidate(retained)).toBe(true);
    expect(profileCandidateValidationIssues(retained)).toEqual([]);
  });

  it("accepts every host/runtime name syntactically and bounded native selectors", () => {
    for (const host of ["local", "herdr"] as const)
      for (const runtime of ["pi", "claude", "codex"] as const) {
        const model = runtime === "pi" ? "openai/gpt-5" : `${runtime}-native-model`;
        const decoded = decodeSubagentConfig(
          document({ profiles: { scout: candidate({ host, runtime, model }) } }),
        );
        expect(decoded.invalidProfileRoutes).toEqual([]);
      }
    expect(isNativeProfileModelSelector("pi", "openai/gpt-5")).toBe(true);
    expect(isNativeProfileModelSelector("claude", "claude-opus-5")).toBe(true);
    expect(isNativeProfileModelSelector("codex", "gpt-5.4")).toBe(true);
    expect(isNativeProfileModelSelector("pi", "parent")).toBe(true);
    expect(isNativeProfileModelSelector("pi", "bare")).toBe(false);
    expect(isNativeProfileModelSelector("claude", "-dangerous-option")).toBe(false);
    expect(isNativeProfileModelSelector("codex", "-dangerous-option")).toBe(false);
    expect(isNativeProfileModelSelector("claude", "model,other")).toBe(false);
    expect(isNativeProfileModelSelector("codex", "model/(glob)")).toBe(false);
    expect(isNativeProfileModelSelector("claude", " model ")).toBe(false);
    expect(isNativeProfileModelSelector("claude", "x".repeat(257))).toBe(false);
  });

  it("treats OpenCode Go only as a Pi model-registry provider", () => {
    const providerRoute = decodeSubagentConfig(
      document({
        profiles: {
          generalist: candidate({ runtime: "pi", model: "opencode-go/gpt-5" }),
        },
      }),
    );
    expect(providerRoute.invalidProfileRoutes).toEqual([]);
    expect(providerRoute.file.profileSets?.default?.profiles.generalist).toMatchObject({
      runtime: "pi",
      model: "opencode-go/gpt-5",
    });
    const fakeRuntime = decodeSubagentConfig(
      document({
        profiles: {
          generalist: { ...candidate(), runtime: "opencode-go", model: "gpt-5" },
        },
      }),
    );
    expect(fakeRuntime.invalidProfileRoutes).toEqual(["generalist"]);
  });

  it("fails a present route closed when its native selector violates the shared grammar", () => {
    const decoded = decodeSubagentConfig(
      document({ profiles: { worker: candidate({ runtime: "claude", model: "model,other" }) } }),
      "project",
    );
    expect(decoded.invalidProfileRoutes).toEqual(["worker"]);
    expect(decoded.file.profileSets?.default?.profiles?.worker).toBeUndefined();
    expect(decoded.diagnostics).toContain("project.profileSets[0].profiles.worker");
  });

  it("rejects unknown candidate keys and forbidden cross-field combinations as whole routes", () => {
    const decoded = decodeSubagentConfig(
      document({
        profiles: {
          scout: { ...candidate(), execution: "background" },
          researcher: candidate({ host: "herdr", runtime: "pi", model: "parent" }),
          planner: candidate({ runtime: "claude", model: "sonnet", context: "fork" }),
          worker: candidate({ closeOnReport: false, writeIntent: "writer" }),
          reviewer: candidate({ closeOnReport: false }),
        },
      }),
      "global",
    );
    expect(decoded.invalidProfileRoutes).toEqual([
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

  it("rejects removed policy fields with strict unknown-key diagnostics", () => {
    const decoded = decodeSubagentConfig(
      document({ denied: [], discouraged: [], execution: "background" }),
      "global",
    );
    expect(decoded.file).toEqual({ version: 6 });
    expect(decoded.diagnostics).toContain("global.<unknown>");
    expect(decoded.file).not.toHaveProperty("denied");
    expect(decoded.file).not.toHaveProperty("discouraged");
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
    const inherited = resolved(global, document());
    expect(inherited.profiles.worker.candidates).toHaveLength(2);
    expect(inherited.profileSources.worker).toBe("global");
    expect(inherited.profileSources.scout).toBe("builtin");
    const invalid = resolved(global, document({ profiles: { worker: null } }));
    expect(invalid.profiles.worker).toEqual({ candidates: [] });
    expect(invalid.profileSources.worker).toBe("project-invalid");
    const untrusted = resolved(global, document({ profiles: { worker: "disabled" } }), false);
    expect(untrusted.profiles.worker.candidates).toHaveLength(2);
  });

  it("plans unsupported host/runtime candidates without claiming adapter availability", () => {
    const config = resolved(
      document({
        profiles: {
          reviewer: [
            candidate({ host: "herdr", runtime: "claude", model: "sonnet" }),
            candidate({ runtime: "codex", model: "gpt-5.4" }),
            candidate({ model: "openai/gpt-review", effort: "medium" }),
          ],
        },
      }),
    );
    expect(resolveProfilePlan("reviewer", config, environment)).toMatchObject({
      kind: "resolved",
      attempts: [
        { candidateIndex: 0, host: "herdr", runtime: "claude", model: "sonnet" },
        { candidateIndex: 1, host: "local", runtime: "codex", model: "gpt-5.4" },
        { candidateIndex: 2, host: "local", runtime: "pi", model: "openai/gpt-review" },
      ],
    });
  });

  it("continues a frozen route strictly after the failed candidate and preserves original indexes", () => {
    const config = resolved(
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
    expect(resolveProfilePlan("scout", resolved(), environment)).toMatchObject({
      kind: "resolved",
      attempts: [{ effort: "low", effortWasExplicit: false }],
    });
    const config = resolved(
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
    expect(resolveProfilePlan("oracle", resolved(), environment)).toMatchObject({
      kind: "resolved",
      attempts: [{ effectiveContext: "fork" }],
    });
    expect(
      resolveProfilePlan("oracle", resolved(), { ...environment, forkAvailable: false }),
    ).toMatchObject({
      kind: "failed",
      code: "fork_context_unavailable",
      skippedCandidates: [{ code: "fork_context_unavailable" }],
    });
  });

  it("guards hostile candidate getters and proxies with structural paths", () => {
    let unknownRead = false;
    const throwingCandidate = { ...candidate() };
    Object.defineProperty(throwingCandidate, "model", {
      enumerable: true,
      get: () => {
        throw new Error("private model getter");
      },
    });
    const getterDecoded = decodeSubagentConfig(
      hostileDocument({ version: 4, profiles: { worker: throwingCandidate } }),
      "project",
    );
    expect(getterDecoded.invalidProfileRoutes).toEqual(["worker"]);
    expect(getterDecoded.diagnostics).toContain("project.profiles.worker");

    const unknownCandidate = { ...candidate() };
    Object.defineProperty(unknownCandidate, "unknown", {
      enumerable: true,
      get: () => {
        unknownRead = true;
        return "private";
      },
    });
    expect(
      decodeSubagentConfig(
        hostileDocument({ version: 4, profiles: { scout: unknownCandidate } }),
        "global",
      ).invalidProfileRoutes,
    ).toEqual(["scout"]);
    expect(unknownRead).toBe(false);

    const revoked = Proxy.revocable([candidate()], {});
    revoked.revoke();
    const proxyDecoded = decodeSubagentConfig(
      hostileDocument({ version: 4, profiles: { reviewer: revoked.proxy } }),
      "global",
    );
    expect(proxyDecoded.invalidProfileRoutes).toEqual(["reviewer"]);
    expect(proxyDecoded.diagnostics).toContain("global.profiles.reviewer");
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
    const decoded = decodeSubagentConfig(
      hostileDocument({ version: 4, profiles: { worker: candidates } }),
      "global",
    );
    expect(accesses).toBe(0);
    expect(decoded.invalidProfileRoutes).toEqual(["worker"]);
    expect(decoded.diagnostics).toContain("global.profiles.worker[32+]");
  });

  it("accepts v4, v5, and v6 while rejecting other declared versions", () => {
    expect(decodeSubagentConfig({ version: 4 }, "global").unsupportedVersion).toBe(false);
    expect(decodeSubagentConfig({ version: 5 }, "global").unsupportedVersion).toBe(false);
    expect(decodeSubagentConfig({ version: 6 }, "global").unsupportedVersion).toBe(false);
    const v3 = decodeSubagentConfig({ version: 3, denied: [] }, "global");
    expect(v3).toMatchObject({ unsupportedVersion: true });
    expect(v3.diagnostics).toEqual(expect.arrayContaining(["global.version", "global.<unknown>"]));
    for (const version of [1, 2, "4", null, false, 4.5])
      expect(decodeSubagentConfig({ version }, "global").unsupportedVersion).toBe(true);
  });

  it("activates loaded base configuration when publication throws", () => {
    const config = resolved(
      document({ profiles: { reviewer: candidate({ model: "openai/base-after-throw" }) } }),
    );
    const store = Layer.succeed(SubagentConfigStore, {
      paths: () =>
        Effect.succeed({
          global: "/agent/pi-subagents.json",
          project: "/repo/.pi/pi-subagents.json",
        }),
      load: () => Effect.succeed(config),
      inspect: () => Effect.die("unused"),
      patchProfile: () => Effect.die("unused"),
      patchDefaultProfileSet: () => Effect.die("unused"),
      createProfileSet: () => Effect.die("unused"),
      copyProfileSet: () => Effect.die("unused"),
      renameProfileSet: () => Effect.die("unused"),
      deleteProfileSet: () => Effect.die("unused"),
      patchNesting: () => Effect.die("unused"),
    });
    let attempts = 0;
    return Effect.runPromise(
      SubagentProfileService.use((service) => service.capture).pipe(
        provideBuiltLayer(
          subagentProfileServiceLayer({
            cwd: "/repo",
            agentDirectory: "/agent",
            projectTrusted: true,
            publishBaseConfig: () => {
              attempts += 1;
              throw new Error("hostile base publication");
            },
          }).pipe(Layer.provide(store)),
        ),
      ),
    ).then((snapshot) => {
      expect(attempts).toBe(1);
      expect(snapshot.effectiveConfig.profiles.reviewer.candidates[0]?.model).toBe(
        "openai/base-after-throw",
      );
    });
  });

  it("logs only path-safe diagnostics from loaded v4 configuration", () => {
    const captured = makeCapturedLogger();
    const config = resolved(document({ denied: "secret-policy-value" }));
    const store = Layer.succeed(SubagentConfigStore, {
      paths: () =>
        Effect.succeed({
          global: "/agent/pi-subagents.json",
          project: "/repo/.pi/pi-subagents.json",
        }),
      load: () => Effect.succeed(config),
      inspect: () => Effect.die("unused"),
      patchProfile: () => Effect.die("unused"),
      patchDefaultProfileSet: () => Effect.die("unused"),
      createProfileSet: () => Effect.die("unused"),
      copyProfileSet: () => Effect.die("unused"),
      renameProfileSet: () => Effect.die("unused"),
      deleteProfileSet: () => Effect.die("unused"),
      patchNesting: () => Effect.die("unused"),
    });
    return Effect.runPromise(
      SubagentProfileService.use((service) =>
        service.capture.pipe(
          Effect.tap((snapshot) =>
            Effect.sync(() =>
              expect(snapshot.effectiveConfig.diagnostics).toContain("global.<unknown>"),
            ),
          ),
          Effect.asVoid,
        ),
      ).pipe(
        provideBuiltLayer(
          subagentProfileServiceLayer({
            cwd: "/repo",
            agentDirectory: "/agent",
            projectTrusted: true,
          }).pipe(Layer.provide(Layer.merge(store, captured.layer))),
        ),
      ),
    ).then(() => {
      expect(JSON.stringify(captured.entries)).not.toContain("secret-policy-value");
    });
  });
});
