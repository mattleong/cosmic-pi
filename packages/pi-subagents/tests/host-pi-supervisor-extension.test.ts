// Promise-shaped Pi host boundary test.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/processEnv:off
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SupervisorToolArgumentsByName,
  SupervisorToolName,
} from "../src/boundary/pi-supervisor-bridge-client.ts";

type BridgeCall = {
  readonly [Name in SupervisorToolName]: {
    readonly name: Name;
    readonly input: SupervisorToolArgumentsByName[Name];
  };
}[SupervisorToolName];

const bridgeCalls: BridgeCall[] = [];
let reportFailuresRemaining = 0;
const close = vi.fn();
vi.mock("../src/boundary/pi-supervisor-bridge-client.ts", () => ({
  openPiSupervisorBridge: vi.fn(async () => ({
    call: async <Name extends SupervisorToolName>(
      name: Name,
      input: SupervisorToolArgumentsByName[Name],
    ) => {
      bridgeCalls.push({ name, input } as BridgeCall);
      if (name === "supervisor_submit_report" && reportFailuresRemaining > 0) {
        reportFailuresRemaining -= 1;
        throw new Error("uncertain report delivery");
      }
      return "accepted";
    },
    close,
  })),
}));

import registerBridge from "../src/boundary/host-pi-supervisor-extension.ts";

afterEach(() => {
  bridgeCalls.length = 0;
  reportFailuresRemaining = 0;
  close.mockClear();
  vi.unstubAllEnvs();
});

type BridgeEventHandler = (...args: unknown[]) => unknown;
type BridgeTool = {
  readonly name: string;
  readonly execute: (
    id: string,
    input: unknown,
    signal?: AbortSignal,
  ) => Promise<{ readonly content: ReadonlyArray<{ readonly text: string }> }>;
};

