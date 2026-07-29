// Promise assertions are test-runner boundaries.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/strictEffectProvide:off
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeCapturedLogger } from "pi-cosmic-core/testing";
import { describe, expect, it } from "vitest";
import { modelPolicyFor, resolveSubagentConfig } from "../src/config/options.ts";
import {
  decodeSubagentConfig,
  isCanonicalProfileModelSelector,
  SUBAGENT_CONFIG_VERSION,
} from "../src/config/schema.ts";
import { SubagentConfigStore } from "../src/config/store.ts";
import { PROFILE_DEFINITIONS } from "../src/profiles/definitions.ts";
import { PROFILE_IDS } from "../src/profiles/model.ts";
import { resolveProfilePlan } from "../src/profiles/resolve.ts";
import { SubagentProfileService, subagentProfileServiceLayer } from "../src/profiles/service.ts";

const document = (value: Record<string, unknown> = {}) => ({ version: 2, ...value });
const resolved = (global: unknown = document(), project?: unknown, projectTrusted = true) =>
  resolveSubagentConfig({
    globalConfigPath: "/agent/pi-subagents.json",
    projectConfigPath: "/repo/.pi/pi-subagents.json",
    projectTrusted,
    globalConfigExists: true,
    projectConfigExists: project !== undefined,
    global: decodeSubagentConfig(global, "global"),
    ...(project === undefined ? {} : { project: decodeSubagentConfig(project, "project") }),
  });

const environment = {
  availablePiModels: [
    { provider: "openai", id: "gpt-parent", supportedEfforts: ["off", "low", "high"] as const },
    { provider: "openai", id: "gpt-review", supportedEfforts: ["off", "medium", "high"] as const },
  ],
  parentModel: { model: "openai/gpt-parent", effort: "high" as const },
  projectTrusted: true,
  forkAvailable: true,
};

