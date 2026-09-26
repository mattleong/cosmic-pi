import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { decodeSubagentConfig } from "../src/config/schema.ts";
import type { SubagentConfigScope } from "../src/config/store.ts";
import type { DeclaredProfileRoute, ProfileId } from "../src/profiles/model.ts";
import { makeSessionProfileSnapshot } from "../src/profiles/session-overrides.ts";
import {
  addRouteCandidate,
  candidateValidationError,
  declaredRouteForDraft,
  defaultRouteCandidate,
  disableRouteDraft,
  duplicateRouteCandidate,
  hasOwnProfileRouteDeclaration,
  loadProfileRouteDraft,
  moveRouteCandidate,
  removeRouteCandidate,
  replaceRouteCandidate,
  runtimeEfforts,
  updateCandidateControls,
  updateCandidateModel,
  type ProfileRouteDraft,
  type ProfileSettingsInspection,
} from "../src/settings/profile-route-editor.ts";
import {
  inheritedInvalidInspection,
  makeProfileSettingsInspection,
} from "./fixtures/profile-settings-inspection.ts";
import { profileCandidate as candidate } from "./fixtures/profiles.ts";

interface InspectionDocumentSeed {
  readonly version: number;
  readonly profiles?: Readonly<Record<string, DeclaredProfileRoute>>;
}

const inspection = (
  global: InspectionDocumentSeed = { version: 4 },
  project?: InspectionDocumentSeed,
): ProfileSettingsInspection => {
  const JsonObjectSchema = Schema.Record(Schema.String, Schema.MutableJson);
  const currentDocument = (input: InspectionDocumentSeed): Schema.MutableJsonObject =>
    Schema.decodeUnknownSync(JsonObjectSchema)(
      input.version === 4
        ? {
            version: 6,
            defaultProfileSet: "default",
            profileSets: { default: { profiles: input.profiles ?? {} } },
          }
        : input,
    );
  return makeProfileSettingsInspection({
    globalDocument: currentDocument(global),
    projectDocument: project ? currentDocument(project) : undefined,
    projectTrusted: true,
  });
};

/** Loads a profile from the "default" saved set in one persistent scope. */
const load = (
  value: ProfileSettingsInspection,
  profile: ProfileId,
  scope: SubagentConfigScope = "global",
) =>
  loadProfileRouteDraft(value, { kind: "profile-set", set: { scope, name: "default" } }, profile);

const threeRoute = [
  candidate("openai/one", { effort: "low" }),
  candidate("claude-opus-5", { host: "herdr", runtime: "claude", effort: "medium" }),
  candidate("gpt-5.6-codex", { runtime: "codex", effort: "xhigh", writeIntent: "writer" }),
];

