// Promise assertions are test-runner boundaries.
// @effect-diagnostics effect/asyncFunction:off
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
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
    update: undefined,
    ctx: ExtensionContext,
  ) => Promise<{
    readonly content: ReadonlyArray<{ readonly type: string; readonly text: string }>;
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
  it("uses fresh/background defaults, inherits model effort, and strips recursive tools", async () => {
    let request: StartSubagentRequest | undefined;
    const service: SubagentServiceShape = {
      start: (input) => Effect.sync(() => ((request = input), view())),
      waitForForeground: () => Effect.succeed(view()),
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
      getActiveTools: () => ["read", "edit", "subagent", "subagent_wait", "workflow"],
    } as unknown as ExtensionAPI;
    registerSubagentTool(pi, {
      run: (effect) =>
        Effect.runPromise(effect.pipe(Effect.provideService(SubagentService, service))),
    });

    const result = await tool?.execute(
      "call",
      { action: "start", task: "Review auth", writeIntent: "read-only" },
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
      execution: "background",
      context: "fresh",
      model: "openai-codex/gpt-5.6-sol",
      effort: "high",
      writeIntent: "read-only",
      parentLeafId: "user-1",
      activeTools: ["read", "edit"],
    });
  });

  it("returns structured activity and one final report without raw transcript duplication", async () => {
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
    expect(text).toContain("Activity:\n✓ read  README.md");
    expect(text).toContain("Final report:\nViewport report.");
    expect(text).not.toContain("Recent transcript");
    expect(text.match(/Viewport report\./g)).toHaveLength(1);
  });

  it("requires write intent and lists authenticated models without a runtime", async () => {
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
      tool?.execute("call", { action: "start", task: "Do work" }, undefined, undefined, context),
    ).rejects.toThrow("writeIntent");
  });
});
