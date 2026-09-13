// Promise assertions are test-runner boundaries.
import { tmpdir } from "node:os";
import type {
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionHandler,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { describe, expect, vi } from "vitest";
import { registerSubagentApplication } from "../src/application/register.ts";
import { resolveSubagentConfig } from "../src/config/options.ts";
import { decodeSubagentConfig } from "../src/config/schema.ts";
import { makeSubagentProfileService } from "../src/profiles/service.ts";
import { extensionApiFixture, extensionContextFixture } from "./fixtures/pi-host.ts";
import { effectTest, settle, step } from "./support/effect-test.ts";
import { nodePath } from "./support/node-builtins.ts";

type Handler = ExtensionHandler<any, any>;

type CapturedApplicationTool = {
  readonly name: string;
  readonly execute: (
    toolCallId: string,
    params: { readonly profile?: string },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ) => Promise<{ readonly details?: unknown }>;
};

const testAgentDirectory = () => nodePath.join(tmpdir(), "pi-subagents-application-tests");

const applicationFixture = <Overrides extends object>(
  overrides: Overrides,
  options: Parameters<typeof registerSubagentApplication>[1] = {
    getAgentDirectory: testAgentDirectory,
    loadSettings: () => Promise.resolve(),
  },
) => {
  const handlers = new Map<string, Handler>();
  const pi = extensionApiFixture({
    on: vi.fn((name: string, handler: Handler) => {
      handlers.set(name, handler);
    }),
    registerCommand: vi.fn(),
    registerTool: vi.fn(),
    getActiveTools: vi.fn(() => ["read"]),
    setActiveTools: vi.fn(),
    sendMessage: vi.fn(),
    ...overrides,
  });
  registerSubagentApplication(pi, options);
  return { handlers, pi };
};

const deferred = <A>() => {
  const cell = Deferred.makeUnsafe<A>();
  return {
    promise: Effect.runPromise(Deferred.await(cell)),
    resolve: (value: A) => Deferred.doneUnsafe(cell, Effect.succeed(value)),
  };
};

describe("subagent Pi registration", () => {
  for (const cancellation of ["editor", "shutdown", "replacement"] as const) {
    effectTest(`owns pending settings refresh through ${cancellation} cancellation`, function* () {
      let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
      const { handlers } = applicationFixture({
        registerCommand: vi.fn(
          (
            _name: string,
            definition: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
          ) => {
            command = definition.handler;
          },
        ),
        getActiveTools: () => [],
      });
      const closed = deferred<boolean>();
      const pending = deferred<{ aborted: boolean }>();
      let refreshSignal: AbortSignal | undefined;
      const notify = vi.fn();
      const ctx = extensionContextFixture({
        cwd: process.cwd(),
        signal: undefined,
        hasUI: true,
        mode: "tui",
        isProjectTrusted: () => false,
        ui: { notify, custom: vi.fn(() => closed.promise) },
        modelRegistry: {
          getAvailable: () => [],
          getError: () => undefined,
          refresh: (options?: { signal?: AbortSignal }) => {
            refreshSignal = options?.signal;
            return pending.promise;
          },
        },
      });
      yield* settle(() => handlers.get("session_start")?.({}, ctx));
      const editing = command?.("profiles", ctx) ?? Promise.resolve();
      yield* step(() => vi.waitFor(() => expect(refreshSignal).toBeDefined()));
      if (cancellation === "editor") closed.resolve(false);
      else
        yield* settle(() =>
          handlers.get(cancellation === "shutdown" ? "session_shutdown" : "session_start")?.(
            {},
            ctx,
          ),
        );
      yield* step(() => vi.waitFor(() => expect(refreshSignal?.aborted).toBe(true)));
      const priorNotifications = notify.mock.calls.length;
      pending.resolve({ aborted: false });
      closed.resolve(false);
      yield* step(() => editing);
      expect(notify.mock.calls).toHaveLength(priorNotifications);
      yield* settle(() => handlers.get("session_shutdown")?.({}, ctx));
    });
  }

  effectTest("holds the session revision lock through a deferred saved-set write", function* () {
    const global = decodeSubagentConfig({ version: 6, profileSets: {} }, "global");
    const config = resolveSubagentConfig({
      globalConfigPath: "/agent/pi-subagents.json",
      projectConfigPath: "/repo/.pi/pi-subagents.json",
      projectTrusted: false,
      globalConfigExists: false,
      projectConfigExists: false,
      global,
    });
    const service = yield* makeSubagentProfileService(config);
    const writeStarted = yield* Deferred.make<void>();
    const releaseWrite = yield* Deferred.make<void>();
    const editAttempted = yield* Deferred.make<void>();
    const editFinished = yield* Deferred.make<void>();
    let persistedReviewerCandidates: number | undefined;

    const saving = yield* Effect.forkChild(
      service
        .withSnapshotAtRevision(0, (snapshot) =>
          Effect.gen(function* () {
            persistedReviewerCandidates =
              snapshot.effectiveConfig.profiles.reviewer.candidates.length;
            yield* Deferred.succeed(writeStarted, undefined);
            yield* Deferred.await(releaseWrite);
          }),
        )
        .pipe(Effect.orDie),
    );
    yield* Deferred.await(writeStarted);

    const editing = yield* Effect.forkChild(
      Effect.gen(function* () {
        yield* Deferred.succeed(editAttempted, undefined);
        yield* service.patchSessionProfile({
          profile: "reviewer",
          route: { candidates: [] },
          expectedRevision: 0,
        });
        yield* Deferred.succeed(editFinished, undefined);
      }).pipe(Effect.orDie),
    );
    yield* Deferred.await(editAttempted);
    yield* Effect.yieldNow;
    expect(Option.isNone(yield* Deferred.poll(editFinished))).toBe(true);

    yield* Deferred.succeed(releaseWrite, undefined);
    yield* Fiber.join(saving);
    yield* Fiber.join(editing);
    expect(persistedReviewerCandidates).toBeGreaterThan(0);
    expect((yield* service.capture).effectiveConfig.profiles.reviewer.candidates).toEqual([]);
  });

  effectTest(
    "aborts superseded preview loading and never registers the stale activation",
    function* () {
      const first = deferred<void>();
      const second = deferred<void>();
      const loads: Array<readonly [string, boolean]> = [];
      const signals: AbortSignal[] = [];
      const tools: string[] = [];
      const { handlers } = applicationFixture(
        { registerTool: vi.fn((tool: { name: string }) => tools.push(tool.name)) },
        {
          getAgentDirectory: testAgentDirectory,
          loadSettings: (cwd, trust, signal) => {
            loads.push([cwd, trust]);
            if (signal) signals.push(signal);
            return loads.length === 1 ? first.promise : second.promise;
          },
        },
      );

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
      expect(tools.length).toBeGreaterThan(0);
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
    const settings = deferred<void>();
    let loaderSignal: AbortSignal | undefined;
    const registerTool = vi.fn();
    const { handlers } = applicationFixture(
      { registerTool },
      {
        getAgentDirectory: testAgentDirectory,
        loadSettings: (_cwd, _trusted, signal) => {
          loaderSignal = signal;
          return settings.promise;
        },
      },
    );
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

  effectTest("activates when preview settings loading fails", function* () {
    const failures: ReadonlyArray<() => Promise<void>> = [
      () => Promise.reject(new Error("preview settings rejected")),
      () => {
        throw new Error("preview settings threw");
      },
    ];

    for (const loadSettings of failures) {
      const registerTool = vi.fn();
      const { handlers } = applicationFixture(
        { registerTool },
        { getAgentDirectory: testAgentDirectory, loadSettings },
      );
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      const ctx = extensionContextFixture({
        cwd: process.cwd(),
        signal: undefined,
        isProjectTrusted: () => true,
        hasUI: false,
        mode: "rpc",
      });

      yield* settle(() => handlers.get("session_start")?.({}, ctx));
      expect(registerTool).toHaveBeenCalled();
      yield* settle(() => handlers.get("session_shutdown")?.({}, ctx));
    }
  });

  effectTest(
    "accumulates partially disabled tool names across failures and clears after success",
    function* () {
      let active = ["read"];
      const registeredNames: string[] = [];
      let callInActivation = 0;
      let throwAt = 2;
      const setActiveTools = vi.fn((names: ReadonlyArray<string>) => {
        active = [...names];
      });
      const { handlers } = applicationFixture({
        registerTool: vi.fn((tool: { name: string }) => {
          registeredNames.push(tool.name);
          callInActivation += 1;
          active = [...new Set([...active, tool.name])];
          if (callInActivation === throwAt) throw new Error("partial registration");
        }),
        getActiveTools: vi.fn(() => [...active]),
        setActiveTools,
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
      expect(active).toEqual(["read", ...new Set(registeredNames)]);
      yield* settle(() => handlers.get("session_shutdown")?.({}, ctx));
    },
  );

  effectTest(
    "deactivates tools during replacement/abort and restores only the prior active subset",
    function* () {
      let active = ["read"];
      const registeredNames: string[] = [];
      const replacementSettings = deferred<void>();
      let settingsLoads = 0;
      const { handlers } = applicationFixture(
        {
          registerTool: vi.fn((tool: { readonly name: string }) => {
            registeredNames.push(tool.name);
            active = [...new Set([...active, tool.name])];
          }),
          getActiveTools: vi.fn(() => [...active]),
          setActiveTools: vi.fn((names: ReadonlyArray<string>) => {
            active = [...names];
          }),
        },
        {
          getAgentDirectory: testAgentDirectory,
          loadSettings: () => {
            settingsLoads += 1;
            return settingsLoads === 2 ? replacementSettings.promise : Promise.resolve();
          },
        },
      );
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
      expect(registeredNames.length).toBeGreaterThan(1);
      const disabledName = registeredNames[0]!;
      const expectedActive = () => [
        "read",
        ...new Set(registeredNames.filter((name) => name !== disabledName)),
      ];
      active = active.filter((name) => name !== disabledName);

      const replacing = Promise.resolve(handlers.get("session_tree")?.({}, context()));
      yield* step(() => Promise.resolve());
      expect(active).toEqual(["read"]);
      replacementSettings.resolve();
      yield* step(() => replacing);
      expect(active).toEqual(expectedActive());

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
      expect(active).toEqual(expectedActive());

      const aborted = new AbortController();
      aborted.abort();
      yield* settle(() => handlers.get("session_tree")?.({}, context(aborted.signal)));
      expect(active).toEqual(["read"]);

      yield* settle(() => handlers.get("session_start")?.({}, context()));
      expect(active).toEqual(expectedActive());
      yield* settle(() => handlers.get("session_shutdown")?.({}, context()));
      expect(active).toEqual(["read"]);
    },
  );

  effectTest(
    "preserves session overrides across tree and reload but clears them for a new session",
    function* () {
      let handlers = new Map<string, Handler>();
      let tools = new Map<string, CapturedApplicationTool>();
      let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
      let active = ["read"];
      const registerFreshApplication = (): void => {
        const nextTools = new Map<string, CapturedApplicationTool>();
        tools = nextTools;
        const { handlers: nextHandlers } = applicationFixture({
          registerTool: vi.fn((tool: CapturedApplicationTool) => {
            nextTools.set(tool.name, tool);
            active = [...new Set([...active, tool.name])];
          }),
          registerCommand: vi.fn(
            (
              _name: string,
              definition: {
                handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
              },
            ) => {
              command = definition.handler;
            },
          ),
          getActiveTools: vi.fn(() => [...active]),
          setActiveTools: vi.fn((names: ReadonlyArray<string>) => {
            active = [...names];
          }),
          getThinkingLevel: vi.fn(() => "high"),
        });
        handlers = nextHandlers;
      };
      registerFreshApplication();

      let component: Component | undefined;
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
        sessionManager: {
          getSessionId: () => "application-reload-session",
          getSessionFile: () => undefined,
        },
      });
      const hasSessionOverride = (context: ExtensionContext): Effect.Effect<boolean> => {
        const tool = tools.get("subagent_models");
        if (!tool) return Effect.succeed(false);
        return Effect.promise(() => tool.execute("models", {}, undefined, undefined, context)).pipe(
          Effect.map((result) => {
            // SAFETY: The owned models tool returns its decoded semantic details object.
            const details = result.details as
              | {
                  readonly action?: string;
                  readonly profiles?: ReadonlyArray<{ readonly source?: string }>;
                }
              | undefined;
            return (
              details?.action === "models" &&
              details.profiles?.some((profile) => profile.source === "session") === true
            );
          }),
        );
      };

      yield* settle(() => handlers.get("session_start")?.({ reason: "startup" }, ctx));
      let editorClosed = false;
      const editing = (command?.("profiles", ctx) ?? Promise.resolve()).then(() => {
        editorClosed = true;
      });
      yield* step(() => vi.waitFor(() => expect(component).toBeDefined()));
      component?.handleInput?.("e"); // Change the selected profile's reasoning.
      component?.handleInput?.("j");
      component?.handleInput?.("\r");
      yield* step(() =>
        vi.waitFor(() =>
          Effect.runPromise(hasSessionOverride(ctx)).then((value) => expect(value).toBe(true)),
        ),
      );
      // The session mutation can be visible before the editor finishes refreshing after save.
      yield* step(() =>
        vi.waitFor(() => {
          component?.handleInput?.("\u001b");
          expect(editorClosed).toBe(true);
        }),
      );
      yield* step(() => editing);

      yield* settle(() => handlers.get("session_tree")?.({}, ctx));
      expect(yield* hasSessionOverride(ctx)).toBe(true);

      yield* settle(() => handlers.get("session_shutdown")?.({ reason: "reload" }, ctx));
      const startupHandlers = handlers;
      registerFreshApplication();
      expect(handlers).not.toBe(startupHandlers);
      yield* settle(() => handlers.get("session_start")?.({ reason: "reload" }, ctx));
      expect(yield* hasSessionOverride(ctx)).toBe(true);

      yield* settle(() => handlers.get("session_shutdown")?.({ reason: "reload" }, ctx));
      yield* settle(() => handlers.get("session_start")?.({ reason: "reload" }, ctx));
      expect(yield* hasSessionOverride(ctx)).toBe(true);

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
      yield* settle(() => handlers.get("session_shutdown")?.({ reason: "reload" }, ctx));
      yield* settle(() => handlers.get("session_start")?.({ reason: "reload" }, ctx));
      expect(yield* hasSessionOverride(ctx)).toBe(true);

      yield* settle(() => handlers.get("session_shutdown")?.({ reason: "quit" }, ctx));
      // SAFETY: A new host session has a distinct session identity even when it uses the same project.
      const newSessionContext = extensionContextFixture({
        ...ctx,
        sessionManager: {
          getSessionId: () => "application-new-session",
          getSessionFile: () => undefined,
        },
      });
      yield* settle(() => handlers.get("session_start")?.({ reason: "new" }, newSessionContext));
      expect(yield* hasSessionOverride(newSessionContext)).toBe(false);
      yield* settle(() =>
        handlers.get("session_shutdown")?.({ reason: "quit" }, newSessionContext),
      );
    },
  );

  effectTest("owns the activity widget across activation, turns, and shutdown", function* () {
    let active = ["read"];
    const setWidget = vi.fn();
    const setStatus = vi.fn();
    const { handlers } = applicationFixture({
      registerTool: vi.fn((tool: { readonly name: string }) => {
        active = [...new Set([...active, tool.name])];
      }),
      getActiveTools: vi.fn(() => [...active]),
      setActiveTools: vi.fn((names: ReadonlyArray<string>) => {
        active = [...names];
      }),
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
    expect(setWidget).toHaveBeenCalled();

    const staleSetWidget = vi.fn();
    const stale = extensionContextFixture({
      ...ctx,
      ui: { ...ctx.ui, setWidget: staleSetWidget },
    });
    yield* settle(() => handlers.get("turn_end")?.({}, stale));
    expect(staleSetWidget).not.toHaveBeenCalled();

    yield* settle(() => handlers.get("session_shutdown")?.({ reason: "quit" }, ctx));
    expect(setWidget.mock.calls.some(([, content]) => content === undefined)).toBe(true);
  });

  effectTest("fails activation visibly when subagent tool registration throws", function* () {
    const notify = vi.fn();
    const { handlers, pi } = applicationFixture({
      registerTool: vi.fn(() => {
        throw new Error("stale extension handle");
      }),
      getActiveTools: vi.fn(() => ["read", "subagent_start", "subagent_await"]),
    });

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
    expect(notify).toHaveBeenCalled();
    expect(notify.mock.calls.some(([, level]) => level === "error")).toBe(true);
  });
});
