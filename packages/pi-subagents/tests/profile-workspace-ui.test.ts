import { visibleWidth } from "@earendil-works/pi-tui";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vitest";
import {
  inheritedInvalidInspection,
  makeProfileSettingsInspection,
} from "./fixtures/profile-settings-inspection.ts";
import { plainTheme } from "pi-cosmic-core/testing";
import { profileCandidate } from "./fixtures/profiles.ts";
import { PROFILE_IDS, type ProfileCandidate, type ProfileId } from "../src/profiles/model.ts";
import { makeSessionProfileSnapshot } from "../src/profiles/session-overrides.ts";
import {
  loadProfileRouteDraft,
  type ProfileSettingsInspection,
} from "../src/settings/profile-route-editor.ts";
import {
  selectCandidateField,
  candidateFieldRows,
} from "../src/settings/ui/profile-workspace-model.ts";
import {
  renderProfileWorkspace,
  workspaceCandidateSummary,
  type ProfileWorkspaceRenderState,
} from "../src/settings/ui/profile-workspace-render.ts";
import { profileWorkspaceRows } from "../src/settings/ui/profile-workspace-rows.ts";
import {
  makeProfileSearchSelector,
  type ProfileSearchSelectorOptions,
} from "../src/settings/ui/profile-workspace-selectors.ts";

const route = [
  profileCandidate("openai/primary"),
  profileCandidate("claude-fallback", { runtime: "claude" }),
  profileCandidate("codex-fallback", { runtime: "codex", writeIntent: "writer" }),
];

const inspection = (
  workerRoute: ReadonlyArray<ProfileCandidate> = route,
): ProfileSettingsInspection => {
  const JsonObjectSchema = Schema.Record(Schema.String, Schema.MutableJson);
  const globalDocument = Schema.decodeUnknownSync(JsonObjectSchema)({
    version: 6,
    defaultProfileSet: "work",
    profileSets: { work: { profiles: { worker: workerRoute } } },
  });
  return makeProfileSettingsInspection({
    globalDocument,
    projectTrusted: true,
  });
};

const targetAwareInspection = (): ProfileSettingsInspection => {
  const saved = inspection([profileCandidate("openai/saved-only-4x8v")]);
  const baseline = {
    ...saved.session.baseline,
    profiles: {
      ...saved.session.baseline.profiles,
      worker: { candidates: [profileCandidate("openai/session-only-9q7z")] },
    },
  };
  return {
    ...saved,
    session: makeSessionProfileSnapshot(saved.config, {
      revision: 1,
      overrides: {},
      baseline,
    }),
  };
};

const indexOfProfile = (profile: ProfileId): number => PROFILE_IDS.indexOf(profile);

const state = (
  overrides: Partial<ProfileWorkspaceRenderState> = {},
): ProfileWorkspaceRenderState => ({
  inspection: inspection(),
  target: { kind: "session" },
  parentEffort: "high",
  parentModel: "openai/parent",
  pane: "profiles",
  profileIndex: indexOfProfile("worker"),
  candidateIndex: 0,
  fieldIndex: 0,
  draft: { kind: "inherit", candidates: route },
  expandedCandidates: new Set(),
  busy: false,
  cancellableBusy: false,
  ...overrides,
});

const render = (overrides: Partial<ProfileWorkspaceRenderState>, width: number, height: number) =>
  renderProfileWorkspace(state(overrides), { theme: plainTheme, width, height });

const search = (overrides: Partial<ProfileSearchSelectorOptions>) =>
  makeProfileSearchSelector({
    theme: plainTheme,
    inspection: inspection(),
    current: "worker",
    parentEffort: "high",
    target: { kind: "session" },
    initialQuery: "",
    getHeight: () => 24,
    requestRender: () => {},
    cancel: vi.fn(),
    select: vi.fn(),
    ...overrides,
  });

const fields = (candidate: ProfileCandidate, expanded: boolean) =>
  candidateFieldRows(candidate, "worker", "high", undefined, expanded);

const expectBounded = (lines: ReadonlyArray<string>, width: number, height: number) => {
  expect(lines).toHaveLength(height);
  expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
};

