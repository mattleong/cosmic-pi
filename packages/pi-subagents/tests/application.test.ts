import { tmpdir } from "node:os";
import { fakeActivityHost } from "pi-cosmic-ui/activity/testing";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  deferredPromise,
  extensionApiFixture,
  extensionContextFixture,
  plainTheme,
  recordingExtensionHost,
} from "pi-cosmic-core/testing";
import { describe, expect, vi } from "vitest";
import { registerSubagentApplication } from "../src/application/register.ts";
import { SubagentBackendRegistry } from "../src/backend/service.ts";
import * as SubagentLayers from "../src/layer.ts";
import type { SubagentProjection } from "../src/run/model.ts";
import { SubagentService } from "../src/run/service.ts";
import { encodeSubagentProxyInput } from "../src/tools/proxy-protocol.ts";
import { view } from "./fixtures/run-view.ts";
import { builtProfileService, completeBaseline, profileCandidate } from "./fixtures/profiles.ts";
import { resolveSubagentConfig } from "../src/config/options.ts";
import { subagentConfigDecoder } from "../src/config/schema.ts";
import { SubagentProfileService } from "../src/profiles/service.ts";
import { mountingCustomUi, sessionContextFixture as sessionContext } from "./fixtures/pi-host.ts";
import { describeActivationLifecycle } from "./support/activation-lifecycle.ts";
import { effectTest, settle, step } from "./support/effect-test.ts";
import { nodePath } from "./support/node-builtins.ts";
import { pickQuestionnaire } from "./support/questionnaire.ts";
import { subagentServiceDouble } from "./tools/fixtures/subagent-service-double.ts";
import { fallbackProfileService, testBackendRegistry } from "./tools/fixtures/tool-harness.ts";

type RegisteredToolSummary = {
  readonly name: string;
  readonly exposure?: string;
  readonly defaultActive?: boolean;
};

// Pi activates direct and model-only tools on registration unless they opt out.
const activatesOnRegistration = (tool: RegisteredToolSummary): boolean =>
  (tool.exposure === undefined || tool.exposure === "direct" || tool.exposure === "model-only") &&
  tool.defaultActive !== false;

const testAgentDirectory = () => nodePath.join(tmpdir(), "pi-subagents-application-tests");

const decodeModelsDetails = Schema.decodeUnknownOption(
  Schema.Struct({
    action: Schema.Literal("models"),
    profiles: Schema.Array(Schema.Struct({ source: Schema.optional(Schema.String) })),
  }),
);

const applicationFixture = (
  overrides: Partial<ExtensionAPI> = {},
  options: Parameters<typeof registerSubagentApplication>[1] = {
    getAgentDirectory: testAgentDirectory,
    loadSettings: () => Promise.resolve(),
  },
) => {
  const host = recordingExtensionHost();
  const recorded = host.pi;
  const pi = extensionApiFixture({
    ...recorded,
    getActiveTools: () => ["read"],
    setActiveTools: vi.fn(),
    sendMessage: vi.fn(),
    ...overrides,
    registerTool: (tool) => {
      overrides.registerTool?.(tool);
      recorded.registerTool(tool);
    },
  });
  registerSubagentApplication(pi, options);
  const subagents = (args: string, ctx: ExtensionCommandContext) => {
    const command = host.commands.get("subagents");
    if (!command) throw new Error("Missing /subagents command");
    return command.handler(args, ctx);
  };
  return { emit: host.emit, tools: host.tools, pi, subagents };
};

const activeToolTracker = (onRegister?: (tool: RegisteredToolSummary) => void) => {
  let active: ReadonlyArray<string> = ["read"];
  const registered: string[] = [];
  /** Registered tools that registration activates. */
  const declared: string[] = [];
  const setActive = (names: ReadonlyArray<string>) => {
    active = [...names];
  };
  return {
    active: () => [...active],
    setActive,
    registered,
    declared,
    overrides: {
      registerTool: (tool: RegisteredToolSummary) => {
        registered.push(tool.name);
        if (activatesOnRegistration(tool)) {
          declared.push(tool.name);
          active = [...new Set([...active, tool.name])];
        }
        onRegister?.(tool);
      },
      getActiveTools: () => [...active],
      setActiveTools: setActive,
    } satisfies Partial<ExtensionAPI>,
  };
};

