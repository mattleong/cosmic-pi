// `code_mode` registration lifecycle at the Pi boundary: availability gating, exact active
// list preservation, user-deactivation policy, stale session races, and settings-before-wrap.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/globalTimers:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerCodeModeApplication,
  type CodeModeApplicationBoundaries,
} from "../src/application.ts";
import type { NestedPiToolDefinitions } from "../src/boundary/host-builtin-tools.ts";
import { CODE_MODE_UNAVAILABLE_MESSAGE } from "../src/tools/execution.ts";
import { CODE_MODE_TOOL_NAME, type CodeModeToolDefinition } from "../src/tools/controller.ts";

const tempDirectories: string[] = [];
afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true });
  delete process.env.PI_CODING_AGENT_DIR;
});

const newDirectory = (prefix: string): string => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
};

const OTHER_TOOLS = ["read", "bash", "another_extension_tool"];

const fakeNestedDefinitions = {} as NestedPiToolDefinitions;

interface HarnessOptions {
  readonly loadSettings?: CodeModeApplicationBoundaries["loadSettings"];
  readonly wrapTool?: CodeModeApplicationBoundaries["wrapTool"];
}

function harness(options: HarnessOptions = {}) {
  const agentDir = newDirectory("pi-code-mode-tool-agent-");
  process.env.PI_CODING_AGENT_DIR = agentDir;

  type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
  const handlers = new Map<string, Handler>();
  const events: string[] = [];
  let activeTools: string[] = [...OTHER_TOOLS];
  const registered: CodeModeToolDefinition[] = [];
  const nestedCwds: string[] = [];
  const notify = vi.fn();

  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    registerCommand: vi.fn(),
    registerTool(definition: CodeModeToolDefinition) {
      registered.push(definition);
      // Pi auto-activates a newly registered dynamic tool name; a re-registered name keeps
      // its previous activation.
      if (registered.length === 1 && !activeTools.includes(definition.name)) {
        activeTools = [...activeTools, definition.name];
      }
    },
    getActiveTools: () => [...activeTools],
    setActiveTools(names: string[]) {
      activeTools = [...names];
    },
    events: { emit: vi.fn(), on: vi.fn() },
  } as unknown as ExtensionAPI;

  const boundaries: CodeModeApplicationBoundaries = {
    loadSettings:
      options.loadSettings ??
      ((cwd) => {
        events.push(`settings:${cwd}`);
        return Promise.resolve(undefined);
      }),
    wrapTool:
      options.wrapTool ??
      ((tool) => {
        events.push(`wrap:${tool.name}`);
        return tool;
      }),
    makeNestedDefinitions: (cwd) => {
      nestedCwds.push(cwd);
      return fakeNestedDefinitions;
    },
  };

  registerCodeModeApplication(pi, boundaries);

  const makeContext = (cwd: string, trusted = true): ExtensionContext =>
    ({
      cwd,
      mode: "rpc",
      hasUI: true,
      ui: { notify, custom: vi.fn(), select: vi.fn(), input: vi.fn() },
      isProjectTrusted: vi.fn(() => trusted),
    }) as unknown as ExtensionContext;

  const startSession = (ctx: ExtensionContext) =>
    Promise.resolve(handlers.get("session_start")?.({ reason: "new" }, ctx)) as Promise<void>;
  const shutdownSession = (ctx: ExtensionContext) =>
    Promise.resolve(handlers.get("session_shutdown")?.({ reason: "quit" }, ctx)) as Promise<void>;

  return {
    agentDir,
    pi,
    events,
    notify,
    registered,
    nestedCwds,
    makeContext,
    startSession,
    shutdownSession,
    activeTools: () => [...activeTools],
    userSetsActiveTools: (names: string[]) => {
      activeTools = [...names];
    },
  };
}

const newCwd = (): string => newDirectory("pi-code-mode-tool-cwd-");

const disableCodeModeGlobally = (agentDir: string): void => {
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  writeFileSync(join(agentDir, "extensions", "pi-code-mode.json"), '{ "enabled": false }\n');
};

