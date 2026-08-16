// Promise assertions are test-runner boundaries.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
import * as Schema from "effect/Schema";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { resolveSubagentConfig } from "../src/config/options.ts";
import { decodeSubagentConfig } from "../src/config/schema.ts";
import { PROFILE_IDS, type ProfileCandidate, type ProfileId } from "../src/profiles/model.ts";
import { makeSessionProfileSnapshot } from "../src/profiles/session-overrides.ts";
import {
  candidateFastModeApplied,
  candidateFieldChoices,
  candidateFieldRows,
  selectCandidateField,
} from "../src/settings/ui/profile-workspace-model.ts";
import type { CandidateModelPickerData } from "../src/settings/ui/candidate-editor.ts";
import {
  ProfileWorkspaceComponent,
  type ProfileWorkspaceSaveResult,
} from "../src/settings/ui/profile-workspace.ts";
import type { ProfileSettingsInspection } from "../src/settings/profile-route-editor.ts";

const inspection = <Global = undefined, Project = undefined>(
  global?: Global,
  project?: Project,
  trusted = true,
): ProfileSettingsInspection => {
  const globalDocument = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.MutableJson))(
    global ?? { version: 4 },
  );
  const projectDocument = project
    ? Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.MutableJson))(project)
    : undefined;
  const decodedGlobal = decodeSubagentConfig(globalDocument, "global");
  const decodedProject = projectDocument
    ? decodeSubagentConfig(projectDocument, "project")
    : undefined;
  const config = resolveSubagentConfig(
    (() => {
      const objectPart1439_0 = {
        globalConfigPath: "/agent/pi-subagents.json",
        projectConfigPath: "/repo/.pi/pi-subagents.json",
        projectTrusted: trusted,
        globalConfigExists: true,
        projectConfigExists: project !== undefined,
        global: decodedGlobal,
      };
      const objectPart1439_1 = decodedProject
        ? { ...objectPart1439_0, project: decodedProject }
        : objectPart1439_0;
      return objectPart1439_1;
    })(),
  );
  return (() => {
    const objectPart1754_0 = {
      config,
      session: makeSessionProfileSnapshot(config),
      globalDocument,
    };
    const objectPart1754_1 = projectDocument
      ? { ...objectPart1754_0, projectDocument }
      : objectPart1754_0;
    const objectPart1754_2 = { ...objectPart1754_1, global: decodedGlobal };
    const objectPart1754_3 = decodedProject
      ? { ...objectPart1754_2, project: decodedProject }
      : objectPart1754_2;
    return objectPart1754_3;
  })();
};

const candidate = (model: string, overrides: Partial<ProfileCandidate> = {}): ProfileCandidate => ({
  host: "local",
  runtime: "pi",
  model,
  effort: "high",
  context: "fresh",
  writeIntent: "read-only",
  fastMode: false,
  closeOnReport: true,
  ...overrides,
});

const input = {
  tab: "\t",
  enter: "\r",
  escape: "\u001b",
  up: "\u001b[A",
  down: "\u001b[B",
  left: "\u001b[D",
  right: "\u001b[C",
} as const;

const selectProfile = (component: ProfileWorkspaceComponent, profile: ProfileId): void => {
  const generalistIndex = PROFILE_IDS.indexOf("generalist");
  const targetIndex = PROFILE_IDS.indexOf(profile);
  const key = targetIndex < generalistIndex ? input.up : input.down;
  for (let index = 0; index < Math.abs(targetIndex - generalistIndex); index += 1)
    component.handleInput(key);
};

const selectScope = (
  component: ProfileWorkspaceComponent,
  scope: "session" | "global" | "project",
  projectTrusted = true,
): void => {
  const presses =
    scope === "global"
      ? 0
      : scope === "project"
        ? projectTrusted
          ? 1
          : 0
        : projectTrusted
          ? 2
          : 1;
  for (let index = 0; index < presses; index += 1) component.handleInput("s");
};

// SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

const modelPicker = (
  current = "parent",
  runtime: ProfileCandidate["runtime"] = "pi",
): CandidateModelPickerData => ({
  current,
  context: {
    profile: "reviewer",
    candidateIndex: 0,
    host: "local",
    runtime,
  },
  choices: [
    {
      choice: { kind: "model", selector: "anthropic/claude-opus-5" },
      item: {
        value: "anthropic/claude-opus-5",
        label: "Claude Opus",
        description: "Powerful",
      },
      searchText: "claude opus powerful",
      supportedEfforts: ["low", "medium", "high", "xhigh"],
      fastModeAvailable: false,
    },
    {
      choice: { kind: "model", selector: "anthropic/sonnet" },
      item: { value: "anthropic/sonnet", label: "Claude Sonnet", description: "Efficient" },
      searchText: "claude sonnet efficient",
      supportedEfforts: ["low", "medium", "high", "xhigh"],
      fastModeAvailable: false,
    },
  ],
});