describeActivationLifecycle("root application", (loadSettings = () => Promise.resolve()) => {
  const tools = activeToolTracker();
  const { emit } = applicationFixture(tools.overrides, {
    getAgentDirectory: testAgentDirectory,
    loadSettings,
  });
  return {
    start: () => emit("session_start", sessionContext()),
    shutdown: () => emit("session_shutdown", sessionContext()),
    registeredToolCount: () => tools.registered.length,
    activeTools: tools.active,
  };
});

const signalledContext = (signal?: AbortSignal) => sessionContext({ signal });

describe("subagent Pi registration", () => {
  effectTest(
    "retired runtime callbacks cannot publish or notify into the next session",
    function* () {
      const captured: SubagentLayers.SubagentLayerOptions[] = [];
      const makeLayer = SubagentLayers.subagentApplicationLayer;
      const capture = vi
        .spyOn(SubagentLayers, "subagentApplicationLayer")
        .mockImplementation((options) => {
          captured.push(options);
          return makeLayer(options);
        });
      yield* Effect.addFinalizer(() => Effect.sync(() => capture.mockRestore()));
      const activity = fakeActivityHost("authority-session");
      const sendMessage = vi.fn();
      const ctx = sessionContext({ isProjectTrusted: () => false }, "authority-session");
      const { emit } = applicationFixture({ events: activity.events, sendMessage });
      yield* settle(() => emit("session_start", ctx));
      const retired = captured[0]!;
      yield* settle(() => emit("session_tree", ctx));
      const current = captured[1]!;
      current.publish({ revision: 1, runs: [view({ id: "current" })] });
      const before = activity.get();
      retired.publish({ revision: 99, runs: [view({ id: "retired" })] });
      const rejected = retired.notify({
        type: "question",
        id: "retired",
        name: "Retired run",
        requestId: "question",
        message: "No longer relevant",
        generation: 1,
      });
      expect(activity.get()).toBe(before);
      expect(rejected?.actionAccepted).toBe(false);
      expect(sendMessage).not.toHaveBeenCalled();
      const questionnaireFailure = yield* retired
        .questionnaireHandler(pickQuestionnaire, {
          runId: "retired",
          assignmentEpoch: 1,
          requestId: "questionnaire",
        })
        .pipe(Effect.flip, Effect.orDie);
      expect(questionnaireFailure).toMatchObject({ code: "proxy_caller_disconnected" });
      const pending = view({
        id: "child",
        parentRunId: "caller",
        state: "waiting_for_parent",
        question: { requestId: "current-question", message: "Proceed?" },
      });
      const send = vi.fn(() =>
        Effect.succeed({
          messageId: "message-1",
          to: pending.id,
          name: pending.name,
          disposition: "answered" as const,
          confirmed: true,
        }),
      );
      const service = subagentServiceDouble({
        visibleList: () => Effect.succeed([view({ id: "caller" }), pending]),
        agentSend: send,
      });
      const replyRequest = encodeSubagentProxyInput({
        tool: "agent_send",
        args: { to: pending.id, message: "Yes" },
      });
      const dispatch = (options: SubagentLayers.SubagentLayerOptions) =>
        options
          .proxyHandler(service, "caller", { ...replyRequest, requestId: "reply" })
          .pipe(
            Effect.provideService(SubagentProfileService, fallbackProfileService),
            Effect.provideService(SubagentBackendRegistry, testBackendRegistry),
          );
      expect(yield* dispatch(retired).pipe(Effect.flip, Effect.orDie)).toMatchObject({
        code: "proxy_caller_disconnected",
      });
      expect(send).not.toHaveBeenCalled();
      yield* dispatch(current).pipe(Effect.orDie);
      expect(send).toHaveBeenCalledWith({ kind: "run", runId: "caller" }, pending.id, "Yes");
      current.notify({
        type: "question",
        id: "current",
        name: "Current run",
        requestId: "question",
        message: "Current question",
        generation: 1,
      });
      expect(sendMessage).toHaveBeenCalled();
      yield* settle(() => emit("session_shutdown", ctx));
    },
  );

  effectTest(
    "reload appends pending reports, then lists the runs it stops, without a turn",
    function* () {
      const makeLayer = SubagentLayers.subagentApplicationLayer;
      const order: string[] = [];
      const capture = vi
        .spyOn(SubagentLayers, "subagentApplicationLayer")
        .mockImplementation((options) =>
          makeLayer(options).pipe(
            Layer.merge(
              Layer.succeed(
                SubagentService,
                subagentServiceDouble({
                  projection: Effect.succeed({ revision: 0, runs: [] }),
                  deliverPendingCompletions: Effect.sync(() => {
                    order.push("flush");
                    options.notify({
                      type: "completed",
                      runs: [
                        {
                          id: "agent-0",
                          name: "finished-reader",
                          generation: 1,
                          outcome: "completed",
                          finalText: "Pending report.",
                        },
                      ],
                    });
                    options.publish({
                      revision: 1,
                      runs: [
                        view({ id: "agent-1", name: "parser-review", state: "running" }),
                        view({ id: "agent-2", name: "lexer-review", state: "paused" }),
                        view({ id: "agent-3", name: "done", state: "completed" }),
                      ],
                    });
                  }),
                }),
              ),
            ),
          ),
        );
      yield* Effect.addFinalizer(() => Effect.sync(() => capture.mockRestore()));
      const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>((message) => {
        order.push(message.customType);
      });
      const notify = vi.fn();
      const ctx = sessionContext({ hasUI: true, mode: "tui", ui: { notify } }, "retiring-session");
      const { emit } = applicationFixture({ sendMessage });
      yield* settle(() => emit("session_start", ctx));

      yield* settle(() =>
        emit("session_shutdown", ctx, { type: "session_shutdown", reason: "reload" }),
      );
      expect(order).toEqual(["flush", "pi-subagents-completed", "pi-subagents-stopped"]);
      expect(sendMessage.mock.calls.map(([, options]) => options?.triggerTurn)).toEqual([
        false,
        false,
      ]);
    },
  );

  effectTest(
    "a tree move stops the runs without adding their reports or a notice to the new branch",
    function* () {
      const makeLayer = SubagentLayers.subagentApplicationLayer;
      const flushes: string[] = [];
      let publish: ((projection: SubagentProjection) => void) | undefined;
      const capture = vi
        .spyOn(SubagentLayers, "subagentApplicationLayer")
        .mockImplementation((options) => {
          publish = options.publish;
          return makeLayer(options).pipe(
            Layer.merge(
              Layer.succeed(
                SubagentService,
                subagentServiceDouble({
                  projection: Effect.succeed({ revision: 0, runs: [] }),
                  deliverPendingCompletions: Effect.sync(() => {
                    flushes.push("flush");
                    options.notify({
                      type: "completed",
                      runs: [
                        {
                          id: "agent-0",
                          name: "finished-reader",
                          generation: 1,
                          outcome: "completed",
                          finalText: "Pending report.",
                        },
                      ],
                    });
                  }),
                }),
              ),
            ),
          );
        });
      yield* Effect.addFinalizer(() => Effect.sync(() => capture.mockRestore()));
      const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
      const notify = vi.fn();
      const ctx = sessionContext({ hasUI: true, mode: "tui", ui: { notify } }, "tree-session");
      const { emit } = applicationFixture({ sendMessage });
      yield* settle(() => emit("session_start", ctx));
      publish?.({
        revision: 1,
        runs: [
          view({ id: "agent-1", name: "parser-review", state: "running" }),
          view({ id: "agent-2", name: "done", state: "completed" }),
        ],
      });

      yield* settle(() => emit("session_tree", ctx));
      expect(flushes).toEqual([]);
      expect(sendMessage).not.toHaveBeenCalled();
    },
  );

  effectTest("retired tools cannot run against a replacement session", function* () {
    const ctx = sessionContext({ isProjectTrusted: () => false });
    const { emit, tools } = applicationFixture();
    yield* settle(() => emit("session_start", ctx));
    const oldModels = tools.get("agent_profiles");
    expect(oldModels).toBeDefined();
    yield* settle(() => emit("session_tree", ctx));
    const currentModels = tools.get("agent_profiles");
    expect(currentModels).not.toBe(oldModels);
    yield* step(() =>
      expect(oldModels!.execute("old-models", {}, undefined, undefined, ctx)).rejects.toThrow(),
    );
    const currentResult = yield* step(() =>
      currentModels!.execute("current-models", {}, undefined, undefined, ctx),
    );
    expect(currentResult.isError).not.toBe(true);
    yield* settle(() => emit("session_shutdown", ctx));
  });

  effectTest("holds the session revision lock through a deferred saved-set write", function* () {
    const global = subagentConfigDecoder("global")({ version: 6, profileSets: {} });
    const config = resolveSubagentConfig({
      globalConfigPath: "/agent/pi-subagents.json",
      projectConfigPath: "/repo/.pi/pi-subagents.json",
      projectTrusted: false,
      global,
    });
    const service = yield* builtProfileService(config);
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
      const { emit } = applicationFixture(
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

      const firstStart = Promise.resolve(emit("session_start", firstContext));
      yield* step(() => vi.waitFor(() => expect(signals).toHaveLength(1)));
      const secondStart = Promise.resolve(emit("session_tree", secondContext));
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
      yield* settle(() => emit("session_shutdown", secondContext));
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
      const { emit } = applicationFixture(tools.overrides);
      const ctx = sessionContext();
      const start = () => emit("session_start", ctx);

      yield* settle(start);
      expect(tools.active()).toEqual(["read"]);
      callInActivation = 0;
      throwAt = 3;
      yield* settle(start);
      expect(tools.active()).toEqual(["read"]);

      callInActivation = 0;
      throwAt = Number.POSITIVE_INFINITY;
      yield* settle(start);
      expect(tools.active()).toEqual(["read", ...new Set(tools.declared)]);
      yield* settle(() => emit("session_shutdown", ctx));
    },
  );

  effectTest(
    "keeps tools through tree replacement and deactivates them only when activation is lost",
    function* () {
      const tools = activeToolTracker();
      const replacementSettings = deferredPromise();
      let settingsLoads = 0;
      const { emit } = applicationFixture(tools.overrides, {
        getAgentDirectory: testAgentDirectory,
        loadSettings: () => {
          settingsLoads += 1;
          return settingsLoads === 2 ? replacementSettings.promise : Promise.resolve();
        },
      });

      yield* settle(() => emit("session_start", signalledContext()));
      expect(tools.declared.length).toBeGreaterThan(1);
      const disabledName = tools.declared[0]!;
      const expectedActive = () => [
        "read",
        ...new Set(tools.declared.filter((name) => name !== disabledName)),
      ];
      tools.setActive(tools.active().filter((name) => name !== disabledName));

      const replacing = Promise.resolve(emit("session_tree", signalledContext()));
      yield* step(() => Promise.resolve());
      expect(tools.active()).toEqual(expectedActive());
      replacementSettings.resolve();
      yield* step(() => replacing);
      expect(tools.active()).toEqual(expectedActive());

      const failedCapture = signalledContext();
      Object.defineProperty(failedCapture, "cwd", {
        get: () => {
          throw new Error("capture failed");
        },
      });
      yield* settle(() => emit("session_tree", failedCapture));
      expect(tools.active()).toEqual(["read"]);
      yield* settle(() => emit("session_start", signalledContext()));
      expect(tools.active()).toEqual(expectedActive());

      const aborted = new AbortController();
      aborted.abort();
      yield* settle(() => emit("session_tree", signalledContext(aborted.signal)));
      expect(tools.active()).toEqual(["read"]);

      yield* settle(() => emit("session_start", signalledContext()));
      expect(tools.active()).toEqual(expectedActive());
      yield* settle(() => emit("session_shutdown", signalledContext()));
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
              candidates: [{ ...profileCandidate("openai/invalid"), host: "local" }],
            },
          },
          baseline: completeBaseline("global"),
        },
      };
      const slotHoldsEnvelope = () =>
        Object.getOwnPropertyDescriptor(globalThis, reloadSlot)?.value === envelope;
      Object.defineProperty(globalThis, reloadSlot, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: envelope,
      });
      const tools = activeToolTracker();
      let { emit } = applicationFixture(tools.overrides);
      const notify = vi.fn();
      const contextFor = (sessionId: string) =>
        sessionContext(
          { hasUI: true, mode: "tui", isProjectTrusted: () => false, ui: { notify } },
          sessionId,
        );
      let ctx = contextFor("application-incompatible-session");
      yield* Effect.addFinalizer(() =>
        settle(() =>
          emit("session_shutdown", ctx, { type: "session_shutdown", reason: "quit" }),
        ).pipe(Effect.ensuring(Effect.sync(() => Reflect.deleteProperty(globalThis, reloadSlot)))),
      );
      for (const event of ["session_start", "session_tree", "session_start"] as const) {
        yield* settle(() =>
          event === "session_tree"
            ? emit("session_tree", ctx)
            : emit("session_start", ctx, { type: "session_start", reason: "reload" }),
        );
        expect(tools.active()).toEqual(["read"]);
        expect(slotHoldsEnvelope()).toBe(true);
      }
      expect(notify.mock.calls.some(([, level]) => level === "warning")).toBe(true);

      yield* settle(() =>
        emit("session_shutdown", ctx, { type: "session_shutdown", reason: "reload" }),
      );
      emit = applicationFixture(tools.overrides).emit;
      yield* settle(() => emit("session_start", ctx, { type: "session_start", reason: "reload" }));
      yield* settle(() => emit("session_tree", ctx));
      expect(tools.active()).toEqual(["read"]);
      expect(slotHoldsEnvelope()).toBe(true);

      ctx = contextFor("application-compatible-new-session");
      yield* settle(() => emit("session_start", ctx, { type: "session_start", reason: "new" }));
      expect(tools.active()).toContain("agent_start");
      expect(Object.hasOwn(globalThis, reloadSlot)).toBe(false);
    },
  );

  effectTest(
    "preserves session overrides across tree and reload but clears them for a new session",
    function* () {
      const activeTools = activeToolTracker();
      const registerFreshApplication = () =>
        applicationFixture({ ...activeTools.overrides, getThinkingLevel: () => "high" });
      let { emit, subagents, tools } = registerFreshApplication();

      let component: Component | undefined;
      const ui = {
        notify: vi.fn(),
        confirm: () => Promise.resolve(false),
        custom: mountingCustomUi(plainTheme, (created) => {
          component = created;
        }).custom,
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
      const hasSessionOverride = (context: ExtensionToolContext): Effect.Effect<boolean> => {
        const tool = tools.get("agent_profiles");
        if (!tool) return Effect.succeed(false);
        return Effect.promise(() => tool.execute("models", {}, undefined, undefined, context)).pipe(
          Effect.map((result) =>
            Option.exists(decodeModelsDetails(result.details), (details) =>
              details.profiles.some((profile) => profile.source === "session"),
            ),
          ),
        );
      };

      yield* settle(() => emit("session_start", ctx, { type: "session_start", reason: "startup" }));
      let editorClosed = false;
      const editing = subagents("profiles", ctx).then(() => {
        editorClosed = true;
        return undefined;
      });
      yield* step(() => vi.waitFor(() => expect(component).toBeDefined()));
      component?.handleInput?.("e");
      component?.handleInput?.("j");
      component?.handleInput?.("\r");
      yield* step(() =>
        vi.waitFor(() =>
          Effect.runPromise(hasSessionOverride(ctx)).then((value) => expect(value).toBe(true)),
        ),
      );
      yield* step(() =>
        vi.waitFor(() => {
          component?.handleInput?.("\u001b");
          expect(editorClosed).toBe(true);
        }),
      );
      yield* step(() => editing);

      yield* settle(() => emit("session_tree", ctx));
      expect(yield* hasSessionOverride(ctx)).toBe(true);

      yield* settle(() =>
        emit("session_shutdown", ctx, { type: "session_shutdown", reason: "reload" }),
      );
      ({ emit, subagents, tools } = registerFreshApplication());
      yield* settle(() => emit("session_start", ctx, { type: "session_start", reason: "reload" }));
      expect(yield* hasSessionOverride(ctx)).toBe(true);

      yield* settle(() =>
        emit("session_shutdown", ctx, { type: "session_shutdown", reason: "reload" }),
      );
      yield* settle(() => emit("session_start", ctx, { type: "session_start", reason: "reload" }));
      expect(yield* hasSessionOverride(ctx)).toBe(true);

      const failedTreeContext = { ...ctx };
      Object.defineProperty(failedTreeContext, "cwd", {
        get: () => {
          throw new Error("tree capture failed");
        },
      });
      yield* settle(() => emit("session_tree", failedTreeContext));
      yield* settle(() =>
        emit("session_shutdown", ctx, { type: "session_shutdown", reason: "reload" }),
      );
      yield* settle(() => emit("session_start", ctx, { type: "session_start", reason: "reload" }));
      expect(yield* hasSessionOverride(ctx)).toBe(true);

      yield* settle(() =>
        emit("session_shutdown", ctx, { type: "session_shutdown", reason: "quit" }),
      );
      const newSessionContext = contextFor("application-new-session");
      yield* settle(() =>
        emit("session_start", newSessionContext, { type: "session_start", reason: "new" }),
      );
      expect(yield* hasSessionOverride(newSessionContext)).toBe(false);
      yield* settle(() =>
        emit("session_shutdown", newSessionContext, { type: "session_shutdown", reason: "quit" }),
      );
    },
  );
});

