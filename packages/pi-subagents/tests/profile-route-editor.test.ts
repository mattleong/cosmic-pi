import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { resolveSubagentConfig } from "../src/config/options.ts";
import { decodeSubagentConfig } from "../src/config/schema.ts";
import { isNativeProfileModelSelector, type ProfileCandidate } from "../src/profiles/model.ts";
import { makeSessionProfileSnapshot } from "../src/profiles/session-overrides.ts";
import {
  addRouteCandidate,
  candidateValidationError,
  declaredRouteForDraft,
  defaultRouteCandidate,
  disableRouteDraft,
  duplicateRouteCandidate,
  hasOwnProfileRouteDeclaration,
  inheritProjectDraft,
  loadProfileRouteDraft,
  moveRouteCandidate,
  removeRouteCandidate,
  replaceRouteCandidate,
  resetGlobalDraft,
  runtimeEfforts,
  updateCandidateControls,
  updateCandidateModel,
  type ProfileRouteDraft,
  type ProfileSettingsInspection,
} from "../src/settings/profile-route-editor.ts";

const candidate = (model: string, overrides: Partial<ProfileCandidate> = {}): ProfileCandidate => ({
  host: "local",
  runtime: "pi",
  model,
  effort: "high",
  context: "fresh",
  writeIntent: "read-only",
  openaiFastMode: false,
  closeOnReport: true,
  ...overrides,
});

interface InspectionDocumentSeed {
  readonly version: number;
  readonly profiles?: Readonly<
    Record<string, ProfileCandidate | ReadonlyArray<ProfileCandidate> | "disabled">
  >;
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
  const globalDocument = Schema.decodeUnknownSync(JsonObjectSchema)(currentDocument(global));
  const projectDocument = project
    ? Schema.decodeUnknownSync(JsonObjectSchema)(currentDocument(project))
    : undefined;
  const decodedGlobal = decodeSubagentConfig(globalDocument, "global");
  const decodedProject = projectDocument
    ? decodeSubagentConfig(projectDocument, "project")
    : undefined;
  const config = resolveSubagentConfig(
    (() => {
      const baseResult = {
        globalConfigPath: "/agent/pi-subagents.json",
        projectConfigPath: "/repo/.pi/pi-subagents.json",
        projectTrusted: true,
        globalConfigExists: true,
        projectConfigExists: project !== undefined,
        global: decodedGlobal,
      };
      const withProject = decodedProject ? { ...baseResult, project: decodedProject } : baseResult;
      return withProject;
    })(),
  );
  return (() => {
    const baseResult = {
      config,
      session: makeSessionProfileSnapshot(config),
      globalDocument,
    };
    const withProjectDocument = projectDocument ? { ...baseResult, projectDocument } : baseResult;
    const withGlobal = { ...withProjectDocument, global: decodedGlobal };
    const withProject = decodedProject ? { ...withGlobal, project: decodedProject } : withGlobal;
    return withProject;
  })();
};

const inheritedInvalidSetInspection = (
  own: "valid" | "invalid" | undefined,
): ProfileSettingsInspection => {
  const JsonObjectSchema = Schema.Record(Schema.String, Schema.MutableJson);
  const invalidRoute = {
    host: "local",
    runtime: "pi",
    model: "parent",
    effort: "impossible",
    context: "fresh",
    writeIntent: "read-only",
    openaiFastMode: false,
    closeOnReport: true,
  };
  const globalDocument = Schema.decodeUnknownSync(JsonObjectSchema)({
    version: 6,
    defaultProfileSet: "lower",
    profileSets: { lower: { profiles: { worker: invalidRoute } } },
  });
  const projectProfiles =
    own === undefined
      ? {}
      : { worker: own === "valid" ? candidate("openai/project-repair") : invalidRoute };
  const projectDocument = Schema.decodeUnknownSync(JsonObjectSchema)({
    version: 6,
    defaultProfileSet: "partial",
    profileSets: { partial: { profiles: projectProfiles } },
  });
  const global = decodeSubagentConfig(globalDocument, "global");
  const project = decodeSubagentConfig(projectDocument, "project");
  const config = resolveSubagentConfig({
    globalConfigPath: "/agent/pi-subagents.json",
    projectConfigPath: "/repo/.pi/pi-subagents.json",
    projectTrusted: true,
    globalConfigExists: true,
    projectConfigExists: true,
    global,
    project,
  });
  return {
    config,
    global,
    project,
    globalDocument,
    projectDocument,
    session: makeSessionProfileSnapshot(config),
  };
};

const threeRoute = [
  candidate("openai/one", { effort: "low" }),
  candidate("claude-opus-5", { host: "herdr", runtime: "claude", effort: "medium" }),
  candidate("gpt-5.6-codex", { runtime: "codex", effort: "xhigh", writeIntent: "writer" }),
];

