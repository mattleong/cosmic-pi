// Promise assertions are test-runner boundaries.
import { tmpdir } from "node:os";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { makeSessionCapabilityProtocol } from "pi-cosmic-core";
import { ACTIVITY_VIEW_DISCOVER } from "pi-cosmic-ui/activity/view";
import type {
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionHandler,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import {
  deferredPromise,
  extensionContextFixture,
  plainTheme,
  temporaryDirectory,
} from "pi-cosmic-core/testing";
import { describe, expect, vi } from "vitest";
import { registerSubagentApplication } from "../src/application/register.ts";
import { completeBaseline, profileCandidate } from "./fixtures/profiles.ts";
import { resolveSubagentConfig } from "../src/config/options.ts";
import { decodeSubagentConfig } from "../src/config/schema.ts";
import { makeSubagentProfileService } from "../src/profiles/service.ts";
import {
  extensionApiFixture,
  mountingCustomUi,
  sessionContextFixture as sessionContext,
} from "./fixtures/pi-host.ts";
import { describeActivationLifecycle } from "./support/activation-lifecycle.ts";
import { effectTest, settle, step } from "./support/effect-test.ts";
import { nodeFsPromises, nodePath } from "./support/node-builtins.ts";

type Handler = ExtensionHandler<any, any>;
type Command = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

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
  const commands = new Map<string, Command>();
  const pi = extensionApiFixture({
    on: vi.fn((name: string, handler: Handler) => {
      handlers.set(name, handler);
    }),
    registerCommand: vi.fn((name: string, definition: { readonly handler: Command }) => {
      commands.set(name, definition.handler);
    }),
    registerTool: vi.fn(),
    getActiveTools: vi.fn(() => ["read"]),
    setActiveTools: vi.fn(),
    sendMessage: vi.fn(),
    ...overrides,
  });
  registerSubagentApplication(pi, options);
  /** Runs `/subagents` with `args`. */
  const subagents = (args: string, ctx: ExtensionCommandContext) =>
    commands.get("subagents")!(args, ctx);
  return { handlers, pi, subagents };
};

/**
 * Host active-tool state that registration extends, unless a tool declares `defaultActive:
 * false`, and that activation replaces.
 */
const activeToolTracker = <
  Tool extends { readonly name: string; readonly defaultActive?: boolean },
>(
  onRegister?: (tool: Tool) => void,
) => {
  let active: ReadonlyArray<string> = ["read"];
  const registered: string[] = [];
  const setActive = (names: ReadonlyArray<string>) => {
    active = [...names];
  };
  return {
    active: () => [...active],
    setActive,
    registered,
    overrides: {
      registerTool: vi.fn((tool: Tool) => {
        registered.push(tool.name);
        if (tool.defaultActive !== false) active = [...new Set([...active, tool.name])];
        onRegister?.(tool);
      }),
      getActiveTools: vi.fn(() => [...active]),
      setActiveTools: vi.fn(setActive),
    },
  };
};

describeActivationLifecycle("root application", (loadSettings = () => Promise.resolve()) => {
  const tools = activeToolTracker();
  const { handlers } = applicationFixture(tools.overrides, {
    getAgentDirectory: testAgentDirectory,
    loadSettings,
  });
  return {
    start: () => Promise.resolve(handlers.get("session_start")?.({}, sessionContext())),
    shutdown: () => Promise.resolve(handlers.get("session_shutdown")?.({}, sessionContext())),
    registeredToolCount: () => tools.registered.length,
    activeTools: tools.active,
  };
});

