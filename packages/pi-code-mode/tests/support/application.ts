import type { ExtensionAPI, ExtensionHandler } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import {
  registerCodeModeApplication,
  type CodeModeApplicationBoundaries,
} from "../../src/application.ts";
import { CODE_MODE_TOOL_NAME } from "../../src/tools/controller.ts";
import {
  extensionApiFixture,
  extensionContextFixture,
  opaqueFixture,
} from "pi-cosmic-core/testing";

// Raw Node builtin access for synchronous test scaffolding, mirroring pi-cosmic-core's
// platform boundary; the Effect FileSystem service does not expose these sync contracts.
const nodeFsModule = process.getBuiltinModule("node:fs");
const nodePathModule = process.getBuiltinModule("node:path");
if (!nodeFsModule || !nodePathModule) throw new Error("Node fs/path builtins are unavailable.");
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = nodeFsModule;
const { join } = nodePathModule;

// Mutating the agent-directory slot is these suites' process-environment host boundary.
const processEnv: NodeJS.ProcessEnv = process.env;
const tempDirectories: string[] = [];

export const temporaryDirectory = (prefix: string): string => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
};

/** Register as the suite's `afterEach`: removes harness directories and the agent-dir override. */
export const cleanupApplications = () => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true });
  delete processEnv.PI_CODING_AGENT_DIR;
};

type Handler = ExtensionHandler<any, any>;
type CommandDefinition = Parameters<ExtensionAPI["registerCommand"]>[1];

/**
 * One real Code Mode registration over a caller-owned active-tool list (mutated in place, so
 * recreated instances can share it) and a fresh agent directory.
 */
export const applicationHarness = (
  boundaryOverrides: Partial<CodeModeApplicationBoundaries> = {},
  activeTools: string[] = [],
) => {
  const agentDir = temporaryDirectory("pi-code-mode-agent-");
  processEnv.PI_CODING_AGENT_DIR = agentDir;
  const cwd = temporaryDirectory("pi-code-mode-cwd-");
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, CommandDefinition>();
  const notify = vi.fn();
  const registerTool = vi.fn<ExtensionAPI["registerTool"]>();
  let restoreAfterNextRead = false;
  const pi = extensionApiFixture({
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    registerCommand(name: string, definition: CommandDefinition) {
      commands.set(name, definition);
    },
    registerTool,
    getActiveTools: () => {
      const snapshot = [...activeTools];
      if (restoreAfterNextRead) {
        restoreAfterNextRead = false;
        if (!activeTools.includes(CODE_MODE_TOOL_NAME)) activeTools.push(CODE_MODE_TOOL_NAME);
      }
      return snapshot;
    },
    setActiveTools(names: string[]) {
      activeTools.splice(0, activeTools.length, ...names);
    },
    events: { emit: vi.fn(), on: vi.fn() },
  });
  registerCodeModeApplication(pi, {
    loadSettings: () => Promise.resolve(opaqueFixture({})),
    wrapTool: (tool) => tool,
    // Tests that execute nested tools override this factory.
    makeNestedDefinitions: () => opaqueFixture({}),
    ...boundaryOverrides,
  });

  const makeContext = (
    options: {
      cwd?: string;
      signal?: AbortSignal;
      trusted?: boolean;
      sessionId?: string | undefined;
    } = {},
  ) =>
    extensionContextFixture({
      cwd: options.cwd ?? cwd,
      mode: "rpc",
      hasUI: true,
      signal: options.signal,
      ui: { notify, custom: vi.fn(), select: vi.fn(), input: vi.fn() },
      isProjectTrusted: vi.fn(() => options.trusted ?? true),
      ...(options.sessionId !== undefined && {
        sessionManager: { getSessionId: () => options.sessionId },
      }),
    });
  type Context = ReturnType<typeof makeContext>;
  const invoke = (name: string, event: { readonly reason: string }, ctx: Context) =>
    Promise.resolve(handlers.get(name)?.(event, ctx)).then(() => undefined);
  return {
    notify,
    registerTool,
    activeTools: () => [...activeTools],
    makeContext,
    start: (ctx: Context, reason = "startup") => invoke("session_start", { reason }, ctx),
    shutdown: (ctx: Context, reason = "quit") => invoke("session_shutdown", { reason }, ctx),
    tree: (ctx: Context) => invoke("session_tree", { reason: "tree" }, ctx),
    /** Runs `/code-mode settings <args>`. */
    command: (args: string, ctx: Context) =>
      Promise.resolve(commands.get("code-mode")?.handler(`settings ${args}`.trim(), ctx)).then(
        () => undefined,
      ),
    writeGlobalConfig: (json: string) => {
      const directory = join(agentDir, "extensions");
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "pi-code-mode.json"), json);
    },
    /** Simulate the host re-adding code_mode right after it next reports the active tools. */
    restoreAfterNextRead: () => {
      restoreAfterNextRead = true;
    },
  };
};