describe("ordered profile-route editor state", () => {
  it("loads and declares a three-candidate route without collapse or reorder", () => {
    const value = inspection({ version: 4, profiles: { worker: threeRoute } });
    const draft = loadProfileRouteDraft(
      value,
      { kind: "profile-set", set: { scope: "global", name: "default" } },
      "worker",
    );
    expect(draft).toEqual({ kind: "explicit", candidates: threeRoute });
    expect(draft.candidates).not.toBe(threeRoute);
    expect(declaredRouteForDraft(draft)).toEqual({ valid: true, route: threeRoute });
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
    expect(
      loadProfileRouteDraft(
        value,
        { kind: "profile-set", set: { scope: "global", name: "default" } },
        "scout",
      ),
    ).toEqual({
      kind: "disabled",
      candidates: [],
    });
    expect(
      loadProfileRouteDraft(
        value,
        { kind: "profile-set", set: { scope: "project", name: "default" } },
        "reviewer",
      ),
    ).toEqual({
      kind: "inherit",
      candidates: threeRoute,
    });
    expect(
      loadProfileRouteDraft(
        value,
        { kind: "profile-set", set: { scope: "global", name: "default" } },
        "planner",
      ).kind,
    ).toBe("reset");
    expect(
      loadProfileRouteDraft(
        value,
        { kind: "profile-set", set: { scope: "global", name: "default" } },
        "worker",
      ),
    ).toEqual({
      kind: "invalid",
      candidates: [],
    });
    expect(
      declaredRouteForDraft(
        loadProfileRouteDraft(
          value,
          { kind: "profile-set", set: { scope: "global", name: "default" } },
          "worker",
        ),
      ),
    ).toMatchObject({
      valid: false,
    });
    expect(declaredRouteForDraft(disableRouteDraft())).toEqual({
      valid: true,
      route: "disabled",
    });
    expect(declaredRouteForDraft(resetGlobalDraft("worker"))).toEqual({ valid: true });
    expect(declaredRouteForDraft(inheritProjectDraft(value, "reviewer"))).toEqual({ valid: true });
  });

  it("shows inherited fail-closed routes as invalid until an explicit route repairs them", () => {
    const target = {
      kind: "profile-set" as const,
      set: { scope: "project" as const, name: "partial" },
    };
    const inherited = inheritedInvalidSetInspection(undefined);
    const draft = loadProfileRouteDraft(inherited, target, "worker");
    expect(draft).toEqual({ kind: "invalid", candidates: [] });
    expect(inheritProjectDraft(inherited, "worker")).toEqual({
      kind: "invalid",
      candidates: [],
    });
    expect(hasOwnProfileRouteDeclaration(inherited, target, "worker")).toBe(false);

    const repaired = addRouteCandidate(draft, defaultRouteCandidate("worker"));
    expect(repaired?.kind).toBe("explicit");
    expect(declaredRouteForDraft(repaired!)).toMatchObject({ valid: true });

    const ownInvalid = inheritedInvalidSetInspection("invalid");
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
    ).toEqual({
      valid: false,
      error: "A profile can have at most 32 Primary/Fallback choices.",
    });
  });
});

describe("profile candidate normalization and validation", () => {
  it("adds all six host/runtime combinations with product-valid defaults", () => {
    let draft: ProfileRouteDraft = disableRouteDraft();
    for (const host of ["local", "herdr"] as const) {
      for (const runtime of ["pi", "claude", "codex"] as const) {
        let current = candidate("parent", { effort: "default" });
        const runtimeUpdate = updateCandidateControls(
          current,
          { runtime },
          { piModel: "openai-codex/gpt-5.6-sol" },
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
        if (runtime === "claude") expect(current.model).toBe("claude-opus-5");
        if (runtime === "codex") expect(current.model).toBe("gpt-5.6-codex");
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

    const claude = updateCandidateControls(
      candidate("parent", { context: "fork", effort: "minimal", openaiFastMode: true }),
      { runtime: "claude" },
      { piModel: "openai-codex/gpt-5.6-sol" },
    );
    expect(claude.candidate).toMatchObject({
      runtime: "claude",
      model: "claude-opus-5",
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
    expect(isNativeProfileModelSelector("pi", "cursor/gpt-5.5@1m")).toBe(true);
    expect(isNativeProfileModelSelector("pi", "cursor/gpt-5.5@272k:fast")).toBe(true);
    expect(isNativeProfileModelSelector("pi", "cursor@team/gpt-5.5@1m")).toBe(true);
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
    expect(isNativeProfileModelSelector("pi", "cursor/@1m")).toBe(false);
    expect(isNativeProfileModelSelector("claude", "claude-opus-5")).toBe(true);
    expect(isNativeProfileModelSelector("claude", "opus[1m]")).toBe(true);
    expect(isNativeProfileModelSelector("claude", "claude-fable-5[200k]")).toBe(true);
    expect(isNativeProfileModelSelector("claude", "model[abc]")).toBe(false);
    expect(isNativeProfileModelSelector("codex", "gpt-5.6-codex")).toBe(true);
    expect(isNativeProfileModelSelector("codex", "-danger")).toBe(false);
    expect(isNativeProfileModelSelector("claude", "bad\u001bmodel")).toBe(false);
    expect(isNativeProfileModelSelector("codex", "model,(glob)*")).toBe(false);
    expect(isNativeProfileModelSelector("codex", "x".repeat(257))).toBe(false);
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

  it("starts additions from the complete built-in profile candidate", () => {
    expect(defaultRouteCandidate("oracle")).toEqual({
      host: "local",
      runtime: "pi",
      model: "parent",
      effort: "default",
      context: "fork",
      writeIntent: "read-only",
      closeOnReport: true,
    });
  });
});
