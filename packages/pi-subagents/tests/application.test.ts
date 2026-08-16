// Promise assertions are test-runner boundaries.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/nodeBuiltinImport:off
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionCommandContext,
  ExtensionHandler,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { registerSubagentApplication } from "../src/application/register.ts";
import { extensionApiFixture, extensionContextFixture } from "./fixtures/pi-host.ts";

type Handler = ExtensionHandler<any, any>;

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
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const pi = extensionApiFixture({
      registerTool: vi.fn((tool: { name: string }) => tools.push(tool.name)),
      registerCommand: vi.fn((name: string) => commands.push(name)),
      on: vi.fn((name: string) => events.push(name)),
      sendMessage: vi.fn(),
    });

    registerSubagentApplication(pi);

    expect(tools).toEqual([]);
    expect(commands).toEqual(["subagents"]);
    expect(events).toEqual(["session_start", "turn_end", "session_tree", "session_shutdown"]);
  });

  it("makes out-of-order session preparation latest-wins and captures cwd/trust once", async () => {
    const handlers = new Map<string, Handler>();
    const first = deferred<void>();
    const second = deferred<void>();
    const loads: Array<readonly [string, boolean]> = [];
    const tools: string[] = [];
    // SAFETY: This test double intentionally implements the host contract surface exercised by this scenario.
    const pi = extensionApiFixture({
      registerTool: vi.fn((tool: { name: string }) => tools.push(tool.name)),
      registerCommand: vi.fn(),
      on: vi.fn((name: string, handler: Handler) => {
        handlers.set(name, handler);
      }),
      getActiveTools: vi.fn(() => ["read"]),
      setActiveTools: vi.fn(),
      sendMessage: vi.fn(),
    });
    registerSubagentApplication(pi, {
      getAgentDirectory: testAgentDirectory,
      loadSettings: (cwd, trust) => {
        loads.push([cwd, trust]);
        return loads.length === 1 ? first.promise : second.promise;
      },
    });

    let firstCwdReads = 0;
    let firstTrustReads = 0;
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const firstContext = extensionContextFixture({
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
    });
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const secondContext = extensionContextFixture({
      cwd: `${process.cwd()}/second`,
      signal: undefined,
      isProjectTrusted: () => false,
      hasUI: false,
      mode: "rpc",
    });

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
    const handlers = new Map<string, Handler>();
    const settings = deferred<void>();
    const registerTool = vi.fn();
    // SAFETY: This test double intentionally implements the host contract surface exercised by this scenario.
    const pi = extensionApiFixture({
      registerTool,
      registerCommand: vi.fn(),
      on: vi.fn((name: string, handler: Handler) => {
        handlers.set(name, handler);
      }),
      getActiveTools: vi.fn(() => ["read"]),
      setActiveTools: vi.fn(),
      sendMessage: vi.fn(),
    });
    registerSubagentApplication(pi, {
      getAgentDirectory: testAgentDirectory,
      loadSettings: () => settings.promise,
    });
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const ctx = extensionContextFixture({
      cwd: process.cwd(),
      signal: undefined,
      isProjectTrusted: () => true,
      hasUI: false,
      mode: "rpc",
    });

    const starting = Promise.resolve(handlers.get("session_start")?.({}, ctx));
    await Promise.resolve(handlers.get("session_shutdown")?.({}, ctx));
    settings.resolve();
    await starting;
    expect(registerTool).not.toHaveBeenCalled();
  });

  it("accumulates partially disabled tool names across failures and clears after success", async () => {
    const handlers = new Map<string, Handler>();
    let active = ["read"];
    let callInActivation = 0;
    let throwAt = 2;
    const setActiveTools = vi.fn((names: ReadonlyArray<string>) => {
      active = [...names];
    });
    // SAFETY: This test double intentionally implements the host contract surface exercised by this scenario.
    const pi = extensionApiFixture({
      registerTool: vi.fn((tool: { name: string }) => {
        callInActivation += 1;
        active = [...new Set([...active, tool.name])];
        if (callInActivation === throwAt) throw new Error("partial registration");
      }),
      registerCommand: vi.fn(),
      on: vi.fn((name: string, handler: Handler) => {
        handlers.set(name, handler);
      }),
      getActiveTools: vi.fn(() => [...active]),
      setActiveTools,
      sendMessage: vi.fn(),
    });
    registerSubagentApplication(pi, {
      getAgentDirectory: testAgentDirectory,
      loadSettings: () => Promise.resolve(),
    });
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const ctx = extensionContextFixture({
      cwd: process.cwd(),
      signal: undefined,
      isProjectTrusted: () => true,
      hasUI: false,
      mode: "rpc",
    });
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
    const handlers = new Map<string, Handler>();
    let active = ["read"];
    const replacementSettings = deferred<void>();
    let settingsLoads = 0;
    // SAFETY: This test double intentionally implements the host contract surface exercised by this scenario.
    const pi = extensionApiFixture({
      registerTool: vi.fn((tool: { readonly name: string }) => {
        active = [...new Set([...active, tool.name])];
      }),
      registerCommand: vi.fn(),
      on: vi.fn((name: string, handler: Handler) => {
        handlers.set(name, handler);
      }),
      getActiveTools: vi.fn(() => [...active]),
      setActiveTools: vi.fn((names: ReadonlyArray<string>) => {
        active = [...names];
      }),
      sendMessage: vi.fn(),
    });
    registerSubagentApplication(pi, {
      getAgentDirectory: testAgentDirectory,
      loadSettings: () => {
        settingsLoads += 1;
        return settingsLoads === 2 ? replacementSettings.promise : Promise.resolve();
      },
    });
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const context = (signal?: AbortSignal) =>
      extensionContextFixture({
        cwd: process.cwd(),
        signal,
        isProjectTrusted: () => true,
        hasUI: false,
        mode: "rpc",
      });

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

    const failedCapture = context();
    Object.defineProperty(failedCapture, "cwd", {
      get: () => {
        throw new Error("capture failed");
      },
    });
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    await Promise.resolve(
      handlers.get("session_tree")?.({}, extensionContextFixture(failedCapture)),
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

  it("preserves session overrides across tree and reload but clears them for a new session", async () => {
    const handlers = new Map<string, Handler>();
    let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    let active = ["read"];
    // SAFETY: This test double intentionally implements the host contract surface exercised by this scenario.
    const pi = extensionApiFixture({
      registerTool: vi.fn((tool: { readonly name: string }) => {
        active = [...new Set([...active, tool.name])];
      }),
      registerCommand: vi.fn(
        (
          _name: string,
          definition: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
        ) => {
          command = definition.handler;
        },
      ),
      on: vi.fn((name: string, handler: Handler) => {
        handlers.set(name, handler);
      }),
      getActiveTools: vi.fn(() => [...active]),
      setActiveTools: vi.fn((names: ReadonlyArray<string>) => {
        active = [...names];
      }),
      sendMessage: vi.fn(),
      getThinkingLevel: vi.fn(() => "high"),
    });
    registerSubagentApplication(pi, {
      getAgentDirectory: testAgentDirectory,
      loadSettings: () => Promise.resolve(),
    });

    let component: Component | undefined;
    let closeOverlay: ((value: boolean) => void) | undefined;
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as Theme;
    const ui = {
      notify: vi.fn(),
      confirm: vi.fn().mockResolvedValue(false),
      custom: vi.fn((factory: (...args: unknown[]) => Component) => {
        let resolve!: (value: boolean) => void;
        const result = new Promise<boolean>((done) => {
          resolve = done;
        });
        closeOverlay = resolve;
        component = factory(
          { terminal: { rows: 24 }, requestRender: vi.fn() },
          theme,
          {
            matches: (data: string, id: string) =>
              id === "tui.select.confirm"
                ? matchesKey(data, Key.enter)
                : id === "tui.select.cancel"
                  ? matchesKey(data, Key.escape)
                  : false,
            getKeys: () => [],
          },
          resolve,
        );
        return result;
      }),
    };
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const ctx = extensionContextFixture({
      cwd: process.cwd(),
      signal: undefined,
      isProjectTrusted: () => true,
      hasUI: true,
      mode: "tui",
      ui,
      model: undefined,
      modelRegistry: { getAvailable: () => [] },
      sessionManager: { getSessionId: () => "application-reload-session" },
    });

    await Promise.resolve(handlers.get("session_start")?.({ reason: "startup" }, ctx));
    const first = command?.("profiles session", ctx) ?? Promise.resolve();
    await vi.waitFor(() => expect(component).toBeDefined());
    component?.handleInput?.("\r");
    component?.handleInput?.("d");
    component?.handleInput?.("d");
    await vi.waitFor(() =>
      expect(component?.render(120).join("\n")).toContain("1 session override · applies now"),
    );
    closeOverlay?.(false);
    await first;

    component = undefined;
    await Promise.resolve(handlers.get("session_tree")?.({}, ctx));
    const afterTree = command?.("profiles session", ctx) ?? Promise.resolve();
    await vi.waitFor(() =>
      expect(component?.render(120).join("\n")).toContain("1 session override · applies now"),
    );
    closeOverlay?.(false);
    await afterTree;

    component = undefined;
    await Promise.resolve(handlers.get("session_shutdown")?.({ reason: "reload" }, ctx));
    await Promise.resolve(handlers.get("session_start")?.({ reason: "reload" }, ctx));
    const afterReload = command?.("profiles session", ctx) ?? Promise.resolve();
    await vi.waitFor(() =>
      expect(component?.render(120).join("\n")).toContain("1 session override · applies now"),
    );
    closeOverlay?.(false);
    await afterReload;

    component = undefined;
    await Promise.resolve(handlers.get("session_shutdown")?.({ reason: "reload" }, ctx));
    await Promise.resolve(handlers.get("session_start")?.({ reason: "reload" }, ctx));
    const afterSecondReload = command?.("profiles session", ctx) ?? Promise.resolve();
    await vi.waitFor(() =>
      expect(component?.render(120).join("\n")).toContain("1 session override · applies now"),
    );
    closeOverlay?.(false);
    await afterSecondReload;

    const failedTreeContext = { ...ctx };
    Object.defineProperty(failedTreeContext, "cwd", {
      get: () => {
        throw new Error("tree capture failed");
      },
    });
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    await Promise.resolve(
      handlers.get("session_tree")?.({}, extensionContextFixture(failedTreeContext)),
    );
    component = undefined;
    await Promise.resolve(handlers.get("session_shutdown")?.({ reason: "reload" }, ctx));
    await Promise.resolve(handlers.get("session_start")?.({ reason: "reload" }, ctx));
    const afterFailedTreeReload = command?.("profiles session", ctx) ?? Promise.resolve();
    await vi.waitFor(() =>
      expect(component?.render(120).join("\n")).toContain("1 session override · applies now"),
    );
    closeOverlay?.(false);
    await afterFailedTreeReload;

    component = undefined;
    await Promise.resolve(handlers.get("session_shutdown")?.({ reason: "new" }, ctx));
    await Promise.resolve(handlers.get("session_start")?.({ reason: "new" }, ctx));
    const afterNew = command?.("profiles session", ctx) ?? Promise.resolve();
    await vi.waitFor(() => expect(component).toBeDefined());
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    expect((component as Component | undefined)?.render(120).join("\n")).not.toContain(
      "session override · applies now",
    );
    closeOverlay?.(false);
    await afterNew;
    await Promise.resolve(handlers.get("session_shutdown")?.({ reason: "quit" }, ctx));
  });

  it("fails activation visibly when subagent tool registration throws", async () => {
    const handlers = new Map<string, Handler>();
    const notify = vi.fn();
    // SAFETY: This test double intentionally implements the host contract surface exercised by this scenario.
    const pi = extensionApiFixture({
      registerTool: vi.fn(() => {
        throw new Error("stale extension handle");
      }),
      registerCommand: vi.fn(),
      on: vi.fn((name: string, handler: Handler) => {
        handlers.set(name, handler);
      }),
      getActiveTools: vi.fn(() => ["read", "subagent_start", "subagent_await"]),
      setActiveTools: vi.fn(),
      sendMessage: vi.fn(),
    });
    registerSubagentApplication(pi);

    const sessionStart = handlers.get("session_start");
    expect(sessionStart).toBeTypeOf("function");
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    await sessionStart?.(
      {},
      extensionContextFixture({
        cwd: process.cwd(),
        signal: undefined,
        hasUI: true,
        mode: "tui",
        isProjectTrusted: () => true,
        ui: { notify },
      }),
    );

    expect(pi.setActiveTools).toHaveBeenCalledWith(["read"]);
    expect(notify).toHaveBeenCalledWith(
      "Subagents failed to activate because tool registration failed.",
      "error",
    );
  });
});
