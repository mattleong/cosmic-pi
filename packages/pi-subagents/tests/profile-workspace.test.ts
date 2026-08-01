// Promise assertions are test-runner boundaries.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { resolveSubagentConfig } from "../src/config/options.ts";
import { decodeSubagentConfig } from "../src/config/schema.ts";
import type { SubagentConfigInspection } from "../src/config/store.ts";
import { PROFILE_IDS, type ProfileCandidate, type ProfileId } from "../src/profiles/model.ts";
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

const inspection = (
  global: Record<string, unknown> = { version: 4 },
  project?: Record<string, unknown>,
  trusted = true,
): SubagentConfigInspection => {
  const decodedGlobal = decodeSubagentConfig(global, "global");
  const decodedProject = project ? decodeSubagentConfig(project, "project") : undefined;
  return {
    config: resolveSubagentConfig({
      globalConfigPath: "/agent/pi-subagents.json",
      projectConfigPath: "/repo/.pi/pi-subagents.json",
      projectTrusted: trusted,
      globalConfigExists: true,
      projectConfigExists: project !== undefined,
      global: decodedGlobal,
      ...(decodedProject ? { project: decodedProject } : {}),
    }),
    globalDocument: global,
    ...(project ? { projectDocument: project } : {}),
    global: decodedGlobal,
    ...(decodedProject ? { project: decodedProject } : {}),
  };
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

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

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
    loadModelPicker,
    supportedPiEfforts: () => ["low", "medium", "high", "xhigh"],
    fastModeAvailable: () => false,
    reload,
    ...overrides,
  });
  return { component, saveDraft, loadModelPicker, reload, close, requestRender };
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
        defaultProfile: "scout",
        profiles: { scout: inherited },
      },
    );
    const { component } = makeComponent(value);
    selectProfile(component, "scout");
    component.handleInput(input.enter);
    expect(component.render(120).join("\n")).toContain("parent:low (default)");
    component.handleInput(input.enter);
    expect(component.render(120).join("\n")).toContain("Effort         low (default)");
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
      defaultProfile: "scout",
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
    expect(rendered).toContain("[g Global]");
    expect(rendered).toContain("Sources  [P] Project > [G] Global > [B] Built-in");
    expect(rendered).toContain("generalist  implicit fallback");
    expect(rendered).not.toContain("★");
    expect(rendered).toContain("1 candidate");
    expect(rendered).not.toContain("1 route");
    component.handleInput(input.left);
    expect(close).not.toHaveBeenCalled();
    component.handleInput(input.escape);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("shows overflow position and keeps long model rows aligned", () => {
    const candidates = Array.from({ length: 8 }, (_, index) =>
      candidate(`provider/a-very-long-model-selector-${index}-with-suffix`),
    );
    const value = inspection(
      { version: 4 },
      { version: 4, defaultProfile: "reviewer", profiles: { reviewer: candidates } },
    );
    const { component } = makeComponent(value, { getHeight: () => 12 });
    selectProfile(component, "reviewer");
    component.handleInput("p");
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
    wide.handleInput("p");
    wide.handleInput(input.enter);
    expect(wide.render(140).join("\n")).toContain("01 Primary");
    expect(wide.render(140).join("\n")).toContain("02 Fallback");
  });

  it("warns when a project override shadows global edits", () => {
    const value = inspection(
      { version: 4, profiles: { reviewer: candidate("openai/global") } },
      {
        version: 4,
        defaultProfile: "reviewer",
        profiles: { reviewer: candidate("openai/project") },
      },
    );
    const { component } = makeComponent(value);
    selectProfile(component, "reviewer");
    component.handleInput("g");
    const rendered = component.render(100).join("\n");
    expect(rendered).toContain("Project override active for reviewer");
    expect(rendered).toContain("global edits are saved but remain shadowed");
    expect(rendered).toContain("Press p to");
    expect(rendered).toContain("edit or reset the project override");
    component.handleInput(input.enter);
    component.handleInput("d");
    expect(component.render(100).join("\n")).toContain("project override remains effective");

    const compact = makeComponent(value, { getHeight: () => 8 }).component;
    selectProfile(compact, "reviewer");
    compact.handleInput("g");
    const compactRendered = compact.render(100).join("\n");
    expect(compactRendered).toContain("Global scope overrides built-in");
    expect(compactRendered).toContain("Project override active");
  });

  it("shows same-count route reorder previews while a save is pending", () => {
    const value = inspection(
      { version: 4 },
      {
        version: 4,
        defaultProfile: "reviewer",
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
    component.handleInput("p");
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

  it("hides no-op route actions and marks narrow fixed fields", () => {
    const { component } = makeComponent();
    component.handleInput("g");
    component.handleInput(input.enter);
    const route = component.render(100).join("\n");
    expect(route).not.toContain("i      Reset");
    expect(route).not.toContain("J      Move");
    expect(route).not.toContain("K      Move");
    component.handleInput(input.enter);
    expect(component.render(40).join("\n")).toContain("· fixed");
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
        defaultProfile: "reviewer",
        profiles: { reviewer: candidate("openai/project") },
      },
    );
    const { component } = makeComponent(value);
    selectProfile(component, "reviewer");
    component.handleInput(input.enter);
    component.handleInput(input.enter);
    component.handleInput("g");
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
    const { component } = makeComponent(undefined, {
      keybindingLabel: (id, fallback) =>
        (
          ({
            "tui.select.up": "P",
            "tui.select.down": "N",
            "tui.select.confirm": "Y",
            "tui.select.cancel": "Q",
          }) as Readonly<Record<string, string>>
        )[id] ?? fallback,
    });
    expect(component.render(120).at(-1)).toContain("P/N Select");
    expect(component.render(120).at(-1)).toContain("Y Route");
    expect(component.render(120).at(-1)).toContain("Q Close");
    expect(component.render(120).join("\n")).toContain("Y      Open generalist route");
    component.handleInput(input.enter);
    component.handleInput(input.enter);
    const candidatePage = component.render(120).join("\n");
    expect(candidatePage).toContain("Y      Choose value");
    expect(candidatePage).toContain("Q      Back to ordered route");
  });

  it("navigates Profiles → Route → Candidate with scope and effective context", () => {
    const value = inspection(
      { version: 4, profiles: { reviewer: candidate("openai/global") } },
      {
        version: 4,
        defaultProfile: "reviewer",
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
    expect(profiles).toContain("[g Global]");
    expect(profiles).toContain("[P] project");

    component.handleInput("p");
    expect(component.render(140).join("\n")).toContain("[p Project]");
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
    const value = inspection(
      { version: 4 },
      { version: 4, defaultProfile: "generalist", profiles: { generalist: "disabled" } },
    );
    const { component } = makeComponent(value);
    component.handleInput("p");
    component.handleInput("d");
    expect(component.render(120).join("\n")).not.toContain("Confirm · Disable");
    component.handleInput(input.enter);
    component.handleInput(input.tab);
    const rendered = component.render(120).join("\n");
    expect(rendered).toContain("generalist route");
    expect(rendered).toContain("Add a candidate before opening candidate details.");
  });

  it("searches profiles and opens the selected route page", () => {
    const { component } = makeComponent(inspection({ version: 4, defaultProfile: "generalist" }));
    component.handleInput("/");
    expect(component.render(120).join("\n")).toContain("Search profiles");
    expect(component.render(120).join("\n")).toContain("generalist · implicit fallback");
    for (const character of "review") component.handleInput(character);
    const filtered = component.render(120).join("\n");
    expect(filtered).toContain("reviewer");
    expect(filtered).not.toContain("generalist · implicit fallback");
    component.handleInput(input.enter);
    expect(component.render(120).join("\n")).toContain("reviewer route");
  });

  it("opens a searchable selector for an enum field and persists its exact value", () => {
    const value = inspection({ version: 4, defaultProfile: "generalist" });
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
    const { component, saveDraft } = makeComponent(
      inspection({ version: 4, defaultProfile: "generalist" }),
      { loadModelPicker },
    );
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
    const { component, saveDraft } = makeComponent(
      inspection({ version: 4, defaultProfile: "generalist" }),
      { loadModelPicker },
    );
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
        defaultProfile: "reviewer",
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
    component.handleInput("p");
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
    const value = inspection({ version: 4, defaultProfile: "reviewer" });
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
    expect(page).toContain("Search:");
    expect(page).toContain("Claude Opus");
    expect(page).toContain("Claude Sonnet");
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
    const value = inspection(
      { version: 4 },
      { version: 4, defaultProfile: "worker", profiles: { worker: "disabled" } },
    );
    const addedValue = inspection(
      { version: 4 },
      { version: 4, defaultProfile: "worker", profiles: { worker: candidate("parent") } },
    );
    const saveDraft = vi
      .fn()
      .mockResolvedValueOnce({ inspection: addedValue })
      .mockResolvedValueOnce({ inspection: addedValue });
    const { component } = makeComponent(value, { saveDraft });
    selectProfile(component, "worker");
    component.handleInput("p");
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
      { version: 4, defaultProfile: "generalist", profiles: { generalist: candidate("parent") } },
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
        { version: 4, defaultProfile: "generalist" },
        { version: 4, profiles: { generalist: candidate("openai/project") } },
      ),
    );
    project.component.handleInput("p");
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
        defaultProfile: "generalist",
        profiles: { generalist: candidate("openai/global") },
      }),
    );
    global.component.handleInput("g");
    expect(global.component.render(140).join("\n")).toContain("Reset generalist to built-in");
    global.component.handleInput("i");
    expect(global.component.render(140).join("\n")).toContain("Current  explicit");
    expect(global.component.render(140).join("\n")).toContain("After    [B] built-in");
    global.component.handleInput("i");
    expect(global.saveDraft.mock.calls[0]?.[2]).toMatchObject({ kind: "reset" });
  });

  it("restores scope defaults immediately and blocks project scope while untrusted", () => {
    const trustedValue = inspection(
      { version: 4, profiles: { generalist: candidate("openai/global") } },
      {
        version: 4,
        defaultProfile: "generalist",
        profiles: { generalist: candidate("openai/project") },
      },
    );
    const trusted = makeComponent(trustedValue);
    trusted.component.handleInput("p");
    trusted.component.handleInput("i");
    trusted.component.handleInput("i");
    expect(trusted.saveDraft.mock.calls[0]?.[2]).toMatchObject({ kind: "inherit" });

    const untrustedValue = inspection(
      { version: 4, defaultProfile: "generalist" },
      undefined,
      false,
    );
    const untrusted = makeComponent(untrustedValue);
    untrusted.component.handleInput("p");
    expect(untrusted.component.render(120).join("\n")).toContain(
      "Project profile settings require a trusted",
    );
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
    expect(component.render(52).join("\n")).toContain("× write conflict");
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
    expect(invalid).toContain("× fails closed");
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
