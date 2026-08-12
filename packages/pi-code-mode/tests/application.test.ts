// Full-extension harness: Pi host callbacks are Promise-shaped boundaries.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCodeModeApplication } from "../src/application.ts";
import type { NestedPiToolDefinitions } from "../src/boundary/host-builtin-tools.ts";
import { CODE_MODE_TOOL_NAME } from "../src/tools/controller.ts";

const tempDirectories: string[] = [];
afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true });
  delete process.env.PI_CODING_AGENT_DIR;
});

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type CommandDefinition = { handler: (args: string, ctx: ExtensionContext) => unknown };

function harness() {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-code-mode-app-agent-"));
  tempDirectories.push(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const handlers = new Map<string, Handler>();
  const commands = new Map<string, CommandDefinition>();
  const registeredEvents: string[] = [];
  const registeredCommands: string[] = [];
  const registerTool = vi.fn();
  const notify = vi.fn();
  let activeTools: string[] = ["read", "bash"];
  const pi = {
    on(name: string, handler: Handler) {
      registeredEvents.push(name);
      handlers.set(name, handler);
    },
    registerCommand(name: string, definition: CommandDefinition) {
      registeredCommands.push(name);
      commands.set(name, definition);
    },
    registerTool,
    getActiveTools: () => [...activeTools],
    setActiveTools(names: string[]) {
      activeTools = [...names];
    },
    events: { emit: vi.fn(), on: vi.fn() },
  } as unknown as ExtensionAPI;

  registerCodeModeApplication(pi, {
    loadSettings: () => Promise.resolve(undefined),
    wrapTool: (tool) => tool,
    makeNestedDefinitions: () => ({}) as NestedPiToolDefinitions,
  });

  const makeContext = (cwd: string): ExtensionContext =>
    ({
      cwd,
      mode: "rpc",
      hasUI: true,
      ui: { notify, custom: vi.fn(), select: vi.fn() },
      isProjectTrusted: vi.fn(() => true),
    }) as unknown as ExtensionContext;

  return {
    handlers,
    commands,
    registeredEvents,
    registeredCommands,
    registerTool,
    notify,
    agentDir,
    makeContext,
    activeTools: () => [...activeTools],
  };
}

const newCwd = (): string => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-code-mode-app-cwd-"));
  tempDirectories.push(cwd);
  return cwd;
};

describe("code mode Pi registration", () => {
  it("registers only /code-mode-settings and session lifecycle handlers at load time", () => {
    const h = harness();
    expect(h.registeredCommands).toEqual(["code-mode-settings"]);
    expect(h.registeredEvents).toEqual(["session_start", "session_shutdown"]);
    // The code_mode tool is registered per session start, never at extension load.
    expect(h.registerTool).not.toHaveBeenCalled();
  });

  it("owns one session runtime across start, replacement, and shutdown", async () => {
    const h = harness();
    const command = h.commands.get("code-mode-settings");
    const firstCwd = newCwd();
    const firstCtx = h.makeContext(firstCwd);

    await h.handlers.get("session_start")?.({ reason: "startup" }, firstCtx);
    await command?.handler("status", firstCtx);
    expect(h.notify).toHaveBeenCalledWith(
      expect.stringContaining("Code Mode settings — effective values"),
      "info",
    );

    // A replacement session start atomically swaps to a runtime bound to the new cwd.
    const secondCwd = newCwd();
    const secondCtx = h.makeContext(secondCwd);
    await h.handlers.get("session_start")?.({ reason: "new" }, secondCtx);
    await command?.handler("project timeoutMs 45000", secondCtx);
    const secondProjectDoc = JSON.parse(
      readFileSync(join(secondCwd, ".pi", "extensions", "pi-code-mode.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(secondProjectDoc).toEqual({ timeoutMs: 45_000 });
    expect(() =>
      readFileSync(join(firstCwd, ".pi", "extensions", "pi-code-mode.json"), "utf8"),
    ).toThrow();

    // Each available session (re-)registers the one code_mode tool and activates it.
    expect(h.registerTool).toHaveBeenCalledTimes(2);
    expect(h.activeTools()).toEqual(["read", "bash", CODE_MODE_TOOL_NAME]);

    // Shutdown disposes the runtime; later commands degrade to a warning instead of hanging.
    await h.handlers.get("session_shutdown")?.({ reason: "quit" }, secondCtx);
    h.notify.mockClear();
    await command?.handler("status", secondCtx);
    expect(h.notify).toHaveBeenCalledWith("Code Mode settings are unavailable.", "warning");

    // Shutdown removes only code_mode from the active list.
    expect(h.activeTools()).toEqual(["read", "bash"]);
  });

  it("shuts down cleanly when the session host cannot be captured", async () => {
    const h = harness();
    const brokenCtx = h.makeContext("");
    await h.handlers.get("session_start")?.({ reason: "startup" }, brokenCtx);
    await h.commands.get("code-mode-settings")?.handler("status", brokenCtx);
    expect(h.notify).toHaveBeenCalledWith("Code Mode settings are unavailable.", "warning");
    expect(h.registerTool).not.toHaveBeenCalled();
  });
});