describe("subagent Pi registration", () => {
  for (const outcome of ["accepted", "unavailable", "absent", "rejected", "replaced"] as const) {
    effectTest(`routes bare subagents to the shared view with ${outcome} admission`, function* () {
      const events = createEventBus();
      const queryProtocol = makeSessionCapabilityProtocol({ version: 1, maxSessionIdChars: 256 });
      const pending = deferredPromise<boolean>();
      const open = vi.fn(() =>
        outcome === "replaced"
          ? pending.promise
          : outcome === "rejected"
            ? Promise.reject(new Error("Manager already open"))
            : Promise.resolve(outcome === "accepted"),
      );
      if (outcome !== "absent")
        events.on(ACTIVITY_VIEW_DISCOVER, (data) => {
          const query = queryProtocol.normalizeQuery(data);
          if (query?.sessionId === "view-session")
            query.respond({ version: 1, sessionId: "view-session", hostToken: {}, open });
        });
      const custom = vi.fn(() => Promise.resolve(undefined));
      const ctx = sessionContext(
        {
          hasUI: true,
          mode: "tui",
          isProjectTrusted: () => false,
          ui: { notify: vi.fn(), custom, setWidget: vi.fn() },
        },
        "view-session",
      );
      const { handlers, subagents } = applicationFixture({ events });
      yield* settle(() => handlers.get("session_start")?.({}, ctx));
      const opened = subagents("", ctx);
      if (outcome === "replaced") {
        yield* step(() => vi.waitFor(() => expect(open).toHaveBeenCalled()));
        yield* settle(() => handlers.get("session_tree")?.({}, ctx));
        pending.resolve(false);
      }
      if (outcome === "rejected" || outcome === "replaced")
        yield* step(() => expect(opened).rejects.toThrow());
      else yield* step(() => opened);
      if (outcome !== "absent") expect(open).toHaveBeenCalledWith("subagents", undefined);
      expect(custom).toHaveBeenCalledTimes(
        outcome === "absent" || outcome === "unavailable" ? 1 : 0,
      );
      yield* settle(() => handlers.get("session_shutdown")?.({}, ctx));
    });
  }

  for (const cancellation of ["editor", "shutdown", "replacement"] as const) {
    effectTest(`owns pending settings refresh through ${cancellation} cancellation`, function* () {
      const { handlers, subagents } = applicationFixture({ getActiveTools: () => [] });
      const closed = deferredPromise<boolean>();
      const pending = deferredPromise<{ aborted: boolean }>();
      let refreshSignal: AbortSignal | undefined;
      const notify = vi.fn();
      const ctx = sessionContext({
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
      const editing = subagents("profiles", ctx);
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
      const first = deferredPromise();
      const second = deferredPromise();
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
      const secondContext = sessionContext({
        cwd: `${process.cwd()}/second`,
        isProjectTrusted: () => false,
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

  effectTest(
    "accumulates partially disabled tool names across failures and clears after success",
    function* () {
      let callInActivation = 0;
      let throwAt = 2;
      const tools = activeToolTracker(() => {
        callInActivation += 1;
        if (callInActivation === throwAt) throw new Error("partial registration");
      });
      const { handlers } = applicationFixture(tools.overrides);
      const ctx = sessionContext();
      const start = handlers.get("session_start");

      yield* settle(() => start?.({}, ctx));
      expect(tools.active()).toEqual(["read"]);
      callInActivation = 0;
      throwAt = 3;
      yield* settle(() => start?.({}, ctx));
      expect(tools.active()).toEqual(["read"]);

      callInActivation = 0;
      throwAt = Number.POSITIVE_INFINITY;
      yield* settle(() => start?.({}, ctx));
      // The workflow runner stays inactive while ultracode is off.
      expect(tools.active()).toEqual([
        "read",
        ...new Set(tools.registered.filter((name) => name !== "subagent_workflow")),
      ]);
      yield* settle(() => handlers.get("session_shutdown")?.({}, ctx));
    },
  );

  effectTest(
    "keeps tools through tree replacement and deactivates them only when activation is lost",
    function* () {
      const tools = activeToolTracker();
      const replacementSettings = deferredPromise();
      let settingsLoads = 0;
      const { handlers } = applicationFixture(tools.overrides, {
        getAgentDirectory: testAgentDirectory,
        loadSettings: () => {
          settingsLoads += 1;
          return settingsLoads === 2 ? replacementSettings.promise : Promise.resolve();
        },
      });
      const context = (signal?: AbortSignal) => sessionContext({ signal });

      yield* settle(() => handlers.get("session_start")?.({}, context()));
      expect(tools.registered.length).toBeGreaterThan(1);
      const disabledName = tools.registered[0]!;
      const expectedActive = () => [
        "read",
        ...new Set(
          tools.registered.filter((name) => name !== disabledName && name !== "subagent_workflow"),
        ),
      ];
      tools.setActive(tools.active().filter((name) => name !== disabledName));

      // Pi awaits the tree replacement, and deactivating would drop its restored tool loadout.
      const replacing = Promise.resolve(handlers.get("session_tree")?.({}, context()));
      yield* step(() => Promise.resolve());
      expect(tools.active()).toEqual(expectedActive());
      replacementSettings.resolve();
      yield* step(() => replacing);
      expect(tools.active()).toEqual(expectedActive());

      const failedCapture = context();
      Object.defineProperty(failedCapture, "cwd", {
        get: () => {
          throw new Error("capture failed");
        },
      });
      yield* settle(() => handlers.get("session_tree")?.({}, failedCapture));
      expect(tools.active()).toEqual(["read"]);
      yield* settle(() => handlers.get("session_start")?.({}, context()));
      expect(tools.active()).toEqual(expectedActive());

      const aborted = new AbortController();
      aborted.abort();
      yield* settle(() => handlers.get("session_tree")?.({}, context(aborted.signal)));
      expect(tools.active()).toEqual(["read"]);

      yield* settle(() => handlers.get("session_start")?.({}, context()));
      expect(tools.active()).toEqual(expectedActive());
      yield* settle(() => handlers.get("session_shutdown")?.({}, context()));
      expect(tools.active()).toEqual(["read"]);
    },
  );

  effectTest(
    "keeps incompatible reload settings inactive through tree changes until a fresh session",
    function* () {
      const reloadSlot = Symbol.for("@cosmic-pi/pi-subagents/profile-reload-handoff/v1");
      const envelope = {
        version: 2,
        sessionKey: "application-incompatible-session",
        seed: {
          revision: 7,
          overrides: {
            worker: {
              candidates: [{ ...profileCandidate("openai/retired"), host: "herdr" }],
            },
          },
          baseline: completeBaseline("global"),
        },
      };
      interface TestReloadGlobalState {
        [reloadSlot]?: typeof envelope;
      }
      // SAFETY: This test installs and owns the exact process-global reload slot.
      const processState = globalThis as typeof globalThis & TestReloadGlobalState;
      processState[reloadSlot] = envelope;
      const tools = activeToolTracker();
      let { handlers } = applicationFixture(tools.overrides);
      const notify = vi.fn();
      const contextFor = (sessionId: string) =>
        sessionContext(
          { hasUI: true, mode: "tui", isProjectTrusted: () => false, ui: { notify } },
          sessionId,
        );
      let ctx = contextFor("application-incompatible-session");
      yield* Effect.addFinalizer(() =>
        settle(() => handlers.get("session_shutdown")?.({ reason: "quit" }, ctx)).pipe(
          Effect.ensuring(Effect.sync(() => Reflect.deleteProperty(processState, reloadSlot))),
        ),
      );
      for (const event of ["session_start", "session_tree", "session_start"] as const) {
        yield* settle(() => handlers.get(event)?.({ reason: "reload" }, ctx));
        expect(tools.active()).toEqual(["read"]);
        expect(processState[reloadSlot]).toBe(envelope);
      }
      expect(notify.mock.calls.some(([, level]) => level === "warning")).toBe(true);

      yield* settle(() => handlers.get("session_shutdown")?.({ reason: "reload" }, ctx));
      handlers = applicationFixture(tools.overrides).handlers;
      yield* settle(() => handlers.get("session_start")?.({ reason: "reload" }, ctx));
      yield* settle(() => handlers.get("session_tree")?.({}, ctx));
      expect(tools.active()).toEqual(["read"]);
      expect(processState[reloadSlot]).toBe(envelope);

      ctx = contextFor("application-compatible-new-session");
      yield* settle(() => handlers.get("session_start")?.({ reason: "new" }, ctx));
      expect(tools.active()).toContain("subagent_start");
      expect(Object.hasOwn(processState, reloadSlot)).toBe(false);
    },
  );

  effectTest(
    "preserves session overrides across tree and reload but clears them for a new session",
    function* () {
      let tools = new Map<string, CapturedApplicationTool>();
      const activeTools = activeToolTracker((tool: CapturedApplicationTool) => {
        tools.set(tool.name, tool);
      });
      const registerFreshApplication = () => {
        tools = new Map<string, CapturedApplicationTool>();
        return applicationFixture({
          ...activeTools.overrides,
          getThinkingLevel: vi.fn(() => "high"),
        });
      };
      let { handlers, subagents } = registerFreshApplication();

      let component: Component | undefined;
      const ui = {
        notify: vi.fn(),
        confirm: vi.fn().mockResolvedValue(false),
        custom: vi.fn(
          mountingCustomUi(plainTheme, (created) => {
            component = created;
          }).custom,
        ),
      };
      const contextFor = (sessionId: string) =>
        sessionContext(
          {
            hasUI: true,
            mode: "tui",
            ui,
            model: undefined,
            modelRegistry: { getAvailable: () => [] },
          },
          sessionId,
        );
      const ctx = contextFor("application-reload-session");
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
      const editing = subagents("profiles", ctx).then(() => {
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
      ({ handlers, subagents } = registerFreshApplication());
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
      yield* settle(() => handlers.get("session_tree")?.({}, failedTreeContext));
      yield* settle(() => handlers.get("session_shutdown")?.({ reason: "reload" }, ctx));
      yield* settle(() => handlers.get("session_start")?.({ reason: "reload" }, ctx));
      expect(yield* hasSessionOverride(ctx)).toBe(true);

      yield* settle(() => handlers.get("session_shutdown")?.({ reason: "quit" }, ctx));
      // A new host session has a distinct session identity even when it uses the same project.
      const newSessionContext = contextFor("application-new-session");
      yield* settle(() => handlers.get("session_start")?.({ reason: "new" }, newSessionContext));
      expect(yield* hasSessionOverride(newSessionContext)).toBe(false);
      yield* settle(() =>
        handlers.get("session_shutdown")?.({ reason: "quit" }, newSessionContext),
      );
    },
  );

  effectTest("applies a saved ultracode switch after reload, not on tree navigation", function* () {
    const agentDirectory = yield* temporaryDirectory("pi-subagents-features-");
    const configPath = nodePath.join(agentDirectory, "pi-subagents.json");
    const readConfig = () => nodeFsPromises.readFile(configPath, "utf8").then(JSON.parse);
    type RegisteredTool = {
      readonly name: string;
      readonly exposure?: string;
      readonly defaultActive?: boolean;
    };
    let registered = new Map<string, RegisteredTool>();
    const activeTools = activeToolTracker((tool: RegisteredTool) => {
      registered.set(tool.name, tool);
    });
    const registerFreshApplication = () => {
      registered = new Map();
      return applicationFixture(activeTools.overrides, {
        getAgentDirectory: () => agentDirectory,
        loadSettings: () => Promise.resolve(),
      });
    };
    const notify = vi.fn();
    const ctx = sessionContext(
      { hasUI: true, mode: "tui", isProjectTrusted: () => false, ui: { notify } },
      "application-feature-switch-session",
    );
    // Ultracode keeps the always-registered dynamic workflow runner active. Native codemode can
    // script the root contract tools either way.
    const scriptable = () => registered.get("subagent_start")?.exposure === "direct";
    const ultracodeOn = () => scriptable() && activeTools.active().includes("subagent_workflow");
    const ultracodeOff = () =>
      scriptable() &&
      registered.get("subagent_workflow")?.exposure === "model-only" &&
      !activeTools.active().includes("subagent_workflow");
    let app = registerFreshApplication();
    const reload = function* () {
      yield* settle(() => app.handlers.get("session_shutdown")?.({ reason: "reload" }, ctx));
      app = registerFreshApplication();
      yield* settle(() => app.handlers.get("session_start")?.({ reason: "reload" }, ctx));
    };
    yield* Effect.addFinalizer(() =>
      settle(() => app.handlers.get("session_shutdown")?.({ reason: "quit" }, ctx)),
    );
    yield* settle(() => app.handlers.get("session_start")?.({ reason: "startup" }, ctx));
    expect(ultracodeOff()).toBe(true);

    const settings = (args: string) => app.subagents(`settings ${args}`, ctx);
    yield* step(() => settings("global ultracode true"));
    expect(yield* step(readConfig)).toEqual({ version: 6, ultracode: true });
    expect(notify).not.toHaveBeenCalledWith(expect.any(String), "error");
    yield* settle(() => app.handlers.get("session_tree")?.({}, ctx));
    expect(ultracodeOff()).toBe(true);

    yield* reload();
    expect(ultracodeOn()).toBe(true);

    yield* step(() => settings("global ultracode inherit"));
    expect(yield* step(readConfig)).toEqual({ version: 6 });
    yield* reload();
    // The reload kept the runner active; it leaves the loadout when the next agent run starts.
    yield* settle(() => app.handlers.get("agent_start")?.({}, ctx));
    expect(ultracodeOff()).toBe(true);
  });

  effectTest("owns the activity widget across activation, turns, and shutdown", function* () {
    const setWidget = vi.fn();
    const setStatus = vi.fn();
    const { handlers } = applicationFixture(activeToolTracker().overrides);
    const ctx = sessionContext({
      hasUI: true,
      mode: "tui",
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

    yield* settle(() =>
      handlers.get("session_start")?.(
        {},
        sessionContext({ hasUI: true, mode: "tui", ui: { notify } }),
      ),
    );

    expect(pi.setActiveTools).toHaveBeenCalledWith(["read"]);
    expect(notify).toHaveBeenCalled();
    expect(notify.mock.calls.some(([, level]) => level === "warning")).toBe(true);
  });
});
