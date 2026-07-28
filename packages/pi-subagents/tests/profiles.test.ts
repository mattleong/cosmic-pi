// Promise assertions are test-runner boundaries; explicit test entry-point Layer provision owns
// the profile-service runtime.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/strictEffectProvide:off
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeCapturedLogger } from "pi-cosmic-core/testing";
import { describe, expect, it } from "vitest";
import { modelPolicyFor, resolveSubagentConfig } from "../src/config/options.ts";
import { decodeSubagentConfig } from "../src/config/schema.ts";
import { SubagentConfigStore } from "../src/config/store.ts";
import { PROFILE_DEFINITIONS } from "../src/profiles/definitions.ts";
import { PROFILE_IDS } from "../src/profiles/model.ts";
import { resolveProfilePlan } from "../src/profiles/resolve.ts";
import { SubagentProfileService, subagentProfileServiceLayer } from "../src/profiles/service.ts";

const resolved = (global: unknown = {}, project?: unknown, projectTrusted = true) =>
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
    { provider: "openai", id: "gpt-parent" },
    { provider: "openai", id: "gpt-review" },
  ],
  parentModel: { model: "openai/gpt-parent", effort: "high" as const },
  projectTrusted: true,
  forkAvailable: true,
};

describe("subagent profile configuration and resolution", () => {
  it("ships exactly seven model-neutral profiles with role-specific effort defaults", () => {
    expect(PROFILE_IDS).toEqual([
      "scout",
      "researcher",
      "planner",
      "worker",
      "reviewer",
      "oracle",
      "delegate",
    ]);
    expect(PROFILE_IDS.filter((id) => PROFILE_DEFINITIONS[id].defaultContext === "fork")).toEqual([
      "oracle",
    ]);
    expect(
      Object.fromEntries(PROFILE_IDS.map((id) => [id, PROFILE_DEFINITIONS[id].defaultEffort])),
    ).toEqual({
      scout: "low",
      researcher: "medium",
      planner: "medium",
      worker: "high",
      reviewer: "high",
      oracle: "high",
      delegate: undefined,
    });
    const config = resolved();
    for (const id of PROFILE_IDS)
      expect(config.profiles[id]).toEqual({ candidates: [], fallback: "parent" });
    expect(config.defaultProfile).toBe("delegate");
  });

  it("keeps the parent model while applying profile, candidate, and request effort precedence", () => {
    const config = resolved({
      profiles: {
        reviewer: {
          candidates: [
            {
              source: "model",
              backend: "pi",
              model: "openai/gpt-review",
              effort: "medium",
            },
          ],
          fallback: "fail",
        },
      },
    });
    // Built-in profile defaults supply the effort but stay soft preferences.
    expect(resolveProfilePlan("reviewer", resolved(), environment)).toMatchObject({
      kind: "resolved",
      attempts: [{ model: "openai/gpt-parent", effort: "high", effortWasExplicit: false }],
    });
    expect(resolveProfilePlan("scout", resolved(), environment)).toMatchObject({
      kind: "resolved",
      attempts: [{ model: "openai/gpt-parent", effort: "low", effortWasExplicit: false }],
    });
    expect(resolveProfilePlan("delegate", resolved(), environment)).toMatchObject({
      kind: "resolved",
      attempts: [{ model: "openai/gpt-parent", effort: "high", effortWasExplicit: false }],
    });
    // Candidate-configured and per-call efforts remain hard requirements.
    expect(resolveProfilePlan("reviewer", config, environment)).toMatchObject({
      kind: "resolved",
      attempts: [{ model: "openai/gpt-review", effort: "medium", effortWasExplicit: true }],
    });
    expect(resolveProfilePlan("reviewer", config, environment, undefined, "low")).toMatchObject({
      kind: "resolved",
      attempts: [{ model: "openai/gpt-review", effort: "low", effortWasExplicit: true }],
    });
  });

  it("fails with parent_model_missing when no parent model is active", () => {
    const resolution = resolveProfilePlan("delegate", resolved(), {
      ...environment,
      parentModel: undefined,
    });
    expect(resolution).toMatchObject({
      kind: "failed",
      code: "profile_no_eligible_model",
      skippedCandidates: [
        {
          candidate: "parent fallback",
          code: "parent_model_missing",
          reason: "No active parent model is available.",
        },
      ],
    });
  });

  it("recovers valid siblings from malformed fields and items", () => {
    const decoded = decodeSubagentConfig(
      {
        defaultProfile: "reviewer",
        denied: [
          { backend: "pi", model: "openai/gpt-parent" },
          { backend: "invalid", model: "bad" },
        ],
        discouraged: "invalid",
        profiles: {
          reviewer: {
            candidates: [
              { source: "model", backend: "pi", model: "openai/gpt-review" },
              { source: "model", backend: "bad", model: "bad" },
            ],
            fallback: "parent",
          },
          future: { candidates: [] },
        },
      },
      "global",
    );
    expect(decoded.file.defaultProfile).toBe("reviewer");
    expect(decoded.file.denied).toEqual([{ backend: "pi", model: "openai/gpt-parent" }]);
    expect(decoded.file.profiles?.reviewer).toEqual({
      candidates: [{ source: "model", backend: "pi", model: "openai/gpt-review" }],
      fallback: "parent",
    });
    expect(decoded.diagnostics).toEqual(
      expect.arrayContaining([
        "global.discouraged",
        "global.denied[1]",
        "global.profiles.reviewer.candidates[1]",
        "global.profiles.<unknown>",
      ]),
    );
  });

  it("rejects excess selector/candidate fields and caps arrays before item decoding", () => {
    const oversized = Array.from({ length: 10_000 }, (_, index) => ({
      backend: "pi",
      model: `provider/model-${index}`,
    }));
    const decoded = decodeSubagentConfig(
      {
        denied: oversized,
        discouraged: [{ backend: "pi", model: "safe", modle: "typo" }],
        profiles: {
          worker: {
            candidates: [
              { source: "parent", effort: "high" },
              { source: "model", backend: "pi", model: "safe", modle: "typo" },
              { source: "model", backend: "pi", model: "valid" },
            ],
            fallback: "fail",
            candidtes: [],
          },
        },
        defualtProfile: "worker",
      },
      "global",
    );

    expect(decoded.file.denied).toHaveLength(256);
    expect(decoded.file.discouraged).toBeUndefined();
    expect(decoded.file.profiles?.worker?.candidates).toEqual([
      { source: "model", backend: "pi", model: "valid" },
    ]);
    expect(decoded.diagnostics).toEqual(
      expect.arrayContaining([
        "global.<unknown>",
        "global.denied[256+]",
        "global.discouraged[0]",
        "global.profiles.worker.<unknown>",
        "global.profiles.worker.candidates[0]",
        "global.profiles.worker.candidates[1]",
      ]),
    );
    expect(decoded.diagnostics.join(" ")).not.toContain("defualtProfile");
    expect(decoded.diagnostics.join(" ")).not.toContain("modle");
  });

  it("never traverses raw array entries beyond the configured decode cap", () => {
    let accesses = 0;
    const denied: unknown[] = [];
    denied.length = 1_000;
    for (let index = 0; index < denied.length; index += 1)
      Object.defineProperty(denied, index, {
        enumerable: true,
        configurable: true,
        get: () => {
          accesses += 1;
          if (index >= 256) throw new Error("out-of-bound entry was inspected");
          return { backend: "pi", model: `provider/model-${index}` };
        },
      });

    const decoded = decodeSubagentConfig({ denied }, "global");
    expect(decoded.file.denied).toHaveLength(256);
    expect(accesses).toBe(256);
    expect(decoded.diagnostics).toContain("global.denied[256+]");
  });

  it("unions project policy while project routes atomically replace global routes", () => {
    const config = resolved(
      {
        defaultProfile: "planner",
        denied: [{ backend: "pi", model: "gpt-parent" }],
        discouraged: [{ backend: "claude-cli", model: "haiku" }],
        profiles: {
          reviewer: {
            candidates: [{ source: "model", backend: "pi", model: "openai/global" }],
            fallback: "parent",
          },
        },
      },
      {
        defaultProfile: "reviewer",
        denied: [{ backend: "claude-cli", model: "opus" }],
        discouraged: [{ backend: "pi", model: "gpt-review" }],
        profiles: {
          reviewer: {
            candidates: [{ source: "model", backend: "pi", model: "openai/project" }],
            fallback: "fail",
          },
        },
      },
    );
    expect(config.defaultProfile).toBe("reviewer");
    expect(config.denied).toEqual([
      { backend: "pi", model: "gpt-parent" },
      { backend: "claude-cli", model: "opus" },
    ]);
    expect(config.discouraged).toHaveLength(2);
    expect(config.profiles.reviewer).toEqual({
      candidates: [{ source: "model", backend: "pi", model: "openai/project" }],
      fallback: "fail",
    });
    expect(modelPolicyFor(config, "pi", "another/gpt-parent")).toBe("denied");
    expect(modelPolicyFor(config, "pi", "openai/gpt-review")).toBe("discouraged");
    expect(modelPolicyFor(config, "claude-cli", "claude-opus-5")).toBe("denied");
  });

  it("applies Claude full-ID policies to dated variants", () => {
    const config = resolved({
      denied: [{ backend: "claude-cli", model: "claude-opus-5" }],
    });
    expect(modelPolicyFor(config, "claude-cli", "claude-opus-5-20260115")).toBe("denied");
    expect(modelPolicyFor(config, "claude-cli", "opus")).toBe("denied");
    expect(modelPolicyFor(config, "claude-cli", "claude-sonnet-5-20260115")).toBe("allowed");
  });

  it("never reads project semantics when the project is untrusted", () => {
    const config = resolved(
      { defaultProfile: "planner" },
      {
        defaultProfile: "reviewer",
        denied: [{ backend: "pi", model: "openai/gpt-parent" }],
      },
      false,
    );
    expect(config.defaultProfile).toBe("planner");
    expect(config.denied).toEqual([]);
    expect(config.projectConfigExists).toBe(false);
  });

  it("keeps deterministic order while skipping denied, discouraged, and unavailable candidates", () => {
    const config = resolved({
      denied: [{ backend: "pi", model: "openai/denied" }],
      discouraged: [{ backend: "pi", model: "openai/gpt-review" }],
      profiles: {
        reviewer: {
          candidates: [
            { source: "model", backend: "pi", model: "openai/denied" },
            { source: "model", backend: "pi", model: "openai/gpt-review" },
            { source: "model", backend: "pi", model: "openai/missing" },
          ],
          fallback: "parent",
        },
      },
    });
    const resolution = resolveProfilePlan("reviewer", config, environment);
    expect(resolution.kind).toBe("resolved");
    if (resolution.kind !== "resolved") return;
    expect(resolution.attempts).toMatchObject([
      {
        source: "profile-parent-fallback",
        backend: "pi",
        model: "openai/gpt-parent",
      },
    ]);
    expect(resolution.skippedCandidates.map((candidate) => candidate.code)).toEqual([
      "model_denied",
      "model_discouraged",
      "pi_model_unknown",
    ]);
  });

  it("skips a hard-incompatible Pi effort before spawn planning and preserves soft defaults", () => {
    const config = resolved({
      profiles: {
        worker: {
          candidates: [
            {
              source: "model",
              backend: "pi",
              model: "openai/gpt-review",
              effort: "xhigh",
            },
            { source: "model", backend: "pi", model: "openai/gpt-parent", effort: "high" },
          ],
          fallback: "fail",
        },
      },
    });
    const capableEnvironment = {
      ...environment,
      availablePiModels: [
        { provider: "openai", id: "gpt-review", supportedEfforts: ["off", "high"] as const },
        {
          provider: "openai",
          id: "gpt-parent",
          supportedEfforts: ["off", "high"] as const,
        },
      ],
    };
    expect(resolveProfilePlan("worker", config, capableEnvironment)).toMatchObject({
      kind: "resolved",
      attempts: [
        {
          model: "openai/gpt-parent",
          effort: "high",
          skippedBefore: [{ candidateIndex: 0, code: "pi_effort_unsupported" }],
        },
      ],
      skippedCandidates: [{ candidateIndex: 0, code: "pi_effort_unsupported" }],
    });
    // A profile default is still a soft preference and does not remove a model from the plan.
    expect(resolveProfilePlan("worker", resolved(), capableEnvironment)).toMatchObject({
      kind: "resolved",
      attempts: [{ model: "openai/gpt-parent", effort: "high", effortWasExplicit: false }],
    });
  });

  it("keeps later invalid candidates out of provenance when an earlier candidate wins", () => {
    const config = resolved({
      profiles: {
        reviewer: {
          candidates: [
            { source: "model", backend: "pi", model: "openai/gpt-review" },
            { source: "model", backend: "pi", model: "openai/missing" },
          ],
          fallback: "fail",
        },
      },
    });
    const resolution = resolveProfilePlan("reviewer", config, environment);
    expect(resolution.kind).toBe("resolved");
    if (resolution.kind !== "resolved") return;
    expect(resolution.attempts[0]?.skippedBefore).toEqual([]);
    expect(resolution.trailingSkippedCandidates).toMatchObject([
      { candidateIndex: 1, code: "pi_model_unknown" },
    ]);
  });

  it("does not retry an identical parent fallback", () => {
    const config = resolved({
      profiles: {
        delegate: {
          candidates: [{ source: "parent" }],
          fallback: "parent",
        },
      },
    });
    const resolution = resolveProfilePlan("delegate", config, environment);
    expect(resolution.kind).toBe("resolved");
    if (resolution.kind !== "resolved") return;
    expect(resolution.attempts).toHaveLength(1);
    expect(resolution.attempts[0]?.source).toBe("profile-parent-candidate");
    expect(resolution.trailingSkippedCandidates).toMatchObject([
      { code: "duplicate_parent_fallback" },
    ]);
  });

  it("fails without arbitrary fallback and reports unknown profiles", () => {
    const config = resolved({
      profiles: { reviewer: { candidates: [], fallback: "fail" } },
    });
    expect(resolveProfilePlan("reviewer", config, environment)).toMatchObject({
      kind: "failed",
      code: "profile_no_eligible_model",
    });
    expect(resolveProfilePlan("future", config, environment)).toMatchObject({
      kind: "failed",
      code: "profile_unknown",
    });
  });

  it("filters Claude candidates that conflict with oracle fork context", () => {
    const config = resolved({
      profiles: {
        oracle: {
          candidates: [{ source: "model", backend: "claude-cli", model: "fable" }],
          fallback: "fail",
        },
      },
    });
    expect(resolveProfilePlan("oracle", config, environment)).toMatchObject({
      kind: "failed",
      code: "profile_no_eligible_model",
      skippedCandidates: [{ code: "claude_context_unsupported" }],
    });
  });

  it("keeps the specific Claude fork reason when the parent branch is also unforkable", () => {
    const config = resolved({
      profiles: {
        oracle: {
          candidates: [
            { source: "model", backend: "claude-cli", model: "fable" },
            { source: "model", backend: "pi", model: "openai/gpt-review" },
          ],
          fallback: "parent",
        },
      },
    });
    expect(
      resolveProfilePlan("oracle", config, { ...environment, forkAvailable: false }),
    ).toMatchObject({
      kind: "failed",
      code: "profile_no_eligible_model",
      skippedCandidates: [
        { candidateIndex: 0, code: "claude_context_unsupported" },
        { candidateIndex: 1, code: "fork_context_unavailable" },
        { candidate: "parent fallback", code: "fork_context_unavailable" },
      ],
    });
  });

  it("logs one path-safe diagnostic warning when the loaded configuration had invalid fields", async () => {
    const captured = makeCapturedLogger();
    const store = Layer.succeed(SubagentConfigStore, {
      paths: () =>
        Effect.succeed({
          global: "/agent/pi-subagents.json",
          project: "/repo/.pi/pi-subagents.json",
        }),
      load: () => Effect.succeed(resolved({ discouraged: "not-an-array" })),
    });
    await Effect.runPromise(
      SubagentProfileService.use((service) =>
        Effect.sync(() => {
          expect(service.config.diagnostics).toContain("global.discouraged");
        }),
      ).pipe(
        Effect.provide(
          subagentProfileServiceLayer({
            cwd: "/repo",
            agentDirectory: "/agent",
            projectTrusted: true,
            // The warning is logged while the layer itself is built, so the captured logger must
            // be part of the layer's own build context.
          }).pipe(Layer.provide(Layer.merge(store, captured.layer))),
        ),
      ),
    );
    const telemetry = JSON.stringify(captured.entries);
    expect(telemetry).toContain("Ignored invalid Subagents configuration fields");
    expect(telemetry).toContain("global.discouraged");
    expect(telemetry).not.toContain("not-an-array");
  });

  it("marks a declared unsupported configuration version for fail-closed activation", () => {
    expect(
      decodeSubagentConfig({ version: 1, defaultProfile: "reviewer" }, "global"),
    ).toMatchObject({
      unsupportedVersion: false,
      file: { version: 1, defaultProfile: "reviewer" },
    });
    const unsupported = decodeSubagentConfig({ version: 2, defaultProfile: "reviewer" }, "global");
    expect(unsupported.unsupportedVersion).toBe(true);
    expect(unsupported.diagnostics).toContain("global.version");
    for (const version of ["1", "2", null, false, true, 1.5]) {
      const malformed = decodeSubagentConfig({ version }, "global");
      expect(malformed.unsupportedVersion).toBe(true);
      expect(malformed.diagnostics).toContain("global.version");
    }
  });
});
