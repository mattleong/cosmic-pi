// Full-extension harness: Pi host callbacks are Promise-shaped boundaries.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
import type { ExtensionHandler } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripAnsi } from "pi-cosmic-core";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  openSettingsSurfaceAtHostBoundary,
  type SettingsSurfaceFactory,
} from "../src/boundary/host-ui.ts";
import codeMode from "../src/extension.ts";
import { CODE_MODE_UNTRUSTED_NOTICE } from "../src/settings/controller.ts";
import { extensionApiFixture, extensionContextFixture } from "./support/host.ts";

const tempDirectories: string[] = [];
afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true });
  delete process.env.PI_CODING_AGENT_DIR;
});

type Handler = ExtensionHandler<any, any>;
type Completion = { value: string; label: string; description?: string };
type CommandDefinition = Parameters<ExtensionAPI["registerCommand"]>[1];
type SettingsComponent = {
  render(width: number): string[];
  handleInput?(data: string): void;
};

type SettingsTui = Parameters<SettingsSurfaceFactory>[0];
const settingsTui = <Fixture extends object>(fixture: Fixture): Fixture & SettingsTui => {
  // SAFETY: Settings surfaces use only requestRender from these TUI fixtures.
  return fixture as Fixture & SettingsTui;
};

type SettingsTheme = Parameters<SettingsSurfaceFactory>[1];
const settingsTheme = <Fixture extends object>(fixture: Fixture): Fixture & SettingsTheme => {
  // SAFETY: Settings surfaces use only fg and bold from these theme fixtures.
  return fixture as Fixture & SettingsTheme;
};

type SettingsKeybindings = Parameters<SettingsSurfaceFactory>[2];
const settingsKeybindings = <Fixture extends object>(
  fixture: Fixture,
): Fixture & SettingsKeybindings => {
  // SAFETY: These scenarios do not invoke keybinding-manager methods.
  return fixture as Fixture & SettingsKeybindings;
};

