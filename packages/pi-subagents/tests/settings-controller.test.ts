// Promise assertions and controllable pending refreshes are test-runner boundaries.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
import * as Schema from "effect/Schema";
import type {
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { makeSubagentProjectionBridge } from "../src/boundary/host-ui.ts";
import { resolveSubagentConfig } from "../src/config/options.ts";
import { decodeSubagentConfig } from "../src/config/schema.ts";
import type { ProfileCandidate } from "../src/profiles/model.ts";
import {
  makeSessionProfileSnapshot,
  SessionProfileConflictError,
} from "../src/profiles/session-overrides.ts";
import {
  registerSubagentManagerCommand,
  type FleetManagerActions,
} from "../src/settings/controller.ts";
import type { ProfileSettingsInspection } from "../src/settings/profile-route-editor.ts";
import { createProfileModelChoices } from "../src/settings/ui/model-picker.ts";
import { extensionApiFixture, extensionContextFixture } from "./fixtures/pi-host.ts";

const tuiFixture = <Fixture extends object>(fixture: Fixture): Fixture & TUI => {
  // SAFETY: Workspace tests invoke only terminal.rows and requestRender on this TUI fixture.
  return fixture as Fixture & TUI;
};

const keybindingsFixture = <Fixture extends object>(
  fixture: Fixture,
): Fixture & KeybindingsManager => {
  // SAFETY: Workspace tests invoke only matches on this keybinding fixture.
  return fixture as Fixture & KeybindingsManager;
};

const inspection = <Global = undefined, Project = undefined>(
  global?: Global,
  project?: Project,
  trusted = true,
): ProfileSettingsInspection => {
  const JsonObjectSchema = Schema.Record(Schema.String, Schema.MutableJson);
  const globalDocument = Schema.decodeUnknownSync(JsonObjectSchema)(global ?? { version: 4 });
  const projectDocument = project ? Schema.decodeUnknownSync(JsonObjectSchema)(project) : undefined;
  const decodedGlobal = decodeSubagentConfig(globalDocument, "global");
  const decodedProject = projectDocument
    ? decodeSubagentConfig(projectDocument, "project")
    : undefined;
  const config = resolveSubagentConfig(
    (() => {
      const objectPart1428_0 = {
        globalConfigPath: "/agent/pi-subagents.json",
        projectConfigPath: "/repo/.pi/pi-subagents.json",
        projectTrusted: trusted,
        globalConfigExists: true,
        projectConfigExists: project !== undefined,
        global: decodedGlobal,
      };
      const objectPart1428_1 = decodedProject
        ? { ...objectPart1428_0, project: decodedProject }
        : objectPart1428_0;
      return objectPart1428_1;
    })(),
  );
  return (() => {
    const objectPart1743_0 = {
      config,
      session: makeSessionProfileSnapshot(config),
      globalDocument,
    };
    const objectPart1743_1 = projectDocument
      ? { ...objectPart1743_0, projectDocument }
      : objectPart1743_0;
    const objectPart1743_2 = { ...objectPart1743_1, global: decodedGlobal };
    const objectPart1743_3 = decodedProject
      ? { ...objectPart1743_2, project: decodedProject }
      : objectPart1743_2;
    return objectPart1743_3;
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
  patchSessionProfile: vi.fn().mockResolvedValue(undefined),
  clearSessionProfiles: vi.fn().mockResolvedValue(undefined),
  listNativeModels: vi.fn().mockResolvedValue([]),
});

const register = (managerActions: FleetManagerActions, bridge = makeSubagentProjectionBridge()) => {
  let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  // SAFETY: This test double intentionally implements the host contract surface exercised by this scenario.
  const pi = extensionApiFixture({
    registerCommand: (
      _name: string,
      command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
    ) => {
      handler = command.handler;
    },
  });
  registerSubagentManagerCommand(pi, bridge, managerActions);
  return (args: string, ctx: ExtensionCommandContext) => handler?.(args, ctx) ?? Promise.resolve();
};

// SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

interface FleetTestUi {
  readonly custom?: ReturnType<typeof vi.fn> | undefined;
  readonly notify?: ReturnType<typeof vi.fn> | undefined;
  readonly confirm?: ReturnType<typeof vi.fn> | undefined;
}

// SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
const baseContext = (ui: FleetTestUi, trusted = true) =>
  extensionContextFixture({
    mode: "tui",
    hasUI: true,
    ui,
    isProjectTrusted: () => trusted,
    model: { provider: "openai", id: "parent" },
    modelRegistry: {
      refresh: vi.fn().mockResolvedValue(undefined),
      getError: () => undefined,
      getAvailable: () => [
        { provider: "openai", id: "parent", name: "Parent", reasoning: true },
        { provider: "zai", id: "plain", name: "Plain", reasoning: false },
      ],
      find: (provider: string, id: string) =>
        provider === "openai" && id === "parent"
          ? { provider, id, name: "Parent", reasoning: true }
          : undefined,
      getRegisteredProviderIds: () => [],
    },
    reload: vi.fn().mockResolvedValue(undefined),
  });

const exerciseWorkspace = async (
  factory: (
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    done: (value: boolean) => void,
  ) => Component,
  exercise: (component: Component, done: (value: boolean) => void) => Promise<void> | void,
): Promise<boolean> => {
  let result = false;
  const done = (value: boolean) => void (result = value);
  const component = factory(
    tuiFixture({ terminal: { rows: 24 }, requestRender: vi.fn() }),
    theme,
    keybindingsFixture({
      matches: (data: string, id: string) => {
        if (id === "tui.select.up") return matchesKey(data, Key.up);
        if (id === "tui.select.down") return matchesKey(data, Key.down);
        if (id === "tui.select.confirm") return matchesKey(data, Key.enter);
        if (id === "tui.select.cancel") return matchesKey(data, Key.escape);
        return false;
      },
    }),
    done,
  );
  await exercise(component, done);
  return result;
};

describe("/subagents profile workspace", () => {
  it("keeps fleet dispatch and gives actionable non-TUI/argument warnings", async () => {
    const run = register(actions());
    const notify = vi.fn();
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    await run(
      "",
      extensionContextFixture({
        mode: "rpc",
        hasUI: true,
        ui: { notify },
      }),
    );
    expect(notify).toHaveBeenCalledWith("/subagents requires interactive TUI mode.", "warning");
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    await run(
      "profiles",
      extensionContextFixture({
        mode: "rpc",
        hasUI: true,
        ui: { notify },
      }),
    );
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("requires interactive TUI mode"),
      "warning",
    );
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    await run(
      "wat",
      extensionContextFixture({
        mode: "rpc",
        hasUI: true,
        ui: { notify },
      }),
    );
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Usage: /subagents [profiles [session|global|project]]"),
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

  it("starts a Pi model refresh before constructing the profile workspace", async () => {
    const custom = vi.fn().mockResolvedValue(false);
    const ctx = baseContext({ custom, notify: vi.fn() });
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const refresh = ctx.modelRegistry.refresh as ReturnType<typeof vi.fn>;

    await register(actions())("profiles", ctx);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.invocationCallOrder[0]).toBeLessThan(custom.mock.invocationCallOrder[0]!);
  });

  it("opens the profile workspace without waiting for a stalled model refresh", async () => {
    const custom = vi.fn().mockResolvedValue(false);
    const ctx = baseContext({ custom, notify: vi.fn() });
    const originalRegistry = ctx.modelRegistry;
    const refresh = vi.fn(
      (options?: { readonly signal?: AbortSignal }) =>
        new Promise<void>((resolve) => {
          options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        }),
    );
    Object.assign(ctx, {
      modelRegistry: {
        refresh,
        getError: () => originalRegistry.getError(),
        getAvailable: () => originalRegistry.getAvailable(),
        find: (provider: string, id: string) => originalRegistry.find(provider, id),
        getRegisteredProviderIds: () => originalRegistry.getRegisteredProviderIds(),
      },
    });

    await register(actions())("profiles", ctx);

    expect(custom).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0]?.[0]?.signal?.aborted).toBe(true);
  });

  it("uses refreshed non-extension models when switching a candidate to Herdr Pi", async () => {
    const managerActions = actions();
    let models = [{ provider: "cursor", id: "cached@1m", name: "Cached Cursor", reasoning: true }];
    const refresh = vi.fn(async () => {
      models = [
        { provider: "cursor", id: "fresh@1m", name: "Fresh Cursor", reasoning: true },
        { provider: "openai", id: "fresh", name: "Fresh OpenAI", reasoning: true },
      ];
    });
    const custom = vi.fn(async (factory) =>
      exerciseWorkspace(factory, async (component) => {
        component.handleInput?.("\r");
        component.handleInput?.("\r");
        component.handleInput?.("\r");
        expect(component.render(120).join("\n")).toContain("Choose host");
        component.handleInput?.("\u001b[B");
        component.handleInput?.("\r");
        await vi.waitFor(() => expect(managerActions.patchProfile).toHaveBeenCalledTimes(1));
      }),
    );
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const ctx = extensionContextFixture({
      ...baseContext({ custom, notify: vi.fn() }),
      model: { provider: "cursor", id: "cached@1m", name: "Cached Cursor", reasoning: true },
      modelRegistry: {
        refresh,
        getError: () => undefined,
        getAvailable: () => models,
        find: (provider: string, id: string) =>
          models.find((model) => model.provider === provider && model.id === id),
        getRegisteredProviderIds: () => ["cursor"],
      },
    });

    await register(managerActions)("profiles", ctx);

    expect(managerActions.patchProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: "generalist",
        route: expect.objectContaining({ host: "herdr", model: "openai/fresh" }),
      }),
    );
  });

  it("reports profile overlay failures instead of failing silently", async () => {
    const notify = vi.fn();
    const custom = vi.fn().mockRejectedValue(new Error("overlay unavailable"));

    await register(actions())("profiles", baseContext({ custom, notify }));

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Could not open Subagents profile settings"),
      "error",
    );
    expect(JSON.stringify(notify.mock.calls)).not.toContain("overlay unavailable");
  });

  it("uses the cached snapshot when Pi records a refresh error without rejecting", async () => {
    const managerActions = actions();
    let models = [{ provider: "openai", id: "cached", name: "Cached OpenAI", reasoning: true }];
    const notify = vi.fn();
    const custom = vi.fn(async (factory) =>
      exerciseWorkspace(factory, async (component) => {
        component.handleInput?.("\r");
        component.handleInput?.("\r");
        component.handleInput?.("\r");
        component.handleInput?.("\u001b[B");
        component.handleInput?.("\r");
        await vi.waitFor(() => expect(managerActions.patchProfile).toHaveBeenCalledTimes(1));
      }),
    );
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const ctx = extensionContextFixture({
      ...baseContext({ custom, notify }),
      model: undefined,
      modelRegistry: {
        refresh: vi.fn(async () => {
          models = [{ provider: "openai", id: "partial", name: "Partial OpenAI", reasoning: true }];
        }),
        getError: () => "secret recorded availability error",
        getAvailable: () => models,
        find: () => undefined,
        getRegisteredProviderIds: () => [],
      },
    });

    await register(managerActions)("profiles", ctx);

    expect(managerActions.patchProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        route: expect.objectContaining({ host: "herdr", model: "openai/cached" }),
      }),
    );
    expect(notify).toHaveBeenCalledWith(
      "Could not refresh Pi model catalogs; showing the last authenticated snapshot.",
      "warning",
    );
    expect(JSON.stringify(notify.mock.calls)).not.toContain("secret recorded availability error");
  });

  it("uses the cached model snapshot with a bounded warning when refresh fails", async () => {
    const custom = vi.fn().mockResolvedValue(false);
    const notify = vi.fn();
    const ctx = baseContext({ custom, notify });
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    (ctx.modelRegistry.refresh as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("secret refresh failure"),
    );

    await register(actions())("profiles", ctx);

    expect(custom).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      "Could not refresh Pi model catalogs; showing the last authenticated snapshot.",
      "warning",
    );
    expect(JSON.stringify(notify.mock.calls)).not.toContain("secret refresh failure");
  });

  it("keeps model search on a new page inside the single profile workspace", async () => {
    const initial = inspection({ version: 4 });
    const managerActions = actions(initial);
    const custom = vi.fn(async (factory) =>
      exerciseWorkspace(factory, async (component) => {
        component.handleInput?.("\u001b[A");
        component.handleInput?.("\u001b[A");
        component.handleInput?.("\t");
        component.handleInput?.("\t");
        component.handleInput?.("\u001b[B");
        component.handleInput?.("\u001b[B");
        component.handleInput?.("\r");
        await vi.waitFor(() =>
          expect(component.render(120).join("\n")).toContain("reviewer › candidate 1 › Model"),
        );
        component.handleInput?.("/");
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

  it("starts in global view regardless of project trust", async () => {
    for (const trusted of [true, false]) {
      const value = inspection({ version: 4 }, undefined, trusted);
      const managerActions = actions(value);
      const custom = vi.fn(async (factory) =>
        exerciseWorkspace(factory, (component, done) => {
          const rendered = component.render(120).join("\n");
          expect(rendered).toContain("[Global]");
          expect(rendered).toContain("Profiles");
          done(false);
        }),
      );
      await register(managerActions)("profiles", baseContext({ custom, notify: vi.fn() }, trusted));
      expect(managerActions.inspectProfiles).toHaveBeenCalledWith(trusted);
    }
  });

  it("dispatches session edits in memory without persistent writes or reload prompts", async () => {
    const initial = inspection();
    const managerActions = actions(initial);
    const notify = vi.fn();
    const custom = vi.fn(async (factory) =>
      exerciseWorkspace(factory, async (component) => {
        component.handleInput?.("\r");
        component.handleInput?.("d");
        component.handleInput?.("d");
        await vi.waitFor(() => expect(managerActions.patchSessionProfile).toHaveBeenCalledTimes(1));
      }),
    );

    await register(managerActions)("profiles session", baseContext({ custom, notify }));

    expect(managerActions.patchSessionProfile).toHaveBeenCalledWith({
      profile: "generalist",
      route: { candidates: [] },
      expectedRevision: 0,
    });
    expect(managerActions.patchProfile).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("Run /reload"), "info");
  });

  it("refreshes and permits retry after a session revision conflict", async () => {
    const initial = inspection();
    const fresh = {
      ...initial,
      session: makeSessionProfileSnapshot(initial.config, { revision: 1, overrides: {} }),
    };
    const managerActions = actions(initial);
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    (managerActions.inspectProfiles as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(initial)
      .mockResolvedValue(fresh);
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    (managerActions.patchSessionProfile as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(
        new SessionProfileConflictError({
          expectedRevision: 0,
          actualRevision: 1,
          message: "session conflict",
        }),
      )
      .mockResolvedValueOnce(undefined);
    const custom = vi.fn(async (factory) =>
      exerciseWorkspace(factory, async (component) => {
        component.handleInput?.("\r");
        component.handleInput?.("d");
        component.handleInput?.("d");
        await vi.waitFor(() =>
          expect(component.render(120).join("\n")).toContain("refreshed the active routes"),
        );
        component.handleInput?.("d");
        component.handleInput?.("d");
        await vi.waitFor(() => expect(managerActions.patchSessionProfile).toHaveBeenCalledTimes(2));
        expect(managerActions.patchSessionProfile).toHaveBeenLastCalledWith(
          expect.objectContaining({ expectedRevision: 1 }),
        );
      }),
    );

    await register(managerActions)("profiles session", baseContext({ custom, notify: vi.fn() }));
  });

  it("writes a complete valid route immediately and refreshes optimistic-concurrency state", async () => {
    const initial = inspection();
    const saved = inspection({ version: 4, profiles: { generalist: "disabled" } });
    const managerActions = actions(initial);
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
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
          expect(component.render(120).join("\n")).toContain("saved changes pending reload"),
        );
        component.handleInput?.("\u001b");
        component.handleInput?.("\u001b");
      }),
    );
    await register(managerActions)("profiles", baseContext({ custom, notify }));

    expect(managerActions.patchProfile).toHaveBeenCalledWith({
      scope: "global",
      profile: "generalist",
      route: "disabled",
      expectedExists: true,
      expectedDocument: { version: 4 },
      projectTrusted: true,
    });
    expect(managerActions.inspectProfiles).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Run /reload"), "info");
  });

  it("keeps failed immediate writes visible without claiming reload is required", async () => {
    const managerActions = actions();
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
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
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
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
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    bridge.publish({ revision: 1, runs: [{ state: "running" } as never] });
    const initial = inspection();
    const saved = inspection({ version: 4 }, { version: 4, profiles: { generalist: "disabled" } });
    const managerActions = actions(initial);
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
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
            expect(component.render(120).join("\n")).toContain("saved changes pending reload"),
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
