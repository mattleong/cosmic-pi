// Promise assertions are test-runner boundaries.
import { tmpdir } from "node:os";
import type {
  ExtensionCommandContext,
  ExtensionHandler,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { describe, expect, vi } from "vitest";
import { registerSubagentApplication } from "../src/application/register.ts";
import { extensionApiFixture, extensionContextFixture } from "./fixtures/pi-host.ts";
import { effectTest, settle, step } from "./support/effect-test.ts";
import { nodePath } from "./support/node-builtins.ts";

type Handler = ExtensionHandler<any, any>;

const testAgentDirectory = () => nodePath.join(tmpdir(), "pi-subagents-application-tests");

const deferred = <A>() => {
  const cell = Deferred.makeUnsafe<A>();
  return {
    promise: Effect.runPromise(Deferred.await(cell)),
    resolve: (value: A) => Deferred.doneUnsafe(cell, Effect.succeed(value)),
  };
};

describe("subagent Pi registration", () => {
  effectTest(
    "aborts superseded preview loading and never registers the stale activation",
    function* () {
      const handlers = new Map<string, Handler>();
      const first = deferred<void>();
      const second = deferred<void>();
      const loads: Array<readonly [string, boolean]> = [];
      const signals: AbortSignal[] = [];
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
        loadSettings: (cwd, trust, signal) => {
          loads.push([cwd, trust]);
          if (signal) signals.push(signal);
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
      yield* step(() => vi.waitFor(() => expect(signals).toHaveLength(1)));
      const secondStart = Promise.resolve(handlers.get("session_tree")?.({}, secondContext));
      yield* step(() =>
        vi.waitFor(() => {
          expect(signals[0]?.aborted).toBe(true);
          expect(signals).toHaveLength(2);
        }),
      );
      second.resolve();
      yield* step(() => secondStart);
      expect(tools).toEqual(expect.arrayContaining(["subagent_start", "subagent_await"]));
      const winningRegistrationCount = tools.length;
      yield* step(() => firstStart);

      first.resolve();
      yield* step(() => first.promise);
      expect(tools).toHaveLength(winningRegistrationCount);
      expect(loads).toEqual([
        [`${process.cwd()}/first`, true],
        [`${process.cwd()}/second`, false],
      ]);
      expect(firstCwdReads).toBe(1);
      expect(firstTrustReads).toBe(1);
      yield* settle(() => handlers.get("session_shutdown")?.({}, secondContext));
    },
  );

  effectTest("aborts preview loading on shutdown before tools can register", function* () {
    const handlers = new Map<string, Handler>();
    const settings = deferred<void>();
    let loaderSignal: AbortSignal | undefined;
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
      loadSettings: (_cwd, _trusted, signal) => {
        loaderSignal = signal;
        return settings.promise;
      },
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
    yield* step(() => vi.waitFor(() => expect(loaderSignal).toBeDefined()));
    yield* settle(() => handlers.get("session_shutdown")?.({}, ctx));
    expect(loaderSignal?.aborted).toBe(true);
    yield* step(() => starting);
    expect(registerTool).not.toHaveBeenCalled();

    settings.resolve();
    yield* step(() => settings.promise);
    expect(registerTool).not.toHaveBeenCalled();
  });

  for (const failure of [
    {
      label: "rejected",
      load: () => Promise.reject(new Error("preview settings rejected")),
    },
    {
      label: "synchronously throwing",
      load: () => {
        throw new Error("preview settings threw");
      },
    },
  ]) {
    effectTest(`activates after ${failure.label} preview loading`, function* () {
      const handlers = new Map<string, Handler>();
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
        loadSettings: failure.load,
      });
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      const ctx = extensionContextFixture({
        cwd: process.cwd(),
        signal: undefined,
        isProjectTrusted: () => true,
        hasUI: false,
        mode: "rpc",
      });

      yield* settle(() => handlers.get("session_start")?.({}, ctx));
      expect(registerTool).toHaveBeenCalledWith(
        expect.objectContaining({ name: "subagent_start" }),
      );
      yield* settle(() => handlers.get("session_shutdown")?.({}, ctx));
    });
  }

  effectTest(
    "accumulates partially disabled tool names across failures and clears after success",
    function* () {
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

      yield* settle(() => start?.({}, ctx));
      expect(active).toEqual(["read"]);
      callInActivation = 0;
      throwAt = 3;
      yield* settle(() => start?.({}, ctx));
      expect(active).toEqual(["read"]);

      callInActivation = 0;
      throwAt = Number.POSITIVE_INFINITY;
      yield* settle(() => start?.({}, ctx));
      expect(active).toEqual(expect.arrayContaining(["read", "subagent_models", "subagent_start"]));
      expect(setActiveTools.mock.calls.some(([names]) => names.includes("subagent_models"))).toBe(
        true,
      );
      yield* settle(() => handlers.get("session_shutdown")?.({}, ctx));
    },
  );

  effectTest(
    "deactivates tools during replacement/abort and restores only the prior active subset",
    function* () {
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

      yield* settle(() => handlers.get("session_start")?.({}, context()));
      expect(active).toContain("subagent_start");
      active = active.filter((name) => name !== "subagent_status");

      const replacing = Promise.resolve(handlers.get("session_tree")?.({}, context()));
      yield* step(() => Promise.resolve());
      expect(active).toEqual(["read"]);
      replacementSettings.resolve();
      yield* step(() => replacing);
      expect(active).toContain("subagent_start");
      expect(active).not.toContain("subagent_status");

      const failedCapture = context();
      Object.defineProperty(failedCapture, "cwd", {
        get: () => {
          throw new Error("capture failed");
        },
      });
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      yield* settle(() =>
        handlers.get("session_tree")?.({}, extensionContextFixture(failedCapture)),
      );
      expect(active).toEqual(["read"]);
      yield* settle(() => handlers.get("session_start")?.({}, context()));
      expect(active).toContain("subagent_start");
      expect(active).not.toContain("subagent_status");

      const aborted = new AbortController();
      aborted.abort();
      yield* settle(() => handlers.get("session_tree")?.({}, context(aborted.signal)));
      expect(active).toEqual(["read"]);

      yield* settle(() => handlers.get("session_start")?.({}, context()));
      expect(active).toContain("subagent_start");
      expect(active).not.toContain("subagent_status");
      yield* settle(() => handlers.get("session_shutdown")?.({}, context()));
      expect(active).toEqual(["read"]);
    },
  );

  effectTest(
    "preserves session overrides across tree and reload but clears them for a new session",
    function* () {
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
          const closed = deferred<boolean>();
          closeOverlay = closed.resolve;
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
            closed.resolve,
          );
          return closed.promise;
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

      yield* settle(() => handlers.get("session_start")?.({ reason: "startup" }, ctx));
      const first = command?.("profiles session", ctx) ?? Promise.resolve();
      yield* step(() => vi.waitFor(() => expect(component).toBeDefined()));
      component?.handleInput?.("\r");
      component?.handleInput?.("d");
      component?.handleInput?.("d");
      yield* step(() =>
        vi.waitFor(() =>
          expect(component?.render(120).join("\n")).toContain("1 session override · applies now"),
        ),
      );
      closeOverlay?.(false);
      yield* step(() => first);

      component = undefined;
      yield* settle(() => handlers.get("session_tree")?.({}, ctx));
      const afterTree = command?.("profiles session", ctx) ?? Promise.resolve();
      yield* step(() =>
        vi.waitFor(() =>
          expect(component?.render(120).join("\n")).toContain("1 session override · applies now"),
        ),
      );
      closeOverlay?.(false);
      yield* step(() => afterTree);

      component = undefined;
      yield* settle(() => handlers.get("session_shutdown")?.({ reason: "reload" }, ctx));
      yield* settle(() => handlers.get("session_start")?.({ reason: "reload" }, ctx));
      const afterReload = command?.("profiles session", ctx) ?? Promise.resolve();
      yield* step(() =>
        vi.waitFor(() =>
          expect(component?.render(120).join("\n")).toContain("1 session override · applies now"),
        ),
      );
      closeOverlay?.(false);
      yield* step(() => afterReload);

      component = undefined;
      yield* settle(() => handlers.get("session_shutdown")?.({ reason: "reload" }, ctx));
      yield* settle(() => handlers.get("session_start")?.({ reason: "reload" }, ctx));
      const afterSecondReload = command?.("profiles session", ctx) ?? Promise.resolve();
      yield* step(() =>
        vi.waitFor(() =>
          expect(component?.render(120).join("\n")).toContain("1 session override · applies now"),
        ),
      );
      closeOverlay?.(false);
      yield* step(() => afterSecondReload);

      const failedTreeContext = { ...ctx };
      Object.defineProperty(failedTreeContext, "cwd", {
        get: () => {
          throw new Error("tree capture failed");
        },
      });
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      yield* settle(() =>
        handlers.get("session_tree")?.({}, extensionContextFixture(failedTreeContext)),
      );
      component = undefined;
      yield* settle(() => handlers.get("session_shutdown")?.({ reason: "reload" }, ctx));
      yield* settle(() => handlers.get("session_start")?.({ reason: "reload" }, ctx));
      const afterFailedTreeReload = command?.("profiles session", ctx) ?? Promise.resolve();
      yield* step(() =>
        vi.waitFor(() =>
          expect(component?.render(120).join("\n")).toContain("1 session override · applies now"),
        ),
      );
      closeOverlay?.(false);
      yield* step(() => afterFailedTreeReload);

      component = undefined;
      yield* settle(() => handlers.get("session_shutdown")?.({ reason: "new" }, ctx));
      yield* settle(() => handlers.get("session_start")?.({ reason: "new" }, ctx));
      const afterNew = command?.("profiles session", ctx) ?? Promise.resolve();
      yield* step(() => vi.waitFor(() => expect(component).toBeDefined()));
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      expect((component as Component | undefined)?.render(120).join("\n")).not.toContain(
        "session override · applies now",
      );
      closeOverlay?.(false);
      yield* step(() => afterNew);
      yield* settle(() => handlers.get("session_shutdown")?.({ reason: "quit" }, ctx));
    },
  );

  effectTest("owns the activity widget across activation, turns, and shutdown", function* () {
    const handlers = new Map<string, Handler>();
    let active = ["read"];
    const setWidget = vi.fn();
    const setStatus = vi.fn();
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
      loadSettings: () => Promise.resolve(),
    });
    const ctx = extensionContextFixture({
      cwd: process.cwd(),
      signal: undefined,
      hasUI: true,
      mode: "tui" as const,
      isProjectTrusted: () => true,
      ui: { setWidget, setStatus, notify: vi.fn() },
    });

    yield* settle(() => handlers.get("session_start")?.({ reason: "startup" }, ctx));
    expect(setWidget).toHaveBeenCalledWith("pi-subagents.activity", expect.any(Function), {
      placement: "aboveEditor",
    });

    const staleSetWidget = vi.fn();
    const stale = extensionContextFixture({
      ...ctx,
      ui: { ...ctx.ui, setWidget: staleSetWidget },
    });
    yield* settle(() => handlers.get("turn_end")?.({}, stale));
    expect(staleSetWidget).not.toHaveBeenCalled();

    yield* settle(() => handlers.get("session_shutdown")?.({ reason: "quit" }, ctx));
    expect(setWidget).toHaveBeenLastCalledWith("pi-subagents.activity", undefined, {
      placement: "aboveEditor",
    });
  });

  effectTest("fails activation visibly when subagent tool registration throws", function* () {
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
    yield* settle(() =>
      sessionStart?.(
        {},
        extensionContextFixture({
          cwd: process.cwd(),
          signal: undefined,
          hasUI: true,
          mode: "tui",
          isProjectTrusted: () => true,
          ui: { notify },
        }),
      ),
    );

    expect(pi.setActiveTools).toHaveBeenCalledWith(["read"]);
    expect(notify).toHaveBeenCalledWith(
      "Subagents failed to activate because tool registration failed.",
      "error",
    );
  });
});
