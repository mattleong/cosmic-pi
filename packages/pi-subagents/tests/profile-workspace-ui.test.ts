import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vitest";
import { resolveSubagentConfig } from "../src/config/options.ts";
import { decodeSubagentConfig } from "../src/config/schema.ts";
import { PROFILE_IDS, type ProfileCandidate, type ProfileId } from "../src/profiles/model.ts";
import { makeSessionProfileSnapshot } from "../src/profiles/session-overrides.ts";
import type { ProfileSettingsInspection } from "../src/settings/profile-route-editor.ts";
import {
  candidateFieldChoices,
  candidateFieldRows,
  targetProfileRouteDraft,
} from "../src/settings/ui/profile-workspace-model.ts";
import {
  renderProfileWorkspace,
  type ProfileWorkspaceRenderState,
} from "../src/settings/ui/profile-workspace-render.ts";
import { makeProfileSearchSelector } from "../src/settings/ui/profile-workspace-selectors.ts";

// SAFETY: The pure renderer uses only the Theme methods implemented by this fixture.
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

const routeOption = (
  model: string,
  overrides: Partial<ProfileCandidate> = {},
): ProfileCandidate => ({
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

const route = [
  routeOption("openai/primary"),
  routeOption("claude-fallback", { host: "herdr", runtime: "claude" }),
  routeOption("codex-fallback", { runtime: "codex", writeIntent: "writer" }),
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
  const global = decodeSubagentConfig(globalDocument, "global");
  const config = resolveSubagentConfig({
    globalConfigPath: "/agent/pi-subagents.json",
    projectConfigPath: "/repo/.pi/pi-subagents.json",
    projectTrusted: true,
    globalConfigExists: true,
    projectConfigExists: false,
    global,
  });
  return { config, global, globalDocument, session: makeSessionProfileSnapshot(config) };
};

const targetAwareInspection = (): ProfileSettingsInspection => {
  const saved = inspection([routeOption("openai/saved-only-4x8v")]);
  const baseline = {
    ...saved.session.baseline,
    profiles: {
      ...saved.session.baseline.profiles,
      worker: { candidates: [routeOption("openai/session-only-9q7z")] },
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

const inheritedInvalidTargetInspection = (): ProfileSettingsInspection => {
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
  const projectDocument = Schema.decodeUnknownSync(JsonObjectSchema)({
    version: 6,
    defaultProfileSet: "partial",
    profileSets: { partial: { profiles: {} } },
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

const indexOfProfile = (profile: ProfileId): number => PROFILE_IDS.indexOf(profile);

const state = (
  overrides: Partial<ProfileWorkspaceRenderState> = {},
): ProfileWorkspaceRenderState => ({
  inspection: inspection(),
  target: { kind: "session" },
  scope: "session",
  projectTrusted: true,
  parentEffort: "high",
  parentModel: "openai/parent",
  pane: "profiles",
  profileIndex: indexOfProfile("worker"),
  candidateIndex: 0,
  fieldIndex: 0,
  draft: { kind: "inherit", candidates: route },
  busy: false,
  cancellableBusy: false,
  ...overrides,
});

const render = (overrides: Partial<ProfileWorkspaceRenderState>, width: number, height: number) =>
  renderProfileWorkspace(state(overrides), { theme, width, height });

const expectBounded = (lines: ReadonlyArray<string>, width: number, height: number) => {
  expect(lines).toHaveLength(height);
  expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
};

describe("profile workspace state projection", () => {
  it("offers every supported host and runtime combination", () => {
    expect(
      candidateFieldChoices(routeOption("openai/primary"), "runWith", {}).map(
        (choice) => choice.value,
      ),
    ).toEqual([
      "local/pi",
      "local/claude",
      "local/codex",
      "herdr/pi",
      "herdr/claude",
      "herdr/codex",
    ]);
  });

  it("exposes advanced state only when the candidate supports or requests it", () => {
    const advancedCandidate = routeOption("openai/primary", {
      host: "herdr",
      openaiFastMode: true,
      closeOnReport: false,
    });
    const collapsedFields = candidateFieldRows(
      advancedCandidate,
      "worker",
      "high",
      undefined,
      false,
    ).map((row) => row.field);
    const expandedFields = candidateFieldRows(
      advancedCandidate,
      "worker",
      "high",
      undefined,
      true,
    ).map((row) => row.field);

    expect(collapsedFields).toContain("advanced");
    expect(collapsedFields).not.toContain("openaiFastMode");
    expect(collapsedFields).not.toContain("closeOnReport");
    expect(expandedFields).toEqual(
      expect.arrayContaining(["advanced", "openaiFastMode", "closeOnReport"]),
    );

    const claudeFields = candidateFieldRows(
      routeOption("claude/local", { runtime: "claude" }),
      "worker",
      "high",
      undefined,
      true,
    ).map((row) => row.field);
    expect(claudeFields).not.toContain("advanced");
    expect(claudeFields).not.toContain("openaiFastMode");
    expect(claudeFields).not.toContain("closeOnReport");
  });

  it("uses the edited target rather than the session baseline for route selection and search", () => {
    const value = targetAwareInspection();
    const target = {
      kind: "profile-set" as const,
      set: { scope: "global" as const, name: "work" },
    };

    expect(targetProfileRouteDraft(value, target, "worker").candidates[0]?.model).toBe(
      "openai/saved-only-4x8v",
    );
    expect(targetProfileRouteDraft(value, { kind: "session" }, "worker").candidates[0]?.model).toBe(
      "openai/session-only-9q7z",
    );

    const selectSaved = vi.fn();
    const savedSearch = makeProfileSearchSelector({
      theme,
      inspection: value,
      current: "worker",
      parentEffort: "high",
      target,
      initialQuery: "4x8v",
      getHeight: () => 20,
      requestRender: () => {},
      select: selectSaved,
      cancel: () => {},
    });
    savedSearch.handleInput("\r");
    expect(selectSaved).toHaveBeenCalledWith("worker");

    const selectSessionOnly = vi.fn();
    const sessionOnlySearch = makeProfileSearchSelector({
      theme,
      inspection: value,
      current: "worker",
      parentEffort: "high",
      target,
      initialQuery: "9q7z",
      getHeight: () => 20,
      requestRender: () => {},
      select: selectSessionOnly,
      cancel: () => {},
    });
    sessionOnlySearch.handleInput("\r");
    expect(selectSessionOnly).not.toHaveBeenCalled();
  });

  it("keeps inherited fail-closed profiles invalid in the edited target", () => {
    const value = inheritedInvalidTargetInspection();
    const target = {
      kind: "profile-set" as const,
      set: { scope: "project" as const, name: "partial" },
    };

    expect(targetProfileRouteDraft(value, target, "worker")).toEqual({
      kind: "invalid",
      candidates: [],
    });
  });

  it("bounds rendering for normal, editing, confirmation, error, and invalid states", () => {
    const invalidValue = inheritedInvalidTargetInspection();
    const invalidTarget = {
      kind: "profile-set" as const,
      set: { scope: "project" as const, name: "partial" },
    };
    const longModel = `openai/${"m".repeat(249)}`;
    const states: ReadonlyArray<Partial<ProfileWorkspaceRenderState>> = [
      {},
      { pane: "fields", advancedExpanded: true },
      {
        pendingConfirmation: {
          title: "Undo changes?",
          detail: `Discard ${longModel}`,
          preview: [longModel],
        },
      },
      { message: { kind: "error", text: `Save failed for ${longModel}` } },
      {
        inspection: invalidValue,
        target: invalidTarget,
        scope: "project",
        draft: targetProfileRouteDraft(invalidValue, invalidTarget, "worker"),
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