describe("availability gating", () => {
  it("registers exactly one wrapped code_mode tool when trusted and enabled", async () => {
    const h = harness();
    const cwd = newCwd();
    await h.startSession(h.makeContext(cwd));
    expect(h.registered).toHaveLength(1);
    expect(h.registered[0]?.name).toBe(CODE_MODE_TOOL_NAME);
    expect(h.nestedCwds).toEqual([cwd]);
    // Settings finished loading before the tool was wrapped, and the wrap preceded use.
    expect(h.events).toEqual([`settings:${cwd}`, `wrap:${CODE_MODE_TOOL_NAME}`]);
    expect(h.activeTools()).toEqual([...OTHER_TOOLS, CODE_MODE_TOOL_NAME]);
  });

  it("describes full built-in authority and the intentional middleware bypass honestly", async () => {
    const h = harness();
    await h.startSession(h.makeContext(newCwd()));
    const description = h.registered[0]?.description ?? "";
    expect(description).toContain("BYPASS Pi tool_call/tool_result middleware");
    expect(description).toContain("full local-user");
    expect(description).toContain("does not confine tool effects to the project directory");
    for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
      expect(description).toContain(`tools.pi.${name}`);
    }
    expect(description).toContain("default local shell implementation");
  });

  it("guides programs toward distilled strings or small purpose-built objects", async () => {
    const h = harness();
    await h.startSession(h.makeContext(newCwd()));
    const guidelines = h.registered[0]?.promptGuidelines?.join("\n") ?? "";
    expect(guidelines).toContain("Prefer a concise distilled string");
    expect(guidelines).toContain("small object containing only the requested fields");
    expect(guidelines).toContain("never raw nested tool results or whole files");
  });

  it("keeps code required while intent stays an optional bounded parameter", async () => {
    const h = harness();
    await h.startSession(h.makeContext(newCwd()));
    const parameters = h.registered[0]?.parameters as unknown as {
      required?: string[];
      properties?: Record<string, { maxLength?: number; description?: string }>;
    };
    expect(parameters?.required).toEqual(["code"]);
    expect(parameters?.properties?.intent?.maxLength).toBe(160);
    expect(parameters?.properties?.intent?.description).toMatch(/human-readable/);
  });

  it("registers nothing in an untrusted project", async () => {
    const h = harness();
    await h.startSession(h.makeContext(newCwd(), false));
    expect(h.registered).toHaveLength(0);
    expect(h.activeTools()).toEqual(OTHER_TOOLS);
  });

  it("registers nothing when Code Mode is disabled by settings", async () => {
    const h = harness();
    disableCodeModeGlobally(h.agentDir);
    await h.startSession(h.makeContext(newCwd()));
    expect(h.registered).toHaveLength(0);
    expect(h.activeTools()).toEqual(OTHER_TOOLS);
  });

  it("registers nothing when runtime startup fails, and removes only code_mode", async () => {
    const h = harness();
    await h.startSession(h.makeContext(newCwd()));
    expect(h.activeTools()).toContain(CODE_MODE_TOOL_NAME);
    // Break the next session's configuration root so its runtime startup fails.
    const brokenAgentDir = newDirectory("pi-code-mode-tool-agent-");
    process.env.PI_CODING_AGENT_DIR = brokenAgentDir;
    writeFileSync(join(brokenAgentDir, "extensions"), "not a directory\n");
    await h.startSession(h.makeContext(newCwd()));
    expect(h.notify).toHaveBeenCalledWith("Code Mode failed to start.", "warning");
    expect(h.registered).toHaveLength(1);
    expect(h.activeTools()).toEqual(OTHER_TOOLS);
  });
});

