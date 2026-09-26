// Promise-shaped Pi host boundary test.
import { applyPresentationSettings, createToolPresentationHarness } from "pi-code-previews/testing";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import type { ExtensionHandler, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import registerBridge, {
  type PiSupervisorBridgeExtensionDependencies,
} from "../src/boundary/host-pi-supervisor-extension.ts";
import {
  type PiSupervisorBridgeClient,
  PiSupervisorBridgeError,
} from "../src/boundary/pi-supervisor-bridge-client.ts";
import { SUBAGENT_TOOL_NAMES } from "../src/run/tool-policy.ts";
import {
  SUPERVISOR_MCP_TOOL_NAMES,
  type SupervisorMcpToolArgumentsByName as SupervisorToolArgumentsByName,
} from "../src/supervisor/mcp-contract.ts";
import { extensionContextFixture } from "pi-cosmic-core/testing";
import { extensionApiFixture, modelFixture } from "./fixtures/pi-host.ts";
import * as subagentTools from "../src/tools/subagent.ts";
import { effectTest, settle, step } from "./support/effect-test.ts";

type SupervisorToolName = keyof SupervisorToolArgumentsByName;
type BridgeCall = {
  readonly [Name in SupervisorToolName]: {
    readonly name: Name;
    readonly input: SupervisorToolArgumentsByName[Name];
  };
}[SupervisorToolName];

const bridgeCalls: BridgeCall[] = [];
let reportFailuresRemaining = 0;
const releaseBridge = vi.fn();
const openBridge = vi.fn(
  (_: string) =>
    Effect.acquireRelease(
      Effect.succeed<PiSupervisorBridgeClient>({
        call: <Name extends SupervisorToolName>(
          name: Name,
          input: SupervisorToolArgumentsByName[Name],
        ) =>
          Effect.suspend(() => {
            // SAFETY: The generic name/input pair is correlated by SupervisorToolArgumentsByName.
            bridgeCalls.push({ name, input } as BridgeCall);
            if (name === "supervisor_submit_report" && reportFailuresRemaining > 0) {
              reportFailuresRemaining -= 1;
              return Effect.fail(
                new PiSupervisorBridgeError({
                  reason: "transport",
                  message: "uncertain report delivery",
                }),
              );
            }
            return Effect.succeed("accepted");
          }),
      }),
      () => Effect.sync(releaseBridge),
    ) satisfies Effect.Effect<PiSupervisorBridgeClient, never, Scope.Scope>,
);

afterEach(() => {
  bridgeCalls.length = 0;
  reportFailuresRemaining = 0;
  releaseBridge.mockClear();
  openBridge.mockClear();
  vi.unstubAllEnvs();
});

type BridgeEventHandler = ExtensionHandler<any, any>;
type NativeBridgeTool = ToolDefinition<any, any, any>;
type NativeBridgeExecute = NativeBridgeTool["execute"];
type BridgeToolResult = Omit<Awaited<ReturnType<NativeBridgeExecute>>, "content"> & {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
};
type BridgeTool = Omit<NativeBridgeTool, "execute"> & {
  readonly execute: (
    id: Parameters<NativeBridgeExecute>[0],
    params: Parameters<NativeBridgeExecute>[1],
    signal?: Parameters<NativeBridgeExecute>[2],
    onUpdate?: Parameters<NativeBridgeExecute>[3],
    ctx?: Parameters<NativeBridgeExecute>[4],
  ) => Promise<BridgeToolResult>;
};

const bridgeContext = extensionContextFixture({});

interface BridgeHarnessOptions {
  readonly open?: PiSupervisorBridgeExtensionDependencies["openBridge"];
  readonly activeTools?: ReadonlyArray<string>;
  readonly flags?: Readonly<Record<string, string | boolean>>;
  readonly trusted?: boolean;
}

const bridgeHarness = ({
  open = openBridge,
  activeTools = ["read"],
  flags = { "pi-subagents-supervisor-config": "/private/supervisor/connection.json" },
}: BridgeHarnessOptions = {}) => {
  const handlers = new Map<string, BridgeEventHandler>();
  const tools: BridgeTool[] = [];
  let active = [...activeTools];
  const pi = extensionApiFixture({
    registerFlag: vi.fn(),
    getFlag: vi.fn((name: string) => flags[name]),
    on: vi.fn((name: string, handler: BridgeEventHandler) => handlers.set(name, handler)),
    registerTool: vi.fn((tool: BridgeTool) => tools.push(tool)),
    getActiveTools: vi.fn(() => active),
    setActiveTools: vi.fn((next: string[]) => void (active = next)),
    registerProvider: vi.fn(),
  });
  registerBridge(pi, { openBridge: open });
  return { pi, handlers, tools, activeTools: () => [...active] };
};

const startSession = (handlers: Map<string, BridgeEventHandler>, trusted = false) =>
  Promise.resolve(
    handlers.get("session_start")?.(
      {},
      extensionContextFixture({ cwd: "/project", isProjectTrusted: () => trusted, hasUI: false }),
    ),
  );

const startBridgeHarness = (options: BridgeHarnessOptions = {}) => {
  const harness = bridgeHarness(options);
  return startSession(harness.handlers, options.trusted).then(() => harness);
};

const finishTurn = (
  handlers: Map<string, BridgeEventHandler>,
  text: string,
  stopReason?: "stop" | "aborted",
) =>
  Effect.sync(() =>
    handlers.get("agent_end")?.({ messages: [assistantMessage(text, stopReason)] }, bridgeContext),
  ).pipe(Effect.andThen(settle(() => handlers.get("agent_settled")?.({}, bridgeContext))));

const submitReport = (
  tools: ReadonlyArray<BridgeTool>,
  id: string,
  deliveryId: string,
  report: string,
) =>
  tools
    .find((tool) => tool.name === "supervisor_submit_report")!
    .execute(id, { delivery_id: deliveryId, report });

const reportCall = (deliveryId: string, report: string): BridgeCall => ({
  name: "supervisor_submit_report",
  input: { delivery_id: deliveryId, report },
});

const runtimeCredentialSnapshot = (source: NodeJS.ProcessEnv) => ({
  apiKey: source.PI_SUBAGENT_RUNTIME_API_KEY,
  provider: source.PI_SUBAGENT_RUNTIME_API_PROVIDER,
});

const assistantMessage = (text: string, stopReason: "stop" | "aborted" = "stop") => ({
  role: "assistant",
  content: [{ type: "text", text }],
  stopReason,
});

describe("Herdr-hosted Pi bridge extension", () => {
  effectTest("renders registered supervisor and proxy tools without transport calls", function* () {
    const restore = applyPresentationSettings({
      toolCallCollapsedStyle: "compact",
      toolCallTiming: false,
    });
    const bridge = yield* step(startBridgeHarness);
    try {
      for (const tool of bridge.tools) {
        const cycled = createToolPresentationHarness(tool).cycle(
          { message: "input evidence", report: "report evidence", delivery_id: "delivery" },
          { content: [{ type: "text", text: "historical reply sentinel" }], details: {} },
        );
        for (const { expanded, text } of cycled)
          if (expanded) expect(text).toContain("historical reply sentinel");
      }
      expect(bridgeCalls).toEqual([]);
    } finally {
      yield* step(() => bridge.handlers.get("session_shutdown")?.({}, bridgeContext));
      restore();
    }
  });
  effectTest("revokes compact animation when the supervisor session shuts down", function* () {
    const registration = vi.spyOn(subagentTools, "registerSubagentTools");
    const harness = yield* step(startBridgeHarness);
    const shutdown = () => harness.handlers.get("session_shutdown")?.({}, bridgeContext);
    try {
      const schedule = registration.mock.calls.at(-1)?.[1].scheduleAnimation;
      let ticks = 0;
      expect(schedule?.(1, () => ticks++)).toBeTypeOf("function");
      yield* step(() => vi.waitFor(() => expect(ticks).toBeGreaterThan(0)));
      yield* settle(shutdown);
      expect(schedule?.(1, () => ticks++)).toBeUndefined();
    } finally {
      yield* settle(shutdown);
      registration.mockRestore();
    }
  });
  it("injects the priority service tier for eligible fast-mode Pi requests", () => {
    const { handlers } = bridgeHarness({ flags: { "pi-subagents-fast-mode": true } });
    expect(
      handlers.get("before_provider_request")?.(
        { payload: { input: "task" } },
        extensionContextFixture({
          model: modelFixture({ provider: "openai-codex", id: "gpt-5.6-sol" }),
        }),
      ),
    ).toEqual({ input: "task", service_tier: "priority" });
  });

  effectTest(
    "deletes ephemeral provider credentials before a config-validation return",
    function* () {
      vi.stubEnv("PI_SUBAGENT_RUNTIME_API_KEY", "must-be-deleted");
      vi.stubEnv("PI_SUBAGENT_RUNTIME_API_PROVIDER", "openai-codex");
      const { handlers, pi } = bridgeHarness({ flags: {} });
      yield* settle(() =>
        handlers.get("session_start")?.({}, extensionContextFixture({ hasUI: false })),
      );
      const remaining = runtimeCredentialSnapshot(process.env);
      expect(remaining.apiKey).toBeUndefined();
      expect(remaining.provider).toBeUndefined();
      expect(pi.registerProvider).not.toHaveBeenCalled();
    },
  );

  effectTest(
    "preserves ordinary inherited tools while reconciling authenticated bridge tools",
    function* () {
      const { activeTools } = yield* step(() =>
        startBridgeHarness({
          activeTools: [
            "read",
            "code_mode",
            "subagent_start",
            "herdr_agent_start",
            "contact_parent",
          ],
          trusted: true,
        }),
      );

      expect(activeTools()).toEqual([
        "read",
        "code_mode",
        ...SUPERVISOR_MCP_TOOL_NAMES,
        ...SUBAGENT_TOOL_NAMES,
      ]);
    },
  );

  effectTest(
    "promotes a settled final Pi response through the supervisor report channel",
    function* () {
      const { handlers } = yield* step(startBridgeHarness);
      handlers.get("before_agent_start")?.({}, bridgeContext);
      handlers.get("agent_end")?.(
        { messages: [assistantMessage("Complete review report.")] },
        bridgeContext,
      );
      expect(bridgeCalls).toEqual([]);

      yield* settle(() => handlers.get("agent_settled")?.({}, bridgeContext));

      expect(bridgeCalls).toEqual([reportCall("pi-final-1", "Complete review report.")]);
    },
  );

  effectTest("does not duplicate an explicitly accepted report at agent settlement", function* () {
    const { handlers, tools } = yield* step(startBridgeHarness);
    handlers.get("before_agent_start")?.({}, bridgeContext);
    yield* step(() => submitReport(tools, "report-1", "explicit-report-1", "Explicit report."));
    yield* finishTurn(handlers, "Native final text.");

    expect(bridgeCalls).toEqual([reportCall("explicit-report-1", "Explicit report.")]);
  });

  for (const [name, stopReason, calls] of [
    ["retries an uncertain explicit report once with its locked delivery identity", "stop", 2],
    ["does not retry an uncertain explicit report after an interrupted turn", "aborted", 1],
  ] as const) {
    effectTest(name, function* () {
      const { handlers, tools } = yield* step(startBridgeHarness);
      handlers.get("before_agent_start")?.(
        { prompt: "Begin supervisor assignment epoch 1." },
        bridgeContext,
      );
      reportFailuresRemaining = 1;
      const uncertain = [
        "stable-explicit-report",
        "Explicit report with uncertain delivery.",
      ] as const;
      yield* step(() =>
        expect(submitReport(tools, "report-uncertain", ...uncertain)).rejects.toThrow("uncertain"),
      );
      yield* step(() =>
        expect(
          submitReport(tools, "report-conflict", "conflicting-report", "Conflicting report."),
        ).rejects.toThrow("different supervisor report identity"),
      );
      yield* finishTurn(handlers, "Native final text.", stopReason);

      expect(bridgeCalls).toEqual(Array.from({ length: calls }, () => reportCall(...uncertain)));
    });
  }

  effectTest(
    "resets retained assignment state when an epoch is steered into the active Pi loop",
    function* () {
      const { handlers, tools } = yield* step(startBridgeHarness);
      handlers.get("before_agent_start")?.(
        { prompt: "Begin supervisor assignment epoch 1." },
        bridgeContext,
      );
      yield* step(() => submitReport(tools, "report-1", "explicit-report-1", "First report."));

      handlers.get("input")?.(
        {
          text: "Begin supervisor assignment epoch 2.\n\nRetained follow-up.",
          source: "interactive",
          streamingBehavior: "steer",
        },
        bridgeContext,
      );
      yield* finishTurn(handlers, "Second report.");

      expect(bridgeCalls).toEqual([
        reportCall("explicit-report-1", "First report."),
        reportCall("pi-final-2", "Second report."),
      ]);
    },
  );

  effectTest("treats same-epoch input and agent-start events as idempotent", function* () {
    const { handlers, tools } = yield* step(startBridgeHarness);
    const epochPrompt = "Begin supervisor assignment epoch 1.\n\nInitial assignment.";
    handlers.get("input")?.({ text: epochPrompt, source: "interactive" }, bridgeContext);
    handlers.get("before_agent_start")?.({ prompt: epochPrompt }, bridgeContext);
    yield* step(() => submitReport(tools, "report-1", "explicit-report-1", "Explicit report."));

    handlers.get("input")?.(
      { text: epochPrompt, source: "interactive", streamingBehavior: "steer" },
      bridgeContext,
    );
    handlers.get("before_agent_start")?.({ prompt: epochPrompt }, bridgeContext);
    yield* finishTurn(handlers, "Duplicate final text.");

    expect(bridgeCalls).toEqual([reportCall("explicit-report-1", "Explicit report.")]);
  });

  effectTest("uses a fresh fallback identity for each retained Pi assignment", function* () {
    const { handlers } = yield* step(startBridgeHarness);
    for (const report of ["First report.", "Second report."]) {
      handlers.get("before_agent_start")?.({}, bridgeContext);
      yield* finishTurn(handlers, report);
    }

    expect(bridgeCalls).toEqual([
      reportCall("pi-final-1", "First report."),
      reportCall("pi-final-2", "Second report."),
    ]);
  });

  effectTest(
    "releases a bridge acquired by startup when shutdown interrupts initialization",
    function* () {
      const acquired = Deferred.makeUnsafe<void>();
      const initialization = Deferred.makeUnsafe<void>();
      const release = vi.fn();
      const blockedOpen: PiSupervisorBridgeExtensionDependencies["openBridge"] = () =>
        Effect.acquireRelease(
          Effect.sync(() => {
            Deferred.doneUnsafe(acquired, Effect.void);
            return {
              call: <Name extends SupervisorToolName>(
                _name: Name,
                _input: SupervisorToolArgumentsByName[Name],
              ) => Effect.succeed("accepted"),
            };
          }),
          () => Effect.sync(release),
        ).pipe(Effect.tap(() => Deferred.await(initialization)));
      const { handlers, tools } = bridgeHarness({ open: blockedOpen });
      const starting = startSession(handlers);
      yield* step(() => Effect.runPromise(Deferred.await(acquired)));

      yield* settle(() => handlers.get("session_shutdown")?.({}, bridgeContext));
      yield* step(() => starting);

      expect(release).toHaveBeenCalledOnce();
      expect(tools).toEqual([]);
    },
  );

  effectTest(
    "persists delegated proxy await cancellation after its bridge finalizer",
    function* () {
      const started = Deferred.makeUnsafe<void>();
      let finalized = false;
      const activeOpen: PiSupervisorBridgeExtensionDependencies["openBridge"] = () =>
        Effect.succeed<PiSupervisorBridgeClient>({
          call: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  finalized = true;
                }),
              ),
            ),
        });
      const { handlers, tools } = yield* step(() => startBridgeHarness({ open: activeOpen }));
      const controller = new AbortController();
      const waiting = tools
        .find((tool) => tool.name === "subagent_await")!
        .execute(
          "await",
          { runIds: ["agent-nested"], until: "all_finished" },
          controller.signal,
          undefined,
          bridgeContext,
        );
      yield* Deferred.await(started);
      controller.abort();
      const result = yield* step(() => waiting);
      expect(finalized).toBe(true);
      expect(result.details).toMatchObject({
        action: "await",
        cancelled: true,
        awaitedRunIds: ["agent-nested"],
        cancellationCleanup: "unconfirmed",
      });
      expect(result.content[0]?.text).toContain("states are unobserved");
      expect(result.content[0]?.text).toContain("Root completion-claim cleanup is unconfirmed");
      expect(result.content[0]?.text).not.toContain("Wait cleanup is complete");
      yield* settle(() => handlers.get("session_shutdown")?.({}, bridgeContext));
    },
  );

  effectTest(
    "interrupts and joins an active bridge call before releasing the bridge on shutdown",
    function* () {
      const callStarted = Deferred.makeUnsafe<void>();
      const blocked = Deferred.makeUnsafe<void>();
      const callInterrupted = vi.fn();
      const bridgeReleased = vi.fn();
      const activeOpen: PiSupervisorBridgeExtensionDependencies["openBridge"] = () =>
        Effect.acquireRelease(
          Effect.succeed<PiSupervisorBridgeClient>({
            call: () =>
              Effect.gen(function* () {
                Deferred.doneUnsafe(callStarted, Effect.void);
                yield* Deferred.await(blocked);
                return "accepted";
              }).pipe(Effect.onInterrupt(() => Effect.sync(callInterrupted))),
          }),
          () => Effect.sync(bridgeReleased),
        );
      const { handlers, tools } = yield* step(() => startBridgeHarness({ open: activeOpen }));
      const progress = tools.find((tool) => tool.name === "supervisor_progress")!;
      const activeCall = progress.execute("progress-active", { message: "Still working" }).then(
        () => "accepted" as const,
        () => "interrupted" as const,
      );
      yield* step(() => Effect.runPromise(Deferred.await(callStarted)));

      yield* settle(() => handlers.get("session_shutdown")?.({}, bridgeContext));
      expect(yield* step(() => activeCall)).toBe("interrupted");
      expect(callInterrupted).toHaveBeenCalledOnce();
      expect(bridgeReleased).toHaveBeenCalledOnce();
      yield* step(() =>
        expect(progress.execute("progress-stale", { message: "Late message" })).rejects.toThrow(
          "unavailable",
        ),
      );
    },
  );

  effectTest("does not auto-report an interrupted turn or after session shutdown", function* () {
    const { handlers } = yield* step(startBridgeHarness);
    handlers.get("before_agent_start")?.({}, bridgeContext);
    yield* finishTurn(handlers, "Partial report.", "aborted");
    expect(bridgeCalls).toEqual([]);

    handlers.get("before_agent_start")?.({}, bridgeContext);
    handlers.get("agent_end")?.(
      { messages: [assistantMessage("Late complete report.")] },
      bridgeContext,
    );
    yield* settle(() => handlers.get("session_shutdown")?.({}, bridgeContext));
    yield* settle(() => handlers.get("agent_settled")?.({}, bridgeContext));

    expect(bridgeCalls).toEqual([]);
    expect(releaseBridge).toHaveBeenCalledOnce();
  });
});