describe("subagent v2 profile configuration and resolution", () => {
  it("ships seven neutral parent/default profiles with role effort defaults", () => {
    expect(SUBAGENT_CONFIG_VERSION).toBe(2);
    expect(PROFILE_IDS).toHaveLength(7);
    expect(PROFILE_DEFINITIONS.oracle.defaultContext).toBe("fork");
    expect(PROFILE_DEFINITIONS.delegate.defaultEffort).toBeUndefined();
    const config = resolved();
    for (const id of PROFILE_IDS) {
      expect(config.profiles[id]).toEqual({ candidates: [{ model: "parent", effort: "default" }] });
      expect(config.profileSources[id]).toBe("builtin");
    }
  });

  it("decodes one candidate, ordered non-empty candidates, and disabled", () => {
    const decoded = decodeSubagentConfig(
      document({
        profiles: {
          scout: { model: "parent", effort: "default" },
          worker: [
            { model: "pi/openai/gpt-review", effort: "medium" },
            { model: "claude-cli/sonnet", effort: "high" },
          ],
          reviewer: "disabled",
        },
      }),
      "global",
    );
    expect(decoded.invalidProfileRoutes).toEqual([]);
    expect(decoded.file.profiles).toEqual({
      scout: { model: "parent", effort: "default" },
      worker: [
        { model: "pi/openai/gpt-review", effort: "medium" },
        { model: "claude-cli/sonnet", effort: "high" },
      ],
      reviewer: "disabled",
    });
  });

  it("accepts only bounded canonical profile model selector forms", () => {
    expect(isCanonicalProfileModelSelector("parent")).toBe(true);
    expect(isCanonicalProfileModelSelector("pi/openai/gpt-5.6-sol")).toBe(true);
    expect(isCanonicalProfileModelSelector("pi/fireworks/accounts/team/models/model")).toBe(true);
    expect(isCanonicalProfileModelSelector("claude-cli/claude-opus-5-20260115")).toBe(true);
    for (const selector of [
      "openai/gpt-5",
      "pi/gpt-5",
      "pi/../gpt-5",
      "pi/openai/../gpt-5",
      "pi/openai/model\u001b",
      `pi/openai/${"x".repeat(300)}`,
      "claude-cli/not-claude",
    ])
      expect(isCanonicalProfileModelSelector(selector)).toBe(false);
  });

  it("rejects legacy and non-canonical route selectors as whole invalid routes", () => {
    const decoded = decodeSubagentConfig(
      document({
        profiles: {
          scout: { source: "parent" },
          researcher: { model: "openai/gpt-review", effort: "high" },
          planner: { model: "pi/gpt-review", effort: "high" },
          worker: [],
          reviewer: [
            { model: "pi/openai/gpt-review", effort: "high" },
            { model: "claude-cli/not-claude", effort: "high" },
          ],
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
    expect(decoded.file.profiles).toBeUndefined();
    expect(decoded.diagnostics).toEqual(
      expect.arrayContaining([
        "global.profiles.scout",
        "global.profiles.researcher",
        "global.profiles.planner",
        "global.profiles.worker",
        "global.profiles.reviewer[1]",
      ]),
    );
  });

  it("bounds selectors and route arrays before traversal", () => {
    let accesses = 0;
    const candidates: unknown[] = [];
    candidates.length = 10_000;
    Object.defineProperty(candidates, 0, {
      get: () => {
        accesses += 1;
        return { model: "parent", effort: "default" };
      },
    });
    const decoded = decodeSubagentConfig(document({ profiles: { worker: candidates } }), "global");
    expect(accesses).toBe(0);
    expect(decoded.invalidProfileRoutes).toEqual(["worker"]);
    expect(decoded.diagnostics).toContain("global.profiles.worker[32+]");
  });

  it("uses default effort softly and concrete configured/per-launch effort hard", () => {
    expect(resolveProfilePlan("scout", resolved(), environment)).toMatchObject({
      kind: "resolved",
      attempts: [{ model: "openai/gpt-parent", effort: "low", effortWasExplicit: false }],
    });
    expect(resolveProfilePlan("delegate", resolved(), environment)).toMatchObject({
      kind: "resolved",
      attempts: [{ effort: "high", effortWasExplicit: false }],
    });
    const config = resolved(
      document({ profiles: { worker: { model: "pi/openai/gpt-review", effort: "high" } } }),
    );
    expect(resolveProfilePlan("worker", config, environment)).toMatchObject({
      kind: "resolved",
      attempts: [{ effort: "high", effortWasExplicit: true }],
    });
    expect(resolveProfilePlan("worker", config, environment, undefined, "medium")).toMatchObject({
      kind: "resolved",
      attempts: [{ effort: "medium", effortWasExplicit: true }],
    });
  });

  it("skips hard-incompatible efforts but does not reject soft defaults", () => {
    const config = resolved(
      document({
        profiles: {
          worker: [
            { model: "pi/openai/gpt-parent", effort: "xhigh" },
            { model: "pi/openai/gpt-review", effort: "default" },
          ],
        },
      }),
    );
    expect(resolveProfilePlan("worker", config, environment)).toMatchObject({
      kind: "resolved",
      attempts: [
        {
          candidateIndex: 1,
          model: "openai/gpt-review",
          effort: "high",
          effortWasExplicit: false,
          skippedBefore: [{ candidateIndex: 0, code: "pi_effort_unsupported" }],
        },
      ],
    });
  });

  it("normalizes disabled and invalid declarations to deterministic no-model failures", () => {
    const disabled = resolved(document({ profiles: { reviewer: "disabled" } }));
    expect(disabled.profiles.reviewer).toEqual({ candidates: [] });
    expect(resolveProfilePlan("reviewer", disabled, environment)).toMatchObject({
      kind: "failed",
      code: "profile_no_eligible_model",
      message: expect.stringContaining("disabled"),
    });
    const invalid = resolved(
      document({ profiles: { reviewer: { model: "bare", effort: "high" } } }),
    );
    expect(invalid.profileSources.reviewer).toBe("global-invalid");
    expect(invalid.profiles.reviewer).toEqual({ candidates: [] });
    expect(resolveProfilePlan("reviewer", invalid, environment)).toMatchObject({
      kind: "failed",
      code: "profile_no_eligible_model",
      message: expect.stringContaining("invalid global route"),
    });
    const projectInvalid = resolved(document(), document({ profiles: { reviewer: null } }));
    expect(resolveProfilePlan("reviewer", projectInvalid, environment)).toMatchObject({
      kind: "failed",
      message: expect.stringContaining("/repo/.pi/pi-subagents.json"),
    });
  });

  it("inherits an entire global route when project is absent and fails invalid project overrides closed", () => {
    const global = document({
      denied: [{ backend: "pi", model: "openai/legacy" }],
      profiles: {
        worker: [
          { model: "pi/openai/gpt-review", effort: "medium" },
          { model: "parent", effort: "default" },
        ],
      },
    });
    const inherited = resolved(global, document({ defaultProfile: "worker" }));
    expect(inherited.profiles.worker.candidates).toHaveLength(2);
    expect(inherited.profileSources.worker).toBe("global");
    const invalid = resolved(global, document({ profiles: { worker: null } }));
    expect(invalid.profiles.worker).toEqual({ candidates: [] });
    expect(invalid.profileSources.worker).toBe("project-invalid");
    const untrusted = resolved(global, document({ profiles: { worker: "disabled" } }), false);
    expect(untrusted.profiles.worker.candidates).toHaveLength(2);
  });

  it("keeps policies additive, skips denied candidates, and retains discouraged profile routes", () => {
    const config = resolved(
      document({
        denied: [{ backend: "pi", model: "openai/denied" }],
        profiles: {
          reviewer: [
            { model: "pi/openai/denied", effort: "high" },
            { model: "pi/openai/gpt-review", effort: "medium" },
            { model: "parent", effort: "default" },
          ],
        },
      }),
      document({ discouraged: [{ backend: "pi", model: "openai/gpt-review" }] }),
    );
    expect(modelPolicyFor(config, "pi", "openai/denied")).toBe("denied");
    expect(resolveProfilePlan("reviewer", config, environment)).toMatchObject({
      kind: "resolved",
      attempts: [
        {
          source: "profile-candidate",
          candidateIndex: 1,
          skippedBefore: [{ code: "model_denied" }],
        },
        {
          source: "profile-parent-candidate",
          candidateIndex: 2,
        },
      ],
    });
  });

  it("retains Claude validation, trust, effort, and fork rules", () => {
    const config = resolved(
      document({ profiles: { oracle: { model: "claude-cli/sonnet", effort: "high" } } }),
    );
    expect(resolveProfilePlan("oracle", config, environment)).toMatchObject({
      kind: "failed",
      code: "profile_no_eligible_model",
      skippedCandidates: [{ code: "claude_context_unsupported" }],
    });
    const fresh = resolved(
      document({ profiles: { worker: { model: "claude-cli/sonnet", effort: "off" } } }),
    );
    expect(resolveProfilePlan("worker", fresh, environment)).toMatchObject({
      kind: "failed",
      skippedCandidates: [{ code: "claude_effort_unsupported" }],
    });
  });

  it("accepts only declared v2 and marks v1/malformed versions unsupported", () => {
    expect(decodeSubagentConfig({ version: 2 }, "global").unsupportedVersion).toBe(false);
    expect(decodeSubagentConfig({}, "global").unsupportedVersion).toBe(true);
    for (const version of [1, "2", null, false, 2.5]) {
      const decoded = decodeSubagentConfig({ version }, "global");
      expect(decoded.unsupportedVersion).toBe(true);
      expect(decoded.diagnostics).toContain("global.version");
    }
  });

  it("logs path-safe diagnostics from the loaded v2 configuration", async () => {
    const captured = makeCapturedLogger();
    const config = resolved(document({ discouraged: "not-an-array" }));
    const store = Layer.succeed(SubagentConfigStore, {
      paths: () =>
        Effect.succeed({
          global: "/agent/pi-subagents.json",
          project: "/repo/.pi/pi-subagents.json",
        }),
      load: () => Effect.succeed(config),
      inspect: () => Effect.die("unused"),
      patchProfile: () => Effect.die("unused"),
    });
    await Effect.runPromise(
      SubagentProfileService.use((service) =>
        Effect.sync(() => expect(service.config.diagnostics).toContain("global.discouraged")),
      ).pipe(
        Effect.provide(
          subagentProfileServiceLayer({
            cwd: "/repo",
            agentDirectory: "/agent",
            projectTrusted: true,
          }).pipe(Layer.provide(Layer.merge(store, captured.layer))),
        ),
      ),
    );
    expect(JSON.stringify(captured.entries)).not.toContain("not-an-array");
  });
});
