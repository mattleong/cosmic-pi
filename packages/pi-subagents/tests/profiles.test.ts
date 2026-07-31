// Promise assertions are test-runner boundaries.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/strictEffectProvide:off
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeCapturedLogger } from "pi-cosmic-core/testing";
import { describe, expect, it } from "vitest";
import { resolveSubagentConfig } from "../src/config/options.ts";
import {
  decodeSubagentConfig,
  isNativeProfileModelSelector,
  SUBAGENT_CONFIG_VERSION,
} from "../src/config/schema.ts";
import { SubagentConfigStore } from "../src/config/store.ts";
import { PROFILE_DEFINITIONS } from "../src/profiles/definitions.ts";
import { PROFILE_IDS, type DeclaredProfileCandidate } from "../src/profiles/model.ts";
import { resolveProfilePlan } from "../src/profiles/resolve.ts";
import { SubagentProfileService, subagentProfileServiceLayer } from "../src/profiles/service.ts";

const document = (value: Record<string, unknown> = {}) => ({ version: 4, ...value });
const candidate = (value: Partial<DeclaredProfileCandidate> = {}): DeclaredProfileCandidate => ({
  host: "local",
  runtime: "pi",
  model: "parent",
  effort: "default",
  context: "fresh",
  writeIntent: "read-only",
  ...value,
});
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
  forkAvailable: true,
};

describe("subagent v4 profile configuration and resolution", () => {
  it("ships seven explicit local Pi parent routes preserving profile defaults", () => {
    expect(SUBAGENT_CONFIG_VERSION).toBe(4);
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
    expect(config.defaultProfile).toBe("delegate");
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
    expect(decoded.file.profiles?.scout).toMatchObject({ closeOnReport: true });
    expect(decoded.file.profiles?.worker).toEqual([
      candidate({
        model: "openai/gpt-review",
        effort: "medium",
        writeIntent: "writer",
        closeOnReport: true,
      }),
      candidate({ host: "herdr", runtime: "claude", model: "sonnet", closeOnReport: false }),
    ]);
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

  it("fails a present route closed when its native selector violates the shared grammar", () => {
    const decoded = decodeSubagentConfig(
      document({ profiles: { worker: candidate({ runtime: "claude", model: "model,other" }) } }),
      "project",
    );
    expect(decoded.invalidProfileRoutes).toEqual(["worker"]);
    expect(decoded.file.profiles?.worker).toBeUndefined();
    expect(decoded.diagnostics).toContain("project.profiles.worker");
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
        "global.profiles.scout",
        "global.profiles.researcher",
        "global.profiles.planner",
        "global.profiles.worker",
        "global.profiles.reviewer",
      ]),
    );
  });

  it("rejects removed policy fields with strict unknown-key diagnostics", () => {
    const decoded = decodeSubagentConfig(
      document({ denied: [], discouraged: [], execution: "background" }),
      "global",
    );
    expect(decoded.file).toEqual({ version: 4 });
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
    const inherited = resolved(global, document({ defaultProfile: "worker" }));
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
    const decoded = decodeSubagentConfig(document({ profiles: { worker: candidates } }), "global");
    expect(accesses).toBe(0);
    expect(decoded.invalidProfileRoutes).toEqual(["worker"]);
    expect(decoded.diagnostics).toContain("global.profiles.worker[32+]");
  });

  it("accepts only declared v4 and records v3 for actionable store migration", () => {
    expect(decodeSubagentConfig({ version: 4 }, "global").unsupportedVersion).toBe(false);
    const v3 = decodeSubagentConfig({ version: 3, denied: [] }, "global");
    expect(v3).toMatchObject({ unsupportedVersion: true, legacyVersion3: true });
    expect(v3.diagnostics).toEqual(expect.arrayContaining(["global.version", "global.<unknown>"]));
    for (const version of [1, 2, "4", null, false, 4.5])
      expect(decodeSubagentConfig({ version }, "global").unsupportedVersion).toBe(true);
  });

  it("logs only path-safe diagnostics from loaded v4 configuration", async () => {
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
    });
    await Effect.runPromise(
      SubagentProfileService.use((service) =>
        Effect.sync(() => expect(service.config.diagnostics).toContain("global.<unknown>")),
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
    expect(JSON.stringify(captured.entries)).not.toContain("secret-policy-value");
  });
});
