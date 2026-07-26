// Promise assertions are test-runner boundaries.
// @effect-diagnostics effect/asyncFunction:off
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { piToolsForWriteIntent } from "../src/run/coordination.ts";
import type { StartSubagentRequest, SubagentRunView } from "../src/run/model.ts";
import { SubagentService, type SubagentServiceShape } from "../src/run/service.ts";
import { registerSubagentTool, type SubagentToolInput } from "../src/tools/subagent.ts";

interface CapturedTool {
  readonly name: string;
  readonly renderShell?: "default" | "self";
  readonly renderCall?: (...args: ReadonlyArray<unknown>) => unknown;
  readonly renderResult?: (...args: ReadonlyArray<unknown>) => unknown;
  readonly promptGuidelines?: ReadonlyArray<string>;
  readonly execute: (
    id: string,
    input: SubagentToolInput,
    signal: AbortSignal | undefined,
    update:
      | ((result: {
          readonly content: ReadonlyArray<{ readonly type: string; readonly text: string }>;
          readonly details?: unknown;
        }) => void)
      | undefined,
    ctx: ExtensionContext,
  ) => Promise<{
    readonly content: ReadonlyArray<{ readonly type: string; readonly text: string }>;
    readonly details?: unknown;
  }>;
}

const view = (overrides: Partial<SubagentRunView> = {}): SubagentRunView => ({
  id: "agent-1",
  name: "auth-review",
  task: "Review auth",
  cwd: "/project",
  state: "running",
  execution: "background",
  context: "fresh",
  writeIntent: "read-only",
  backend: "pi",
  capabilities: [
    "steer",
    "interrupt",
    "resume",
    "rename-display",
    "parent-contact",
    "peer-notice",
    "native-fork",
  ],
  model: "openai-codex/gpt-5.6-sol",
  effort: "high",
  startedAt: 1,
  lastActivityAt: 1,
  transcript: [],
  sessionEvents: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
  ...overrides,
});

const context = {
  cwd: "/project",
  model: {
    provider: "openai-codex",
    id: "gpt-5.6-sol",
    name: "GPT 5.6 Sol",
    reasoning: true,
  },
  modelRegistry: {
    find: () => ({
      provider: "openai-codex",
      id: "gpt-5.6-sol",
      name: "GPT 5.6 Sol",
      reasoning: true,
    }),
    hasConfiguredAuth: () => true,
    getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
    getApiKeyAndHeaders: () => Promise.resolve({ ok: true, apiKey: "stored-key" }),
    getAvailable: () => [
      {
        provider: "openai-codex",
        id: "gpt-5.6-sol",
        name: "GPT 5.6 Sol",
        reasoning: true,
      },
    ],
  },
  sessionManager: {
    getSessionFile: () => "/sessions/parent.jsonl",
    getSessionId: () => "parent-session",
    getLeafEntry: () => ({
      type: "message",
      id: "assistant-1",
      parentId: "user-1",
      message: { role: "assistant" },
    }),
  },
  isProjectTrusted: () => true,
} as unknown as ExtensionContext;

