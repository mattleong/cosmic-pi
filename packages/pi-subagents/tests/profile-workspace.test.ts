// Promise assertions are test-runner boundaries.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { resolveSubagentConfig } from "../src/config/options.ts";
import { decodeSubagentConfig } from "../src/config/schema.ts";
import type { SubagentConfigInspection } from "../src/config/store.ts";
import type { ProfileCandidate } from "../src/profiles/model.ts";
import {
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
  closeOnReport: true,
  ...overrides,
});

const input = {
  tab: "\t",
  enter: "\r",
  escape: "\u001b",
  down: "\u001b[B",
  right: "\u001b[C",
} as const;

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
    },
    {
      choice: { kind: "model", selector: "anthropic/sonnet" },
      item: { value: "anthropic/sonnet", label: "Claude Sonnet", description: "Efficient" },
      searchText: "claude sonnet efficient",
      supportedEfforts: ["low", "medium", "high", "xhigh"],
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
    getHeight: () => 24,
    requestRender,
    close,
    saveDraft,
    loadModelPicker,
    supportedPiEfforts: () => ["low", "medium", "high", "xhigh"],
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
      expect(lines.join("\n")).toContain(width > 12 ? "/subagents" : "/subagent");
    }
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
    const profiles = component.render(140).join("\n");
    expect(profiles).toContain("Profiles");
    expect(profiles).toContain("[p Project]");
    expect(profiles).toContain("project override");

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
    expect(details).toContain("After report");
  });

  it("keeps selected profiles and candidate fields visible in short terminals", () => {
    const { component } = makeComponent(inspection(), { getHeight: () => 12 });
    for (let index = 0; index < 6; index += 1) component.handleInput(input.down);
    expect(component.render(100).join("\n")).toContain("delegate");
    component.handleInput(input.enter);
    component.handleInput(input.enter);
    for (let index = 0; index < 6; index += 1) component.handleInput(input.down);
    expect(component.render(100).join("\n")).toContain("After report");
  });

  it("keeps route-only actions out of the profiles pane and blocks empty-route Tab navigation", () => {
    const value = inspection(
      { version: 4 },
      { version: 4, defaultProfile: "delegate", profiles: { delegate: "disabled" } },
    );
    const { component } = makeComponent(value);
    component.handleInput("d");
    expect(component.render(120).join("\n")).not.toContain("Confirm · Disable");
    component.handleInput(input.enter);
    component.handleInput(input.tab);
    const rendered = component.render(120).join("\n");
    expect(rendered).toContain("delegate route");
    expect(rendered).toContain("Add a candidate before opening candidate details.");
  });

  it("searches profiles and opens the selected route page", () => {
    const { component } = makeComponent(inspection({ version: 4, defaultProfile: "delegate" }));
    component.handleInput("/");
    expect(component.render(120).join("\n")).toContain("Search profiles");
    for (const character of "review") component.handleInput(character);
    const filtered = component.render(120).join("\n");
    expect(filtered).toContain("reviewer");
    expect(filtered).not.toContain("delegate ★ default");
    component.handleInput(input.enter);
    expect(component.render(120).join("\n")).toContain("reviewer route");
  });

  it("opens a searchable selector for an enum field and persists its exact value", () => {
    const value = inspection({ version: 4, defaultProfile: "delegate" });
    const { component, saveDraft } = makeComponent(value);
    component.handleInput(input.enter);
    component.handleInput(input.enter);
    component.handleInput(input.enter);
    expect(component.render(130).join("\n")).toContain("Choose host");
    component.handleInput(input.down);
    component.handleInput(input.enter);

    expect(saveDraft).toHaveBeenCalledTimes(1);
    const [scope, profile, draft] = saveDraft.mock.calls[0]!;
    expect(scope).toBe("project");
    expect(profile).toBe("delegate");
    expect(draft.candidates[0]).toMatchObject({
      host: "herdr",
      runtime: "pi",
      model: "openai/parent",
    });
    expect(component.render(130).join("\n")).toContain("Saving delegate");
  });

  it("requires an advertised model choice before persisting a native runtime change", async () => {
    const loadModelPicker = vi.fn().mockResolvedValue({
      current: "claude-opus-5",
      defaultSelector: "sonnet",
      context: {
        profile: "delegate",
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
        },
        {
          choice: { kind: "model", selector: "sonnet" },
          item: { value: "sonnet", label: "Claude Sonnet (default)" },
          searchText: "claude sonnet",
          supportedEfforts: ["low", "high"],
        },
      ],
    } satisfies CandidateModelPickerData);
    const { component, saveDraft } = makeComponent(
      inspection({ version: 4, defaultProfile: "delegate" }),
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
      inspection({ version: 4, defaultProfile: "delegate" }),
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
        },
      ],
    } satisfies CandidateModelPickerData);
    const { component, saveDraft } = makeComponent(value, { loadModelPicker });
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
    component.handleInput(input.tab);
    component.handleInput(input.tab);
    component.handleInput(input.down);
    component.handleInput(input.down);
    component.handleInput(input.enter);
    await vi.waitFor(() =>
      expect(component.render(130).join("\n")).toContain("/subagents profiles › model"),
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
    );
    expect(saveDraft).toHaveBeenCalledWith(
      "project",
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
      expect(component.render(100).join("\n")).toContain("/subagents profiles › model"),
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
      { version: 4, defaultProfile: "delegate", profiles: { delegate: candidate("parent") } },
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
        { version: 4, defaultProfile: "delegate" },
        { version: 4, profiles: { delegate: candidate("openai/project") } },
      ),
    );
    expect(project.component.render(140).join("\n")).toContain("Reset delegate");
    project.component.handleInput("i");
    expect(project.component.render(140).join("\n")).toContain("Confirm · Reset delegate?");
    expect(project.component.render(140).join("\n")).toContain(
      "effective route will come from global settings",
    );
    project.component.handleInput("i");
    expect(project.saveDraft.mock.calls[0]?.[2]).toMatchObject({ kind: "inherit" });

    const global = makeComponent(
      inspection({
        version: 4,
        defaultProfile: "delegate",
        profiles: { delegate: candidate("openai/global") },
      }),
    );
    global.component.handleInput("g");
    expect(global.component.render(140).join("\n")).toContain("Reset delegate to built-in");
    global.component.handleInput("i");
    global.component.handleInput("i");
    expect(global.saveDraft.mock.calls[0]?.[2]).toMatchObject({ kind: "reset" });
  });

  it("restores scope defaults immediately and blocks project scope while untrusted", () => {
    const trustedValue = inspection(
      { version: 4, profiles: { delegate: candidate("openai/global") } },
      {
        version: 4,
        defaultProfile: "delegate",
        profiles: { delegate: candidate("openai/project") },
      },
    );
    const trusted = makeComponent(trustedValue);
    trusted.component.handleInput("i");
    trusted.component.handleInput("i");
    expect(trusted.saveDraft.mock.calls[0]?.[2]).toMatchObject({ kind: "inherit" });

    const untrustedValue = inspection({ version: 4, defaultProfile: "delegate" }, undefined, false);
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
    expect(component.render(130).join("\n")).not.toContain("reload required");
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
    await vi.waitFor(() => expect(component.render(120).join("\n")).toContain("reload required"));
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
    await vi.waitFor(() => expect(component.render(120).join("\n")).toContain("reload required"));
    component.handleInput("r");
    await vi.waitFor(() => expect(close).toHaveBeenCalledWith(false));
  });

  it("does not persist inline fields disabled by the current policy", () => {
    const { component, saveDraft } = makeComponent(inspection());
    component.handleInput(input.tab);
    component.handleInput(input.tab);
    for (let index = 0; index < 6; index += 1) component.handleInput(input.down);
    component.handleInput(input.enter);
    expect(saveDraft).not.toHaveBeenCalled();
    expect(component.render(130).join("\n")).toContain("fixed by the current");
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
