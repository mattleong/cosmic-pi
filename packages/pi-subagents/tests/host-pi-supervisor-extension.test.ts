// Promise-shaped Pi host boundary test.
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import type { ExtensionHandler, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import registerBridge, {
  type PiSupervisorBridgeExtensionDependencies,
} from "../src/boundary/host-pi-supervisor-extension.ts";
import type { PiSupervisorBridgeClient } from "../src/boundary/pi-supervisor-bridge-client.ts";
import { RpcSessionTransportError } from "../src/boundary/rpc-session.ts";
import { SUBAGENT_TOOL_NAMES } from "../src/run/tool-policy.ts";
import {
  SUPERVISOR_MCP_TOOL_NAMES,
  type SupervisorMcpToolArgumentsByName as SupervisorToolArgumentsByName,
} from "../src/supervisor/mcp-contract.ts";
import { extensionApiFixture, extensionContextFixture, modelFixture } from "./fixtures/pi-host.ts";
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
                new RpcSessionTransportError({ message: "uncertain report delivery" }),
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

const bridgeHarness = (
  bridgeOpen: PiSupervisorBridgeExtensionDependencies["openBridge"] = openBridge,
  initialActiveTools: ReadonlyArray<string> = ["read"],
) => {
  const handlers = new Map<string, BridgeEventHandler>();
  const tools: BridgeTool[] = [];
  let active = [...initialActiveTools];
  // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
  const pi = extensionApiFixture({
    registerFlag: vi.fn(),
    getFlag: vi.fn((name: string) =>
      name === "pi-subagents-supervisor-config" ? "/private/supervisor/connection.json" : undefined,
    ),
    on: vi.fn((name: string, handler: BridgeEventHandler) => handlers.set(name, handler)),
    registerTool: vi.fn((tool: BridgeTool) => tools.push(tool)),
    getActiveTools: vi.fn(() => active),
    setActiveTools: vi.fn((next: string[]) => void (active = next)),
    registerProvider: vi.fn(),
  });
  registerBridge(pi, { openBridge: bridgeOpen });
  return { handlers, tools, activeTools: () => [...active] };
};

const startBridgeHarness = () => {
  const harness = bridgeHarness();
  return Promise.resolve(
    harness.handlers.get("session_start")?.(
      {},
      extensionContextFixture({ cwd: "/project", isProjectTrusted: () => false, hasUI: false }),
    ),
  ).then(() => harness);
};

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
  it("injects the priority service tier for eligible fast-mode Pi requests", () => {
    const handlers = new Map<string, BridgeEventHandler>();
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const pi = extensionApiFixture({
      registerFlag: vi.fn(),
      getFlag: vi.fn((name: string) => name === "pi-subagents-fast-mode"),
      on: vi.fn((name: string, handler: BridgeEventHandler) => handlers.set(name, handler)),
    });
    registerBridge(pi, { openBridge });
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
      const handlers = new Map<string, BridgeEventHandler>();
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      const pi = extensionApiFixture({
        registerFlag: vi.fn(),
        getFlag: vi.fn(() => undefined),
        on: vi.fn((name: string, handler: BridgeEventHandler) => handlers.set(name, handler)),
        registerProvider: vi.fn(),
      });
      vi.stubEnv("PI_SUBAGENT_RUNTIME_API_KEY", "must-be-deleted");
      vi.stubEnv("PI_SUBAGENT_RUNTIME_API_PROVIDER", "openai-codex");
      registerBridge(pi, { openBridge });
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
      const { handlers, activeTools } = bridgeHarness(openBridge, [
        "read",
        "code_mode",
        "subagent_start",
        "herdr_agent_start",
        "contact_parent",
      ]);
      yield* settle(() =>
        handlers.get("session_start")?.(
          {},
          extensionContextFixture({ cwd: "/project", isProjectTrusted: () => true, hasUI: false }),
        ),
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

      expect(bridgeCalls).toEqual([
        {
          name: "supervisor_submit_report",
          input: { delivery_id: "pi-final-1", report: "Complete review report." },
        },
      ]);
    },
  );

  effectTest("does not duplicate an explicitly accepted report at agent settlement", function* () {
    const { handlers, tools } = yield* step(startBridgeHarness);
    handlers.get("before_agent_start")?.({}, bridgeContext);
    const report = tools.find((tool) => tool.name === "supervisor_submit_report")!;
    yield* step(() =>
      report.execute("report-1", {
        delivery_id: "explicit-report-1",
        report: "Explicit report.",
      }),
    );
    handlers.get("agent_end")?.(
      { messages: [assistantMessage("Native final text.")] },
      bridgeContext,
    );
    yield* settle(() => handlers.get("agent_settled")?.({}, bridgeContext));

    expect(bridgeCalls).toEqual([
      {
        name: "supervisor_submit_report",
        input: { delivery_id: "explicit-report-1", report: "Explicit report." },
      },
    ]);
  });

  effectTest("retries an uncertain explicit report with the same delivery identity", function* () {
    const { handlers, tools } = yield* step(startBridgeHarness);
    handlers.get("before_agent_start")?.({}, bridgeContext);
    reportFailuresRemaining = 1;
    const report = tools.find((tool) => tool.name === "supervisor_submit_report")!;
    yield* step(() =>
      expect(
        report.execute("report-uncertain", {
          delivery_id: "stable-explicit-report",
          report: "Explicit report with uncertain delivery.",
        }),
      ).rejects.toThrow("uncertain"),
    );
    handlers.get("agent_end")?.(
      { messages: [assistantMessage("Native final text.")] },
      bridgeContext,
    );
    yield* settle(() => handlers.get("agent_settled")?.({}, bridgeContext));

    expect(bridgeCalls).toEqual([
      {
        name: "supervisor_submit_report",
        input: {
          delivery_id: "stable-explicit-report",
          report: "Explicit report with uncertain delivery.",
        },
      },
      {
        name: "supervisor_submit_report",
        input: {
          delivery_id: "stable-explicit-report",
          report: "Explicit report with uncertain delivery.",
        },
      },
    ]);
  });

  effectTest(
    "locks an uncertain explicit report identity against conflicting retries",
    function* () {
      const { handlers, tools } = yield* step(startBridgeHarness);
      handlers.get("before_agent_start")?.(
        { prompt: "Begin supervisor assignment epoch 1." },
        bridgeContext,
      );
      reportFailuresRemaining = 1;
      const report = tools.find((tool) => tool.name === "supervisor_submit_report")!;
      yield* step(() =>
        expect(
          report.execute("report-uncertain", {
            delivery_id: "stable-explicit-report",
            report: "Explicit report with uncertain delivery.",
          }),
        ).rejects.toThrow("uncertain"),
      );
      yield* step(() =>
        expect(
          report.execute("report-conflict", {
            delivery_id: "conflicting-report",
            report: "Conflicting report.",
          }),
        ).rejects.toThrow("different supervisor report identity"),
      );
      handlers.get("agent_end")?.(
        { messages: [assistantMessage("Native final text.")] },
        bridgeContext,
      );
      yield* settle(() => handlers.get("agent_settled")?.({}, bridgeContext));

      expect(bridgeCalls).toHaveLength(2);
      expect(bridgeCalls[1]).toEqual(bridgeCalls[0]);
    },
  );

  effectTest(
    "resets retained assignment state when an epoch is steered into the active Pi loop",
    function* () {
      const { handlers, tools } = yield* step(startBridgeHarness);
      handlers.get("before_agent_start")?.(
        { prompt: "Begin supervisor assignment epoch 1." },
        bridgeContext,
      );
      const report = tools.find((tool) => tool.name === "supervisor_submit_report")!;
      yield* step(() =>
        report.execute("report-1", {
          delivery_id: "explicit-report-1",
          report: "First report.",
        }),
      );

      handlers.get("input")?.(
        {
          text: "Begin supervisor assignment epoch 2.\n\nRetained follow-up.",
          source: "interactive",
          streamingBehavior: "steer",
        },
        bridgeContext,
      );
      handlers.get("agent_end")?.(
        { messages: [assistantMessage("Second report.")] },
        bridgeContext,
      );
      yield* settle(() => handlers.get("agent_settled")?.({}, bridgeContext));

      expect(bridgeCalls).toEqual([
        {
          name: "supervisor_submit_report",
          input: { delivery_id: "explicit-report-1", report: "First report." },
        },
        {
          name: "supervisor_submit_report",
          input: { delivery_id: "pi-final-2", report: "Second report." },
        },
      ]);
    },
  );

  effectTest("treats same-epoch input and agent-start events as idempotent", function* () {
    const { handlers, tools } = yield* step(startBridgeHarness);
    const epochPrompt = "Begin supervisor assignment epoch 1.\n\nInitial assignment.";
    handlers.get("input")?.({ text: epochPrompt, source: "interactive" }, bridgeContext);
    handlers.get("before_agent_start")?.({ prompt: epochPrompt }, bridgeContext);
    const report = tools.find((tool) => tool.name === "supervisor_submit_report")!;
    yield* step(() =>
      report.execute("report-1", {
        delivery_id: "explicit-report-1",
        report: "Explicit report.",
      }),
    );

    handlers.get("input")?.(
      { text: epochPrompt, source: "interactive", streamingBehavior: "steer" },
      bridgeContext,
    );
    handlers.get("before_agent_start")?.({ prompt: epochPrompt }, bridgeContext);
    handlers.get("agent_end")?.(
      { messages: [assistantMessage("Duplicate final text.")] },
      bridgeContext,
    );
    yield* settle(() => handlers.get("agent_settled")?.({}, bridgeContext));

    expect(bridgeCalls).toEqual([
      {
        name: "supervisor_submit_report",
        input: { delivery_id: "explicit-report-1", report: "Explicit report." },
      },
    ]);
  });

  effectTest("uses a fresh fallback identity for each retained Pi assignment", function* () {
    const { handlers } = yield* step(startBridgeHarness);
    for (const report of ["First report.", "Second report."]) {
      handlers.get("before_agent_start")?.({}, bridgeContext);
      handlers.get("agent_end")?.({ messages: [assistantMessage(report)] }, bridgeContext);
      yield* settle(() => handlers.get("agent_settled")?.({}, bridgeContext));
    }

    expect(bridgeCalls).toEqual([
      {
        name: "supervisor_submit_report",
        input: { delivery_id: "pi-final-1", report: "First report." },
      },
      {
        name: "supervisor_submit_report",
        input: { delivery_id: "pi-final-2", report: "Second report." },
      },
    ]);
  });

  effectTest("does not retry an uncertain explicit report after an interrupted turn", function* () {
    const { handlers, tools } = yield* step(startBridgeHarness);
    handlers.get("before_agent_start")?.(
      { prompt: "Begin supervisor assignment epoch 1." },
      bridgeContext,
    );
    reportFailuresRemaining = 1;
    const report = tools.find((tool) => tool.name === "supervisor_submit_report")!;
    yield* step(() =>
      expect(
        report.execute("report-uncertain", {
          delivery_id: "interrupted-report",
          report: "Do not retry after interruption.",
        }),
      ).rejects.toThrow("uncertain"),
    );
    handlers.get("agent_end")?.(
      { messages: [assistantMessage("Partial report.", "aborted")] },
      bridgeContext,
    );
    yield* settle(() => handlers.get("agent_settled")?.({}, bridgeContext));

    expect(bridgeCalls).toEqual([
      {
        name: "supervisor_submit_report",
        input: {
          delivery_id: "interrupted-report",
          report: "Do not retry after interruption.",
        },
      },
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
      const { handlers, tools } = bridgeHarness(blockedOpen);
      const starting = Promise.resolve(
        handlers.get("session_start")?.(
          {},
          extensionContextFixture({ cwd: "/project", isProjectTrusted: () => false, hasUI: false }),
        ),
      );
      yield* step(() => Effect.runPromise(Deferred.await(acquired)));

      yield* settle(() => handlers.get("session_shutdown")?.({}, bridgeContext));
      yield* step(() => starting);

      expect(release).toHaveBeenCalledOnce();
      expect(tools).toEqual([]);
    },
  );

  effectTest(
    "interrupts and joins an active bridge call before releasing the helper on shutdown",
    function* () {
      const callStarted = Deferred.makeUnsafe<void>();
      const blocked = Deferred.makeUnsafe<void>();
      const callInterrupted = vi.fn();
      const helperReleased = vi.fn();
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
          () => Effect.sync(helperReleased),
        );
      const { handlers, tools } = bridgeHarness(activeOpen);
      yield* settle(() =>
        handlers.get("session_start")?.(
          {},
          extensionContextFixture({ cwd: "/project", isProjectTrusted: () => false, hasUI: false }),
        ),
      );
      const progress = tools.find((tool) => tool.name === "supervisor_progress")!;
      const activeCall = progress.execute("progress-active", { message: "Still working" }).then(
        () => "accepted" as const,
        () => "interrupted" as const,
      );
      yield* step(() => Effect.runPromise(Deferred.await(callStarted)));

      yield* settle(() => handlers.get("session_shutdown")?.({}, bridgeContext));
      expect(yield* step(() => activeCall)).toBe("interrupted");
      expect(callInterrupted).toHaveBeenCalledOnce();
      expect(helperReleased).toHaveBeenCalledOnce();
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
    handlers.get("agent_end")?.(
      { messages: [assistantMessage("Partial report.", "aborted")] },
      bridgeContext,
    );
    yield* settle(() => handlers.get("agent_settled")?.({}, bridgeContext));
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