describe("subagent tool", () => {
  it("enforces the Pi read-only tool policy", () => {
    const tools = ["read", "grep", "edit", "write", "bash", "mcp"];
    expect(piToolsForWriteIntent(tools, "read-only")).toEqual(["read", "grep"]);
    expect(piToolsForWriteIntent(tools, "writer")).toEqual(tools);
  });

  it("uses fresh/background defaults, inherits model effort, and strips recursive tools", async () => {
    let request: StartSubagentRequest | undefined;
    const service: SubagentServiceShape = {
      start: (input) => Effect.sync(() => ((request = input), view())),
      waitForForeground: () => Effect.succeed(view()),
      awaitTerminal: () => Effect.succeed([view()]),
      list: Effect.succeed([]),
      status: () => Effect.succeed(view()),
      send: () => Effect.succeed(view()),
      reply: () => Effect.succeed(view()),
      interrupt: () => Effect.succeed(view()),
      resume: () => Effect.succeed(view()),
      rename: () => Effect.succeed(view()),
      stop: () => Effect.succeed(view()),
      projection: Effect.succeed({ revision: 0, runs: [] }),
    };
    let tool: CapturedTool | undefined;
    const pi = {
      registerTool: (definition: unknown) => {
        tool = definition as CapturedTool;
      },
      getThinkingLevel: () => "high",
      getActiveTools: () => [
        "read",
        "grep",
        "edit",
        "write",
        "bash",
        "mcp",
        "subagent",
        "subagent_wait",
        "workflow",
      ],
    } as unknown as ExtensionAPI;
    registerSubagentTool(pi, {
      run: (effect) =>
        Effect.runPromise(effect.pipe(Effect.provideService(SubagentService, service))),
    });

    const result = await tool?.execute(
      "call",
      { action: "start", backend: "pi", task: "Review auth", writeIntent: "read-only" },
      undefined,
      undefined,
      context,
    );

    expect(tool?.name).toBe("subagent");
    expect(tool?.renderShell).toBe("default");
    expect(tool?.renderCall).toBeTypeOf("function");
    expect(tool?.renderResult).toBeTypeOf("function");
    expect(tool?.promptGuidelines?.join(" ")).toContain("one writer");
    expect(result?.content[0]?.text).toContain("agent-1");
    expect(request).toMatchObject({
      backend: "pi",
      execution: "background",
      context: "fresh",
      model: "openai-codex/gpt-5.6-sol",
      effort: "high",
      writeIntent: "read-only",
      parentLeafId: "user-1",
      activeTools: ["read", "grep"],
    });
  });

  it("resolves Claude aliases without Pi model-registry authentication", async () => {
    let request: StartSubagentRequest | undefined;
    const service = {
      start: (input: StartSubagentRequest) =>
        Effect.sync(
          () => (
            (request = input),
            view({
              backend: "claude-cli",
              capabilities: ["resume", "rename-display"],
              model: input.model,
            })
          ),
        ),
      waitForForeground: () => Effect.succeed(view()),
      awaitTerminal: () => Effect.succeed([view()]),
      list: Effect.succeed([]),
      status: () => Effect.succeed(view()),
      send: () => Effect.succeed(view()),
      reply: () => Effect.succeed(view()),
      interrupt: () => Effect.succeed(view()),
      resume: () => Effect.succeed(view()),
      rename: () => Effect.succeed(view()),
      stop: () => Effect.succeed(view()),
      projection: Effect.succeed({ revision: 0, runs: [] }),
    } satisfies SubagentServiceShape;
    let tool: CapturedTool | undefined;
    const pi = {
      registerTool: (definition: unknown) => {
        tool = definition as CapturedTool;
      },
      getThinkingLevel: () => "high",
      getActiveTools: () => ["read", "edit"],
    } as unknown as ExtensionAPI;
    registerSubagentTool(pi, {
      run: (effect) =>
        Effect.runPromise(effect.pipe(Effect.provideService(SubagentService, service))),
    });

    const result = await tool?.execute(
      "call",
      {
        action: "start",
        backend: "claude-cli",
        model: "opus",
        task: "Review auth",
        writeIntent: "read-only",
      },
      undefined,
      undefined,
      context,
    );

    expect(request).toMatchObject({
      backend: "claude-cli",
      model: "opus",
      context: "fresh",
      activeTools: [],
    });
    expect(result?.content[0]?.text).toContain("claude-cli/opus");
  });

  it("transfers runtime-only authentication without exposing it in the model id", async () => {
    let request: StartSubagentRequest | undefined;
    const service = {
      start: (input: StartSubagentRequest) => Effect.sync(() => ((request = input), view())),
      waitForForeground: () => Effect.succeed(view()),
      awaitTerminal: () => Effect.succeed([view()]),
      list: Effect.succeed([]),
      status: () => Effect.succeed(view()),
      send: () => Effect.succeed(view()),
      reply: () => Effect.succeed(view()),
      interrupt: () => Effect.succeed(view()),
      resume: () => Effect.succeed(view()),
      rename: () => Effect.succeed(view()),
      stop: () => Effect.succeed(view()),
      projection: Effect.succeed({ revision: 0, runs: [] }),
    } satisfies SubagentServiceShape;
    let tool: CapturedTool | undefined;
    const pi = {
      registerTool: (definition: unknown) => {
        tool = definition as CapturedTool;
      },
      getThinkingLevel: () => "high",
      getActiveTools: () => ["read"],
    } as unknown as ExtensionAPI;
    registerSubagentTool(pi, {
      run: (effect) =>
        Effect.runPromise(effect.pipe(Effect.provideService(SubagentService, service))),
    });
    const runtimeContext = {
      ...context,
      modelRegistry: {
        ...context.modelRegistry,
        getProviderAuthStatus: () => ({ configured: true, source: "runtime" }),
        getApiKeyAndHeaders: () => Promise.resolve({ ok: true as const, apiKey: "runtime-key" }),
      },
    } as unknown as ExtensionContext;

    await tool?.execute(
      "call",
      {
        action: "start",
        backend: "pi",
        task: "Review auth",
        writeIntent: "read-only",
      },
      undefined,
      undefined,
      runtimeContext,
    );

    expect(request?.runtimeApiKey).toBe("runtime-key");
    expect(request?.model).toBe("openai-codex/gpt-5.6-sol");
  });

  it("returns formatted status metadata and one final report without activity duplication", async () => {
    const completed = view({
      state: "completed",
      endedAt: 2,
      finalText: "Viewport report.",
      transcript: ["Viewport report."],
      sessionEvents: [
        {
          type: "tool",
          toolCallId: "tool-1",
          toolName: "read",
          target: "README.md",
          state: "completed",
          startedAt: 1,
          endedAt: 2,
        },
        { type: "assistant", text: "Viewport report.", createdAt: 2 },
      ],
    });
    const service: SubagentServiceShape = {
      start: () => Effect.succeed(completed),
      waitForForeground: () => Effect.succeed(completed),
      awaitTerminal: () => Effect.succeed([completed]),
      list: Effect.succeed([completed]),
      status: () => Effect.succeed(completed),
      send: () => Effect.succeed(completed),
      reply: () => Effect.succeed(completed),
      interrupt: () => Effect.succeed(completed),
      resume: () => Effect.succeed(completed),
      rename: () => Effect.succeed(completed),
      stop: () => Effect.succeed(completed),
      projection: Effect.succeed({ revision: 1, runs: [completed] }),
    };
    let tool: CapturedTool | undefined;
    const pi = {
      registerTool: (definition: unknown) => {
        tool = definition as CapturedTool;
      },
      getThinkingLevel: () => "high",
      getActiveTools: () => ["read"],
    } as unknown as ExtensionAPI;
    registerSubagentTool(pi, {
      run: (effect) =>
        Effect.runPromise(effect.pipe(Effect.provideService(SubagentService, service))),
    });

    const result = await tool?.execute(
      "call",
      { action: "status", runId: "agent-1" },
      undefined,
      undefined,
      context,
    );
    const text = result?.content[0]?.text ?? "";
    expect(text).toContain("Subagent status");
    expect(text).toContain("Name       auth-review");
    expect(text).toContain("ID         agent-1");
    expect(text).toContain("Model      pi/openai-codex/gpt-5.6-sol · high");
    expect(text).toContain("Final report\nViewport report.");
    expect(text).not.toContain("Activity:");
    expect(text.match(/Viewport report\./g)).toHaveLength(1);
    expect(result?.details).toEqual({ action: "status" });

    const listed = await tool?.execute("call", { action: "list" }, undefined, undefined, context);
    expect(listed?.details).toEqual({ action: "list" });
  });

  it("awaits a fleet in one live card and batches compact guidance acknowledgements", async () => {
    const completedOne = view({
      id: "agent-1",
      state: "completed",
      endedAt: 2,
      finalText: "First report.",
    });
    const completedTwo = view({
      id: "agent-2",
      name: "test-review",
      state: "completed",
      endedAt: 2,
      finalText: "Second report.",
    });
    const sent: string[] = [];
    const service: SubagentServiceShape = {
      start: () => Effect.succeed(view()),
      waitForForeground: () => Effect.succeed(view()),
      awaitTerminal: (_ids, _until, onUpdate) =>
        Effect.sync(() => {
          onUpdate?.([view(), view({ id: "agent-2", name: "test-review" })]);
          return [completedOne, completedTwo];
        }),
      list: Effect.succeed([]),
      status: (id) => Effect.succeed(id === "agent-1" ? completedOne : completedTwo),
      send: (id) => Effect.sync(() => (sent.push(id), id === "agent-1" ? view() : view({ id }))),
      reply: () => Effect.succeed(view()),
      interrupt: () => Effect.succeed(view()),
      resume: () => Effect.succeed(view()),
      rename: () => Effect.succeed(view()),
      stop: () => Effect.succeed(view()),
      projection: Effect.succeed({ revision: 0, runs: [] }),
    };
    let tool: CapturedTool | undefined;
    const pi = {
      registerTool: (definition: unknown) => {
        tool = definition as CapturedTool;
      },
      getThinkingLevel: () => "high",
      getActiveTools: () => ["read"],
    } as unknown as ExtensionAPI;
    registerSubagentTool(pi, {
      run: (effect) =>
        Effect.runPromise(effect.pipe(Effect.provideService(SubagentService, service))),
    });

    const updates: string[] = [];
    const awaited = await tool?.execute(
      "call",
      { action: "await", runIds: ["agent-1", "agent-2"] },
      undefined,
      (result) => updates.push(result.content[0]?.text ?? ""),
      context,
    );
    expect(updates).toEqual([
      "Awaiting subagents · 0/2 terminal · all_terminal\nagent-1 running · agent-2 running",
    ]);
    expect(awaited?.content[0]?.text).toContain("First report.");
    expect(awaited?.content[0]?.text).toContain("Second report.");
    expect(awaited?.details).toEqual({ action: "await" });

    const sentResult = await tool?.execute(
      "call",
      { action: "send", runIds: ["agent-1", "agent-2"], message: "Conclude now." },
      undefined,
      undefined,
      context,
    );
    expect([...sent].sort()).toEqual(["agent-1", "agent-2"]);
    expect(sentResult?.content[0]?.text).toBe(
      "Guidance delivered to 2 subagents: agent-1, agent-2.",
    );
    expect(sentResult?.content[0]?.text).not.toContain("Subagent status");
  });

  it("enforces the combined target count and aggregate detailed-output budget", async () => {
    const runs = Array.from({ length: 9 }, (_, index) =>
      view({
        id: `agent-${index + 1}`,
        name: `review-${index + 1}`,
        state: "completed",
        finalText: "x".repeat(32 * 1024),
      }),
    );
    const service: SubagentServiceShape = {
      start: () => Effect.succeed(runs[0]!),
      waitForForeground: () => Effect.succeed(runs[0]!),
      awaitTerminal: (ids) => Effect.succeed(ids.map((id) => runs.find((run) => run.id === id)!)),
      list: Effect.succeed(runs),
      status: (id) => Effect.succeed(runs.find((run) => run.id === id)!),
      send: () => Effect.succeed(runs[0]!),
      reply: () => Effect.succeed(runs[0]!),
      interrupt: () => Effect.succeed(runs[0]!),
      resume: () => Effect.succeed(runs[0]!),
      rename: () => Effect.succeed(runs[0]!),
      stop: () => Effect.succeed(runs[0]!),
      projection: Effect.succeed({ revision: 0, runs }),
    };
    let tool: CapturedTool | undefined;
    const pi = {
      registerTool: (definition: unknown) => {
        tool = definition as CapturedTool;
      },
      getThinkingLevel: () => "high",
      getActiveTools: () => ["read"],
    } as unknown as ExtensionAPI;
    registerSubagentTool(pi, {
      run: (effect) =>
        Effect.runPromise(effect.pipe(Effect.provideService(SubagentService, service))),
    });

    await expect(
      tool?.execute(
        "call",
        {
          action: "status",
          runId: "agent-1",
          runIds: runs.slice(1).map((run) => run.id),
        },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toThrow("at most 8 targets");

    const result = await tool?.execute(
      "call",
      { action: "status", runIds: runs.slice(0, 8).map((run) => run.id) },
      undefined,
      undefined,
      context,
    );
    const text = result?.content[0]?.text ?? "";
    expect(text.length).toBeLessThanOrEqual(48_000);
    for (const run of runs.slice(0, 8)) expect(text).toContain(run.id);
    expect(text).toContain("[run output truncated]");
  });

  it("requires write intent and backend and lists authenticated models without a runtime", async () => {
    let tool: CapturedTool | undefined;
    const pi = {
      registerTool: (definition: unknown) => {
        tool = definition as CapturedTool;
      },
      getThinkingLevel: () => "high",
      getActiveTools: () => ["read"],
    } as unknown as ExtensionAPI;
    registerSubagentTool(pi, {
      run: (effect) =>
        Effect.runPromise(
          effect.pipe(Effect.provideService(SubagentService, {} as SubagentServiceShape)),
        ),
    });

    const models = await tool?.execute(
      "call",
      { action: "models", query: "sol" },
      undefined,
      undefined,
      context,
    );
    expect(models?.content[0]?.text).toContain("openai-codex/gpt-5.6-sol");

    await expect(
      tool?.execute(
        "call",
        { action: "start", backend: "pi", task: "Do work" },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toThrow("writeIntent");

    await expect(
      tool?.execute(
        "call",
        { action: "start", task: "Do work", writeIntent: "read-only" },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toThrow("backend=pi or claude-cli");
  });
});