describe("active tool list reconciliation", () => {
  it("preserves every unrelated active tool exactly across sessions and shutdown", async () => {
    const h = harness();
    await h.startSession(h.makeContext(newCwd()));
    expect(h.activeTools()).toEqual([...OTHER_TOOLS, CODE_MODE_TOOL_NAME]);
    await h.startSession(h.makeContext(newCwd()));
    expect(h.activeTools()).toEqual([...OTHER_TOOLS, CODE_MODE_TOOL_NAME]);
    await h.shutdownSession(h.makeContext(newCwd()));
    expect(h.activeTools()).toEqual(OTHER_TOOLS);
  });

  it("preserves a user's deliberate deactivation across session replacement", async () => {
    const h = harness();
    await h.startSession(h.makeContext(newCwd()));
    expect(h.activeTools()).toContain(CODE_MODE_TOOL_NAME);
    // The user turns code_mode off mid-session.
    h.userSetsActiveTools(h.activeTools().filter((name) => name !== CODE_MODE_TOOL_NAME));
    await h.startSession(h.makeContext(newCwd()));
    expect(h.registered).toHaveLength(2);
    expect(h.activeTools()).toEqual(OTHER_TOOLS);
    // The user turns it back on; the next session keeps it active again.
    h.userSetsActiveTools([...h.activeTools(), CODE_MODE_TOOL_NAME]);
    await h.startSession(h.makeContext(newCwd()));
    expect(h.activeTools()).toEqual([...OTHER_TOOLS, CODE_MODE_TOOL_NAME]);
  });

  it("does not misread its own lifecycle removals as user deactivation", async () => {
    const h = harness();
    await h.startSession(h.makeContext(newCwd()));
    // An unavailable session removes code_mode (lifecycle removal, not user intent).
    await h.startSession(h.makeContext(newCwd(), false));
    expect(h.activeTools()).toEqual(OTHER_TOOLS);
    // The next available session re-activates because the user never deactivated it.
    await h.startSession(h.makeContext(newCwd()));
    expect(h.activeTools()).toEqual([...OTHER_TOOLS, CODE_MODE_TOOL_NAME]);
  });
});