describe("orphaned workspace sweep notice", () => {
  effectTest(
    "tells only the user which orphans a session start swept, and reload sweeps nothing",
    function* () {
      const makeLayer = SubagentLayers.subagentApplicationLayer;
      let sweeps = 0;
      const swept = [
        {
          workspaceId: "swept-workspace",
          sourceRoot: "/repo",
          changedPathCount: 2,
          patchPath: "/agent/subagent-worktrees/swept-workspace/revision.diff",
        },
      ];
      const capture = vi
        .spyOn(SubagentLayers, "subagentApplicationLayer")
        .mockImplementation((options) =>
          makeLayer(options).pipe(
            Layer.merge(
              Layer.succeed(
                SubagentService,
                subagentServiceDouble({
                  projection: Effect.succeed({ revision: 0, runs: [] }),
                  deliverPendingCompletions: Effect.void,
                  sweepOrphanedWorkspaces: Effect.sync(() => {
                    sweeps += 1;
                    return swept;
                  }),
                }),
              ),
            ),
          ),
        );
      yield* Effect.addFinalizer(() => Effect.sync(() => capture.mockRestore()));
      const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
      const notify = vi.fn();
      const ctx = sessionContext({ hasUI: true, mode: "tui", ui: { notify } }, "sweep-session");
      const { emit } = applicationFixture({ sendMessage });
      yield* settle(() => emit("session_start", ctx));
      yield* settle(() => Promise.resolve());
      expect(sweeps).toBe(1);
      const notices = notify.mock.calls.filter(([text]) =>
        String(text).includes("swept-workspace"),
      );
      expect(notices).toHaveLength(1);
      expect(String(notices[0]?.[0])).toContain(swept[0]?.patchPath);
      expect(sendMessage).not.toHaveBeenCalled();

      yield* settle(() =>
        emit("session_shutdown", ctx, { type: "session_shutdown", reason: "reload" }),
      );
      yield* settle(() => emit("session_start", ctx, { type: "session_start", reason: "reload" }));
      yield* settle(() => Promise.resolve());
      expect(sweeps).toBe(1);
      yield* settle(() =>
        emit("session_shutdown", ctx, { type: "session_shutdown", reason: "quit" }),
      );
    },
  );
});

