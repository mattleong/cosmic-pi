// Promise assertions are test-runner boundaries.
// @effect-diagnostics effect/asyncFunction:off
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { makeSubagentProjectionBridge } from "../src/boundary/host-ui.ts";
import { resolveSubagentConfig } from "../src/config/options.ts";
import { decodeSubagentConfig } from "../src/config/schema.ts";
import type { SubagentConfigInspection } from "../src/config/store.ts";
import {
  _profileSettingsTest,
  registerSubagentManagerCommand,
  type FleetManagerActions,
} from "../src/settings/controller.ts";

const globalDocument = { version: 2 };
const inspection = (
  global: Record<string, unknown> = globalDocument,
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

const register = (managerActions: FleetManagerActions) => {
  let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  const pi = {
    registerCommand: (
      _name: string,
      command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
    ) => {
      handler = command.handler;
    },
  } as unknown as ExtensionAPI;
  registerSubagentManagerCommand(pi, makeSubagentProjectionBridge(), managerActions);
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

describe("/subagents command and profile settings", () => {
  it("keeps no-argument fleet dispatch and reports the TUI requirement", async () => {
    const run = register(actions());
    const notify = vi.fn();
    await run("", {
      mode: "rpc",
      hasUI: true,
      ui: { notify },
    } as unknown as ExtensionCommandContext);
    expect(notify).toHaveBeenCalledWith("/subagents requires interactive TUI mode.", "warning");

    const custom = vi.fn().mockResolvedValue(undefined);
    await run("", baseContext({ custom }));
    expect(custom.mock.calls[0]?.[1]).toEqual({
      overlay: true,
      overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" },
    });
  });

  it("gives actionable help for unknown arguments and non-TUI profile settings", async () => {
    const run = register(actions());
    const notify = vi.fn();
    await run("wat", {
      mode: "rpc",
      hasUI: true,
      ui: { notify },
    } as unknown as ExtensionCommandContext);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Usage: /subagents [profiles]"),
      "error",
    );
    await run("profiles", {
      mode: "rpc",
      hasUI: true,
      ui: { notify },
    } as unknown as ExtensionCommandContext);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("requires interactive TUI mode"),
      "warning",
    );
  });

  it("shows only global scope when the project is untrusted", async () => {
    const managerActions = actions();
    const run = register(managerActions);
    const select = vi.fn().mockResolvedValue(undefined);
    await run("profiles", baseContext({ select, custom: vi.fn(), notify: vi.fn() }, false));
    expect(select.mock.calls[0]?.[0]).toContain("Project unavailable while untrusted");
    expect(select.mock.calls[0]?.[1]).toEqual(["Global · /agent/pi-subagents.json"]);
    expect(managerActions.inspectProfiles).toHaveBeenCalledWith(false);
    expect(managerActions.patchProfile).not.toHaveBeenCalled();
  });

  it("lists all profiles with source/model/effort and cancel performs no write", async () => {
    const managerActions = actions();
    const run = register(managerActions);
    const select = vi
      .fn()
      .mockResolvedValueOnce("Global · /agent/pi-subagents.json")
      .mockResolvedValueOnce(undefined);
    await run("profiles", baseContext({ select, custom: vi.fn(), notify: vi.fn() }));
    expect(select.mock.calls[1]?.[0]).toContain("/agent/pi-subagents.json");
    expect(select.mock.calls[1]?.[1]).toHaveLength(7);
    expect(select.mock.calls[1]?.[1][0]).toContain("builtin · parent · default");
    expect(managerActions.patchProfile).not.toHaveBeenCalled();
  });

  it("keeps global summaries scoped when a project route overrides them", () => {
    const value = inspection(
      {
        version: 2,
        profiles: { reviewer: { model: "claude-cli/fable", effort: "medium" } },
      },
      {
        version: 2,
        profiles: { reviewer: { model: "pi/openai-codex/gpt-5.6-sol", effort: "xhigh" } },
      },
    );

    expect(_profileSettingsTest.profileSummary(value, "global", "reviewer")).toBe(
      "reviewer · global · claude-cli/fable · medium",
    );
    expect(_profileSettingsTest.profileSummary(value, "project", "reviewer")).toBe(
      "reviewer · project · pi/openai-codex/gpt-5.6-sol · xhigh",
    );
  });

  it("navigates back from model to profile and from profile to scope", async () => {
    const managerActions = actions();
    const run = register(managerActions);
    const worker = _profileSettingsTest.profileSummary(inspection(), "global", "worker");
    const select = vi
      .fn()
      .mockResolvedValueOnce("Global · /agent/pi-subagents.json")
      .mockResolvedValueOnce(worker)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("Project · /repo/.pi/pi-subagents.json")
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    const custom = vi.fn().mockResolvedValueOnce(undefined);

    await run("profiles", baseContext({ select, custom, notify: vi.fn() }));

    expect(custom).toHaveBeenCalledTimes(1);
    expect(select.mock.calls.map(([title]) => title)).toEqual([
      "Subagent profile settings · choose scope · esc close",
      expect.stringContaining("Global profiles"),
      expect.stringContaining("Global profiles"),
      "Subagent profile settings · choose scope · esc close",
      expect.stringContaining("Project profiles"),
      "Subagent profile settings · choose scope · esc close",
    ]);
    expect(managerActions.patchProfile).not.toHaveBeenCalled();
  });

  it("returns from effort selection to the same profile's model picker", async () => {
    const managerActions = actions();
    const run = register(managerActions);
    const worker = _profileSettingsTest.profileSummary(inspection(), "global", "worker");
    const select = vi
      .fn()
      .mockResolvedValueOnce("Global · /agent/pi-subagents.json")
      .mockResolvedValueOnce(worker)
      .mockResolvedValueOnce(undefined);
    const custom = vi.fn().mockResolvedValueOnce("pi/zai/plain").mockResolvedValueOnce(undefined);

    await run("profiles", baseContext({ select, custom, notify: vi.fn() }));

    expect(select.mock.calls[2]?.[0]).toContain("Profile: worker · Effort");
    expect(custom).toHaveBeenCalledTimes(2);
    expect(managerActions.patchProfile).not.toHaveBeenCalled();
  });

  it("shows the active profile and scope in the model picker", async () => {
    const managerActions = actions();
    const run = register(managerActions);
    const worker = _profileSettingsTest.profileSummary(inspection(), "global", "worker");
    const custom = vi
      .fn()
      .mockImplementationOnce(
        (
          factory: (
            tui: { requestRender: () => void },
            theme: { fg: (_color: string, text: string) => string; bold: (text: string) => string },
            keybindings: { matches: () => boolean },
            done: (value: string | null) => void,
          ) => { render: (width: number) => string[] },
        ) => {
          const component = factory(
            { requestRender: vi.fn() },
            { fg: (_color, text) => text, bold: (text) => text },
            { matches: () => false },
            vi.fn(),
          );
          const rendered = component.render(120).join("\n");
          expect(rendered).toContain("Profile: worker · Select model");
          expect(rendered).toContain("Scope: Global · /agent/pi-subagents.json");
          expect(rendered).toContain("esc back to profiles");
          return Promise.resolve("disabled");
        },
      );
    const select = vi
      .fn()
      .mockResolvedValueOnce("Global · /agent/pi-subagents.json")
      .mockResolvedValueOnce(worker);

    await run(
      "profiles",
      baseContext({
        select,
        custom,
        confirm: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
        notify: vi.fn(),
      }),
    );

    expect(managerActions.patchProfile).toHaveBeenCalledWith(
      expect.objectContaining({ profile: "worker", route: "disabled" }),
    );
  });

  it("protects existing ordered routes as read-only", async () => {
    const value = inspection({
      version: 2,
      profiles: {
        worker: [
          { model: "pi/openai/one", effort: "low" },
          { model: "parent", effort: "default" },
        ],
      },
    });
    const managerActions = actions(value);
    const run = register(managerActions);
    const notify = vi.fn();
    const worker = _profileSettingsTest.profileSummary(value, "global", "worker");
    const select = vi
      .fn()
      .mockResolvedValueOnce("Global · /agent/pi-subagents.json")
      .mockResolvedValueOnce(worker);
    await run("profiles", baseContext({ select, custom: vi.fn(), notify }));
    expect(worker).toContain("Ordered route · 2 candidates · JSON-managed");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("read-only"), "warning");
    expect(managerActions.patchProfile).not.toHaveBeenCalled();
  });

  it("keeps an inherited global ordered route editable from project scope", async () => {
    const value = inspection(
      {
        version: 2,
        profiles: {
          worker: [
            { model: "pi/openai/one", effort: "low" },
            { model: "parent", effort: "default" },
          ],
        },
      },
      { version: 2 },
    );
    expect(_profileSettingsTest.currentSelectorFor(value, "project", "worker")).toBe("inherit");
    const managerActions = actions(value);
    const run = register(managerActions);
    const worker = _profileSettingsTest.profileSummary(value, "project", "worker");
    const select = vi
      .fn()
      .mockResolvedValueOnce("Project · /repo/.pi/pi-subagents.json")
      .mockResolvedValueOnce(worker)
      .mockResolvedValueOnce("off");
    const notify = vi.fn();
    await run(
      "profiles",
      baseContext({
        select,
        custom: vi.fn().mockResolvedValue("pi/zai/plain"),
        confirm: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
        notify,
      }),
    );
    expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("read-only"), "warning");
    expect(managerActions.patchProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "project",
        profile: "worker",
        route: { model: "pi/zai/plain", effort: "off" },
      }),
    );
  });

  it("keeps project-declared ordered routes read-only and names the project document", async () => {
    const value = inspection(
      { version: 2 },
      {
        version: 2,
        profiles: {
          worker: [
            { model: "pi/openai/one", effort: "low" },
            { model: "parent", effort: "default" },
          ],
        },
      },
    );
    const managerActions = actions(value);
    const run = register(managerActions);
    const notify = vi.fn();
    const worker = _profileSettingsTest.profileSummary(value, "project", "worker");
    const select = vi
      .fn()
      .mockResolvedValueOnce("Project · /repo/.pi/pi-subagents.json")
      .mockResolvedValueOnce(worker);
    await run("profiles", baseContext({ select, custom: vi.fn(), notify }));
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("/repo/.pi/pi-subagents.json"),
      "warning",
    );
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("read-only"), "warning");
    expect(managerActions.patchProfile).not.toHaveBeenCalled();
  });

  it("marks a malformed project route invalid instead of current inherit and lets inherit remove it", async () => {
    const value = inspection(
      { version: 2 },
      { version: 2, profiles: { worker: { model: "bare", effort: "high" } } },
    );
    expect(value.project?.invalidProfileRoutes).toEqual(["worker"]);
    expect(_profileSettingsTest.currentSelectorFor(value, "project", "worker")).toBeUndefined();
    expect(_profileSettingsTest.currentSelectorFor(value, "global", "worker")).toBe("parent");
    const managerActions = actions(value);
    const run = register(managerActions);
    const notify = vi.fn();
    const worker = _profileSettingsTest.profileSummary(value, "project", "worker");
    const select = vi
      .fn()
      .mockResolvedValueOnce("Project · /repo/.pi/pi-subagents.json")
      .mockResolvedValueOnce(worker);
    await run(
      "profiles",
      baseContext({
        select,
        custom: vi.fn().mockResolvedValue("inherit"),
        confirm: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
        notify,
      }),
    );
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("fails closed"), "warning");
    expect(managerActions.patchProfile).toHaveBeenCalledWith(
      expect.not.objectContaining({ route: expect.anything() }),
    );
  });

  it("mirrors invalid fail-closed handling for a malformed global route", () => {
    const value = inspection({
      version: 2,
      profiles: { worker: { model: "bare", effort: "high" } },
    });
    expect(value.global.invalidProfileRoutes).toEqual(["worker"]);
    expect(_profileSettingsTest.currentSelectorFor(value, "global", "worker")).toBeUndefined();
  });

  it("filters denied models and exposes only supported effort choices", () => {
    const models = [
      { provider: "openai", id: "reasoning", name: "Reasoning", reasoning: true },
      { provider: "zai", id: "plain", name: "Plain", reasoning: false },
    ] as never;
    const choices = _profileSettingsTest.createProfileModelChoices({
      models,
      parentModel: undefined,
      currentSelector: undefined,
      projectScope: false,
      policyFor: (_backend, model) => (model.includes("reasoning") ? "denied" : "allowed"),
    });
    expect(choices.some((choice) => choice.item.label.includes("reasoning"))).toBe(false);
    const plain = choices.find((choice) => choice.item.value === "pi/zai/plain");
    const efforts = _profileSettingsTest.effortPickerOptions(plain?.supportedEfforts ?? []);
    expect(efforts[0]).toEqual({ label: "Profile default", effort: "default" });
    expect(efforts.map((entry) => entry.effort)).toEqual(["default", "off"]);
    const claudeDescription = choices.find((choice) => choice.item.value === "claude-cli/sonnet")
      ?.item.description;
    expect(claudeDescription).toContain("fresh context only");
    expect(claudeDescription).toContain("an omitted fork preference adapts to fresh");
    expect(claudeDescription).toContain("launch readiness checked only when starting");
  });

  it("stages disabled, saves once, and declining reload explains next application", async () => {
    const managerActions = actions();
    const run = register(managerActions);
    const value = inspection();
    const worker = _profileSettingsTest.profileSummary(value, "global", "worker");
    const select = vi
      .fn()
      .mockResolvedValueOnce("Global · /agent/pi-subagents.json")
      .mockResolvedValueOnce(worker);
    const custom = vi.fn().mockResolvedValue("disabled");
    const confirm = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const notify = vi.fn();
    const ctx = baseContext({ select, custom, confirm, notify });
    await run("profiles", ctx);
    expect(managerActions.patchProfile).toHaveBeenCalledTimes(1);
    expect(managerActions.patchProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "global",
        profile: "worker",
        route: "disabled",
        expectedExists: true,
      }),
    );
    expect(ctx.reload).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("next /reload"), "info");
  });

  it("writes a concrete model and capability-filtered effort as one candidate", async () => {
    const managerActions = actions();
    const run = register(managerActions);
    const value = inspection();
    const worker = _profileSettingsTest.profileSummary(value, "global", "worker");
    const select = vi
      .fn()
      .mockResolvedValueOnce("Global · /agent/pi-subagents.json")
      .mockResolvedValueOnce(worker)
      .mockResolvedValueOnce("off");
    const ctx = baseContext({
      select,
      custom: vi.fn().mockResolvedValue("pi/zai/plain"),
      confirm: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
      notify: vi.fn(),
    });
    await run("profiles", ctx);
    expect(select.mock.calls[2]?.[0]).toContain("Profile: worker · Effort");
    expect(managerActions.patchProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "global",
        profile: "worker",
        route: { model: "pi/zai/plain", effort: "off" },
      }),
    );
  });

  it("removes a project profile declaration when Inherit global is selected", async () => {
    const value = inspection(
      { version: 2 },
      {
        version: 2,
        profiles: { worker: { model: "pi/openai/parent", effort: "high" } },
      },
    );
    const managerActions = actions(value);
    const run = register(managerActions);
    const worker = _profileSettingsTest.profileSummary(value, "project", "worker");
    const select = vi
      .fn()
      .mockResolvedValueOnce("Project · /repo/.pi/pi-subagents.json")
      .mockResolvedValueOnce(worker);
    const ctx = baseContext({
      select,
      custom: vi.fn().mockResolvedValue("inherit"),
      confirm: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
      notify: vi.fn(),
    });
    await run("profiles", ctx);
    expect(managerActions.patchProfile).toHaveBeenCalledWith(
      expect.not.objectContaining({ route: expect.anything() }),
    );
    expect(managerActions.patchProfile).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "project", profile: "worker" }),
    );
  });

  it("requires explicit confirmation before saving a discouraged model", async () => {
    const value = inspection({
      version: 2,
      discouraged: [{ backend: "pi", model: "zai/plain" }],
    });
    const worker = _profileSettingsTest.profileSummary(value, "global", "worker");
    const declineActions = actions(value);
    const runDecline = register(declineActions);
    const declineConfirm = vi.fn().mockResolvedValue(false);
    await runDecline(
      "profiles",
      baseContext({
        select: vi
          .fn()
          .mockResolvedValueOnce("Global · /agent/pi-subagents.json")
          .mockResolvedValueOnce(worker),
        custom: vi.fn().mockResolvedValueOnce("pi/zai/plain").mockResolvedValueOnce(undefined),
        confirm: declineConfirm,
        notify: vi.fn(),
      }),
    );
    expect(declineConfirm).toHaveBeenCalledWith("Discouraged model for worker", expect.any(String));
    expect(declineActions.patchProfile).not.toHaveBeenCalled();

    const acceptActions = actions(value);
    const runAccept = register(acceptActions);
    await runAccept(
      "profiles",
      baseContext({
        select: vi
          .fn()
          .mockResolvedValueOnce("Global · /agent/pi-subagents.json")
          .mockResolvedValueOnce(worker)
          .mockResolvedValueOnce("off"),
        custom: vi.fn().mockResolvedValue("pi/zai/plain"),
        confirm: vi
          .fn()
          .mockResolvedValueOnce(true)
          .mockResolvedValueOnce(true)
          .mockResolvedValueOnce(false),
        notify: vi.fn(),
      }),
    );
    expect(acceptActions.patchProfile).toHaveBeenCalledWith(
      expect.objectContaining({ route: { model: "pi/zai/plain", effort: "off" } }),
    );
  });

  it("reports patch conflicts as errors without reloading", async () => {
    const managerActions = actions();
    (managerActions.patchProfile as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Subagents settings changed on disk; reopen /subagents profiles and try again."),
    );
    const run = register(managerActions);
    const value = inspection();
    const worker = _profileSettingsTest.profileSummary(value, "global", "worker");
    const notify = vi.fn();
    const ctx = baseContext({
      select: vi
        .fn()
        .mockResolvedValueOnce("Global · /agent/pi-subagents.json")
        .mockResolvedValueOnce(worker),
      custom: vi.fn().mockResolvedValue("disabled"),
      confirm: vi.fn().mockResolvedValue(true),
      notify,
    });
    await run("profiles", ctx);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("changed on disk"), "error");
    expect(ctx.reload).not.toHaveBeenCalled();
  });

  it("reloads terminally after save and warns when active runs exist", async () => {
    const bridge = makeSubagentProjectionBridge();
    bridge.publish({
      revision: 1,
      runs: [{ state: "running" } as never],
    });
    const managerActions = actions();
    let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    const pi = {
      registerCommand: (_name: string, value: { handler: typeof handler }) => {
        handler = value.handler;
      },
    } as unknown as ExtensionAPI;
    registerSubagentManagerCommand(pi, bridge, managerActions);
    const value = inspection();
    const worker = _profileSettingsTest.profileSummary(value, "global", "worker");
    const select = vi
      .fn()
      .mockResolvedValueOnce("Global · /agent/pi-subagents.json")
      .mockResolvedValueOnce(worker);
    const confirm = vi.fn().mockResolvedValue(true);
    const ctx = baseContext({
      select,
      custom: vi.fn().mockResolvedValue("disabled"),
      confirm,
      notify: vi.fn(),
    });
    await handler?.("profiles", ctx);
    expect(confirm.mock.calls.at(-1)?.[1]).toContain("stops all session-scoped runs");
    expect(ctx.reload).toHaveBeenCalledTimes(1);
  });
});
