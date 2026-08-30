import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { resolveSubagentConfig } from "../src/config/options.ts";
import { decodeSubagentConfig } from "../src/config/schema.ts";
import { PROFILE_DEFINITIONS } from "../src/profiles/definitions.ts";
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

const output = (lines: ReadonlyArray<string>) => lines.join("\n");

const expectBounded = (lines: ReadonlyArray<string>, width: number, height: number) => {
  expect(lines).toHaveLength(height);
  expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
};

describe("profile workspace responsive projection", () => {
  it("renders a split list/detail view at 100 columns and keeps the description visible", () => {
    const lines = render({}, 120, 24);
    const text = output(lines);

    expectBounded(lines, 120, 24);
    expect(text).toContain("Current Session · based on Global/work · no changes");
    expect(text).toContain("Profiles");
    expect(text).toContain(PROFILE_DEFINITIONS.worker.description);
    expect(text).toContain("Primary");
    expect(text).toContain("Fallback 1");
    expect(text).toContain("Fallback 2");
    expect(lines.some((line) => (line.match(/│/gu) ?? []).length >= 3)).toBe(true);
  });

  it("renders a stacked dashboard below 100 columns", () => {
    const lines = render({}, 80, 24);
    const text = output(lines);

    expectBounded(lines, 80, 24);
    expect(text).toContain("Profiles");
    expect(text).toContain(PROFILE_DEFINITIONS.worker.description);
    expect(text).toContain("Primary");
  });

  it("keeps narrow and very short views bounded with identity, safety, and description", () => {
    const narrow = render({ projectTrusted: false }, 48, 12);
    expectBounded(narrow, 48, 12);
    expect(output(narrow)).toContain("Focused implementation and validation");
    expect(output(narrow)).toContain("approved task.");

    const short = render({ projectTrusted: false }, 48, 5);
    expectBounded(short, 48, 5);
    expect(output(short)).toContain("Trust this project to edit Project sets");
    expect(output(short)).toContain("worker");
  });

  it("bounds long confirmations and messages in every responsive layout", () => {
    const longModel = `openai/${"m".repeat(249)}`;
    expect(longModel).toHaveLength(256);
    const pendingConfirmation = {
      title: "Restore worker to its Current Session starting point?",
      detail:
        "This discards changes to this profile and restores its Current Session starting point. Active runs do not change.",
      preview: [
        `Current settings custom · Primary only · ${longModel}`,
        "Starting point  invalid, won't run until fixed",
      ],
    };

    for (const width of [48, 80, 100, 120]) {
      const confirmation = render({ pendingConfirmation }, width, 9);
      expectBounded(confirmation, width, 9);
      const text = output(confirmation);
      expect(text).toContain("Confirm");
      expect(text).toContain("Current Session starting point");
      expect(text).toContain("Enter confirms · Esc cancels");

      const message = render(
        { message: { kind: "error", text: `Save failed for ${longModel}` } },
        width,
        9,
      );
      expectBounded(message, width, 9);
      expect(output(message)).toContain("Save failed");
    }
  });

  it("keeps confirmation title, destructive detail, and confirm hint at short heights", () => {
    const lines = render(
      {
        pendingConfirmation: {
          title: "Disable worker?",
          detail: "No later launch can use this profile.",
        },
      },
      48,
      5,
    );

    expectBounded(lines, 48, 5);
    const text = output(lines);
    expect(text).toContain("Confirm · Disable worker?");
    expect(text).toContain("No later launch can use this profile.");
    expect(text).toContain("Enter confirms · Esc cancels");
  });

  it("offers all six host and runtime combinations through Run with", () => {
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

  it("shows essential candidate settings first and keeps advanced settings behind one row", () => {
    const collapsed = output(
      render({ pane: "fields", fieldIndex: 0, advancedExpanded: false }, 120, 24),
    );
    const labels = ["Model", "Reasoning", "File access", "Run with", "Advanced", "Actions"];
    for (let index = 1; index < labels.length; index += 1)
      expect(collapsed.indexOf(labels[index]!)).toBeGreaterThan(
        collapsed.indexOf(labels[index - 1]!),
      );
    expect(collapsed).not.toContain("After reporting");

    const advancedCandidate = routeOption("openai/primary", {
      host: "herdr",
      openaiFastMode: true,
      closeOnReport: false,
    });
    const expanded = output(
      render(
        {
          pane: "fields",
          advancedExpanded: true,
          draft: { kind: "explicit", candidates: [advancedCandidate] },
        },
        120,
        26,
      ),
    );
    expect(expanded).toContain("OpenAI fast mode");
    expect(expanded).toContain("After reporting");
  });

  it("omits Advanced when the route has no advanced fields", () => {
    const candidate = routeOption("claude/local", { runtime: "claude" });
    expect(
      candidateFieldRows(candidate, "worker", "high", undefined, true).map((row) => row.field),
    ).toEqual(["model", "effort", "writeIntent", "runWith", "actions"]);

    const text = output(
      render(
        {
          pane: "fields",
          advancedExpanded: true,
          draft: { kind: "explicit", candidates: [candidate] },
        },
        120,
        24,
      ),
    );
    for (const label of ["Model", "Reasoning", "File access", "Run with", "Actions"])
      expect(text).toContain(label);
    expect(text).not.toContain("Advanced");
  });

  it("summarizes the edited saved set in the profile list and search", () => {
    const saved = targetAwareInspection();
    const target = {
      kind: "profile-set" as const,
      set: { scope: "global" as const, name: "work" },
    };
    const savedDraft = {
      kind: "explicit" as const,
      candidates: [routeOption("openai/saved-only-4x8v")],
    };
    const list = output(
      render({ inspection: saved, target, scope: "global", draft: savedDraft }, 120, 24),
    );
    expect(list).toContain("openai/saved-only-4x8v");
    expect(list).not.toContain("openai/session-only-9q7z");

    const search = makeProfileSearchSelector({
      theme,
      inspection: saved,
      current: "worker",
      parentEffort: "high",
      target,
      initialQuery: "4x8v",
      getHeight: () => 20,
      requestRender: () => {},
      select: () => {},
      cancel: () => {},
    });
    search.handleInput("\u001b");
    search.handleInput("?");
    const searchText = output(search.render(120));
    expect(searchText).toContain("worker");
    expect(searchText).toContain("custom · openai/saved-only-4x8v");
    expect(searchText).not.toContain("openai/session-only-9q7z");

    const sessionOnlySearch = makeProfileSearchSelector({
      theme,
      inspection: saved,
      current: "worker",
      parentEffort: "high",
      target,
      initialQuery: "9q7z",
      getHeight: () => 20,
      requestRender: () => {},
      select: () => {},
      cancel: () => {},
    });
    expect(output(sessionOnlySearch.render(120))).toContain("No matching profiles");
  });

  it("shows inherited fail-closed saved-set profiles as invalid in list, search, and detail", () => {
    const value = inheritedInvalidTargetInspection();
    const target = {
      kind: "profile-set" as const,
      set: { scope: "project" as const, name: "partial" },
    };
    const draft = targetProfileRouteDraft(value, target, "worker");
    expect(draft).toEqual({ kind: "invalid", candidates: [] });

    const text = output(
      render(
        {
          inspection: value,
          target,
          scope: "project",
          profileIndex: indexOfProfile("worker"),
          draft,
        },
        120,
        24,
      ),
    );
    expect(text).toContain("worker");
    expect(text).toContain("invalid, won't run until fixed");
    expect(text).toContain("Invalid profile, won't run until fixed");
    expect(text).not.toContain("Profile disabled");

    const search = makeProfileSearchSelector({
      theme,
      inspection: value,
      current: "worker",
      parentEffort: "high",
      target,
      initialQuery: "until fixed",
      getHeight: () => 20,
      requestRender: () => {},
      select: () => {},
      cancel: () => {},
    });
    search.handleInput("\u001b");
    search.handleInput("?");
    const searchText = output(search.render(120));
    expect(searchText).toContain("worker");
    expect(searchText).toContain("invalid, won't run until fixed");
    expect(searchText).not.toContain("disabled");
  });

  it("states that saved-set editing leaves Current Session unchanged", () => {
    const text = output(
      render(
        {
          target: { kind: "profile-set", set: { scope: "project", name: "review" } },
          scope: "project",
        },
        120,
        20,
      ),
    );
    expect(text).toContain("Saved set · Project/review · Current Session unchanged");
    expect(text).not.toContain("reload required");
  });

  it("keeps the main footer quiet and sends route changes to Actions", () => {
    const main = output(render({}, 120, 20));
    expect(main).toContain("Enter Edit");
    expect(main).toContain("p Profile sets");
    expect(main).toContain("Esc Close");
    expect(main).not.toContain("1/2/3");
    expect(main).not.toContain("Clone");
    expect(main).not.toContain("Remove");

    const fields = output(render({ pane: "fields", fieldIndex: 5 }, 120, 20));
    expect(fields).toContain("Actions");
  });
});
