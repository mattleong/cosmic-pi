import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { resolveSubagentConfig } from "../src/config/options.ts";
import { decodeSubagentConfig } from "../src/config/schema.ts";
import { PROFILE_IDS, type ProfileCandidate, type ProfileId } from "../src/profiles/model.ts";
import { makeSessionProfileSnapshot } from "../src/profiles/session-overrides.ts";
import type { ProfileSettingsInspection } from "../src/settings/profile-route-editor.ts";
import {
  renderProfileWorkspace,
  type ProfileWorkspaceRenderState,
} from "../src/settings/ui/profile-workspace-render.ts";

// SAFETY: The pure renderer uses only the two Theme methods implemented by this fixture.
const renderTheme = {
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

const globalRoute = [
  routeOption("openai/primary"),
  routeOption("claude-fallback", { host: "herdr", runtime: "claude" }),
  routeOption("codex-fallback", { runtime: "codex", writeIntent: "writer" }),
];

const inspection = (): ProfileSettingsInspection => {
  const JsonObjectSchema = Schema.Record(Schema.String, Schema.MutableJson);
  const globalDocument = Schema.decodeUnknownSync(JsonObjectSchema)({
    version: 6,
    defaultProfileSet: "global-work",
    profileSets: {
      "global-work": {
        profiles: {
          reviewer: globalRoute,
          worker: globalRoute,
        },
      },
    },
  });
  const projectDocument = Schema.decodeUnknownSync(JsonObjectSchema)({
    version: 6,
    defaultProfileSet: "project-work",
    profileSets: {
      "project-work": {
        profiles: {
          reviewer: routeOption("openai/project-reviewer"),
        },
      },
    },
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

const profileIndex = (profile: ProfileId): number => PROFILE_IDS.indexOf(profile);

const renderState = (
  overrides: Partial<ProfileWorkspaceRenderState> = {},
): ProfileWorkspaceRenderState => ({
  inspection: inspection(),
  target: { kind: "profile-set", set: { scope: "global", name: "global-work" } },
  scope: "global",
  projectTrusted: true,
  parentEffort: "high",
  parentModel: "openai/parent",
  pane: "profiles",
  profileIndex: profileIndex("worker"),
  candidateIndex: 0,
  fieldIndex: 0,
  draft: { kind: "explicit", candidates: globalRoute },
  busy: false,
  cancellableBusy: false,
  reloadRequired: false,
  ...overrides,
});

const render = (
  overrides: Partial<ProfileWorkspaceRenderState>,
  width = 120,
  height = 28,
): string[] =>
  renderProfileWorkspace(renderState(overrides), { theme: renderTheme, width, height });

const joined = (lines: ReadonlyArray<string>): string => lines.join("\n");

describe("profile workspace projection", () => {
  it("shows the scope dashboard and marks an unavailable Project scope", () => {
    const output = joined(render({ pane: "profiles", projectTrusted: false }));

    expect(output).toContain("1 Session · 2 Project · 3 Global");
    expect(output).toContain("Current  3 Global");
    expect(output).toContain("Project unavailable (trust required)");
    expect(output).toContain("s Sets");
    expect(output).toContain("[S] Session > [P] Project > [G] Global > [B] Built-in");
  });

  it("presents route priority and fields in task order", () => {
    const route = joined(render({ pane: "candidates", profileIndex: profileIndex("worker") }));
    expect(route).toContain("Routing order");
    expect(route).toContain("Primary");
    expect(route).toContain("Fallback 1");
    expect(route).toContain("Fallback 2");
    expect(route).toContain("Add fallback");
    expect(route).toContain("Clone fallback");
    expect(route).toContain("Remove route option");

    const fields = joined(
      render({ pane: "fields", profileIndex: profileIndex("worker"), candidateIndex: 1 }),
    );
    expect(fields).toContain("worker › Fallback 1");
    const labels = [
      "Runtime",
      "Model",
      "Effort",
      "File access",
      "Host",
      "Context",
      "OpenAI fast mode",
      "Report policy",
    ];
    for (let index = 1; index < labels.length; index += 1)
      expect(fields.indexOf(labels[index]!)).toBeGreaterThan(fields.indexOf(labels[index - 1]!));
  });

  it("projects confirmation through Enter and Esc instead of the action key", () => {
    const output = joined(
      render({
        pane: "candidates",
        pendingConfirmation: {
          title: "Remove candidate 1 from worker?",
          detail: "This is the last candidate. Removing it disables the route after reload.",
        },
      }),
    );

    expect(output).toContain("Remove route option · Primary");
    expect(output).toContain("Enter confirms · Esc cancels");
    expect(output).not.toContain("Press x again");
  });

  it("describes Project shadowing profile by profile", () => {
    const shadowed = joined(
      render({ pane: "candidates", profileIndex: profileIndex("reviewer") }, 160, 30),
    );
    expect(shadowed).toContain("Project declarations override Global profile by profile");
    expect(shadowed).toContain("Omitted Project profiles inherit Global");
    expect(shadowed).toContain("shadowed only for reviewer");

    const inherited = joined(
      render({ pane: "candidates", profileIndex: profileIndex("worker") }, 160, 30),
    );
    expect(inherited).not.toContain("shadowed only for worker");
  });

  it("keeps compact pages bounded with status, selection, and essential controls", () => {
    const cases: ReadonlyArray<Partial<ProfileWorkspaceRenderState>> = [
      { pane: "profiles", projectTrusted: false, reloadRequired: true },
      { pane: "candidates", candidateIndex: 1, reloadRequired: true },
      { pane: "fields", candidateIndex: 1, fieldIndex: 3, reloadRequired: true },
    ];

    for (const state of cases) {
      const width = 80;
      const height = 6;
      const lines = render(state, width, height);
      const output = joined(lines);
      expect(lines).toHaveLength(height);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(output).toContain("reload");
      if (state.pane === "profiles") expect(output).toContain("s Sets");
      expect(output).toContain("Enter");
      expect(output).toContain("Esc");
      expect(output).toMatch(/worker|Fallback 1|File access/);
    }
  });
});
