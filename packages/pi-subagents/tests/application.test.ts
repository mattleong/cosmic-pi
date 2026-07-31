// Promise assertions are test-runner boundaries.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/nodeBuiltinImport:off
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerSubagentApplication } from "../src/application/register.ts";

const testAgentDirectory = () => join(tmpdir(), "pi-subagents-application-tests");

const deferred = <A>() => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("subagent Pi registration", () => {
  it("defers the agent tool until session settings load", () => {
    const tools: string[] = [];
    const commands: string[] = [];
    const events: string[] = [];
    const pi = {
      registerTool: vi.fn((tool: { name: string }) => tools.push(tool.name)),
      registerCommand: vi.fn((name: string) => commands.push(name)),
      on: vi.fn((name: string) => events.push(name)),
      sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;

    registerSubagentApplication(pi);

    expect(tools).toEqual([]);
    expect(commands).toEqual(["subagents"]);
    expect(events).toEqual(["session_start", "turn_end", "session_tree", "session_shutdown"]);
  });

  it("makes out-of-order session preparation latest-wins and captures cwd/trust once", async () => {
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
    const first = deferred<void>();
    const second = deferred<void>();
    const loads: Array<readonly [string, boolean]> = [];
    const tools: string[] = [];
    const pi = {
      registerTool: vi.fn((tool: { name: string }) => tools.push(tool.name)),
      registerCommand: vi.fn(),
      on: vi.fn((name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
        handlers.set(name, handler);
      }),
      getActiveTools: vi.fn(() => ["read"]),
      setActiveTools: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;
    registerSubagentApplication(pi, {
      getAgentDirectory: testAgentDirectory,
      loadSettings: (cwd, trust) => {
        loads.push([cwd, trust]);
        return loads.length === 1 ? first.promise : second.promise;
      },
    });

    let firstCwdReads = 0;
    let firstTrustReads = 0;
    const firstContext = {
      get cwd() {
        firstCwdReads += 1;
        return `${process.cwd()}/first`;
      },
      signal: undefined,
      get isProjectTrusted() {
        firstTrustReads += 1;
        return () => true;
      },
      hasUI: false,
      mode: "rpc",
    } as unknown as ExtensionContext;
    const secondContext = {
      cwd: `${process.cwd()}/second`,
      signal: undefined,
      isProjectTrusted: () => false,
      hasUI: false,
      mode: "rpc",
    } as unknown as ExtensionContext;

    const firstStart = Promise.resolve(handlers.get("session_start")?.({}, firstContext));
    const secondStart = Promise.resolve(handlers.get("session_tree")?.({}, secondContext));
    second.resolve();
    await secondStart;
    expect(tools).toEqual(expect.arrayContaining(["subagent_start", "subagent_await"]));
    const winningRegistrationCount = tools.length;

    first.resolve();
    await firstStart;
    expect(tools).toHaveLength(winningRegistrationCount);
    expect(loads).toEqual([
      [`${process.cwd()}/first`, true],
      [`${process.cwd()}/second`, false],
    ]);
    expect(firstCwdReads).toBe(1);
    expect(firstTrustReads).toBe(1);
    await Promise.resolve(handlers.get("session_shutdown")?.({}, secondContext));
  });

  it("invalidates pending preparation on shutdown before tools can register", async () => {
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
    const settings = deferred<void>();
    const registerTool = vi.fn();
    const pi = {
      registerTool,
      registerCommand: vi.fn(),
      on: vi.fn((name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
        handlers.set(name, handler);
      }),
      getActiveTools: vi.fn(() => ["read"]),
      setActiveTools: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;
    registerSubagentApplication(pi, {
      getAgentDirectory: testAgentDirectory,
      loadSettings: () => settings.promise,
    });
    const ctx = {
      cwd: process.cwd(),
      signal: undefined,
      isProjectTrusted: () => true,
      hasUI: false,
      mode: "rpc",
    } as unknown as ExtensionContext;

    const starting = Promise.resolve(handlers.get("session_start")?.({}, ctx));
    await Promise.resolve(handlers.get("session_shutdown")?.({}, ctx));
    settings.resolve();
    await starting;
    expect(registerTool).not.toHaveBeenCalled();
  });

  it("accumulates partially disabled tool names across failures and clears after success", async () => {
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
    let active = ["read"];
    let callInActivation = 0;
    let throwAt = 2;
    const setActiveTools = vi.fn((names: ReadonlyArray<string>) => {
      active = [...names];
    });
    const pi = {
      registerTool: vi.fn((tool: { name: string }) => {
        callInActivation += 1;
        active = [...new Set([...active, tool.name])];
        if (callInActivation === throwAt) throw new Error("partial registration");
      }),
      registerCommand: vi.fn(),
      on: vi.fn((name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
        handlers.set(name, handler);
      }),
      getActiveTools: vi.fn(() => [...active]),
      setActiveTools,
      sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;
    registerSubagentApplication(pi, {
      getAgentDirectory: testAgentDirectory,
      loadSettings: () => Promise.resolve(),
    });
    const ctx = {
      cwd: process.cwd(),
      signal: undefined,
      isProjectTrusted: () => true,
      hasUI: false,
      mode: "rpc",
    } as unknown as ExtensionContext;
    const start = handlers.get("session_start");

    await Promise.resolve(start?.({}, ctx));
    expect(active).toEqual(["read"]);
    callInActivation = 0;
    throwAt = 3;
    await Promise.resolve(start?.({}, ctx));
    expect(active).toEqual(["read"]);

    callInActivation = 0;
    throwAt = Number.POSITIVE_INFINITY;
    await Promise.resolve(start?.({}, ctx));
    expect(active).toEqual(expect.arrayContaining(["read", "subagent_models", "subagent_start"]));
    expect(setActiveTools.mock.calls.some(([names]) => names.includes("subagent_models"))).toBe(
      true,
    );
    await Promise.resolve(handlers.get("session_shutdown")?.({}, ctx));
  });

  it("deactivates tools during replacement/abort and restores only the prior active subset", async () => {
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
    let active = ["read"];
    const replacementSettings = deferred<void>();
    let settingsLoads = 0;
    const pi = {
      registerTool: vi.fn((tool: { readonly name: string }) => {
        active = [...new Set([...active, tool.name])];
      }),
      registerCommand: vi.fn(),
      on: vi.fn((name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
        handlers.set(name, handler);
      }),
      getActiveTools: vi.fn(() => [...active]),
      setActiveTools: vi.fn((names: ReadonlyArray<string>) => {
        active = [...names];
      }),
      sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;
    registerSubagentApplication(pi, {
      getAgentDirectory: testAgentDirectory,
      loadSettings: () => {
        settingsLoads += 1;
        return settingsLoads === 2 ? replacementSettings.promise : Promise.resolve();
      },
    });
    const context = (signal?: AbortSignal) =>
      ({
        cwd: process.cwd(),
        signal,
        isProjectTrusted: () => true,
        hasUI: false,
        mode: "rpc",
      }) as unknown as ExtensionContext;

    await Promise.resolve(handlers.get("session_start")?.({}, context()));
    expect(active).toContain("subagent_start");
    active = active.filter((name) => name !== "subagent_status");

    const replacing = Promise.resolve(handlers.get("session_tree")?.({}, context()));
    await Promise.resolve();
    expect(active).toEqual(["read"]);
    replacementSettings.resolve();
    await replacing;
    expect(active).toContain("subagent_start");
    expect(active).not.toContain("subagent_status");

    const failedCapture = context() as unknown as Record<string, unknown>;
    Object.defineProperty(failedCapture, "cwd", {
      get: () => {
        throw new Error("capture failed");
      },
    });
    await Promise.resolve(
      handlers.get("session_tree")?.({}, failedCapture as unknown as ExtensionContext),
    );
    expect(active).toEqual(["read"]);
    await Promise.resolve(handlers.get("session_start")?.({}, context()));
    expect(active).toContain("subagent_start");
    expect(active).not.toContain("subagent_status");

    const aborted = new AbortController();
    aborted.abort();
    await Promise.resolve(handlers.get("session_tree")?.({}, context(aborted.signal)));
    expect(active).toEqual(["read"]);

    await Promise.resolve(handlers.get("session_start")?.({}, context()));
    expect(active).toContain("subagent_start");
    expect(active).not.toContain("subagent_status");
    await Promise.resolve(handlers.get("session_shutdown")?.({}, context()));
    expect(active).toEqual(["read"]);
  });

  it("fails activation visibly when subagent tool registration throws", async () => {
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
    const notify = vi.fn();
    const pi = {
      registerTool: vi.fn(() => {
        throw new Error("stale extension handle");
      }),
      registerCommand: vi.fn(),
      on: vi.fn((name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
        handlers.set(name, handler);
      }),
      getActiveTools: vi.fn(() => ["read", "subagent_start", "subagent_await"]),
      setActiveTools: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;
    registerSubagentApplication(pi);

    const sessionStart = handlers.get("session_start");
    expect(sessionStart).toBeTypeOf("function");
    await sessionStart?.({}, {
      cwd: process.cwd(),
      signal: undefined,
      hasUI: true,
      mode: "tui",
      isProjectTrusted: () => true,
      ui: { notify },
    } as unknown as ExtensionContext);

    expect(pi.setActiveTools).toHaveBeenCalledWith(["read"]);
    expect(notify).toHaveBeenCalledWith(
      "Subagents failed to activate because tool registration failed.",
      "error",
    );
  });
});