const startBridgeHarness = async () => {
  const handlers = new Map<string, BridgeEventHandler>();
  const tools: BridgeTool[] = [];
  let active = ["read"];
  const pi = {
    registerFlag: vi.fn(),
    getFlag: vi.fn((name: string) =>
      name === "pi-subagents-supervisor-config" ? "/private/supervisor/connection.json" : undefined,
    ),
    on: vi.fn((name: string, handler: BridgeEventHandler) => handlers.set(name, handler)),
    registerTool: vi.fn((tool: BridgeTool) => tools.push(tool)),
    getActiveTools: vi.fn(() => active),
    setActiveTools: vi.fn((next: string[]) => void (active = next)),
    registerProvider: vi.fn(),
  } as unknown as ExtensionAPI;
  registerBridge(pi);
  await handlers.get("session_start")?.(
    {},
    { cwd: "/project", isProjectTrusted: () => false, hasUI: false },
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
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const pi = {
      registerFlag: vi.fn(),
      getFlag: vi.fn((name: string) => name === "pi-subagents-fast-mode"),
      on: vi.fn((name: string, handler: (...args: unknown[]) => unknown) =>
        handlers.set(name, handler),
      ),
    } as unknown as ExtensionAPI;
    registerBridge(pi);
    expect(
      handlers.get("before_provider_request")?.(
        { payload: { input: "task" } },
        { model: { provider: "openai-codex", id: "gpt-5.6-sol" } },
      ),
    ).toEqual({ input: "task", service_tier: "priority" });
  });

  it("deletes ephemeral provider credentials before a config-validation return", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const pi = {
      registerFlag: vi.fn(),
      getFlag: vi.fn(() => undefined),
      on: vi.fn((name: string, handler: (...args: unknown[]) => unknown) =>
        handlers.set(name, handler),
      ),
      registerProvider: vi.fn(),
    } as unknown as ExtensionAPI;
    vi.stubEnv("PI_SUBAGENT_RUNTIME_API_KEY", "must-be-deleted");
    vi.stubEnv("PI_SUBAGENT_RUNTIME_API_PROVIDER", "openai-codex");
    registerBridge(pi);
    await handlers.get("session_start")?.({}, { hasUI: false });
    expect(process.env.PI_SUBAGENT_RUNTIME_API_KEY).toBeUndefined();
    expect(process.env.PI_SUBAGENT_RUNTIME_API_PROVIDER).toBeUndefined();
    expect(pi.registerProvider).not.toHaveBeenCalled();
  });

  it("registers only four cooperative supervisor tools with strict inputs", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const tools: Array<{
      readonly name: string;
      readonly execute: (
        id: string,
        input: unknown,
        signal?: AbortSignal,
      ) => Promise<{ readonly content: ReadonlyArray<{ readonly text: string }> }>;
      readonly renderCall?: unknown;
    }> = [];
    let active = ["read", "subagent_start", "herdr_agent_start", "contact_parent"];
    const registeredProviders: Array<readonly [string, unknown]> = [];
    const pi = {
      registerFlag: vi.fn(),
      getFlag: vi.fn(() => "/private/supervisor/connection.json"),
      on: vi.fn((name: string, handler: (...args: unknown[]) => unknown) =>
        handlers.set(name, handler),
      ),
      registerTool: vi.fn((tool: (typeof tools)[number]) => tools.push(tool)),
      getActiveTools: vi.fn(() => active),
      setActiveTools: vi.fn((next: string[]) => void (active = next)),
      registerProvider: vi.fn(
        (name: string, options: unknown) => void registeredProviders.push([name, options]),
      ),
    } as unknown as ExtensionAPI;
    vi.stubEnv("PI_SUBAGENT_RUNTIME_API_KEY", "private-runtime-key");
    vi.stubEnv("PI_SUBAGENT_RUNTIME_API_PROVIDER", "openai-codex");

    registerBridge(pi);
    const start = handlers.get("session_start");
    expect(start).toBeDefined();
    await start?.(
      {},
      {
        cwd: "/project",
        isProjectTrusted: () => false,
        hasUI: false,
      },
    );

    expect(tools.map((tool) => tool.name)).toEqual([
      "supervisor_progress",
      "supervisor_warning",
      "supervisor_question",
      "supervisor_submit_report",
    ]);
    expect(tools.every((tool) => typeof tool.renderCall === "function")).toBe(true);
    expect(active).toContain("read");
    expect(active).not.toContain("subagent_start");
    expect(active).not.toContain("herdr_agent_start");
    expect(active).not.toContain("contact_parent");
    expect(registeredProviders).toEqual([["openai-codex", { apiKey: "private-runtime-key" }]]);
    expect(process.env.PI_SUBAGENT_RUNTIME_API_KEY).toBeUndefined();

    const result = await tools[0]?.execute("call-1", { message: "progress" });
    expect(result?.content[0]?.text).toBe("accepted");
    expect(bridgeCalls).toEqual([{ name: "supervisor_progress", input: { message: "progress" } }]);
    await expect(tools[0]?.execute("call-2", { message: "progress", extra: true })).rejects.toThrow(
      "malformed",
    );

    handlers.get("session_shutdown")?.();
    expect(close).toHaveBeenCalledOnce();
  });

  it("promotes a settled final Pi response through the supervisor report channel", async () => {
    const { handlers } = await startBridgeHarness();
    handlers.get("before_agent_start")?.({}, {});
    handlers.get("agent_end")?.({ messages: [assistantMessage("Complete review report.")] }, {});
    expect(bridgeCalls).toEqual([]);

    await handlers.get("agent_settled")?.({}, {});

    expect(bridgeCalls).toEqual([
      {
        name: "supervisor_submit_report",
        input: { delivery_id: "pi-final-1", report: "Complete review report." },
      },
    ]);
  });

  it("does not duplicate an explicitly accepted report at agent settlement", async () => {
    const { handlers, tools } = await startBridgeHarness();
    handlers.get("before_agent_start")?.({}, {});
    const report = tools.find((tool) => tool.name === "supervisor_submit_report")!;
    await report.execute("report-1", {
      delivery_id: "explicit-report-1",
      report: "Explicit report.",
    });
    handlers.get("agent_end")?.({ messages: [assistantMessage("Native final text.")] }, {});
    await handlers.get("agent_settled")?.({}, {});

    expect(bridgeCalls).toEqual([
      {
        name: "supervisor_submit_report",
        input: { delivery_id: "explicit-report-1", report: "Explicit report." },
      },
    ]);
  });

  it("retries an uncertain explicit report with the same delivery identity", async () => {
    const { handlers, tools } = await startBridgeHarness();
    handlers.get("before_agent_start")?.({}, {});
    reportFailuresRemaining = 1;
    const report = tools.find((tool) => tool.name === "supervisor_submit_report")!;
    await expect(
      report.execute("report-uncertain", {
        delivery_id: "stable-explicit-report",
        report: "Explicit report with uncertain delivery.",
      }),
    ).rejects.toThrow("uncertain");
    handlers.get("agent_end")?.({ messages: [assistantMessage("Native final text.")] }, {});
    await handlers.get("agent_settled")?.({}, {});

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
    handlers.get("before_agent_start")?.({ prompt: "Begin supervisor assignment epoch 1." }, {});
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
    handlers.get("agent_end")?.({ messages: [assistantMessage("Native final text.")] }, {});
    await handlers.get("agent_settled")?.({}, {});

    expect(bridgeCalls).toHaveLength(2);
    expect(bridgeCalls[1]).toEqual(bridgeCalls[0]);
  });

  it("resets retained assignment state when an epoch is steered into the active Pi loop", async () => {
    const { handlers, tools } = await startBridgeHarness();
    handlers.get("before_agent_start")?.({ prompt: "Begin supervisor assignment epoch 1." }, {});
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
      {},
    );
    handlers.get("agent_end")?.({ messages: [assistantMessage("Second report.")] }, {});
    await handlers.get("agent_settled")?.({}, {});

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
    handlers.get("input")?.({ text: epochPrompt, source: "interactive" }, {});
    handlers.get("before_agent_start")?.({ prompt: epochPrompt }, {});
    const report = tools.find((tool) => tool.name === "supervisor_submit_report")!;
    await report.execute("report-1", {
      delivery_id: "explicit-report-1",
      report: "Explicit report.",
    });

    handlers.get("input")?.(
      { text: epochPrompt, source: "interactive", streamingBehavior: "steer" },
      {},
    );
    handlers.get("before_agent_start")?.({ prompt: epochPrompt }, {});
    handlers.get("agent_end")?.({ messages: [assistantMessage("Duplicate final text.")] }, {});
    await handlers.get("agent_settled")?.({}, {});

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
      handlers.get("before_agent_start")?.({}, {});
      handlers.get("agent_end")?.({ messages: [assistantMessage(report)] }, {});
      await handlers.get("agent_settled")?.({}, {});
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
    handlers.get("before_agent_start")?.({ prompt: "Begin supervisor assignment epoch 1." }, {});
    reportFailuresRemaining = 1;
    const report = tools.find((tool) => tool.name === "supervisor_submit_report")!;
    await expect(
      report.execute("report-uncertain", {
        delivery_id: "interrupted-report",
        report: "Do not retry after interruption.",
      }),
    ).rejects.toThrow("uncertain");
    handlers.get("agent_end")?.({ messages: [assistantMessage("Partial report.", "aborted")] }, {});
    await handlers.get("agent_settled")?.({}, {});

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
    handlers.get("before_agent_start")?.({}, {});
    handlers.get("agent_end")?.({ messages: [assistantMessage("Partial report.", "aborted")] }, {});
    await handlers.get("agent_settled")?.({}, {});
    expect(bridgeCalls).toEqual([]);

    handlers.get("before_agent_start")?.({}, {});
    handlers.get("agent_end")?.({ messages: [assistantMessage("Late complete report.")] }, {});
    handlers.get("session_shutdown")?.({}, {});
    await handlers.get("agent_settled")?.({}, {});

    expect(bridgeCalls).toEqual([]);
    expect(close).toHaveBeenCalledOnce();
  });
});