describe("ordered profile-route editor state", () => {
  it("loads and declares a three-candidate route without collapse or reorder", () => {
    const value = inspection({ version: 4, profiles: { worker: threeRoute } });
    const draft = load(value, "worker");
    expect(draft).toEqual({ kind: "explicit", candidates: threeRoute });
    expect(draft.candidates).not.toBe(threeRoute);
    expect(declaredRouteForDraft(draft)).toEqual({ valid: true, route: threeRoute });
  });

  it("normalizes omitted retention defaults without mutating the declaration", () => {
    const declared = {
      host: "local",
      runtime: "pi",
      model: "parent",
      effort: "default",
      context: "fresh",
      writeIntent: "read-only",
    } as const;
    const value = inspection({ version: 4, profiles: { worker: declared } });
    const before = structuredClone(value.global.file);
    const draft = load(value, "worker");
    expect(draft.candidates[0]).toMatchObject({ ...declared, closeOnReport: true });
    expect(value.global.file).toEqual(before);
    expect(declared).not.toHaveProperty("closeOnReport");
  });

  it("loads session overrides as explicit routes and resets to the active base", () => {
    const base = inspection(
      { version: 4, profiles: { reviewer: candidate("openai/global") } },
      { version: 4, profiles: { reviewer: candidate("openai/project") } },
    );
    const value = {
      ...base,
      session: makeSessionProfileSnapshot(base.config, {
        revision: 1,
        overrides: { reviewer: { candidates: [candidate("openai/session")] } },
      }),
    };
    expect(loadProfileRouteDraft(value, { kind: "session" }, "reviewer")).toEqual({
      kind: "explicit",
      candidates: [candidate("openai/session")],
    });
    const inherited = { ...value, session: makeSessionProfileSnapshot(base.config) };
    expect(loadProfileRouteDraft(inherited, { kind: "session" }, "reviewer")).toEqual({
      kind: "inherit",
      candidates: [candidate("openai/project")],
    });

    const detached = {
      ...base,
      session: makeSessionProfileSnapshot(base.config, {
        revision: 2,
        overrides: {},
        baseline: {
          origin: { scope: "global", name: "detached" },
          profiles: {
            ...base.session.baseline.profiles,
            reviewer: { candidates: [candidate("openai/detached")] },
          },
          profileSources: { ...base.session.baseline.profileSources, reviewer: "global" },
        },
      }),
    };
    expect(loadProfileRouteDraft(detached, { kind: "session" }, "reviewer")).toEqual({
      kind: "inherit",
      candidates: [candidate("openai/detached")],
    });
  });

  it("models reset, inherit, disabled, and invalid fail-closed declarations distinctly", () => {
    const value = inspection(
      {
        version: 4,
        profiles: {
          reviewer: threeRoute,
          scout: "disabled",
          worker: { ...candidate("bare"), model: "bare" },
        },
      },
      { version: 4 },
    );
    expect(load(value, "scout")).toEqual({ kind: "disabled", candidates: [] });
    expect(load(value, "reviewer", "project")).toEqual({ kind: "inherit", candidates: threeRoute });
    expect(load(value, "planner").kind).toBe("reset");
    expect(load(value, "worker")).toEqual({ kind: "invalid", candidates: [] });
    expect(declaredRouteForDraft(load(value, "worker"))).toMatchObject({ valid: false });
    expect(declaredRouteForDraft(disableRouteDraft())).toEqual({
      valid: true,
      route: "disabled",
    });
    expect(declaredRouteForDraft({ kind: "reset", candidates: [] })).toEqual({ valid: true });
    expect(declaredRouteForDraft({ kind: "inherit", candidates: [] })).toEqual({ valid: true });
  });

  it("shows inherited fail-closed routes as invalid until an explicit route repairs them", () => {
    const target = { kind: "profile-set", set: { scope: "project", name: "partial" } } as const;
    const inherited = inheritedInvalidInspection();
    const draft = loadProfileRouteDraft(inherited, target, "worker");
    expect(draft).toEqual({ kind: "invalid", candidates: [] });
    expect(hasOwnProfileRouteDeclaration(inherited, target, "worker")).toBe(false);

    const repaired = addRouteCandidate(draft, defaultRouteCandidate("worker"));
    expect(repaired?.kind).toBe("explicit");
    expect(declaredRouteForDraft(repaired!)).toMatchObject({ valid: true });

    const ownInvalid = inheritedInvalidInspection(true);
    expect(loadProfileRouteDraft(ownInvalid, target, "worker")).toEqual({
      kind: "invalid",
      candidates: [],
    });
    expect(hasOwnProfileRouteDeclaration(ownInvalid, target, "worker")).toBe(true);
  });

  it("adds, edits, duplicates, moves, and removes candidates in exact staged order", () => {
    let draft: ProfileRouteDraft = disableRouteDraft();
    draft = addRouteCandidate(draft, threeRoute[0]!)!;
    draft = addRouteCandidate(draft, threeRoute[1]!)!;
    draft = addRouteCandidate(draft, threeRoute[2]!)!;
    draft = replaceRouteCandidate(
      draft,
      1,
      candidate("claude-sonnet-5", {
        host: "herdr",
        runtime: "claude",
        effort: "high",
      }),
    );
    draft = moveRouteCandidate(draft, 2, "up");
    draft = moveRouteCandidate(draft, 1, "down");
    draft = moveRouteCandidate(draft, 2, "up");
    draft = duplicateRouteCandidate(draft, 0)!;
    expect(draft.candidates.map((entry) => entry.model)).toEqual([
      "openai/one",
      "openai/one",
      "gpt-5.6-codex",
      "claude-sonnet-5",
    ]);
    draft = removeRouteCandidate(draft, 1);
    expect(draft.candidates.map((entry) => entry.model)).toEqual([
      "openai/one",
      "gpt-5.6-codex",
      "claude-sonnet-5",
    ]);
    draft = removeRouteCandidate(removeRouteCandidate(draft, 2), 1);
    draft = removeRouteCandidate(draft, 0);
    expect(draft).toEqual({ kind: "disabled", candidates: [] });
  });

  it("leaves input routes unchanged and clones duplicated candidates independently", () => {
    const original: ProfileRouteDraft = { kind: "explicit", candidates: threeRoute };
    const before = structuredClone(original);
    const moved = moveRouteCandidate(original, 0, "down");
    const duplicated = duplicateRouteCandidate(moved, 0)!;
    expect(original).toEqual(before);
    expect(duplicated.candidates[0]).toEqual(duplicated.candidates[1]);
    expect(duplicated.candidates[0]).not.toBe(duplicated.candidates[1]);
    for (const entry of duplicated.candidates) expect(original.candidates).not.toContain(entry);
  });

  it("enforces the 32-candidate bound for add and duplicate", () => {
    const full: ProfileRouteDraft = {
      kind: "explicit",
      candidates: Array.from({ length: 32 }, (_, index) => candidate(`openai/model-${index}`)),
    };
    expect(addRouteCandidate(full, candidate("openai/overflow"))).toBeUndefined();
    expect(duplicateRouteCandidate(full, 0)).toBeUndefined();
    expect(declaredRouteForDraft(full)).toMatchObject({ valid: true });
    expect(
      declaredRouteForDraft({
        kind: "explicit",
        candidates: [...full.candidates, candidate("openai/overflow")],
      }),
    ).toMatchObject({ valid: false });
  });
});

