// Promise assertions are test-runner boundaries.
// @effect-diagnostics effect/asyncFunction:off
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { makeSubagentProjectionBridge } from "../src/boundary/host-ui.ts";
import { resolveSubagentConfig } from "../src/config/options.ts";
import { decodeSubagentConfig } from "../src/config/schema.ts";
import type { SubagentConfigInspection } from "../src/config/store.ts";
import type { ProfileCandidate } from "../src/profiles/model.ts";
import {
  _profileSettingsTest,
  registerSubagentManagerCommand,
  type FleetManagerActions,
} from "../src/settings/controller.ts";
import {
  candidateMenuSummary,
  loadProfileRouteDraft,
} from "../src/settings/profile-route-editor.ts";
import { createProfileModelChoices } from "../src/settings/ui/model-picker.ts";

const inspection = (
  global: Record<string, unknown> = { version: 4 },
  project?: Record<string, unknown>,
): SubagentConfigInspection => {
  const decodedGlobal = decodeSubagentConfig(global, "global");
  const decodedProject = project ? decodeSubagentConfig(project, "project") : undefined;
  return {
    config: resolveSubagentConfig({
      globalConfigPath: "/agent/pi-subagents.json",
      projectConfigPath: "/repo/.pi/pi-subagents.json",
      projectTrusted: true,
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

const threeRoute = [
  candidate("openai/one", { effort: "low" }),
  candidate("claude-opus-5", { host: "herdr", runtime: "claude", effort: "medium" }),
  candidate("gpt-5.6-codex", { runtime: "codex", effort: "xhigh", writeIntent: "writer" }),
];

const actions = (value = inspection()): FleetManagerActions => ({
  stop: () => Promise.resolve(),
  interrupt: () => Promise.resolve(),
  resume: () => Promise.resolve(),
  send: () => Promise.resolve(),
  reply: () => Promise.resolve(),
  rename: () => Promise.resolve(),
  inspectProfiles: vi.fn().mockResolvedValue(value),
  patchProfile: vi.fn().mockResolvedValue(undefined),
});

const register = (managerActions: FleetManagerActions, bridge = makeSubagentProjectionBridge()) => {
  let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  const pi = {
    registerCommand: (
      _name: string,
      command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
    ) => {
      handler = command.handler;
    },
  } as unknown as ExtensionAPI;
  registerSubagentManagerCommand(pi, bridge, managerActions);
  return (args: string, ctx: ExtensionCommandContext) => handler?.(args, ctx) ?? Promise.resolve();
};

const baseContext = (ui: Record<string, unknown>, trusted = true) =>
  ({
    mode: "tui",
    hasUI: true,
    ui,
    isProjectTrusted: () => trusted,
    model: { provider: "openai", id: "parent" },
    modelRegistry: {
      getAvailable: () => [
        { provider: "openai", id: "parent", name: "Parent", reasoning: true },
        { provider: "zai", id: "plain", name: "Plain", reasoning: false },
      ],
      find: (provider: string, id: string) =>
        provider === "openai" && id === "parent"
          ? { provider, id, name: "Parent", reasoning: true }
          : undefined,
    },
    reload: vi.fn().mockResolvedValue(undefined),
  }) as unknown as ExtensionCommandContext;

const globalScope = "Global · /agent/pi-subagents.json";
const projectScope = "Project · /repo/.pi/pi-subagents.json";

describe("/subagents profile route settings", () => {
  it("keeps fleet dispatch and gives actionable non-TUI/argument warnings", async () => {
    const run = register(actions());
    const notify = vi.fn();
    await run("", {
      mode: "rpc",
      hasUI: true,
      ui: { notify },
    } as unknown as ExtensionCommandContext);
    expect(notify).toHaveBeenCalledWith("/subagents requires interactive TUI mode.", "warning");
    await run("profiles", {
      mode: "rpc",
      hasUI: true,
      ui: { notify },
    } as unknown as ExtensionCommandContext);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("requires interactive TUI mode"),
      "warning",
    );
    await run("wat", {
      mode: "rpc",
      hasUI: true,
      ui: { notify },
    } as unknown as ExtensionCommandContext);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Usage: /subagents [profiles]"),
      "error",
    );
  });

  it("opens the full-screen fleet overlay in TUI mode", async () => {
    const custom = vi.fn().mockResolvedValue(undefined);
    await register(actions())("", baseContext({ custom }));
    expect(custom.mock.calls[0]?.[1]).toEqual({
      overlay: true,
      overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" },
    });
  });

  it("gates project scope on trust and cancel performs no write", async () => {
    const managerActions = actions();
    const select = vi.fn().mockResolvedValue(undefined);
    await register(managerActions)(
      "profiles",
      baseContext({ select, custom: vi.fn(), notify: vi.fn() }, false),
    );
    expect(select.mock.calls[0]?.[0]).toContain("Project unavailable while untrusted");
    expect(select.mock.calls[0]?.[1]).toEqual([globalScope]);
    expect(managerActions.inspectProfiles).toHaveBeenCalledWith(false);
    expect(managerActions.patchProfile).not.toHaveBeenCalled();
  });

  it("lists every profile and exposes ordered routes as editable rather than JSON-managed", async () => {
    const value = inspection({ version: 4, profiles: { worker: threeRoute } });
    const managerActions = actions(value);
    const select = vi.fn().mockResolvedValueOnce(globalScope).mockResolvedValueOnce(undefined);
    await register(managerActions)(
      "profiles",
      baseContext({ select, custom: vi.fn(), notify: vi.fn() }),
    );
    const labels = select.mock.calls[1]?.[1] as string[];
    expect(labels).toHaveLength(7);
    expect(labels.find((label) => label.startsWith("worker"))).toContain("3 candidates");
    expect(labels.join(" ")).not.toContain("JSON-managed");
    expect(managerActions.patchProfile).not.toHaveBeenCalled();
  });

  it("loads, edits, confirms, and writes a complete three-candidate route in order", async () => {
    const value = inspection({ version: 4, profiles: { worker: threeRoute } });
    const managerActions = actions(value);
    const worker = _profileSettingsTest.profileSummary(value, "global", "worker");
    const second = candidateMenuSummary(threeRoute[1]!, 1);
    const select = vi
      .fn()
      .mockResolvedValueOnce(globalScope)
      .mockResolvedValueOnce(worker)
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce("Edit candidate")
      .mockResolvedValueOnce("Effort · medium")
      .mockResolvedValueOnce("high")
      .mockResolvedValueOnce("Done · apply candidate")
      .mockResolvedValueOnce("Save route");
    const confirm = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const notify = vi.fn();
    const ctx = baseContext({ select, custom: vi.fn(), confirm, notify });

    await register(managerActions)("profiles", ctx);

    const route = (managerActions.patchProfile as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
      .route as ProfileCandidate[];
    expect(route.map((entry) => entry.model)).toEqual([
      "openai/one",
      "claude-opus-5",
      "gpt-5.6-codex",
    ]);
    expect(route.map((entry) => entry.effort)).toEqual(["low", "high", "xhigh"]);
    expect(confirm.mock.calls[0]?.[1]).toContain("1. host=local · runtime=pi · model=openai/one");
    expect(confirm.mock.calls[0]?.[1]).toContain(
      "3. host=local · runtime=codex · model=gpt-5.6-codex",
    );
    expect(confirm.mock.calls[0]?.[1]).toContain("Target: /agent/pi-subagents.json");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("next /reload"), "info");
  });

  it("adds a retained Herdr Claude reader and retries unsafe native model input", async () => {
    const value = inspection();
    const managerActions = actions(value);
    const worker = _profileSettingsTest.profileSummary(value, "global", "worker");
    const select = vi
      .fn()
      .mockResolvedValueOnce(globalScope)
      .mockResolvedValueOnce(worker)
      .mockResolvedValueOnce("Disable route")
      .mockResolvedValueOnce("Add candidate · 0/32")
      .mockResolvedValueOnce("Host · local")
      .mockResolvedValueOnce("Herdr")
      .mockResolvedValueOnce("Runtime · pi")
      .mockResolvedValueOnce("Claude Code")
      .mockResolvedValueOnce("Model · claude-opus-5")
      .mockResolvedValueOnce("Effort · default")
      .mockResolvedValueOnce("xhigh")
      .mockResolvedValueOnce("Write intent · writer")
      .mockResolvedValueOnce("read-only")
      .mockResolvedValueOnce("After report · close")
      .mockResolvedValueOnce("Retain after report")
      .mockResolvedValueOnce("Done · apply candidate")
      .mockResolvedValueOnce("Save route");
    const input = vi.fn().mockResolvedValueOnce("-unsafe").mockResolvedValueOnce("claude-sonnet-5");
    const notify = vi.fn();
    await register(managerActions)(
      "profiles",
      baseContext({
        select,
        input,
        custom: vi.fn(),
        confirm: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
        notify,
      }),
    );

    expect(input.mock.calls[0]?.[0]).toContain("current: claude-opus-5");
    expect(input.mock.calls[0]?.[1]).toContain("Example/default: claude-opus-5");
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("cannot start with '-'"),
      "warning",
    );
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Candidate normalized"), "warning");
    expect(managerActions.patchProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        route: {
          host: "herdr",
          runtime: "claude",
          model: "claude-sonnet-5",
          effort: "xhigh",
          context: "fresh",
          writeIntent: "read-only",
          closeOnReport: false,
        },
      }),
    );
  });

  it("offers canonical authenticated Pi models and parent only to local Pi", () => {
    const models = [
      { provider: "openai", id: "reasoning", name: "Reasoning", reasoning: true },
      { provider: "zai", id: "plain", name: "Plain", reasoning: false },
    ] as never;
    const local = createProfileModelChoices({
      models,
      currentSelector: "parent",
      allowParent: true,
    });
    const herdr = createProfileModelChoices({
      models,
      currentSelector: "openai/reasoning",
      allowParent: false,
    });
    expect(local.map((choice) => choice.item.value)).toEqual([
      "parent",
      "openai/reasoning",
      "zai/plain",
    ]);
    expect(herdr.map((choice) => choice.item.value)).toEqual(["openai/reasoning", "zai/plain"]);
  });

  it("stages disabled and project-inherit declarations through the route menu", async () => {
    const disabledActions = actions();
    const disabledValue = inspection();
    await register(disabledActions)(
      "profiles",
      baseContext({
        select: vi
          .fn()
          .mockResolvedValueOnce(globalScope)
          .mockResolvedValueOnce(
            _profileSettingsTest.profileSummary(disabledValue, "global", "worker"),
          )
          .mockResolvedValueOnce("Disable route")
          .mockResolvedValueOnce("Save route"),
        custom: vi.fn(),
        confirm: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
        notify: vi.fn(),
      }),
    );
    expect(disabledActions.patchProfile).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "global", profile: "worker", route: "disabled" }),
    );

    const projectValue = inspection(
      { version: 4, profiles: { worker: threeRoute } },
      { version: 4, profiles: { worker: candidate("openai/project") } },
    );
    const inheritActions = actions(projectValue);
    await register(inheritActions)(
      "profiles",
      baseContext({
        select: vi
          .fn()
          .mockResolvedValueOnce(projectScope)
          .mockResolvedValueOnce(
            _profileSettingsTest.profileSummary(projectValue, "project", "worker"),
          )
          .mockResolvedValueOnce("Inherit global (remove project route)")
          .mockResolvedValueOnce("Save route"),
        custom: vi.fn(),
        confirm: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
        notify: vi.fn(),
      }),
    );
    expect(inheritActions.patchProfile).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "project", profile: "worker" }),
    );
    expect(inheritActions.patchProfile).toHaveBeenCalledWith(
      expect.not.objectContaining({ route: expect.anything() }),
    );
  });

  it("writes a missing trusted-project document with expectedExists=false", async () => {
    const value = inspection();
    const managerActions = actions(value);
    await register(managerActions)(
      "profiles",
      baseContext({
        select: vi
          .fn()
          .mockResolvedValueOnce(projectScope)
          .mockResolvedValueOnce(_profileSettingsTest.profileSummary(value, "project", "worker"))
          .mockResolvedValueOnce("Disable route")
          .mockResolvedValueOnce("Save route"),
        custom: vi.fn(),
        confirm: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
        notify: vi.fn(),
      }),
    );
    expect(managerActions.patchProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "project",
        profile: "worker",
        route: "disabled",
        expectedExists: false,
        projectTrusted: true,
      }),
    );
    expect(managerActions.patchProfile).toHaveBeenCalledWith(
      expect.not.objectContaining({ expectedDocument: expect.anything() }),
    );
  });

  it("resets a global declaration to built-in without writing a replacement candidate", async () => {
    const value = inspection({ version: 4, profiles: { worker: threeRoute } });
    const managerActions = actions(value);
    await register(managerActions)(
      "profiles",
      baseContext({
        select: vi
          .fn()
          .mockResolvedValueOnce(globalScope)
          .mockResolvedValueOnce(_profileSettingsTest.profileSummary(value, "global", "worker"))
          .mockResolvedValueOnce("Reset global to built-in")
          .mockResolvedValueOnce("Save route"),
        custom: vi.fn(),
        confirm: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
        notify: vi.fn(),
      }),
    );
    expect(managerActions.patchProfile).toHaveBeenCalledWith(
      expect.not.objectContaining({ route: expect.anything() }),
    );
  });

  it("replaces an invalid fail-closed declaration from the UI", async () => {
    const value = inspection({
      version: 4,
      profiles: { worker: { ...candidate("bare"), model: "bare" } },
    });
    const managerActions = actions(value);
    const notify = vi.fn();
    await register(managerActions)(
      "profiles",
      baseContext({
        select: vi
          .fn()
          .mockResolvedValueOnce(globalScope)
          .mockResolvedValueOnce(_profileSettingsTest.profileSummary(value, "global", "worker"))
          .mockResolvedValueOnce("Add candidate · 0/32")
          .mockResolvedValueOnce("Done · apply candidate")
          .mockResolvedValueOnce("Save route"),
        custom: vi.fn(),
        confirm: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
        notify,
      }),
    );
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("fails closed"), "warning");
    expect(managerActions.patchProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        route: {
          host: "local",
          runtime: "pi",
          model: "parent",
          effort: "default",
          context: "fresh",
          writeIntent: "writer",
          closeOnReport: true,
        },
      }),
    );
  });

  it("shows an actionable max-32 warning and cancel never writes", async () => {
    const route = Array.from({ length: 32 }, (_, index) => candidate(`openai/model-${index}`));
    const value = inspection({ version: 4, profiles: { worker: route } });
    const managerActions = actions(value);
    const notify = vi.fn();
    await register(managerActions)(
      "profiles",
      baseContext({
        select: vi
          .fn()
          .mockResolvedValueOnce(globalScope)
          .mockResolvedValueOnce(_profileSettingsTest.profileSummary(value, "global", "worker"))
          .mockResolvedValueOnce("Add candidate · maximum 32 reached")
          .mockResolvedValueOnce("Cancel · discard without writing"),
        custom: vi.fn(),
        notify,
      }),
    );
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("at most 32"), "warning");
    expect(managerActions.patchProfile).not.toHaveBeenCalled();
  });

  it("discards candidate edits and the entire route when cancel/back is chosen", async () => {
    const value = inspection({ version: 4, profiles: { worker: threeRoute } });
    const managerActions = actions(value);
    const first = candidateMenuSummary(threeRoute[0]!, 0);
    await register(managerActions)(
      "profiles",
      baseContext({
        select: vi
          .fn()
          .mockResolvedValueOnce(globalScope)
          .mockResolvedValueOnce(_profileSettingsTest.profileSummary(value, "global", "worker"))
          .mockResolvedValueOnce(first)
          .mockResolvedValueOnce("Edit candidate")
          .mockResolvedValueOnce("Cancel · discard candidate changes")
          .mockResolvedValueOnce("Cancel · discard without writing"),
        custom: vi.fn(),
        notify: vi.fn(),
      }),
    );
    expect(managerActions.patchProfile).not.toHaveBeenCalled();
  });

  it("reports patch conflicts without reload", async () => {
    const managerActions = actions();
    (managerActions.patchProfile as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Subagents settings changed on disk; reopen /subagents profiles and try again."),
    );
    const value = inspection();
    const notify = vi.fn();
    const ctx = baseContext({
      select: vi
        .fn()
        .mockResolvedValueOnce(globalScope)
        .mockResolvedValueOnce(_profileSettingsTest.profileSummary(value, "global", "worker"))
        .mockResolvedValueOnce("Disable route")
        .mockResolvedValueOnce("Save route"),
      custom: vi.fn(),
      confirm: vi.fn().mockResolvedValue(true),
      notify,
    });
    await register(managerActions)("profiles", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("changed on disk"), "error");
    expect(ctx.reload).not.toHaveBeenCalled();
  });

  it("preserves expectedDocument concurrency and warns before active-run reload", async () => {
    const bridge = makeSubagentProjectionBridge();
    bridge.publish({ revision: 1, runs: [{ state: "running" } as never] });
    const value = inspection({ version: 4, defaultProfile: "worker" });
    const managerActions = actions(value);
    const confirm = vi.fn().mockResolvedValue(true);
    const ctx = baseContext({
      select: vi
        .fn()
        .mockResolvedValueOnce(globalScope)
        .mockResolvedValueOnce(_profileSettingsTest.profileSummary(value, "global", "worker"))
        .mockResolvedValueOnce("Disable route")
        .mockResolvedValueOnce("Save route"),
      custom: vi.fn(),
      confirm,
      notify: vi.fn(),
    });
    await register(managerActions, bridge)("profiles", ctx);
    expect(managerActions.patchProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedExists: true,
        expectedDocument: { version: 4, defaultProfile: "worker" },
        projectTrusted: true,
      }),
    );
    expect(confirm.mock.calls.at(-1)?.[1]).toContain("stops all session-scoped runs");
    expect(ctx.reload).toHaveBeenCalledTimes(1);
  });

  it("keeps missing project routes inspectable as inherited ordered candidates", () => {
    const value = inspection({ version: 4, profiles: { worker: threeRoute } }, { version: 4 });
    const draft = loadProfileRouteDraft(value, "project", "worker");
    expect(draft.kind).toBe("inherit");
    expect(draft.candidates.map((entry) => entry.model)).toEqual([
      "openai/one",
      "claude-opus-5",
      "gpt-5.6-codex",
    ]);
  });
});
