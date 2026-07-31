// Promise assertions are test-runner boundaries.
// @effect-diagnostics effect/asyncFunction:off
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { makeSubagentProjectionBridge } from "../src/boundary/host-ui.ts";
import { resolveSubagentConfig } from "../src/config/options.ts";
import { decodeSubagentConfig } from "../src/config/schema.ts";
import type { SubagentConfigInspection } from "../src/config/store.ts";
import type { ProfileCandidate } from "../src/profiles/model.ts";
import {
  registerSubagentManagerCommand,
  type FleetManagerActions,
} from "../src/settings/controller.ts";
import { createProfileModelChoices } from "../src/settings/ui/model-picker.ts";

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

const actions = (value = inspection()): FleetManagerActions => ({
  isAvailable: () => true,
  stop: () => Promise.resolve(),
  interrupt: () => Promise.resolve(),
  resume: () => Promise.resolve(),
  send: () => Promise.resolve(),
  reply: () => Promise.resolve(),
  rename: () => Promise.resolve(),
  inspectProfiles: vi.fn().mockResolvedValue(value),
  patchProfile: vi.fn().mockResolvedValue(undefined),
  listNativeModels: vi.fn().mockResolvedValue([]),
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

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

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

const exerciseWorkspace = async (
  factory: (
    tui: unknown,
    theme: Theme,
    keybindings: unknown,
    done: (value: boolean) => void,
  ) => Component,
  exercise: (component: Component, done: (value: boolean) => void) => Promise<void> | void,
): Promise<boolean> => {
  let result = false;
  const done = (value: boolean) => void (result = value);
  const component = factory(
    { terminal: { rows: 24 }, requestRender: vi.fn() },
    theme,
    {
      matches: (data: string, id: string) => {
        if (id === "tui.select.up") return matchesKey(data, Key.up);
        if (id === "tui.select.down") return matchesKey(data, Key.down);
        if (id === "tui.select.confirm") return matchesKey(data, Key.enter);
        if (id === "tui.select.cancel") return matchesKey(data, Key.escape);
        return false;
      },
    },
    done,
  );
  await exercise(component, done);
  return result;
};

describe("/subagents profile workspace", () => {
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

  it("explains inactive fleet state before opening an empty overlay", async () => {
    const managerActions: FleetManagerActions = { ...actions(), isAvailable: () => false };
    const custom = vi.fn().mockResolvedValue(undefined);
    const notify = vi.fn();
    await register(managerActions)("", baseContext({ custom, notify }));
    expect(custom).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      "Subagents are not active. Run /reload, then reopen /subagents.",
      "warning",
    );
  });

  it("opens fleet and profiles as full-screen overlays", async () => {
    const fleetCustom = vi.fn().mockResolvedValue(undefined);
    await register(actions())("", baseContext({ custom: fleetCustom }));
    expect(fleetCustom.mock.calls[0]?.[1]).toEqual({
      overlay: true,
      overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" },
    });

    const profileCustom = vi.fn().mockResolvedValue(false);
    const managerActions = actions();
    await register(managerActions)(
      "profiles",
      baseContext({ custom: profileCustom, notify: vi.fn() }),
    );
    expect(managerActions.inspectProfiles).toHaveBeenCalledWith(true);
    expect(profileCustom.mock.calls[0]?.[1]).toEqual({
      overlay: true,
      overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" },
    });
  });

  it("keeps model search on a new page inside the single profile workspace", async () => {
    const initial = inspection({ version: 4, defaultProfile: "reviewer" });
    const managerActions = actions(initial);
    const custom = vi.fn(async (factory) =>
      exerciseWorkspace(factory, async (component) => {
        component.handleInput?.("\t");
        component.handleInput?.("\t");
        component.handleInput?.("\u001b[B");
        component.handleInput?.("\u001b[B");
        component.handleInput?.("\r");
        await vi.waitFor(() =>
          expect(component.render(120).join("\n")).toContain("reviewer › candidate 1 › Model"),
        );
        for (const character of "zai") component.handleInput?.(character);
        expect(component.render(120).join("\n")).toContain("zai/plain");
        component.handleInput?.("\r");
        await vi.waitFor(() => expect(managerActions.patchProfile).toHaveBeenCalledTimes(1));
      }),
    );

    await register(managerActions)("profiles", baseContext({ custom, notify: vi.fn() }));

    expect(custom).toHaveBeenCalledTimes(1);
    expect(managerActions.patchProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: "reviewer",
        route: expect.objectContaining({ model: "zai/plain" }),
      }),
    );
  });

  it("starts in effective project view when trusted and global view when untrusted", async () => {
    for (const trusted of [true, false]) {
      const value = inspection({ version: 4 }, undefined, trusted);
      const managerActions = actions(value);
      const custom = vi.fn(async (factory) =>
        exerciseWorkspace(factory, (component, done) => {
          const rendered = component.render(120).join("\n");
          expect(rendered).toContain(trusted ? "[p Project]" : "[g Global]");
          expect(rendered).toContain("Profiles");
          done(false);
        }),
      );
      await register(managerActions)("profiles", baseContext({ custom, notify: vi.fn() }, trusted));
      expect(managerActions.inspectProfiles).toHaveBeenCalledWith(trusted);
    }
  });

  it("writes a complete valid route immediately and refreshes optimistic-concurrency state", async () => {
    const initial = inspection();
    const saved = inspection({ version: 4 }, { version: 4, profiles: { delegate: "disabled" } });
    const managerActions = actions(initial);
    (managerActions.inspectProfiles as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(saved);
    const notify = vi.fn();
    const custom = vi.fn(async (factory) =>
      exerciseWorkspace(factory, async (component) => {
        component.handleInput?.("\r");
        component.handleInput?.("d");
        component.handleInput?.("d");
        await vi.waitFor(() => expect(managerActions.patchProfile).toHaveBeenCalledTimes(1));
        await vi.waitFor(() =>
          expect(component.render(120).join("\n")).toContain("reload required"),
        );
        component.handleInput?.("\u001b");
        component.handleInput?.("\u001b");
      }),
    );
    await register(managerActions)("profiles", baseContext({ custom, notify }));

    expect(managerActions.patchProfile).toHaveBeenCalledWith({
      scope: "project",
      profile: "delegate",
      route: "disabled",
      expectedExists: false,
      projectTrusted: true,
    });
    expect(managerActions.inspectProfiles).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Run /reload"), "info");
  });

  it("keeps failed immediate writes visible without claiming reload is required", async () => {
    const managerActions = actions();
    (managerActions.patchProfile as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Subagents settings changed on disk; reopen the workspace."),
    );
    const notify = vi.fn();
    const custom = vi.fn(async (factory) =>
      exerciseWorkspace(factory, async (component, done) => {
        component.handleInput?.("\r");
        component.handleInput?.("d");
        component.handleInput?.("d");
        await vi.waitFor(() =>
          expect(component.render(120).join("\n")).toContain("changed on disk"),
        );
        component.handleInput?.("\u001b");
        done(false);
      }),
    );
    await register(managerActions)("profiles", baseContext({ custom, notify }));
    expect(managerActions.inspectProfiles).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("Run /reload"), "info");
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

  it("warns before reloading with active subagents", async () => {
    const bridge = makeSubagentProjectionBridge();
    bridge.publish({ revision: 1, runs: [{ state: "running" } as never] });
    const initial = inspection();
    const saved = inspection({ version: 4 }, { version: 4, profiles: { delegate: "disabled" } });
    const managerActions = actions(initial);
    (managerActions.inspectProfiles as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(saved);
    const confirm = vi.fn().mockResolvedValue(true);
    const notify = vi.fn();
    const ctx = baseContext({
      custom: vi.fn(async (factory) =>
        exerciseWorkspace(factory, async (component) => {
          component.handleInput?.("\r");
          component.handleInput?.("d");
          component.handleInput?.("d");
          await vi.waitFor(() =>
            expect(component.render(120).join("\n")).toContain("reload required"),
          );
          component.handleInput?.("r");
          await vi.waitFor(() => expect(confirm).toHaveBeenCalled());
        }),
      ),
      confirm,
      notify,
    });
    await register(managerActions, bridge)("profiles", ctx);
    expect(confirm.mock.calls[0]?.[1]).toContain("stops all session-scoped runs");
    expect(ctx.reload).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("Run /reload"), "info");
  });

  it("preserves complete ordered route declarations", () => {
    const value = inspection(
      {
        version: 4,
        profiles: {
          worker: [
            candidate("openai/one"),
            candidate("claude-opus-5", { host: "herdr", runtime: "claude" }),
          ],
        },
      },
      { version: 4 },
    );
    expect(value.config.profiles.worker.candidates.map((entry) => entry.model)).toEqual([
      "openai/one",
      "claude-opus-5",
    ]);
  });
});