describe("profile workspace state projection", () => {
  it("projects one row sequence while keeping per-candidate expansion independent", () => {
    const rows = profileWorkspaceRows(
      { kind: "explicit", candidates: route },
      "worker",
      "high",
      undefined,
      new Set([1]),
    );
    expect(rows.filter((row) => row.field === "model").map((row) => row.candidateIndex)).toEqual([
      0, 1, 2,
    ]);
    expect(rows.filter((row) => row.field === "context").map((row) => row.candidateIndex)).toEqual([
      1,
    ]);
    expect(rows.findIndex((row) => row.candidateIndex === 2)).toBeGreaterThan(
      rows.findIndex((row) => row.candidateIndex === 1),
    );
  });

  it("preserves the effective default effort when a long model must be truncated", () => {
    const candidate = profileCandidate(`test/${"long".repeat(60)}`, { effort: "default" });
    const summary = workspaceCandidateSummary(
      candidate,
      "worker",
      "low",
      40,
      undefined,
      plainTheme,
    );
    expect(visibleWidth(summary)).toBeLessThanOrEqual(40);
    expect(summary).toContain("high (profile default)");
    expect(summary).not.toContain(candidate.model);
  });
  it("keeps the focused model visible after successful saves on short terminals", () => {
    for (const height of [4, 5, 6, 8]) {
      const lines = render(
        { pane: "fields", message: { kind: "success", text: "Saved" } },
        80,
        height,
      );
      expectBounded(lines, 80, height);
      expect(lines.join("\n")).toContain(route[0]!.model);
    }
  });

  it("cancels profile search once without selecting or changing the current profile", () => {
    for (const initialQuery of ["", "worker"]) {
      const cancel = vi.fn();
      const select = vi.fn();
      search({ current: "scout", initialQuery, cancel, select }).handleInput("\u001b");
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(select).not.toHaveBeenCalled();
    }
  });

  it("accepts local selections and rejects stale remote choices without changing the candidate", () => {
    for (const runtime of ["pi", "claude", "codex"] as const) {
      const candidate = profileCandidate(runtime === "pi" ? "parent" : "native", { runtime });
      const before = structuredClone(candidate);
      expect(selectCandidateField(candidate, "runWith", `local/${runtime}`, {}).candidate).toEqual(
        before,
      );
      expect(
        selectCandidateField(candidate, "runWith", `herdr/${runtime}`, {}).candidate,
      ).toBeUndefined();
      expect(candidate).toEqual(before);
    }
  });

  it("collapses advanced controls without dropping unsupported settings", () => {
    const advancedCandidate = profileCandidate("openai/primary", {
      openaiFastMode: true,
    });
    const collapsedFields = fields(advancedCandidate, false).map((row) => row.field);
    const expandedFields = fields(advancedCandidate, true).map((row) => row.field);

    expect(collapsedFields).toContain("advanced");
    expect(collapsedFields).not.toContain("openaiFastMode");
    expect(collapsedFields).not.toContain("closeOnReport");
    expect(expandedFields).toEqual(expect.arrayContaining(["advanced", "openaiFastMode"]));

    const fixed = fields(profileCandidate("claude/local", { runtime: "claude" }), true);
    expect(fixed.map((row) => row.field)).toEqual(
      expect.arrayContaining(["advanced", "context", "openaiFastMode"]),
    );
    expect(fixed.find((row) => row.field === "context")?.fixed).toBe(true);
  });

  it("uses the edited target rather than the session baseline for route selection and search", () => {
    const value = targetAwareInspection();
    const target = {
      kind: "profile-set" as const,
      set: { scope: "global" as const, name: "work" },
    };

    expect(loadProfileRouteDraft(value, target, "worker").candidates[0]?.model).toBe(
      "openai/saved-only-4x8v",
    );
    expect(loadProfileRouteDraft(value, { kind: "session" }, "worker").candidates[0]?.model).toBe(
      "openai/session-only-9q7z",
    );

    const selectSaved = vi.fn();
    const shared = { inspection: value, target, getHeight: () => 20 };
    search({ ...shared, initialQuery: "4x8v", select: selectSaved }).handleInput("\r");
    expect(selectSaved).toHaveBeenCalledWith("worker");

    const selectSessionOnly = vi.fn();
    search({ ...shared, initialQuery: "9q7z", select: selectSessionOnly }).handleInput("\r");
    expect(selectSessionOnly).not.toHaveBeenCalled();
  });

  it("bounds rendering for normal, editing, confirmation, error, and invalid states", () => {
    const invalidValue = inheritedInvalidInspection();
    const invalidTarget = {
      kind: "profile-set" as const,
      set: { scope: "project" as const, name: "partial" },
    };
    const longModel = `openai/${"m".repeat(249)}`;
    const states: ReadonlyArray<Partial<ProfileWorkspaceRenderState>> = [
      {},
      { pane: "fields", expandedCandidates: new Set([0]) },
      { pane: "profiles", saveFocused: true },
      { pane: "fields", saveFocused: true },
      {
        pendingConfirmation: {
          title: "Undo changes?",
          detail: `Discard ${longModel}`,
        },
      },
      { message: { kind: "error", text: `Save failed for ${longModel}` } },
      {
        inspection: invalidValue,
        target: invalidTarget,
        draft: loadProfileRouteDraft(invalidValue, invalidTarget, "worker"),
      },
    ];

    for (const [width, height] of [
      [120, 24],
      [80, 12],
      [48, 5],
      [1, 3],
    ] as const) {
      for (const overrides of states)
        expectBounded(render(overrides, width, height), width, height);
    }
    expect(render({}, 0, 5)).toEqual([]);
  });
});