// Gives each runtime a service double and returns the layer options each runtime received.
const withServiceDouble = (service: Parameters<typeof subagentServiceDouble>[0]) => {
  const captured: SubagentLayers.SubagentLayerOptions[] = [];
  const makeLayer = SubagentLayers.subagentApplicationLayer;
  const capture = vi
    .spyOn(SubagentLayers, "subagentApplicationLayer")
    .mockImplementation((options) => {
      captured.push(options);
      return makeLayer(options).pipe(
        Layer.merge(
          Layer.succeed(
            SubagentService,
            subagentServiceDouble({
              projection: Effect.succeed({ revision: 0, runs: [] }),
              deliverPendingCompletions: Effect.void,
              ...service,
            }),
          ),
        ),
      );
    });
  return Effect.addFinalizer(() => Effect.sync(() => capture.mockRestore())).pipe(
    Effect.as(captured),
  );
};

describe("worktree tool activation", () => {
  effectTest("declares agent_worktree once a worktree writer runs", function* () {
    const captured = yield* withServiceDouble({});
    const tools = activeToolTracker();
    const { emit } = applicationFixture(tools.overrides);
    const ctx = sessionContext({}, "worktree-launch-session");
    yield* settle(() => emit("session_start", ctx));
    expect(tools.registered).toEqual(expect.arrayContaining(["agent_profiles", "agent_worktree"]));
    expect(tools.active()).toContain("agent_start");
    expect(tools.active()).not.toContain("agent_worktree");
    expect(tools.active()).not.toContain("agent_profiles");

    captured.at(-1)!.publish({ revision: 1, runs: [view({ id: "reader" })] });
    expect(tools.active()).not.toContain("agent_worktree");
    captured.at(-1)!.publish({
      revision: 2,
      runs: [view({ id: "writer", writeIntent: "writer", workspaceId: "workspace-1" })],
    });
    expect(tools.active()).toContain("agent_worktree");
    yield* settle(() => emit("session_shutdown", ctx));
  });

  effectTest("declares agent_worktree when a session starts beside an orphan", function* () {
    yield* withServiceDouble({
      workspaceList: () =>
        Effect.succeed({
          records: [],
          unavailable: [],
          orphans: new Map([["orphan-1", "adoptable" as const]]),
        }),
    });
    const tools = activeToolTracker();
    const { emit } = applicationFixture(tools.overrides);
    const ctx = sessionContext({}, "worktree-orphan-session");
    yield* settle(() => emit("session_start", ctx));
    yield* step(() => vi.waitFor(() => expect(tools.active()).toContain("agent_worktree")));
    yield* settle(() => emit("session_shutdown", ctx));
  });

  effectTest(
    "a new session in the same process declares agent_worktree only beside an orphan",
    function* () {
      let orphans = new Map<string, "adoptable">();
      let listings = 0;
      const captured = yield* withServiceDouble({
        workspaceList: () =>
          Effect.sync(() => {
            listings += 1;
            return { records: [], unavailable: [], orphans };
          }),
      });
      const tools = activeToolTracker();
      const { emit } = applicationFixture(tools.overrides);
      const replace = (from: ReturnType<typeof sessionContext>, key: string) =>
        Effect.gen(function* () {
          const listed = listings;
          yield* settle(() =>
            emit("session_shutdown", from, { type: "session_shutdown", reason: "new" }),
          );
          const next = sessionContext({}, key);
          yield* settle(() =>
            emit("session_start", next, { type: "session_start", reason: "new" }),
          );
          yield* step(() => vi.waitFor(() => expect(listings).toBe(listed + 1)));
          yield* settle(() => Promise.resolve());
          return next;
        });

      const first = sessionContext({}, "worktree-first-session");
      yield* settle(() => emit("session_start", first));
      captured.at(-1)!.publish({
        revision: 1,
        runs: [view({ id: "writer", writeIntent: "writer", workspaceId: "workspace-1" })],
      });
      expect(tools.active()).toContain("agent_worktree");

      const second = yield* replace(first, "worktree-second-session");
      expect(tools.active()).toContain("agent_start");
      expect(tools.active()).not.toContain("agent_worktree");

      orphans = new Map([["orphan-1", "adoptable"]]);
      const third = yield* replace(second, "worktree-third-session");
      yield* step(() => vi.waitFor(() => expect(tools.active()).toContain("agent_worktree")));
      yield* settle(() => emit("session_shutdown", third));
    },
  );
});