const makeComponent = (
  value = inspection(),
  overrides: Partial<ConstructorParameters<typeof ProfileWorkspaceComponent>[0]> = {},
) => {
  const saveDraft = vi.fn().mockResolvedValue({ inspection: value });
  const loadModelPicker = vi.fn().mockResolvedValue(modelPicker());
  const reload = vi.fn().mockResolvedValue(false);
  const close = vi.fn();
  const requestRender = vi.fn();
  const clearSessionOverrides = vi.fn().mockResolvedValue({ inspection: value });
  const component = new ProfileWorkspaceComponent({
    theme,
    inspection: value,
    projectTrusted: value.config.projectTrusted,
    piModel: "openai/parent",
    parentModel: "openai-codex/gpt-5.6-sol",
    parentEffort: "xhigh",
    getHeight: () => 24,
    requestRender,
    close,
    saveDraft,
    clearSessionOverrides,
    loadModelPicker,
    supportedPiEfforts: () => ["low", "medium", "high", "xhigh"],
    fastModeAvailable: () => false,
    reload,
    ...overrides,
  });
  return {
    component,
    saveDraft,
    clearSessionOverrides,
    loadModelPicker,
    reload,
    close,
    requestRender,
  };
};

describe("profile settings workspace", () => {
  it("renders full-height width-safe wide, stacked, narrow, and tiny layouts", () => {
    for (const [width, height] of [
      [130, 24],
      [84, 20],
      [52, 14],
      [12, 4],
    ] as const) {
      const { component } = makeComponent(inspection(), { getHeight: () => height });
      const lines = component.render(width);
      expect(lines).toHaveLength(height);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      const rendered = lines.join("\n");
      expect(rendered).toContain(width > 12 ? "/subagents" : "/subagent");
      expect(rendered).toContain(width > 12 ? "generalist" : "generali");
    }
  });

  it("shows the effective effort behind profile-default inheritance", () => {
    const inherited = candidate("parent", { effort: "default" });
    expect(
      candidateFieldRows(inherited, "scout", "xhigh").find((row) => row.field === "effort")?.value,
    ).toBe("low (default)");
    expect(
      candidateFieldRows(inherited, "generalist", "xhigh").find((row) => row.field === "effort")
        ?.value,
    ).toBe("xhigh (default)");
    expect(
      candidateFieldChoices(inherited, "effort", {
        profile: "reviewer",
        parentEffort: "xhigh",
      })[0],
    ).toMatchObject({
      value: "default",
      label: "high (default)",
      description: "Use the reviewer profile default: high",
    });

    const value = inspection(
      { version: 4 },
      {
        version: 4,
        profiles: { scout: inherited },
      },
    );
    const { component } = makeComponent(value);
    selectProfile(component, "scout");
    component.handleInput(input.enter);
    expect(component.render(120).join("\n")).toContain("parent:low (default)");
    component.handleInput(input.enter);
    expect(component.render(120).join("\n")).toContain("Effort           low (default)");
  });

  it("keeps the longest field label and its edit action intact at narrow widths", () => {
    const { component } = makeComponent();
    component.handleInput(input.enter);
    component.handleInput(input.enter);
    const lines = component.render(46);
    expect(lines.every((line) => visibleWidth(line) <= 46)).toBe(true);
    const fastRow = lines.find((line) => line.includes("OpenAI fast mode"));
    expect(fastRow).toBeDefined();
    expect(fastRow).toContain("· edit");
    const modelRow = lines.find((line) => line.includes("Model"));
    expect(modelRow).toContain("· edit");
  });

  it("shows fast markers only when priority mode applies to the resolved model", () => {
    const configured = candidate("parent", { effort: "default", fastMode: true });
    expect(candidateFastModeApplied(configured, "openai-codex/gpt-5.6-sol")).toBe(true);
    expect(candidateFastModeApplied(configured, "anthropic/claude-opus-5")).toBe(false);
    expect(candidateFastModeApplied(configured)).toBe(false);
    expect(
      candidateFastModeApplied(
        { ...configured, runtime: "claude", model: "claude-opus-5" },
        "openai-codex/gpt-5.6-sol",
      ),
    ).toBe(false);

    const value = inspection({
      version: 4,
      profiles: { scout: configured },
    });
    const eligible = makeComponent(value).component.render(140).join("\n");
    expect(eligible.split("\n").find((line) => line.includes("scout"))).toContain("⚡");
    const ineligible = makeComponent(value, {
      parentModel: "anthropic/claude-opus-5",
    })
      .component.render(140)
      .join("\n");
    expect(ineligible).not.toContain("⚡");
  });

  it("uses neutral ready status, candidate terminology, and safe root navigation", () => {
    const { component, close } = makeComponent();
    const rendered = component.render(120).join("\n");
    expect(rendered).toContain("· ready");
    expect(rendered).toContain("[Global]");
    expect(rendered).toContain("Sources  [S] Session > [P] Project > [G] Global > [B] Built-in");
    expect(rendered).toContain("generalist  when omitted");
    expect(rendered).not.toContain("★");
    expect(rendered).toContain("1 candidate");
    expect(rendered).not.toContain("1 route");
    component.handleInput(input.left);
    expect(close).not.toHaveBeenCalled();
    component.handleInput(input.escape);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("applies session routes immediately without marking reload pending", async () => {
    const value = inspection();
    const { component, saveDraft } = makeComponent(value, { initialScope: "session" });
    selectProfile(component, "reviewer");
    component.handleInput(input.enter);
    component.handleInput("d");
    component.handleInput("d");
    await vi.waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(1));
    expect(saveDraft).toHaveBeenCalledWith(
      "session",
      "reviewer",
      expect.objectContaining({ kind: "disabled" }),
    );
    const rendered = component.render(120).join("\n");
    expect(rendered).toContain("Applied to this session · reviewer · route disabled");
    expect(rendered).not.toContain("saved changes pending reload");
  });

  it("changes a candidate model only in session scope", async () => {
    const value = inspection();
    const { component, saveDraft } = makeComponent(value, { initialScope: "session" });
    selectProfile(component, "reviewer");
    component.handleInput(input.enter);
    component.handleInput(input.enter);
    component.handleInput(input.down);
    component.handleInput(input.down);
    component.handleInput(input.enter);
    await vi.waitFor(() => expect(component.render(120).join("\n")).toContain("Choose model"));
    component.handleInput(input.enter);
    await vi.waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(1));
    expect(saveDraft).toHaveBeenCalledWith(
      "session",
      "reviewer",
      expect.objectContaining({
        kind: "explicit",
        candidates: [expect.objectContaining({ model: "anthropic/claude-opus-5" })],
      }),
    );
  });

  it("shows session provenance and confirms clearing all temporary overrides", async () => {
    const base = inspection();
    const value = {
      ...base,
      session: makeSessionProfileSnapshot(base.config, {
        revision: 1,
        overrides: { reviewer: { candidates: [candidate("openai/session")] } },
      }),
    };
    const { component, clearSessionOverrides } = makeComponent(value, {
      initialScope: "session",
    });
    const rendered = component.render(140).join("\n");
    expect(rendered).toContain("1 session override · applies now");
    expect(rendered).toContain("[S] Session > [P] Project");
    component.handleInput("X");
    expect(component.render(140).join("\n")).toContain("Clear all session profile overrides?");
    component.handleInput("X");
    await vi.waitFor(() => expect(clearSessionOverrides).toHaveBeenCalledTimes(1));
  });

  it("shows overflow position and keeps long model rows aligned", () => {
    const candidates = Array.from({ length: 8 }, (_, index) =>
      candidate(`provider/a-very-long-model-selector-${index}-with-suffix`),
    );
    const value = inspection({ version: 4 }, { version: 4, profiles: { reviewer: candidates } });
    const { component } = makeComponent(value, { getHeight: () => 12 });
    selectProfile(component, "reviewer");
    selectScope(component, "project");
    expect(component.render(70).join("\n")).toContain("↑ more");
    component.handleInput(input.enter);
    expect(component.render(70).join("\n")).toContain("1–1 of 8 · ↓ more");
    component.handleInput(input.enter);
    component.handleInput(input.down);
    component.handleInput(input.down);
    const fields = component.render(60).join("\n");
    expect(fields).toContain("…");
    expect(fields).toContain("Enter to choose");

    const wide = makeComponent(value).component;
    selectProfile(wide, "reviewer");
    selectScope(wide, "project");
    wide.handleInput(input.enter);
    expect(wide.render(140).join("\n")).toContain("01 Primary");
    expect(wide.render(140).join("\n")).toContain("02 Fallback");
  });

  it("warns when a project override shadows global edits", () => {
    const value = inspection(
      { version: 4, profiles: { reviewer: candidate("openai/global") } },
      {
        version: 4,
        profiles: { reviewer: candidate("openai/project") },
      },
    );
    const { component } = makeComponent(value);
    selectProfile(component, "reviewer");
    selectScope(component, "global");
    const rendered = component.render(100).join("\n");
    expect(rendered).toContain("Project override active for reviewer");
    expect(rendered).toContain("global edits are saved but remain shadowed");
    expect(rendered).toContain("Use s to cycle");
    expect(rendered).toContain("edit or reset it");
    component.handleInput(input.enter);
    component.handleInput("d");
    expect(component.render(100).join("\n")).toContain("project override remains effective");

    const compact = makeComponent(value, { getHeight: () => 8 }).component;
    selectProfile(compact, "reviewer");
    selectScope(compact, "global");
    const compactRendered = compact.render(100).join("\n");
    expect(compactRendered).toContain("[P] project");
    expect(compactRendered).toContain("Project override active");
  });

  it("shows same-count route reorder previews while a save is pending", () => {
    const value = inspection(
      { version: 4 },
      {
        version: 4,
        profiles: { reviewer: [candidate("openai/first"), candidate("openai/second")] },
      },
    );
    let resolveSave: ((value: ProfileWorkspaceSaveResult) => void) | undefined;
    const pendingSave = new Promise<ProfileWorkspaceSaveResult>((resolve) => {
      resolveSave = resolve;
    });
    const { component } = makeComponent(value, {
      saveDraft: () => pendingSave,
    });
    selectProfile(component, "reviewer");
    selectScope(component, "project");
    component.handleInput(input.enter);
    component.handleInput("J");
    expect(component.render(100).join("\n")).toContain("Preview    2 candidates");
    resolveSave?.({ inspection: value });
  });

  it("explains that removing the last candidate disables the route", () => {
    const { component } = makeComponent();
    component.handleInput(input.enter);
    component.handleInput("x");
    const rendered = component.render(100).join("\n");
    expect(rendered).toContain("This is the last candidate");
    expect(rendered).toContain("disables the route after reload");
  });

  it("describes session remove and disable actions as immediate for future launches", () => {
    const removal = makeComponent().component;
    selectScope(removal, "session");
    removal.handleInput(input.enter);
    removal.handleInput("x");
    const removalText = removal.render(120).join("\n");
    expect(removalText).toContain("immediately for future launches");
    expect(removalText).toContain("active runs are unchanged");
    expect(removalText).not.toContain("after reload");

    const disable = makeComponent().component;
    selectScope(disable, "session");
    disable.handleInput(input.enter);
    disable.handleInput("d");
    const disableText = disable.render(120).join("\n");
    expect(disableText).toContain("immediately disables the profile for future launches");
    expect(disableText).toContain("active runs are unchanged");
    expect(disableText).not.toContain("after reload");
  });

  it("hides no-op route actions and marks narrow fixed fields", () => {
    const { component } = makeComponent();
    selectScope(component, "global");
    component.handleInput(input.enter);
    const route = component.render(100).join("\n");
    expect(route).not.toContain("i      Reset");
    expect(route).not.toContain("J      Move");
    expect(route).not.toContain("K      Move");
    component.handleInput(input.enter);
    expect(component.render(40).join("\n")).toContain("· fixed");
  });

  it("cycles scopes with s and navigates endpoints with gg/G", () => {
    const { component } = makeComponent();
    expect(component.render(120).join("\n")).toContain("[Global]");
    component.handleInput("s");
    expect(component.render(120).join("\n")).toContain("[Project]");
    component.handleInput("s");
    expect(component.render(120).join("\n")).toContain("[Session]");
    component.handleInput("s");
    expect(component.render(120).join("\n")).toContain("[Global]");

    component.handleInput("g");
    component.handleInput("g");
    expect(component.render(120).join("\n")).toContain("> scout");
    component.handleInput("G");
    expect(component.render(120).join("\n")).toContain("> generalist");
  });

  it("accepts Kitty CSI-u printable action shortcuts", () => {
    const { component } = makeComponent();
    component.handleInput("\u001b[47u");
    expect(component.render(100).join("\n")).toContain("Search profiles");
  });

  it("returns to the route when a deep scope switch has no candidate", () => {
    const value = inspection(
      { version: 4, profiles: { reviewer: "disabled" } },
      {
        version: 4,
        profiles: { reviewer: candidate("openai/project") },
      },
    );
    const { component } = makeComponent(value);
    selectProfile(component, "reviewer");
    component.handleInput(input.enter);
    component.handleInput(input.enter);
    selectScope(component, "global");
    const rendered = component.render(100).join("\n");
    expect(rendered).toContain("reviewer route");
    expect(rendered).toContain("No candidates · route is disabled");
  });

  it("cancels an in-flight native model catalog load with Escape", async () => {
    let capturedSignal: AbortSignal | undefined;
    const loadModelPicker = vi.fn(
      (_profile, _candidateIndex, _candidate, signal?: AbortSignal) =>
        new Promise<CandidateModelPickerData>((_resolve, reject) => {
          capturedSignal = signal;
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    const { component } = makeComponent(undefined, { loadModelPicker });
    component.handleInput(input.enter);
    component.handleInput(input.enter);
    component.handleInput(input.down);
    component.handleInput(input.down);
    component.handleInput(input.enter);
    expect(component.render(100).join("\n")).toContain("Loading model catalog");
    component.handleInput(input.escape);
    expect(capturedSignal?.aborted).toBe(true);
    expect(component.render(100).join("\n")).toContain("Model catalog loading canceled");
  });

  it("renders configured selection keys in workspace help", () => {
    const labels = new Map([
      ["tui.select.up", "P"],
      ["tui.select.down", "N"],
      ["tui.select.confirm", "Y"],
      ["tui.select.cancel", "Q"],
    ]);
    const { component } = makeComponent(undefined, {
      keybindingLabel: (id, fallback) => labels.get(id) ?? fallback,
    });
    expect(component.render(120).at(-1)).toContain("j/k · P/N Select");
    expect(component.render(120).at(-1)).toContain("Y/l Route");
    expect(component.render(120).at(-1)).toContain("Q Close");
    expect(component.render(120).join("\n")).toContain("Y      Open generalist route");
    component.handleInput(input.enter);
    component.handleInput(input.enter);
    const candidatePage = component.render(120).join("\n");
    expect(candidatePage).toContain("Y      Choose value");
    expect(candidatePage).toContain("Q      Back to ordered route");
  });

  it("filters configured key labels that collide with workspace shortcuts from help", () => {
    const labels = new Map([
      ["tui.select.up", "⇧K/↑"],
      ["tui.select.down", "s/↓"],
    ]);
    const { component } = makeComponent(undefined, {
      keybindingLabel: (id, fallback) => labels.get(id) ?? fallback,
    });
    const footer = component.render(140).at(-1) ?? "";
    expect(footer).toContain("j/k · ↑/↓ Select");
    expect(footer).not.toContain("⇧K");
    expect(footer).not.toContain("s/↓");
  });

  it("advertises the ? key reference from candidate and field panes", () => {
    const { component } = makeComponent();
    component.handleInput(input.enter);
    expect(component.render(140).at(-1)).toContain("Tab/⇧Tab Pages · ? Help");
    component.handleInput(input.enter);
    expect(component.render(140).at(-1)).toContain("⇧Tab Back · ? Help");
    component.handleInput("?");
    const expanded = component.render(140).at(-1) ?? "";
    expect(expanded).toContain("PgUp/PgDn Page");
    expect(expanded).toContain("? Back");
    component.handleInput("?");
    expect(component.render(140).at(-1)).toContain("⇧Tab Back · ? Help");
  });

  it("navigates Profiles → Route → Candidate with scope and effective context", () => {
    const value = inspection(
      { version: 4, profiles: { reviewer: candidate("openai/global") } },
      {
        version: 4,
        profiles: {
          reviewer: candidate("claude-opus-5", {
            runtime: "claude",
            effort: "xhigh",
          }),
        },
      },
    );
    const { component } = makeComponent(value);
    selectProfile(component, "reviewer");
    const profiles = component.render(140).join("\n");
    expect(profiles).toContain("Profiles");
    expect(profiles).toContain("[Global]");
    expect(profiles).toContain("[P] project");

    selectScope(component, "project");
    expect(component.render(140).join("\n")).toContain("[Project]");
    component.handleInput(input.enter);
    const route = component.render(140).join("\n");
    expect(route).toContain("reviewer route");
    expect(route).toContain("Editing    project · explicit");
    expect(route).toContain("Ordered candidates");

    component.handleInput(input.enter);
    const details = component.render(140).join("\n");
    expect(details).toContain("reviewer › candidate 1");
    expect(details).toContain("Candidate fields");
    expect(details).toContain("Host");
    expect(details).toContain("Runtime");
    expect(details).toContain("Report policy");
  });

  it("keeps selected profiles and candidate fields visible in short terminals", () => {
    const { component } = makeComponent(inspection(), { getHeight: () => 12 });
    for (let index = 0; index < 6; index += 1) component.handleInput(input.down);
    expect(component.render(100).join("\n")).toContain("generalist");
    component.handleInput(input.enter);
    component.handleInput(input.enter);
    for (let index = 0; index < 7; index += 1) component.handleInput(input.down);
    expect(component.render(100).join("\n")).toContain("Report policy");
  });

  it("keeps route-only actions out of the profiles pane and blocks empty-route Tab navigation", () => {
    const value = inspection({ version: 4 }, { version: 4, profiles: { generalist: "disabled" } });
    const { component } = makeComponent(value);
    selectScope(component, "project");
    component.handleInput("d");
    expect(component.render(120).join("\n")).not.toContain("Confirm · Disable");
    component.handleInput(input.enter);
    component.handleInput(input.tab);
    const rendered = component.render(120).join("\n");
    expect(rendered).toContain("generalist route");
    expect(rendered).toContain("Add a candidate before opening candidate details.");
  });

  it("searches profiles and opens the selected route page", () => {
    const { component } = makeComponent(inspection({ version: 4 }));
    component.handleInput("/");
    expect(component.render(120).join("\n")).toContain("Search profiles");
    expect(component.render(120).join("\n")).toContain("generalist · when omitted");
    for (const character of "review") component.handleInput(character);
    const filtered = component.render(120).join("\n");
    expect(filtered).toContain("reviewer");
    expect(filtered).not.toContain("generalist · when omitted");
    component.handleInput(input.enter);
    expect(component.render(120).join("\n")).toContain("reviewer route");
  });

  it("opens a searchable selector for an enum field and persists its exact value", () => {
    const value = inspection({ version: 4 });
    const { component, saveDraft } = makeComponent(value);
    component.handleInput(input.enter);
    component.handleInput(input.enter);
    component.handleInput(input.enter);
    expect(component.render(130).join("\n")).toContain("Choose host");
    component.handleInput(input.down);
    component.handleInput(input.enter);

    expect(saveDraft).toHaveBeenCalledTimes(1);
    const [scope, profile, draft] = saveDraft.mock.calls[0]!;
    expect(scope).toBe("global");
    expect(profile).toBe("generalist");
    expect(draft.candidates[0]).toMatchObject({
      host: "herdr",
      runtime: "pi",
      model: "openai/parent",
    });
    expect(component.render(130).join("\n")).toContain("Saving globally · generalist");
  });

  it("requires an advertised model choice before persisting a native runtime change", async () => {
    const loadModelPicker = vi.fn().mockResolvedValue({
      current: "claude-opus-5",
      defaultSelector: "sonnet",
      context: {
        profile: "generalist",
        candidateIndex: 0,
        host: "local",
        runtime: "claude",
      },
      choices: [
        {
          choice: { kind: "model", selector: "claude-opus-5" },
          item: { value: "claude-opus-5", label: "Claude Opus" },
          searchText: "claude opus",
          supportedEfforts: ["high"],
          fastModeAvailable: false,
        },
        {
          choice: { kind: "model", selector: "sonnet" },
          item: { value: "sonnet", label: "Claude Sonnet (default)" },
          searchText: "claude sonnet",
          supportedEfforts: ["low", "high"],
          fastModeAvailable: false,
        },
      ],
    } satisfies CandidateModelPickerData);
    const { component, saveDraft } = makeComponent(inspection({ version: 4 }), { loadModelPicker });
    component.handleInput(input.enter);
    component.handleInput(input.enter);
    component.handleInput(input.down);
    component.handleInput(input.enter);
    component.handleInput(input.down);
    component.handleInput(input.enter);
    await vi.waitFor(() => expect(component.render(120).join("\n")).toContain("Choose model"));
    expect(saveDraft).not.toHaveBeenCalled();
    component.handleInput(input.enter);
    expect(saveDraft.mock.calls[0]?.[2].candidates[0]).toMatchObject({
      runtime: "claude",
      model: "sonnet",
    });
  });

  it("explains that canceling the required model picker also cancels a runtime change", async () => {
    const loadModelPicker = vi.fn().mockResolvedValue({
      ...modelPicker("claude-opus-5", "claude"),
      defaultSelector: "anthropic/claude-opus-5",
    });
    const { component, saveDraft } = makeComponent(inspection({ version: 4 }), { loadModelPicker });
    component.handleInput(input.enter);
    component.handleInput(input.enter);
    component.handleInput(input.down);
    component.handleInput(input.enter);
    component.handleInput(input.down);
    component.handleInput(input.enter);
    await vi.waitFor(() => expect(component.render(120).join("\n")).toContain("Choose model"));
    component.handleInput(input.escape);
    expect(component.render(120).join("\n")).toContain(
      "Runtime change canceled because no model was selected.",
    );
    expect(saveDraft).not.toHaveBeenCalled();
  });

  it("does not write when a selector confirms the current value", () => {
    const { component, saveDraft } = makeComponent();
    component.handleInput(input.enter);
    component.handleInput(input.enter);
    component.handleInput(input.enter);
    component.handleInput(input.enter);
    expect(saveDraft).not.toHaveBeenCalled();
    expect(component.render(120).join("\n")).toContain("No profile change was needed");
    component.handleInput(input.down);
    expect(component.render(120).join("\n")).not.toContain("No profile change was needed");
  });

  it("narrows native effort choices to the selected model catalog", async () => {
    const value = inspection(
      { version: 4 },
      {
        version: 4,
        profiles: {
          reviewer: candidate("claude-opus-5", { runtime: "claude", effort: "high" }),
        },
      },
    );
    const loadModelPicker = vi.fn().mockResolvedValue({
      current: "claude-opus-5",
      context: {
        profile: "reviewer",
        candidateIndex: 0,
        host: "local",
        runtime: "claude",
      },
      choices: [
        {
          choice: { kind: "model", selector: "claude-opus-5" },
          item: { value: "claude-opus-5", label: "Claude Opus" },
          searchText: "claude opus",
          supportedEfforts: ["low"],
          fastModeAvailable: false,
        },
      ],
    } satisfies CandidateModelPickerData);
    const { component, saveDraft } = makeComponent(value, { loadModelPicker });
    selectProfile(component, "reviewer");
    selectScope(component, "project");
    component.handleInput(input.enter);
    component.handleInput(input.enter);
    for (let index = 0; index < 3; index += 1) component.handleInput(input.down);
    component.handleInput(input.enter);
    await vi.waitFor(() => expect(component.render(120).join("\n")).toContain("Choose effort"));
    const effortPage = component.render(120).join("\n");
    expect(effortPage).toContain("Options · 2/2");
    expect(effortPage).toContain("Use low reasoning effort");
    expect(effortPage).not.toContain("Use high reasoning effort");
    component.handleInput(input.enter);
    expect(saveDraft.mock.calls[0]?.[2].candidates[0]).toMatchObject({ effort: "default" });
  });

  it("enters a full-page searchable model dropdown and persists its selection", async () => {
    const value = inspection({ version: 4 });
    const loadModelPicker = vi.fn().mockResolvedValue(modelPicker("parent", "pi"));
    const { component, saveDraft } = makeComponent(value, { loadModelPicker });
    selectProfile(component, "reviewer");
    component.handleInput(input.tab);
    component.handleInput(input.tab);
    component.handleInput(input.down);
    component.handleInput(input.down);
    component.handleInput(input.enter);
    await vi.waitFor(() =>
      expect(component.render(130).join("\n")).toContain("reviewer › candidate 1 › Model"),
    );

    for (const width of [130, 52, 12, 3]) {
      const lines = component.render(width);
      expect(lines).toHaveLength(24);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
    const page = component.render(130).join("\n");
    expect(page).toContain("Choose model");
    expect(page).toContain("Press / to filter");
    expect(page).toContain("Claude Opus");
    expect(page).toContain("Claude Sonnet");
    component.handleInput("/");
    for (const character of "sonnet") component.handleInput(character);
    const filtered = component.render(130).join("\n");
    expect(filtered).not.toContain("Claude Opus");
    expect(filtered).toContain("Claude Sonnet");
    component.handleInput(input.enter);
    await vi.waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(1));

    expect(loadModelPicker).toHaveBeenCalledWith(
      "reviewer",
      0,
      expect.objectContaining({ model: "parent" }),
      expect.any(AbortSignal),
    );
    expect(saveDraft).toHaveBeenCalledWith(
      "global",
      "reviewer",
      expect.objectContaining({
        kind: "explicit",
        candidates: [expect.objectContaining({ model: "anthropic/sonnet" })],
      }),
    );
  });

  it("returns from the model page to candidate details on Escape", async () => {
    const { component, saveDraft, close } = makeComponent();
    component.handleInput(input.tab);
    component.handleInput(input.tab);
    component.handleInput(input.down);
    component.handleInput(input.down);
    component.handleInput(input.enter);
    await vi.waitFor(() =>
      expect(component.render(100).join("\n")).toContain("reviewer › candidate 1 › Model"),
    );
    component.handleInput(input.escape);
    expect(component.render(100).join("\n")).toContain("Candidate fields");
    expect(saveDraft).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("adds and clones complete candidates without a separate save step", async () => {
    const value = inspection({ version: 4 }, { version: 4, profiles: { worker: "disabled" } });
    const addedValue = inspection(
      { version: 4 },
      { version: 4, profiles: { worker: candidate("parent") } },
    );
    const saveDraft = vi
      .fn()
      .mockResolvedValueOnce({ inspection: addedValue })
      .mockResolvedValueOnce({ inspection: addedValue });
    const { component } = makeComponent(value, { saveDraft });
    selectProfile(component, "worker");
    selectScope(component, "project");
    component.handleInput(input.enter);
    component.handleInput("a");
    await vi.waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(1));
    expect(saveDraft.mock.calls[0]?.[2].candidates).toHaveLength(1);
    expect(saveDraft.mock.calls[0]?.[2].candidates[0]).toMatchObject({
      writeIntent: "writer",
    });

    component.handleInput("c");
    await vi.waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(2));
    expect(saveDraft.mock.calls[1]?.[2].candidates).toHaveLength(2);
  });

  it("requires an in-workspace confirmation for destructive route operations", () => {
    const value = inspection(
      { version: 4 },
      { version: 4, profiles: { generalist: candidate("parent") } },
    );
    const { component, saveDraft } = makeComponent(value);
    component.handleInput(input.enter);
    component.handleInput("x");
    expect(saveDraft).not.toHaveBeenCalled();
    expect(component.render(100).join("\n")).toContain("Press x again to confirm");
    component.handleInput("x");
    expect(saveDraft.mock.calls[0]?.[2]).toMatchObject({ kind: "disabled", candidates: [] });
  });

  it("shows and confirms the selected-profile reset option for each scope", () => {
    const project = makeComponent(
      inspection(
        { version: 4 },
        { version: 4, profiles: { generalist: candidate("openai/project") } },
      ),
    );
    selectScope(project.component, "project");
    expect(project.component.render(140).join("\n")).toContain("Reset generalist");
    project.component.handleInput("i");
    expect(project.component.render(140).join("\n")).toContain("Confirm · Reset generalist?");
    expect(project.component.render(140).join("\n")).toContain(
      "effective route will come from global settings",
    );
    expect(project.component.render(140).join("\n")).toContain("Current  explicit");
    expect(project.component.render(140).join("\n")).toContain(
      "After    inherits [G] global / [B] built-in",
    );
    project.component.handleInput("i");
    expect(project.saveDraft.mock.calls[0]?.[2]).toMatchObject({ kind: "inherit" });

    const global = makeComponent(
      inspection({
        version: 4,
        profiles: { generalist: candidate("openai/global") },
      }),
    );
    selectScope(global.component, "global");
    expect(global.component.render(140).join("\n")).toContain("Reset generalist to built-in");
    global.component.handleInput("i");
    expect(global.component.render(140).join("\n")).toContain("Current  explicit");
    expect(global.component.render(140).join("\n")).toContain("After    [B] built-in");
    global.component.handleInput("i");
    expect(global.saveDraft.mock.calls[0]?.[2]).toMatchObject({ kind: "reset" });
  });

  it("restores scope defaults immediately and skips project scope while untrusted", () => {
    const trustedValue = inspection(
      { version: 4, profiles: { generalist: candidate("openai/global") } },
      {
        version: 4,
        profiles: { generalist: candidate("openai/project") },
      },
    );
    const trusted = makeComponent(trustedValue);
    selectScope(trusted.component, "project");
    trusted.component.handleInput("i");
    trusted.component.handleInput("i");
    expect(trusted.saveDraft.mock.calls[0]?.[2]).toMatchObject({ kind: "inherit" });

    const untrustedValue = inspection({ version: 4 }, undefined, false);
    const untrusted = makeComponent(untrustedValue);
    untrusted.component.handleInput("s");
    expect(untrusted.component.render(120).join("\n")).toContain("[Session]");
    untrusted.component.handleInput("s");
    expect(untrusted.component.render(120).join("\n")).toContain("[Global]");
    expect(untrusted.component.render(120).join("\n")).toContain("Session ↔ Global");
    expect(untrusted.saveDraft).not.toHaveBeenCalled();
  });

  it("locks concurrent edits during a write and preserves visible write errors", async () => {
    let rejectSave: (error: Error) => void = () => {};
    const pending = new Promise<ProfileWorkspaceSaveResult>((_resolve, reject) => {
      rejectSave = reject;
    });
    const saveDraft = vi.fn().mockReturnValue(pending);
    const { component } = makeComponent(inspection(), { saveDraft });
    component.handleInput(input.enter);
    component.handleInput(input.enter);
    component.handleInput(input.enter);
    component.handleInput(input.down);
    component.handleInput(input.enter);
    expect(saveDraft).toHaveBeenCalledTimes(1);
    rejectSave(new Error("write conflict"));
    await vi.waitFor(() => expect(component.render(130).join("\n")).toContain("write conflict"));
    expect(component.render(130).join("\n")).toContain("Reopen /subagents profiles");
    expect(component.render(52).join("\n")).toContain("editing again");
    expect(component.render(52).join("\n")).toContain("✗ write conflict");
    expect(component.render(130).join("\n")).not.toContain("saved changes pending reload");
    component.handleInput(input.enter);
    component.handleInput(input.down);
    component.handleInput(input.enter);
    expect(saveDraft).toHaveBeenCalledTimes(1);
    expect(component.render(130).join("\n")).toContain("could not be safely refreshed");
  });

  it("offers reload after a successful write and reports pending state on close", async () => {
    const reload = vi.fn().mockResolvedValue(false);
    const { component, close } = makeComponent(inspection(), { reload });
    component.handleInput(input.enter);
    component.handleInput("d");
    component.handleInput("d");
    await vi.waitFor(() =>
      expect(component.render(120).join("\n")).toContain("saved changes pending reload"),
    );
    expect(component.render(120).join("\n")).toContain("Saved globally · generalist");
    expect(component.render(120).join("\n")).toContain("r Reload");
    component.handleInput("r");
    expect(reload).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(component.render(120).join("\n")).toContain("Reload canceled"));
    component.handleInput(input.escape);
    component.handleInput(input.escape);
    expect(close).toHaveBeenCalledWith(true);
  });

  it("closes with no pending notice after a successful reload", async () => {
    const reload = vi.fn().mockResolvedValue(true);
    const { component, close } = makeComponent(inspection(), { reload });
    component.handleInput(input.enter);
    component.handleInput("d");
    component.handleInput("d");
    await vi.waitFor(() =>
      expect(component.render(120).join("\n")).toContain("saved changes pending reload"),
    );
    component.handleInput("r");
    await vi.waitFor(() => expect(close).toHaveBeenCalledWith(false));
  });

  it("persists OpenAI fast mode immediately for an eligible candidate", async () => {
    const { component, saveDraft } = makeComponent(inspection(), {
      fastModeAvailable: () => true,
    });
    component.handleInput(input.enter);
    component.handleInput(input.enter);
    for (let index = 0; index < 6; index += 1) component.handleInput(input.down);
    component.handleInput(input.enter);
    await vi.waitFor(() =>
      expect(component.render(130).join("\n")).not.toContain("Loading model catalog"),
    );
    component.handleInput(input.down);
    component.handleInput(input.enter);
    await vi.waitFor(() => expect(saveDraft).toHaveBeenCalledTimes(1));
    expect(saveDraft).toHaveBeenCalledWith(
      "global",
      "generalist",
      expect.objectContaining({
        kind: "explicit",
        candidates: [expect.objectContaining({ fastMode: true })],
      }),
    );
  });

  it("does not persist inline fields disabled by the current policy", () => {
    const { component, saveDraft } = makeComponent(inspection());
    component.handleInput(input.tab);
    component.handleInput(input.tab);
    for (let index = 0; index < 7; index += 1) component.handleInput(input.down);
    component.handleInput(input.enter);
    expect(saveDraft).not.toHaveBeenCalled();
    expect(component.render(130).join("\n")).toContain(
      "Retention is available only to Herdr read-only candidates",
    );
  });

  it("shows direct reasons for fields unavailable under the current policy", () => {
    const rows = candidateFieldRows(
      candidate("claude-opus-5", { runtime: "claude" }),
      "reviewer",
      "high",
    );
    expect(rows.find((row) => row.field === "context")).toMatchObject({
      fixed: true,
      value: "fresh · fixed: fork requires local Pi",
      fixedReason: "Fork context is available only to local Pi.",
    });
    expect(rows.find((row) => row.field === "fastMode")).toMatchObject({
      fixed: true,
      value: "unavailable · Claude does not support OpenAI fast mode",
    });
    expect(rows.find((row) => row.field === "closeOnReport")).toMatchObject({
      fixed: true,
      value: "close after report · fixed: retain requires Herdr read-only",
    });
  });

  it("distinguishes disabled and invalid routes with semantic markers", () => {
    const disabled = makeComponent(inspection({ version: 4, profiles: { generalist: "disabled" } }))
      .component.render(120)
      .join("\n");
    expect(disabled).toContain("— disabled");

    const invalid = makeComponent(inspection({ version: 4, profiles: { generalist: null } }))
      .component.render(120)
      .join("\n");
    expect(invalid).toContain("✗ fails closed");
  });

  it("offers exact choices for every editable non-model field", () => {
    const editable = candidate("parent", {
      host: "herdr",
      writeIntent: "read-only",
      closeOnReport: false,
    });
    for (const field of ["host", "runtime", "effort", "writeIntent", "closeOnReport"] as const)
      expect(candidateFieldChoices(editable, field, {}).length).toBeGreaterThan(1);

    const update = selectCandidateField(editable, "runtime", "claude", {
      piModel: "openai/parent",
    });
    expect(update.candidate).toMatchObject({ runtime: "claude", model: "claude-opus-5" });
    expect(selectCandidateField(editable, "closeOnReport", "false", {}).candidate).toMatchObject({
      closeOnReport: false,
    });
  });

  it("uses the shared normalization rules and visibly marks fixed fields", () => {
    const local = candidate("parent", { context: "fork" });
    const update = selectCandidateField(local, "runtime", "claude", {
      piModel: "openai/parent",
    });
    expect(update.candidate).toMatchObject({
      runtime: "claude",
      model: "claude-opus-5",
      context: "fresh",
    });
    expect(update.notices.join(" ")).toContain("Model reset");
    expect(update.notices.join(" ")).toContain("context reset");

    const rows = candidateFieldRows(update.candidate!);
    expect(rows.find((row) => row.field === "context")?.fixed).toBe(true);
    expect(rows.find((row) => row.field === "closeOnReport")?.fixed).toBe(true);
  });
});