describe("stale session races", () => {
  it("never registers an implementation for a superseded session start", async () => {
    const settingsGates = new Map<string, () => void>();
    const h = harness({
      loadSettings: (cwd) =>
        new Promise((resolve) => {
          settingsGates.set(cwd, () => resolve(undefined));
        }),
    });
    const waitForGate = async (cwd: string): Promise<() => void> => {
      while (!settingsGates.has(cwd)) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      return settingsGates.get(cwd) as () => void;
    };
    const slowCwd = newCwd();
    const fastCwd = newCwd();
    const slowStart = h.startSession(h.makeContext(slowCwd));
    const fastStart = h.startSession(h.makeContext(fastCwd));
    // The replacement session's settings resolve first; the stale one (if its start got far
    // enough to load settings at all) resolves afterwards.
    (await waitForGate(fastCwd))();
    await fastStart;
    settingsGates.get(slowCwd)?.();
    await slowStart;
    expect(h.registered).toHaveLength(1);
    expect(h.nestedCwds).toEqual([fastCwd]);
    expect(h.activeTools()).toEqual([...OTHER_TOOLS, CODE_MODE_TOOL_NAME]);
  });

  it("gates a stale registered implementation defensively at execute time", async () => {
    const h = harness();
    await h.startSession(h.makeContext(newCwd()));
    const stale = h.registered[0];
    await h.startSession(h.makeContext(newCwd()));
    expect(h.registered).toHaveLength(2);
    await expect(
      stale?.execute("stale-call", { code: "return 1;" }, undefined, undefined, {
        cwd: "/",
      } as unknown as ExtensionContext),
    ).rejects.toThrow(CODE_MODE_UNAVAILABLE_MESSAGE);
  });

  it("keeps the tool unregistered after shutdown even if a slow settings load resolves late", async () => {
    let releaseSettings: (() => void) | undefined;
    const h = harness({
      loadSettings: () =>
        new Promise((resolve) => {
          releaseSettings = () => resolve(undefined);
        }),
    });
    const ctx = h.makeContext(newCwd());
    const start = h.startSession(ctx);
    while (releaseSettings === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const shutdown = h.shutdownSession(ctx);
    releaseSettings?.();
    await Promise.all([start, shutdown]);
    expect(h.registered).toHaveLength(0);
    expect(h.activeTools()).toEqual(OTHER_TOOLS);
  });
});

describe("preview shell integration", () => {
  it("wraps the registered tool with the real code-preview shell after settings load", async () => {
    const { loadCodePreviewSettings, withCodePreviewShell } = await import("pi-code-previews");
    const h = harness({
      loadSettings: loadCodePreviewSettings,
      wrapTool: (tool) => withCodePreviewShell(tool),
    });
    await h.startSession(h.makeContext(newCwd()));
    expect(h.registered).toHaveLength(1);
    const wrapped = h.registered[0];
    expect(wrapped?.name).toBe(CODE_MODE_TOOL_NAME);
    expect(typeof wrapped?.renderCall).toBe("function");
    expect(typeof wrapped?.renderResult).toBe("function");
    expect(wrapped?.renderShell).toBeDefined();
  });

  it("preserves the humanized code_mode renderers through the real wrapper", async () => {
    const { loadCodePreviewSettings, withCodePreviewShell } = await import("pi-code-previews");
    const h = harness({
      loadSettings: loadCodePreviewSettings,
      wrapTool: (tool) => withCodePreviewShell(tool),
    });
    await h.startSession(h.makeContext(newCwd()));
    const wrapped = h.registered[0];
    const theme = {
      bold: (text: string) => text,
      fg: (_key: string, text: string) => text,
    } as never;
    const args = { code: "return 1;", intent: "Probe the repo" };

    // The cooperative shell delegates the call slot to the tool's own renderer.
    const call = wrapped?.renderCall?.(args, theme, undefined as never);
    expect(call?.render(200).join("\n")).toContain("Code Mode · Probe the repo");

    // And the result slot: activity rows, footer, and expanded output all come through.
    const context = {
      args,
      toolCallId: "call-render",
      invalidate: () => undefined,
      lastComponent: undefined,
      state: {},
      cwd: "/tmp",
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      expanded: true,
      showImages: false,
      isError: false,
    };
    const result = wrapped?.renderResult?.(
      {
        content: [{ type: "text", text: "model output" }],
        details: { toolCalls: [{ tool: "pi.read", status: "completed", activity: "Read a" }] },
      },
      { expanded: true, isPartial: false },
      theme,
      context as never,
    );
    const text = result?.render(200).join("\n") ?? "";
    expect(text).toContain("✓ 📖 Read a");
    expect(text).toContain("1 operation completed");
    expect(text).toContain("model output");
  });

  it("keeps the custom result inside the border shell for realistic multiline JSON", async () => {
    const { withCodePreviewShell } = await import("pi-code-previews");
    const h = harness({
      wrapTool: (tool) => withCodePreviewShell(tool, { mode: "border" }),
    });
    await h.startSession(h.makeContext(newCwd()));
    const wrapped = h.registered[0];
    const theme = {
      bold: (text: string) => text,
      fg: (_key: string, text: string) => text,
    } as never;
    const args = { code: "return { status };", intent: "Audit query migration structure" };
    const state = {};
    const context = (expanded: boolean, isPartial: boolean, lastComponent: unknown) =>
      ({
        args,
        toolCallId: "call-border-render",
        invalidate: () => undefined,
        lastComponent,
        state,
        cwd: "/tmp",
        executionStarted: true,
        argsComplete: true,
        isPartial,
        expanded,
        showImages: false,
        isError: false,
      }) as never;

    let shell = wrapped?.renderCall?.(args, theme, context(false, true, undefined));
    shell = wrapped?.renderCall?.(args, theme, context(true, false, shell));
    wrapped?.renderResult?.(
      {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: " M src/a.ts\n M src/b.ts\n",
                protectedQueryFiles: "src/protected/a.ts\nsrc/protected/b.ts",
                nestedIndexes: "No files found matching pattern",
                diffCheck: "(no output)",
              },
              null,
              2,
            ),
          },
        ],
        details: {
          toolCalls: [
            {
              tool: "pi.bash",
              status: "completed",
              activity: "Run git status --short",
              durationMs: 141,
            },
          ],
          counts: {
            total: 1,
            queued: 0,
            running: 0,
            succeeded: 1,
            failed: 0,
            cancelled: 0,
          },
          outputKind: "structured",
        },
      },
      { expanded: true, isPartial: false },
      theme,
      context(true, false, undefined),
    );
    const text = shell?.render(200).join("\n") ?? "";
    expect(text).toContain("Code Mode · Audit query migration structure");
    expect(text).toContain("✓ 🔧 Run git status --short · 141ms");
    expect(text).toContain("1 operation completed");
    expect(text).toContain("status");
    expect(text).toContain(" M src/a.ts");
    expect(text).toContain(" M src/b.ts");
    expect(text).not.toContain('"status": " M src/a.ts\\n');
  });

  it("still registers the tool when preview settings loading fails", async () => {
    const h = harness({
      loadSettings: () => Promise.reject(new Error("settings backend down")),
    });
    await h.startSession(h.makeContext(newCwd()));
    expect(h.registered).toHaveLength(1);
    expect(h.activeTools()).toContain(CODE_MODE_TOOL_NAME);
  });
});