function harness(options: { trusted?: boolean } = {}) {
  const trusted = options.trusted ?? true;
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-mode-settings-cwd-"));
  const agentDir = mkdtempSync(join(tmpdir(), "pi-code-mode-settings-agent-"));
  tempDirectories.push(cwd, agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const handlers = new Map<string, Handler>();
  const commands = new Map<string, CommandDefinition>();
  const registerTool = vi.fn();
  const notify = vi.fn();
  const custom = vi.fn();
  const select = vi.fn(() => Promise.resolve<string | undefined>(undefined));
  const input = vi.fn(() => Promise.resolve<string | undefined>(undefined));
  const pi = extensionApiFixture({
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    registerCommand(name: string, definition: CommandDefinition) {
      commands.set(name, definition);
    },
    registerTool,
    events: { emit: vi.fn(), on: vi.fn() },
  });
  const ctx = extensionContextFixture({
    cwd,
    mode: "tui",
    hasUI: true,
    ui: { notify, custom, select, input },
    isProjectTrusted: vi.fn(() => trusted),
  });

  codeMode(pi);
  const command = commands.get("code-mode-settings");
  const globalPath = join(agentDir, "extensions", "pi-code-mode.json");
  const projectPath = join(cwd, ".pi", "extensions", "pi-code-mode.json");
  const readDoc = (path: string): Schema.JsonObject =>
    Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(
      JSON.parse(readFileSync(path, "utf8")),
    );
  const writeDoc = (path: string, document: Schema.JsonObject) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(document)}\n`);
  };
  return {
    handlers,
    commands,
    command,
    ctx,
    cwd,
    agentDir,
    notify,
    custom,
    select,
    input,
    registerTool,
    globalPath,
    projectPath,
    readDoc,
    writeDoc,
    start: () => Promise.resolve(handlers.get("session_start")?.({}, ctx)),
    shutdown: () => Promise.resolve(handlers.get("session_shutdown")?.({ reason: "quit" }, ctx)),
  };
}

const completionValues = async (
  result: Completion[] | Promise<Completion[] | null> | null | undefined,
): Promise<string[] | null> => {
  const completions = await result;
  return completions ? completions.map((completion) => completion.value) : null;
};

describe("/code-mode-settings", () => {
  test("completes ids, scopes, verbs, values, and inherit", async () => {
    const h = harness();
    const complete = h.command?.getArgumentCompletions;
    expect(complete).toBeTypeOf("function");

    expect(await completionValues(complete?.(""))).toEqual([
      "enabled",
      "timeoutMs",
      "maxToolCalls",
      "maxOutputBytes",
      "maxSourceBytes",
      "maxCumulativeChildOutputBytes",
      "catalogBudget",
      "global",
      "project",
      "status",
      "help",
    ]);
    expect(await completionValues(complete?.("timeo"))).toEqual(["timeoutMs"]);
    expect(await completionValues(complete?.("enabled "))).toEqual([
      "enabled true",
      "enabled false",
      "enabled inherit",
    ]);
    expect(await completionValues(complete?.("project enab"))).toEqual(["project enabled"]);
    expect(await completionValues(complete?.("project enabled "))).toEqual([
      "project enabled true",
      "project enabled false",
      "project enabled inherit",
    ]);
    expect(complete?.("zzz")).toBeNull();
  });

  test("bare non-TUI command never prompts: RPC gets help notifications, print is a no-op", async () => {
    const h = harness();
    await h.start();
    Object.assign(h.ctx, { mode: "rpc" });

    // RPC hosts receive the help text through `ctx.ui.notify` notifications.
    await h.command?.handler("", h.ctx);
    expect(h.custom).not.toHaveBeenCalled();
    expect(h.select).not.toHaveBeenCalled();
    expect(h.input).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("Code Mode settings"), "info");
    expect(h.notify).toHaveBeenCalledWith(
      expect.stringContaining("/code-mode-settings [global|project] <id> <value>"),
      "info",
    );

    // In print/JSON modes notifications are not rendered, so the bare command resolves as a
    // non-blocking no-op: no prompt, no custom surface, no hang.
    h.notify.mockClear();
    Object.assign(h.ctx, { mode: "print", hasUI: false });
    await h.command?.handler("", h.ctx);
    expect(h.custom).not.toHaveBeenCalled();
    expect(h.select).not.toHaveBeenCalled();
    expect(h.input).not.toHaveBeenCalled();
    await h.shutdown();
  });

  test("status shows effective values, provenance, and availability", async () => {
    const h = harness();
    h.writeDoc(h.globalPath, { timeoutMs: 60_000 });
    await h.start();

    await h.command?.handler("status", h.ctx);
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const message = h.notify.mock.calls.at(-1)?.[0] as string;
    expect(message).toContain("enabled = true (default)");
    expect(message).toContain("timeoutMs = 60000 (global)");
    expect(message).toContain("Code Mode availability: enabled for this trusted project");
    expect(message).toContain("The code_mode tool registers at session start");
    await h.shutdown();
  });

  test("applies global and project values and supports inherit", async () => {
    const h = harness();
    await h.start();

    await h.command?.handler("global timeoutMs 60000", h.ctx);
    expect(h.notify).toHaveBeenCalledWith("global timeoutMs = 60000", "info");
    expect(h.readDoc(h.globalPath)).toEqual({ timeoutMs: 60_000 });

    await h.command?.handler("project timeoutMs 45000", h.ctx);
    expect(h.notify).toHaveBeenCalledWith("project timeoutMs = 45000", "info");
    expect(h.readDoc(h.projectPath)).toEqual({ timeoutMs: 45_000 });

    await h.command?.handler("project timeoutMs inherit", h.ctx);
    expect(h.notify).toHaveBeenCalledWith("project timeoutMs = inherit", "info");
    expect(h.readDoc(h.projectPath)).toEqual({});

    h.notify.mockClear();
    await h.command?.handler("project enabled false", h.ctx);
    expect(h.notify).toHaveBeenCalledWith("project enabled = false", "info");
    expect(h.notify).toHaveBeenCalledWith(
      expect.stringContaining("Code Mode availability: disabled by settings"),
      "info",
    );
    await h.shutdown();
  });

  test("rejects invalid integers without persisting them", async () => {
    const h = harness();
    h.writeDoc(h.globalPath, { timeoutMs: 15_000 });
    await h.start();

    await h.command?.handler("global timeoutMs nope", h.ctx);
    expect(h.notify).toHaveBeenCalledWith(
      expect.stringContaining("Invalid value for timeoutMs"),
      "error",
    );
    await h.command?.handler("global timeoutMs 999999999", h.ctx);
    expect(h.readDoc(h.globalPath)).toEqual({ timeoutMs: 15_000 });
    await h.shutdown();
  });

  test("reports unknown settings and missing values", async () => {
    const h = harness();
    await h.start();
    await h.command?.handler("nope true", h.ctx);
    expect(h.notify).toHaveBeenCalledWith("Unknown setting: nope", "error");
    await h.command?.handler("enabled", h.ctx);
    expect(h.notify).toHaveBeenCalledWith(
      "Usage: /code-mode-settings [global|project] <id> <value|inherit>",
      "error",
    );
    await h.shutdown();
  });

  test("untrusted projects edit global scope only and hear the availability notice", async () => {
    const h = harness({ trusted: false });
    await h.start();

    // Project-scope writes are refused with the notice; no project document appears.
    await h.command?.handler("project enabled true", h.ctx);
    expect(h.notify).toHaveBeenCalledWith(CODE_MODE_UNTRUSTED_NOTICE, "warning");
    expect(existsSync(h.projectPath)).toBe(false);

    // Global writes still work.
    h.notify.mockClear();
    await h.command?.handler("global enabled true", h.ctx);
    expect(h.readDoc(h.globalPath)).toEqual({ enabled: true });
    expect(h.notify).toHaveBeenCalledWith(
      expect.stringContaining("unavailable — this project is not trusted"),
      "info",
    );

    // The interactive surface never offers a scope choice and repeats the notice.
    initTheme(undefined, false);
    h.custom.mockImplementation(() => Promise.resolve(undefined));
    h.notify.mockClear();
    await h.command?.handler("", h.ctx);
    expect(h.select).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledWith(CODE_MODE_UNTRUSTED_NOTICE, "warning");
    expect(h.custom).toHaveBeenCalledTimes(1);
    await h.shutdown();
  });

  test("opens an interactive per-scope list in TUI mode and persists cycled values", async () => {
    const h = harness();
    initTheme(undefined, false);
    let component: SettingsComponent | undefined;
    const done = vi.fn();
    h.custom.mockImplementation((factory) => {
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      component = (factory as SettingsSurfaceFactory)(
        settingsTui({ requestRender: vi.fn() }),
        settingsTheme({ fg: (_tone: string, text: string) => text, bold: (text: string) => text }),
        settingsKeybindings({}),
        done,
      );
      return Promise.resolve(undefined);
    });
    h.select.mockResolvedValue("project");

    await h.start();
    await h.command?.handler("", h.ctx);

    expect(h.select).toHaveBeenCalledTimes(1);
    expect(h.custom).toHaveBeenCalledTimes(1);
    const page = stripAnsi(component!.render(120).join("\n"));
    expect(page).toContain("Code Mode Settings — project scope");
    expect(page).toContain("Code Mode enabled");
    expect(page).toMatch(/Code Mode enabled\s+inherit/);

    // Enter cycles the first row from `inherit` to `true` and persists it in project scope.
    component!.handleInput?.("\r");
    await vi.waitFor(() => {
      expect(h.readDoc(h.projectPath)).toEqual({ enabled: true });
    });
    expect(stripAnsi(component!.render(120).join("\n"))).toMatch(/Code Mode enabled\s+true/);

    component!.handleInput?.("q");
    expect(done).toHaveBeenCalledWith(undefined);
    await h.shutdown();
  });

  test("warns instead of hanging when the session runtime is not active", async () => {
    const h = harness();
    // No session_start: every path resolves and reports unavailability.
    await h.command?.handler("status", h.ctx);
    expect(h.notify).toHaveBeenCalledWith("Code Mode settings are unavailable.", "warning");
    await h.command?.handler("global enabled false", h.ctx);
    expect(h.notify).toHaveBeenLastCalledWith("Code Mode settings are unavailable.", "warning");
  });

  /** Opens the interactive surface with the timeoutMs row displaying its last preset. */
  const openSurfaceAtLastTimeoutPreset = async (h: ReturnType<typeof harness>) => {
    h.writeDoc(h.globalPath, { timeoutMs: 300_000 });
    initTheme(undefined, false);
    let component: SettingsComponent | undefined;
    const done = vi.fn();
    h.custom.mockImplementation((factory) => {
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      component = (factory as SettingsSurfaceFactory)(
        settingsTui({ requestRender: vi.fn() }),
        settingsTheme({ fg: (_tone: string, text: string) => text, bold: (text: string) => text }),
        settingsKeybindings({}),
        done,
      );
      return Promise.resolve(undefined);
    });
    h.select.mockResolvedValue("global");
    await h.start();
    await h.command?.handler("", h.ctx);
    expect(h.custom).toHaveBeenCalledTimes(1);
    // Move to the timeoutMs row; Enter cycles its last preset (300000) onto `custom…`.
    component!.handleInput?.("\x1b[B");
    return component!;
  };

  test("persists a free bounded integer through the custom… input flow", async () => {
    const h = harness();
    h.input.mockResolvedValue("25000");
    const component = await openSurfaceAtLastTimeoutPreset(h);

    component.handleInput?.("\r");
    await vi.waitFor(() => {
      expect(h.input).toHaveBeenCalledTimes(1);
    });
    expect(h.input).toHaveBeenCalledWith(
      expect.stringContaining("timeoutMs: integer between 1 and 600000"),
      "300000",
    );
    await vi.waitFor(() => {
      expect(h.readDoc(h.globalPath)).toEqual({ timeoutMs: 25_000 });
    });
    await vi.waitFor(() => {
      expect(stripAnsi(component.render(120).join("\n"))).toMatch(/Program timeout \(ms\)\s+25000/);
    });
    await h.shutdown();
  });

  test("invalid custom input never persists and restores the persisted display", async () => {
    const h = harness();
    h.input.mockResolvedValue("nope");
    const component = await openSurfaceAtLastTimeoutPreset(h);

    component.handleInput?.("\r");
    await vi.waitFor(() => {
      expect(h.notify).toHaveBeenCalledWith(
        expect.stringContaining("Invalid value for timeoutMs"),
        "error",
      );
    });
    expect(h.readDoc(h.globalPath)).toEqual({ timeoutMs: 300_000 });
    await vi.waitFor(() => {
      expect(stripAnsi(component.render(120).join("\n"))).toMatch(
        /Program timeout \(ms\)\s+300000/,
      );
    });
    await h.shutdown();
  });

  test("cancelled custom input never persists and restores the persisted display", async () => {
    const h = harness();
    h.input.mockResolvedValue(undefined);
    const component = await openSurfaceAtLastTimeoutPreset(h);

    component.handleInput?.("\r");
    await vi.waitFor(() => {
      expect(h.input).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(stripAnsi(component.render(120).join("\n"))).toMatch(
        /Program timeout \(ms\)\s+300000/,
      );
    });
    expect(h.readDoc(h.globalPath)).toEqual({ timeoutMs: 300_000 });
    expect(h.notify).not.toHaveBeenCalledWith(expect.stringContaining("Invalid"), "error");
    await h.shutdown();
  });

  test("a hostile input callback degrades to a bounded warning without hanging", async () => {
    const h = harness();
    h.input.mockImplementation(() => {
      throw new Error("hostile input");
    });
    const component = await openSurfaceAtLastTimeoutPreset(h);

    component.handleInput?.("\r");
    await vi.waitFor(() => {
      expect(h.notify).toHaveBeenCalledWith(
        "Unable to read a custom value for timeoutMs.",
        "warning",
      );
    });
    expect(h.readDoc(h.globalPath)).toEqual({ timeoutMs: 300_000 });
    await vi.waitFor(() => {
      expect(stripAnsi(component.render(120).join("\n"))).toMatch(
        /Program timeout \(ms\)\s+300000/,
      );
    });
    await h.shutdown();
  });

  test("a rejecting input callback degrades to a bounded warning without hanging", async () => {
    const h = harness();
    h.input.mockImplementation(() => Promise.reject(new Error("rejected input")));
    const component = await openSurfaceAtLastTimeoutPreset(h);

    component.handleInput?.("\r");
    await vi.waitFor(() => {
      expect(h.notify).toHaveBeenCalledWith(
        "Unable to read a custom value for timeoutMs.",
        "warning",
      );
    });
    expect(h.readDoc(h.globalPath)).toEqual({ timeoutMs: 300_000 });
    await h.shutdown();
  });

  test("hostile select, custom, and render host callbacks stay contained", async () => {
    const h = harness();
    initTheme(undefined, false);
    await h.start();

    // A rejecting scope selector degrades to the global scope instead of failing the command.
    let component: SettingsComponent | undefined;
    h.select.mockImplementation(() => Promise.reject(new Error("hostile select")));
    const hostileRender = vi.fn(() => {
      throw new Error("hostile requestRender");
    });
    h.custom.mockImplementation((factory) => {
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      component = (factory as SettingsSurfaceFactory)(
        settingsTui({ requestRender: hostileRender }),
        settingsTheme({ fg: (_tone: string, text: string) => text, bold: (text: string) => text }),
        settingsKeybindings({}),
        vi.fn(),
      );
      return Promise.resolve(undefined);
    });
    await h.command?.handler("", h.ctx);
    expect(h.custom).toHaveBeenCalledTimes(1);
    expect(stripAnsi(component!.render(120).join("\n"))).toContain(
      "Code Mode Settings — global scope",
    );

    // Even with a throwing requestRender, applying a value persists and does not hang.
    component!.handleInput?.("\r");
    await vi.waitFor(() => {
      expect(h.readDoc(h.globalPath)).toEqual({ enabled: true });
    });

    // A synchronously throwing custom surface degrades to a bounded warning.
    h.custom.mockImplementation(() => {
      throw new Error("hostile custom");
    });
    h.select.mockResolvedValue("global");
    h.notify.mockClear();
    await h.command?.handler("", h.ctx);
    expect(h.notify).toHaveBeenCalledWith("Unable to open Code Mode settings.", "warning");

    // A synchronously throwing select also degrades without escaping the handler.
    h.select.mockImplementation(() => {
      throw new Error("hostile select");
    });
    h.custom.mockImplementation(() => Promise.reject(new Error("hostile custom")));
    h.notify.mockClear();
    await h.command?.handler("", h.ctx);
    expect(h.notify).toHaveBeenCalledWith("Unable to open Code Mode settings.", "warning");
    await h.shutdown();
  });

  test("a deferred hostile factory invocation yields an inert surface and a bounded warning", async () => {
    const h = harness();
    initTheme(undefined, false);
    await h.start();
    let component: ReturnType<SettingsSurfaceFactory> | undefined;
    const done = vi.fn(() => {
      throw new Error("hostile done");
    });
    // The host stores the factory and only invokes it later, outside the immediate call
    // stack, with a theme whose `bold` throws during surface construction.
    h.custom.mockImplementation((factory) =>
      Promise.resolve().then(() => {
        // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
        component = (factory as SettingsSurfaceFactory)(
          settingsTui({ requestRender: vi.fn() }),
          settingsTheme({
            fg: (_tone: string, text: string) => text,
            bold: () => {
              throw new Error("hostile theme");
            },
          }),
          settingsKeybindings({}),
          done,
        );
        return undefined;
      }),
    );
    h.select.mockResolvedValue("global");
    h.notify.mockClear();
    await h.command?.handler("", h.ctx);
    // The synchronous factory throw never reached the host; the outcome degraded instead.
    expect(h.notify).toHaveBeenCalledWith("Unable to open Code Mode settings.", "warning");
    // The wrapped factory asked the (hostile) host `done` to close and stayed contained.
    expect(done).toHaveBeenCalledWith(undefined);
    // The neutral replacement component is total for render/input/invalidate.
    expect(component!.render(120)).toEqual([]);
    expect(() => component!.handleInput?.("\r")).not.toThrow();
    expect(() => component!.invalidate()).not.toThrow();
    await h.shutdown();
  });

  test("a throwing host done callback stays contained on the cancel path", async () => {
    const h = harness();
    initTheme(undefined, false);
    let component: SettingsComponent | undefined;
    const done = vi.fn(() => {
      throw new Error("hostile done");
    });
    h.custom.mockImplementation((factory) => {
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      component = (factory as SettingsSurfaceFactory)(
        settingsTui({ requestRender: vi.fn() }),
        settingsTheme({ fg: (_tone: string, text: string) => text, bold: (text: string) => text }),
        settingsKeybindings({}),
        done,
      );
      return Promise.resolve(undefined);
    });
    h.select.mockResolvedValue("global");
    await h.start();
    await h.command?.handler("", h.ctx);
    expect(component).toBeDefined();
    // Cancelling delegates to the host `done`; its throw stays behind the guard.
    expect(() => component!.handleInput?.("q")).not.toThrow();
    expect(done).toHaveBeenCalledWith(undefined);
    await h.shutdown();
  });

  test("malformed host input delegation is contained by the caller-owned surface bridge", async () => {
    const h = harness();
    h.writeDoc(h.globalPath, { timeoutMs: 300_000 });
    initTheme(undefined, false);
    let component: SettingsComponent | undefined;
    h.custom.mockImplementation((factory) => {
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      component = (factory as SettingsSurfaceFactory)(
        settingsTui({ requestRender: vi.fn() }),
        settingsTheme({ fg: (_tone: string, text: string) => text, bold: (text: string) => text }),
        settingsKeybindings({}),
        vi.fn(),
      );
      return Promise.resolve(undefined);
    });
    h.select.mockResolvedValue("global");
    await h.start();
    await h.command?.handler("", h.ctx);
    // A hostile host may deliver non-string input data; delegation resolves to the bridge
    // fallback instead of throwing into the host, and the surface keeps working afterwards.
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    expect(() => component!.handleInput?.(undefined as undefined & string)).not.toThrow();
    expect(stripAnsi(component!.render(120).join("\n"))).toContain(
      "Code Mode Settings — global scope",
    );
    await h.shutdown();
  });
});

describe("openSettingsSurfaceAtHostBoundary", () => {
  const fakeCtx = (custom: (factory: SettingsSurfaceFactory) => Promise<undefined>) =>
    extensionContextFixture({ ui: { custom } });

  test("a stale post-settlement factory invocation stays contained", async () => {
    let captured: SettingsSurfaceFactory | undefined;
    const ctx = fakeCtx((factory) => {
      captured = factory;
      return Promise.resolve(undefined);
    });
    const outcome = await openSettingsSurfaceAtHostBoundary(ctx, () => {
      throw new Error("hostile factory");
    });
    // The host settled without invoking the factory, so the surface closed normally.
    expect(outcome).toBe("closed");

    // A stale host invoking the wrapped factory afterwards gets a neutral component and a
    // guarded close attempt; the caller factory's throw never escapes.
    const done = vi.fn(() => {
      throw new Error("hostile done");
    });
    let component: ReturnType<SettingsSurfaceFactory> | undefined;
    expect(() => {
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      component = captured!(undefined as never, undefined as never, undefined as never, done);
    }).not.toThrow();
    expect(done).toHaveBeenCalledWith(undefined);
    expect(component!.render(80)).toEqual([]);
    expect(() => component!.handleInput?.("x")).not.toThrow();
    expect(() => component!.invalidate()).not.toThrow();
    expect(() => component!.dispose?.()).not.toThrow();
  });

  test("the guarded done handed to the factory contains a throwing host done", async () => {
    let captured: SettingsSurfaceFactory | undefined;
    let resolveSurface: ((value: undefined) => void) | undefined;
    const ctx = fakeCtx((factory) => {
      captured = factory;
      return new Promise<undefined>((resolve) => {
        resolveSurface = resolve;
      });
    });
    let receivedDone: ((result: undefined) => void) | undefined;
    const outcomePromise = openSettingsSurfaceAtHostBoundary(
      ctx,
      (_tui, _theme, _keybindings, done) => {
        receivedDone = done;
        return { render: () => [], invalidate: () => undefined };
      },
    );
    const hostileDone = vi.fn(() => {
      throw new Error("hostile done");
    });
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    captured!(undefined as never, undefined as never, undefined as never, hostileDone);
    // The caller's cancel path invokes the guarded done without observing the host throw.
    expect(() => receivedDone!(undefined)).not.toThrow();
    expect(hostileDone).toHaveBeenCalledWith(undefined);
    resolveSurface!(undefined);
    await expect(outcomePromise).resolves.toBe("closed");
  });
});
