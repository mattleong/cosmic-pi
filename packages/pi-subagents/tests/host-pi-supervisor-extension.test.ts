// Promise-shaped Pi host boundary test.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/processEnv:off
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import type { ExtensionHandler, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import registerBridge from "../src/boundary/host-pi-supervisor-extension.ts";
import type {
  SupervisorToolArgumentsByName,
  SupervisorToolName,
} from "../src/boundary/pi-supervisor-bridge-client.ts";
import { extensionApiFixture, extensionContextFixture, modelFixture } from "./fixtures/pi-host.ts";

type BridgeCall = {
  readonly [Name in SupervisorToolName]: {
    readonly name: Name;
    readonly input: SupervisorToolArgumentsByName[Name];
  };
}[SupervisorToolName];

const bridgeCalls: BridgeCall[] = [];
let reportFailuresRemaining = 0;
const close = vi.fn();
const openBridge = vi.fn(
  (_: string) =>
    Effect.succeed({
      call: async <Name extends SupervisorToolName>(
        name: Name,
        input: SupervisorToolArgumentsByName[Name],
      ) => {
        // SAFETY: The generic name/input pair is correlated by SupervisorToolArgumentsByName.
        bridgeCalls.push({ name, input } as BridgeCall);
        if (name === "supervisor_submit_report" && reportFailuresRemaining > 0) {
          reportFailuresRemaining -= 1;
          throw new Error("uncertain report delivery");
        }
        return "accepted";
      },
      close,
    }) satisfies Effect.Effect<unknown, never, Scope.Scope>,
);

afterEach(() => {
  bridgeCalls.length = 0;
  reportFailuresRemaining = 0;
  close.mockClear();
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

const startBridgeHarness = async () => {
  const handlers = new Map<string, BridgeEventHandler>();
  const tools: BridgeTool[] = [];
  let active = ["read"];
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
  registerBridge(pi, { openBridge });
  await handlers.get("session_start")?.(
    {},
    extensionContextFixture({ cwd: "/project", isProjectTrusted: () => false, hasUI: false }),
  );
  return { handlers, tools };
};

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

  it("deletes ephemeral provider credentials before a config-validation return", async () => {
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
    await handlers.get("session_start")?.({}, extensionContextFixture({ hasUI: false }));
    expect(process.env.PI_SUBAGENT_RUNTIME_API_KEY).toBeUndefined();
    expect(process.env.PI_SUBAGENT_RUNTIME_API_PROVIDER).toBeUndefined();
    expect(pi.registerProvider).not.toHaveBeenCalled();
  });

  it("promotes a settled final Pi response through the supervisor report channel", async () => {
    const { handlers } = await startBridgeHarness();
    handlers.get("before_agent_start")?.({}, bridgeContext);
    handlers.get("agent_end")?.(
      { messages: [assistantMessage("Complete review report.")] },
      bridgeContext,
    );
    expect(bridgeCalls).toEqual([]);

    await handlers.get("agent_settled")?.({}, bridgeContext);

    expect(bridgeCalls).toEqual([
      {
        name: "supervisor_submit_report",
        input: { delivery_id: "pi-final-1", report: "Complete review report." },
      },
    ]);
  });

  it("does not duplicate an explicitly accepted report at agent settlement", async () => {
    const { handlers, tools } = await startBridgeHarness();
    handlers.get("before_agent_start")?.({}, bridgeContext);
    const report = tools.find((tool) => tool.name === "supervisor_submit_report")!;
    await report.execute("report-1", {
      delivery_id: "explicit-report-1",
      report: "Explicit report.",
    });
    handlers.get("agent_end")?.(
      { messages: [assistantMessage("Native final text.")] },
      bridgeContext,
    );
    await handlers.get("agent_settled")?.({}, bridgeContext);

    expect(bridgeCalls).toEqual([
      {
        name: "supervisor_submit_report",
        input: { delivery_id: "explicit-report-1", report: "Explicit report." },
      },
    ]);
  });

  it("retries an uncertain explicit report with the same delivery identity", async () => {
    const { handlers, tools } = await startBridgeHarness();
    handlers.get("before_agent_start")?.({}, bridgeContext);
    reportFailuresRemaining = 1;
    const report = tools.find((tool) => tool.name === "supervisor_submit_report")!;
    await expect(
      report.execute("report-uncertain", {
        delivery_id: "stable-explicit-report",
        report: "Explicit report with uncertain delivery.",
      }),
    ).rejects.toThrow("uncertain");
    handlers.get("agent_end")?.(
      { messages: [assistantMessage("Native final text.")] },
      bridgeContext,
    );
    await handlers.get("agent_settled")?.({}, bridgeContext);

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

  it("locks an uncertain explicit report identity against conflicting retries", async () => {
    const { handlers, tools } = await startBridgeHarness();
    handlers.get("before_agent_start")?.(
      { prompt: "Begin supervisor assignment epoch 1." },
      bridgeContext,
    );
    reportFailuresRemaining = 1;
    const report = tools.find((tool) => tool.name === "supervisor_submit_report")!;
    await expect(
      report.execute("report-uncertain", {
        delivery_id: "stable-explicit-report",
        report: "Explicit report with uncertain delivery.",
      }),
    ).rejects.toThrow("uncertain");
    await expect(
      report.execute("report-conflict", {
        delivery_id: "conflicting-report",
        report: "Conflicting report.",
      }),
    ).rejects.toThrow("different supervisor report identity");
    handlers.get("agent_end")?.(
      { messages: [assistantMessage("Native final text.")] },
      bridgeContext,
    );
    await handlers.get("agent_settled")?.({}, bridgeContext);

    expect(bridgeCalls).toHaveLength(2);
    expect(bridgeCalls[1]).toEqual(bridgeCalls[0]);
  });

  it("resets retained assignment state when an epoch is steered into the active Pi loop", async () => {
    const { handlers, tools } = await startBridgeHarness();
    handlers.get("before_agent_start")?.(
      { prompt: "Begin supervisor assignment epoch 1." },
      bridgeContext,
    );
    const report = tools.find((tool) => tool.name === "supervisor_submit_report")!;
    await report.execute("report-1", {
      delivery_id: "explicit-report-1",
      report: "First report.",
    });

    handlers.get("input")?.(
      {
        text: "Begin supervisor assignment epoch 2.\n\nRetained follow-up.",
        source: "interactive",
        streamingBehavior: "steer",
      },
      bridgeContext,
    );
    handlers.get("agent_end")?.({ messages: [assistantMessage("Second report.")] }, bridgeContext);
    await handlers.get("agent_settled")?.({}, bridgeContext);

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
  });

  it("treats same-epoch input and agent-start events as idempotent", async () => {
    const { handlers, tools } = await startBridgeHarness();
    const epochPrompt = "Begin supervisor assignment epoch 1.\n\nInitial assignment.";
    handlers.get("input")?.({ text: epochPrompt, source: "interactive" }, bridgeContext);
    handlers.get("before_agent_start")?.({ prompt: epochPrompt }, bridgeContext);
    const report = tools.find((tool) => tool.name === "supervisor_submit_report")!;
    await report.execute("report-1", {
      delivery_id: "explicit-report-1",
      report: "Explicit report.",
    });

    handlers.get("input")?.(
      { text: epochPrompt, source: "interactive", streamingBehavior: "steer" },
      bridgeContext,
    );
    handlers.get("before_agent_start")?.({ prompt: epochPrompt }, bridgeContext);
    handlers.get("agent_end")?.(
      { messages: [assistantMessage("Duplicate final text.")] },
      bridgeContext,
    );
    await handlers.get("agent_settled")?.({}, bridgeContext);

    expect(bridgeCalls).toEqual([
      {
        name: "supervisor_submit_report",
        input: { delivery_id: "explicit-report-1", report: "Explicit report." },
      },
    ]);
  });

  it("uses a fresh fallback identity for each retained Pi assignment", async () => {
    const { handlers } = await startBridgeHarness();
    for (const report of ["First report.", "Second report."]) {
      handlers.get("before_agent_start")?.({}, bridgeContext);
      handlers.get("agent_end")?.({ messages: [assistantMessage(report)] }, bridgeContext);
      await handlers.get("agent_settled")?.({}, bridgeContext);
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

  it("does not retry an uncertain explicit report after an interrupted turn", async () => {
    const { handlers, tools } = await startBridgeHarness();
    handlers.get("before_agent_start")?.(
      { prompt: "Begin supervisor assignment epoch 1." },
      bridgeContext,
    );
    reportFailuresRemaining = 1;
    const report = tools.find((tool) => tool.name === "supervisor_submit_report")!;
    await expect(
      report.execute("report-uncertain", {
        delivery_id: "interrupted-report",
        report: "Do not retry after interruption.",
      }),
    ).rejects.toThrow("uncertain");
    handlers.get("agent_end")?.(
      { messages: [assistantMessage("Partial report.", "aborted")] },
      bridgeContext,
    );
    await handlers.get("agent_settled")?.({}, bridgeContext);

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

  it("does not auto-report an interrupted turn or after session shutdown", async () => {
    const { handlers } = await startBridgeHarness();
    handlers.get("before_agent_start")?.({}, bridgeContext);
    handlers.get("agent_end")?.(
      { messages: [assistantMessage("Partial report.", "aborted")] },
      bridgeContext,
    );
    await handlers.get("agent_settled")?.({}, bridgeContext);
    expect(bridgeCalls).toEqual([]);

    handlers.get("before_agent_start")?.({}, bridgeContext);
    handlers.get("agent_end")?.(
      { messages: [assistantMessage("Late complete report.")] },
      bridgeContext,
    );
    handlers.get("session_shutdown")?.({}, bridgeContext);
    await handlers.get("agent_settled")?.({}, bridgeContext);

    expect(bridgeCalls).toEqual([]);
    expect(close).toHaveBeenCalledOnce();
  });
});
