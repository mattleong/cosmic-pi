import { describe, expect, it } from "vitest";
import type { SubagentConfigScope } from "../src/config/store.ts";
import { BUILTIN_PROFILE_ROUTES } from "../src/profiles/definitions.ts";
import type { DeclaredProfileRoute, ProfileId } from "../src/profiles/model.ts";
import {
  declaredRouteForDraft,
  disableRouteDraft,
  loadProfileRouteDraft,
  updateCandidateModel,
  type ProfileSettingsInspection,
} from "../src/settings/profile-route-editor.ts";
import { jsonObject, profileSettingsInspection } from "./fixtures/profile-settings-inspection.ts";
import { profileCandidate as candidate } from "./fixtures/profiles.ts";

type ProfileSetSeed = Readonly<Record<string, DeclaredProfileRoute>>;

const currentDocument = (profiles: ProfileSetSeed) =>
  jsonObject({
    version: 6,
    defaultProfileSet: "default",
    profileSets: { default: { profiles } },
  });

const inspection = (
  global: ProfileSetSeed = {},
  project?: ProfileSetSeed,
): ProfileSettingsInspection => {
  return profileSettingsInspection({
    globalDocument: currentDocument(global),
    projectDocument: project ? currentDocument(project) : undefined,
    projectTrusted: true,
  });
};

const load = (
  value: ProfileSettingsInspection,
  profile: ProfileId,
  scope: SubagentConfigScope = "global",
) =>
  loadProfileRouteDraft(value, { kind: "profile-set", set: { scope, name: "default" } }, profile);

const threeRoute = [
  candidate("openai/one", { effort: "low" }),
  candidate("claude-opus-5", { host: "local", runtime: "claude", effort: "medium" }),
  candidate("gpt-5.6-codex", { runtime: "codex", effort: "xhigh", writeIntent: "writer" }),
];

describe("ordered profile-route editor state", () => {
  it("loads and declares a three-candidate route without collapse or reorder", () => {
    const value = inspection({ worker: threeRoute });
    const draft = load(value, "worker");
    expect(draft).toEqual({ kind: "explicit", candidates: threeRoute });
    expect(draft.candidates).not.toBe(threeRoute);
    expect(declaredRouteForDraft(draft)).toEqual({ valid: true, route: threeRoute });
    Object.assign(draft.candidates[0]!, { model: "openai/edited" });
    expect(load(value, "worker").candidates).toEqual(threeRoute);
  });

  it("models reset, inherit, disabled, and invalid fail-closed declarations distinctly", () => {
    const value = inspection(
      {
        reviewer: threeRoute,
        scout: "disabled",
        worker: { ...candidate("bare"), model: "bare" },
      },
      {},
    );
    expect(load(value, "scout")).toEqual({ kind: "disabled", candidates: [] });
    expect(load(value, "scout", "project")).toEqual({ kind: "inherit", candidates: [] });
    expect(load(value, "reviewer", "project")).toEqual({ kind: "inherit", candidates: threeRoute });
    expect(load(value, "planner")).toEqual({
      kind: "reset",
      candidates: BUILTIN_PROFILE_ROUTES.planner.candidates,
    });
    expect(load(value, "worker")).toEqual({ kind: "invalid", candidates: [] });
    expect(declaredRouteForDraft(load(value, "worker"))).toMatchObject({ valid: false });
    expect(declaredRouteForDraft(disableRouteDraft())).toEqual({
      valid: true,
      route: "disabled",
    });
    expect(declaredRouteForDraft({ kind: "reset", candidates: [] })).toEqual({ valid: true });
    expect(declaredRouteForDraft({ kind: "inherit", candidates: [] })).toEqual({ valid: true });
  });
});

describe("profile candidate normalization and validation", () => {
  it("rejects unsafe native selectors with the same bounded config rules", () => {
    for (const runtime of ["pi", "claude", "codex"] as const) {
      const model = runtime === "pi" ? "provider/model,(glob)*" : "model,(glob)*";
      expect(updateCandidateModel(candidate("openai/model", { runtime }), model).candidate).toBe(
        undefined,
      );
    }
  });
});