describe("profile candidate normalization and validation", () => {
  it("adds all six host/runtime combinations with product-valid defaults", () => {
    let draft: ProfileRouteDraft = disableRouteDraft();
    const nativeModels = { claude: "live-claude", codex: "live-codex" } as const;
    for (const host of ["local", "herdr"] as const) {
      for (const runtime of ["pi", "claude", "codex"] as const) {
        let current = candidate("parent", { effort: "default" });
        const runtimeUpdate = updateCandidateControls(
          current,
          { runtime },
          {
            piModel: "openai-codex/gpt-5.6-sol",
            nativeModel: runtime === "pi" ? undefined : nativeModels[runtime],
          },
        );
        expect(runtimeUpdate.error).toBeUndefined();
        current = runtimeUpdate.candidate!;
        const hostUpdate = updateCandidateControls(
          current,
          { host },
          { piModel: "openai-codex/gpt-5.6-sol" },
        );
        expect(hostUpdate.error).toBeUndefined();
        current = hostUpdate.candidate!;
        expect(candidateValidationError(current), `${host}/${runtime}`).toBeUndefined();
        if (host === "herdr" && runtime === "pi")
          expect(current.model).toBe("openai-codex/gpt-5.6-sol");
        if (runtime !== "pi") expect(current.model).toBe(nativeModels[runtime]);
        draft = addRouteCandidate(draft, current)!;
      }
    }
    expect(draft.candidates.map(({ host, runtime }) => `${host}/${runtime}`)).toEqual([
      "local/pi",
      "local/claude",
      "local/codex",
      "herdr/pi",
      "herdr/claude",
      "herdr/codex",
    ]);
  });

  it("normalizes controlling fields visibly and never retains an incompatible dependency", () => {
    const retainedFork = candidate("parent", {
      context: "fork",
      host: "herdr",
      writeIntent: "read-only",
      closeOnReport: false,
    });
    const local = updateCandidateControls(
      retainedFork,
      { host: "local" },
      {
        piModel: "openai-codex/gpt-5.6-sol",
      },
    );
    expect(local.candidate).toMatchObject({ host: "local", closeOnReport: true });
    expect(local.notices.join(" ")).toContain("stay open after reporting");

    const forked = candidate("parent", {
      context: "fork",
      effort: "minimal",
      openaiFastMode: true,
    });
    // Claude and Codex have no built-in model; the switch waits for one from the live catalog.
    for (const runtime of ["claude", "codex"] as const) {
      const pending = updateCandidateControls(
        forked,
        { runtime },
        { piModel: "openai-codex/gpt-5.6-sol" },
      );
      expect(pending.candidate).toBeUndefined();
      expect(pending.error).toBeDefined();
    }

    const claude = updateCandidateControls(
      forked,
      { runtime: "claude" },
      { piModel: "openai-codex/gpt-5.6-sol", nativeModel: "live-claude" },
    );
    expect(claude.candidate).toMatchObject({
      runtime: "claude",
      model: "live-claude",
      context: "fresh",
      effort: "default",
      openaiFastMode: false,
    });
    expect(claude.notices).toHaveLength(4);
    expect(claude.notices.join(" ")).toContain("Fast mode");

    const writer = updateCandidateControls(
      candidate("claude-opus-5", {
        host: "herdr",
        runtime: "claude",
        writeIntent: "read-only",
        closeOnReport: false,
      }),
      { writeIntent: "writer" },
      { piModel: "openai-codex/gpt-5.6-sol" },
    );
    expect(writer.candidate).toMatchObject({ writeIntent: "writer", closeOnReport: true });
  });

  it("keeps retained readers valid while rejecting retained writers, fork, and parent misuse", () => {
    expect(
      candidateValidationError(
        candidate("claude-opus-5", {
          host: "herdr",
          runtime: "claude",
          writeIntent: "read-only",
          closeOnReport: false,
        }),
      ),
    ).toBeUndefined();
    expect(
      candidateValidationError(
        candidate("claude-opus-5", {
          host: "herdr",
          runtime: "claude",
          writeIntent: "writer",
          closeOnReport: false,
        }),
      ),
    ).toContain("Herdr read-only");
    expect(candidateValidationError(candidate("parent", { host: "herdr" }))).toContain("Local Pi");
    expect(
      candidateValidationError(candidate("openai/model", { runtime: "codex", context: "fork" })),
    ).toContain("Fork");
  });

  it("uses exact runtime capabilities and resets effort or fast mode when a model cannot use them", () => {
    expect(candidateValidationError(candidate("parent", { openaiFastMode: true }))).toBeUndefined();
    expect(
      candidateValidationError(candidate("other-provider/plain", { openaiFastMode: true })),
    ).toContain("Fast mode");
    expect(
      candidateValidationError(
        candidate("future-codex", { runtime: "codex", openaiFastMode: true }),
      ),
    ).toBeUndefined();
    expect(
      candidateValidationError(
        candidate("claude-opus-5", { runtime: "claude", openaiFastMode: true }),
      ),
    ).toContain("Fast mode");
    expect(runtimeEfforts("claude")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(runtimeEfforts("codex")).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(runtimeEfforts("claude", ["minimal", "low", "high"])).toEqual(["low", "high"]);
    expect(
      candidateValidationError(
        candidate("claude-opus-5", { runtime: "claude", effort: "minimal" }),
      ),
    ).toContain("does not support the minimal reasoning level");
    expect(
      decodeSubagentConfig({
        version: 4,
        profiles: {
          reviewer: candidate("claude-opus-5", { runtime: "claude", effort: "minimal" }),
        },
      }).invalidProfileRoutes,
    ).toContain("reviewer");
    const update = updateCandidateModel(
      candidate("openai-codex/gpt-5.6-sol", { effort: "xhigh", openaiFastMode: true }),
      "zai/plain",
      ["off"],
      false,
    );
    expect(update.candidate).toMatchObject({
      model: "zai/plain",
      effort: "default",
      openaiFastMode: false,
    });
    expect(update.notices.join(" ")).toContain("profile default");
    expect(update.notices.join(" ")).toContain("does not support fast mode");
  });

  it("rejects unsafe native selectors with the same bounded config rules", () => {
    expect(
      decodeSubagentConfig(
        {
          version: 6,
          defaultProfileSet: "default",
          profileSets: {
            default: { profiles: { reviewer: candidate("cursor/gpt-5.5@1m") } },
          },
        },
        "global",
      ).invalidProfileRoutes,
    ).not.toContain("reviewer");
    for (const runtime of ["pi", "claude", "codex"] as const) {
      const model = runtime === "pi" ? "provider/model,(glob)*" : "model,(glob)*";
      expect(candidateValidationError(candidate(model, { runtime }))).toContain("valid");
      expect(updateCandidateModel(candidate("openai/model", { runtime }), model).candidate).toBe(
        undefined,
      );
    }
    expect(updateCandidateControls(candidate("parent"), { host: "herdr" }, {}).error).toContain(
      "Check that Pi is signed in",
    );
  });
});
