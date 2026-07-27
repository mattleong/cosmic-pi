// Promise assertions are test-runner boundaries.
// @effect-diagnostics effect/asyncFunction:off
import {
  initTheme,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { piToolsForWriteIntent } from "../src/run/coordination.ts";
import { SubagentProcessError } from "../src/run/errors.ts";
import type { StartSubagentRequest, SubagentRunView } from "../src/run/model.ts";
import {
  SubagentService,
  type SubagentAwaitUntil,
  type SubagentServiceShape,
} from "../src/run/service.ts";
import { subagentServiceDouble } from "./subagent-service-double.ts";
import {
  awaitResultBanner,
  registerSubagentTools,
  renderAwaitProgressComponent,
  renderExpandedStartAwaitResult,
  renderStartAwaitOverviewComponent,
} from "../src/tools/subagent.ts";

interface CapturedTool {
  readonly name: string;
  readonly renderShell?: "default" | "self";
  readonly renderCall?: (...args: ReadonlyArray<unknown>) => unknown;
  readonly renderResult?: (...args: ReadonlyArray<unknown>) => unknown;
  readonly promptGuidelines?: ReadonlyArray<string>;
  readonly parameters?: unknown;
  readonly execute: (
    id: string,
    input: unknown,
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
  sessionEvents: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
  ...overrides,
});

const captureSubagentTools = (
  service: SubagentServiceShape,
  activeTools: ReadonlyArray<string> = ["read"],
): ReadonlyMap<string, CapturedTool> => {
  const tools = new Map<string, CapturedTool>();
  const pi = {
    registerTool: (definition: unknown) => {
      const tool = definition as CapturedTool;
      tools.set(tool.name, tool);
    },
    getThinkingLevel: () => "high",
    getActiveTools: () => [...activeTools],
  } as unknown as ExtensionAPI;
  registerSubagentTools(pi, {
    run: (effect) =>
      Effect.runPromise(effect.pipe(Effect.provideService(SubagentService, service))),
  });
  return tools;
};

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

const registryContext = (
  available: ReadonlyArray<{
    readonly provider: string;
    readonly id: string;
    readonly name: string;
    readonly reasoning: boolean;
  }>,
): ExtensionContext =>
  ({
    ...(context as unknown as Record<string, unknown>),
    modelRegistry: {
      getAvailable: () => [...available],
      find: (provider: string, id: string) =>
        available.find((model) => model.provider === provider && model.id === id),
      hasConfiguredAuth: () => true,
      getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
      getApiKeyAndHeaders: () => Promise.resolve({ ok: true, apiKey: "stored-key" }),
    },
  }) as unknown as ExtensionContext;

const startCapturingService = (requests: StartSubagentRequest[]) =>
  subagentServiceDouble({
    start: (input) =>
      Effect.sync(() => {
        requests.push(input);
        return view({ id: `agent-${requests.length}`, backend: input.backend, model: input.model });
      }),
    waitForForeground: () => Effect.succeed(view()),
    awaitTerminal: () => Effect.succeed([]),
    list: Effect.succeed([]),
    status: () => Effect.succeed(view()),
    send: () => Effect.succeed(view()),
    reply: () => Effect.succeed(view()),
    interrupt: () => Effect.succeed(view()),
    resume: () => Effect.succeed(view()),
    rename: () => Effect.succeed(view()),
    stop: () => Effect.succeed(view()),
    projection: Effect.succeed({ revision: 0, runs: [] }),
  });

interface CapturedModelView {
  readonly backend: "pi" | "claude-cli";
  readonly id: string;
}

const modelViews = (
  result: { readonly details?: unknown } | undefined,
): ReadonlyArray<CapturedModelView> =>
  (result?.details as { readonly models?: ReadonlyArray<CapturedModelView> } | undefined)?.models ??
  [];

describe("subagent tool", () => {
  beforeAll(() => initTheme("dark", false));

  it("enforces the Pi read-only tool policy", () => {
    const tools = ["read", "grep", "edit", "write", "bash", "mcp"];
    expect(piToolsForWriteIntent(tools, "read-only")).toEqual(["read", "grep"]);
    expect(piToolsForWriteIntent(tools, "writer")).toEqual(tools);
  });

  it("registers focused tools with non-overlapping parameter contracts", () => {
    const tools = captureSubagentTools({} as SubagentServiceShape);
    expect([...tools.keys()]).toEqual([
      "subagent_models",
      "subagent_start",
      "subagent_list",
      "subagent_status",
      "subagent_await",
      "subagent_send",
      "subagent_reply",
      "subagent_lifecycle",
      "subagent_rename",
    ]);
    const schema = (name: string) =>
      tools.get(name)?.parameters as
        | {
            readonly properties?: Readonly<Record<string, unknown>>;
            readonly required?: ReadonlyArray<string>;
          }
        | undefined;
    const properties = (name: string): ReadonlyArray<string> =>
      Object.keys(schema(name)?.properties ?? {});
    expect(properties("subagent_models")).toEqual(["query", "backend"]);
    expect(properties("subagent_start")).toEqual(["agents"]);
    expect(properties("subagent_list")).toEqual([]);
    expect(properties("subagent_status")).toEqual(["runIds"]);
    expect(properties("subagent_await")).toEqual(["runIds", "until", "timeoutSeconds"]);
    expect(schema("subagent_status")?.required).toEqual(["runIds"]);
    expect(schema("subagent_await")?.required).toEqual(["runIds", "until", "timeoutSeconds"]);
    expect(properties("subagent_send")).toEqual(["runIds", "message"]);
    expect(properties("subagent_reply")).toEqual(["runId", "message"]);
    expect(properties("subagent_lifecycle")).toEqual(["action", "runIds", "message"]);
    expect(properties("subagent_rename")).toEqual(["runId", "name"]);
    for (const tool of tools.values()) {
      expect(tool.renderShell).toBe("default");
      expect(tool.renderCall).toBeTypeOf("function");
      expect(tool.renderResult).toBeTypeOf("function");
    }
  });

  it("color-codes agent names by state while await is in progress", () => {
    const theme = {
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    } as unknown as Theme;
    const progress = (runs: ReadonlyArray<SubagentRunView>, until: SubagentAwaitUntil) =>
      renderAwaitProgressComponent(runs, until, theme).render(120).join("\n");
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const rendered = progress(
        [
          view({ id: "agent-1", name: "running-agent", state: "running" }),
          view({ id: "agent-2", name: "waiting-agent", state: "waiting_for_parent" }),
          view({ id: "agent-3", name: "failed-agent", state: "failed" }),
          view({ id: "agent-4", name: "stopped-agent", state: "stopped" }),
        ],
        "all_finished",
      );

      expect(rendered).toContain(
        "<error>Waiting for all agents · 2 of 4 finished · 1 running · 1 waiting for you</error>",
      );
      expect(rendered).toContain("<success>⠋ running-agent</success>");
      expect(rendered).toContain("<warning>? waiting-agent</warning>");
      expect(rendered).toContain("<warning>waiting for you</warning>");
      expect(rendered).toContain("<toolOutput>openai-codex/gpt-5.6-sol</toolOutput>");
      expect(rendered).toContain("<thinkingHigh>high</thinkingHigh>");
      expect(rendered).toContain("<error>× failed-agent</error>");
      expect(rendered).toContain("<muted>■ stopped-agent</muted>");
      expect(progress([view({ state: "running" })], "any_finished")).toContain(
        "Waiting for first agent · 0 of 1 finished · 1 running",
      );
      expect(progress([view({ state: "completed" })], "all_finished")).toContain(
        "<success>1 agent finished</success>",
      );
      expect(progress([view({ state: "running" })], "all_finished")).toContain(
        "<success>⠋ auth-review</success>",
      );
      vi.setSystemTime(320);
      expect(progress([view({ state: "running" })], "all_finished")).toContain(
        "<success>⠹ auth-review</success>",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("projects timeout, cancellation, and first-finished await outcomes", () => {
    const running = view({ name: "still-working", state: "running" });
    const completed = view({
      id: "agent-2",
      name: "first-agent",
      state: "completed",
      endedAt: 10,
    });
    expect(awaitResultBanner({ action: "await", runs: [running], timedOut: true })).toEqual({
      color: "warning",
      text: "Await timed out · 1 agent still running",
    });
    expect(awaitResultBanner({ action: "await", runs: [running], cancelled: true })).toEqual({
      color: "warning",
      text: "Await cancelled · 1 agent continues running",
    });
    expect(
      awaitResultBanner({
        action: "await",
        runs: [running, completed],
        awaitUntil: "any_finished",
      }),
    ).toEqual({
      color: "accent",
      text: "first-agent finished first · 1 agent continues running",
    });
  });

  it("keeps completed start and await cards compact until expanded", () => {
    const theme = {
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    } as unknown as Theme;
    const run = view({
      id: "agent-secret-id",
      name: "review-agent",
      model: "openai-codex/gpt-5.6-sol",
      effort: "high",
      state: "completed",
      finalText: "## Findings\nEverything passed.",
    });

    const compact = renderStartAwaitOverviewComponent([run], theme).render(120);
    expect(compact).toHaveLength(2);
    expect(compact[0]).toContain("<success>✓ review-agent</success>");
    expect(compact[0]).toContain("<toolOutput>openai-codex/gpt-5.6-sol</toolOutput>");
    expect(compact[0]).toContain("<thinkingHigh>high</thinkingHigh>");
    expect(compact[0]).toContain("<success>finished</success>");
    expect(compact[1]).toBe("<dim>▸ final report · expand to view</dim>");
    expect(compact.join("\n")).not.toContain("agent-secret-id");

    const expanded = renderExpandedStartAwaitResult([run], theme).render(120).join("\n");
    expect(expanded).toContain("<dim>▾ final report</dim>");
    expect(expanded).toContain("Final report — review-agent");
    expect(expanded).not.toContain("agent-secret-id");

    const markdown = renderExpandedStartAwaitResult([run], theme).render(80).join("\n");
    expect(markdown).toContain("Findings");
    expect(markdown).not.toContain("## Findings");
  });

  it("aligns wide summary columns and truncates models first on narrow terminals", () => {
    const theme = {
      fg: (_color: string, text: string) => text,
    } as unknown as Theme;
    const first = view({ name: "a", model: "short-model", state: "completed" });
    const second = view({
      id: "agent-2",
      name: "longer-agent-name",
      model: "a-very-long-provider/model-identifier-that-needs-truncation",
      state: "completed",
    });
    const wide = renderExpandedStartAwaitResult([first, second], theme).render(110);
    expect(wide[0]?.indexOf("short-model")).toBe(wide[1]?.indexOf("a-very-long"));

    const narrow = renderExpandedStartAwaitResult([second], theme).render(36);
    expect(narrow[0]).toContain("longer-agent-name");
    expect(narrow[1]).toContain(" · high");
    expect(narrow[2]).toContain("finished");
    expect(narrow.join("\n")).not.toContain(second.model);
    expect(narrow.every((line) => visibleWidth(line) <= 36)).toBe(true);
  });

  it("labels failed-run expansion as failure details", () => {
    const theme = {
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    } as unknown as Theme;
    const failed = view({ state: "failed", error: "child failed" });
    expect(renderStartAwaitOverviewComponent([failed], theme).render(120)).toContain(
      "<dim>▸ failure detail · expand to view</dim>",
    );
  });

  it("keeps partial batch-start failures compact", () => {
    const theme = {
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    } as unknown as Theme;
    const failures = [{ index: 1, name: "broken-agent", message: "spawn failed" }];
    const compact = renderStartAwaitOverviewComponent(
      [view({ name: "good-agent" })],
      theme,
      failures,
    )
      .render(120)
      .join("\n");
    expect(compact).toContain("<success>● good-agent</success>");
    expect(compact).toContain("<error>× broken-agent</error> · <error>failed to start</error>");
    expect(compact).not.toContain("spawn failed");

    const expanded = renderExpandedStartAwaitResult([view({ name: "good-agent" })], theme, failures)
      .render(120)
      .join("\n");
    expect(expanded).toContain("spawn failed");
  });

  it("uses fresh/background defaults, inherits model effort, and strips recursive tools", async () => {
    let request: StartSubagentRequest | undefined;
    const service = subagentServiceDouble({
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
    });
    const tool = captureSubagentTools(service, [
      "read",
      "grep",
      "edit",
      "write",
      "bash",
      "mcp",
      "subagent_start",
      "subagent_await",
      "workflow",
    ]).get("subagent_start");

    const result = await tool?.execute(
      "call",
      {
        agents: [{ backend: "pi", task: "Review auth", writeIntent: "read-only" }],
      },
      undefined,
      undefined,
      context,
    );

    expect(tool?.name).toBe("subagent_start");
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

  it("starts a per-agent batch and keeps successful launches when one fails", async () => {
    const requests: StartSubagentRequest[] = [];
    const waited: string[] = [];
    const service = subagentServiceDouble({
      start: (input) =>
        Effect.sync(() => requests.push(input)).pipe(
          Effect.flatMap((index) =>
            input.task === "Fail launch"
              ? Effect.fail(
                  new SubagentProcessError({
                    operation: "start",
                    message: "simulated launch failure",
                  }),
                )
              : Effect.succeed(
                  view({
                    id: `agent-${index}`,
                    name: input.name ?? `agent-${index}`,
                    task: input.task,
                    backend: input.backend,
                    model: input.model,
                    execution: input.execution,
                  }),
                ),
          ),
        ),
      waitForForeground: (id) =>
        Effect.sync(() => {
          waited.push(id);
          return view({ id, state: "completed" });
        }),
      awaitTerminal: () => Effect.succeed([]),
      list: Effect.succeed([]),
      status: () => Effect.succeed(view()),
      send: () => Effect.succeed(view()),
      reply: () => Effect.succeed(view()),
      interrupt: () => Effect.succeed(view()),
      resume: () => Effect.succeed(view()),
      rename: () => Effect.succeed(view()),
      stop: () => Effect.succeed(view()),
      projection: Effect.succeed({ revision: 0, runs: [] }),
    });
    const tool = captureSubagentTools(service, ["read", "grep"]).get("subagent_start");

    const result = await tool?.execute(
      "call",
      {
        agents: [
          {
            task: "Review auth",
            name: "auth",
            backend: "pi",
            writeIntent: "read-only",
          },
          {
            task: "Fail launch",
            name: "broken",
            backend: "pi",
            writeIntent: "read-only",
          },
          {
            task: "Review storage",
            name: "storage",
            backend: "claude-cli",
            model: "opus",
            execution: "foreground",
            effort: "medium",
            writeIntent: "read-only",
          },
        ],
      },
      undefined,
      undefined,
      context,
    );

    expect(requests.map((request) => request.task)).toEqual([
      "Review auth",
      "Fail launch",
      "Review storage",
    ]);
    expect(requests[2]).toMatchObject({
      backend: "claude-cli",
      model: "opus",
      execution: "foreground",
      effort: "medium",
    });
    expect(waited).toEqual(["agent-3"]);
    expect(result?.content[0]?.text).toContain("Failed starts (1)");
    expect(result?.content[0]?.text).toContain("#2 broken: simulated launch failure");
    expect(result?.content[0]?.text).toContain("agent-1");
    expect(result?.content[0]?.text).toContain("agent-3");
    expect(result?.details).toMatchObject({
      action: "start",
      runs: [{ id: "agent-1" }, { id: "agent-3" }],
      startFailures: [{ index: 1, name: "broken", message: "simulated launch failure" }],
    });
  });

  it("accepts exactly twelve batch starts at the runtime boundary", async () => {
    const requests: StartSubagentRequest[] = [];
    const service = {
      start: (input: StartSubagentRequest) =>
        Effect.sync(() => {
          requests.push(input);
          return view({ id: `agent-${requests.length}`, task: input.task });
        }),
    } as unknown as SubagentServiceShape;
    const tool = captureSubagentTools(service).get("subagent_start");

    const result = await tool?.execute(
      "call",
      {
        agents: Array.from({ length: 12 }, (_, index) => ({
          task: `Review area ${index + 1}`,
          backend: "pi" as const,
          writeIntent: "read-only" as const,
        })),
      },
      undefined,
      undefined,
      context,
    );

    expect(requests).toHaveLength(12);
    const details = result?.details as
      | { readonly runs?: ReadonlyArray<SubagentRunView> }
      | undefined;
    expect(details?.runs).toHaveLength(12);
  });

  it("advertises one canonical launch shape and enforces its cardinality", async () => {
    const service = {
      start: () => Effect.succeed(view()),
    } as unknown as SubagentServiceShape;
    const tool = captureSubagentTools(service).get("subagent_start");
    const schema = tool?.parameters as
      | { readonly properties?: Readonly<Record<string, unknown>> }
      | undefined;

    expect(Object.keys(schema?.properties ?? {})).toEqual(["agents"]);
    await expect(
      tool?.execute("call", { agents: [] }, undefined, undefined, context),
    ).rejects.toThrow("requires between 1 and 12 agents");
    await expect(
      tool?.execute(
        "call",
        {
          agents: Array.from({ length: 13 }, (_, index) => ({
            task: `Review area ${index + 1}`,
            backend: "pi" as const,
            writeIntent: "read-only" as const,
          })),
        },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toThrow("requires between 1 and 12 agents");
  });

  it("resolves Claude aliases without Pi model-registry authentication", async () => {
    let request: StartSubagentRequest | undefined;
    const service = subagentServiceDouble({
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
    });
    const tool = captureSubagentTools(service, ["read", "edit"]).get("subagent_start");

    const result = await tool?.execute(
      "call",
      {
        agents: [
          {
            backend: "claude-cli",
            model: "opus",
            task: "Review auth",
            writeIntent: "read-only",
          },
        ],
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
    const service = subagentServiceDouble({
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
    });
    const tool = captureSubagentTools(service).get("subagent_start");
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
        agents: [{ backend: "pi", task: "Review auth", writeIntent: "read-only" }],
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
    const service = subagentServiceDouble({
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
    });
    const tool = captureSubagentTools(service).get("subagent_status");

    const result = await tool?.execute(
      "call",
      { runIds: ["agent-1"] },
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

    const listed = await captureSubagentTools(service)
      .get("subagent_list")
      ?.execute("call", {}, undefined, undefined, context);
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
    const service = subagentServiceDouble({
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
    });
    const tools = captureSubagentTools(service);
    const awaitTool = tools.get("subagent_await");
    const sendTool = tools.get("subagent_send");

    const updates: string[] = [];
    const awaited = await awaitTool?.execute(
      "call",
      { runIds: ["agent-1", "agent-2"], until: "all_finished", timeoutSeconds: 0 },
      undefined,
      (result) => updates.push(result.content[0]?.text ?? ""),
      context,
    );
    expect(updates).toEqual([
      "Waiting for all agents · 0 of 2 finished · 2 running\n● auth-review (agent-1) · running\n● test-review (agent-2) · running",
    ]);
    expect(awaited?.content[0]?.text).toContain("First report.");
    expect(awaited?.content[0]?.text).toContain("Second report.");
    expect(awaited?.details).toMatchObject({
      action: "await",
      runs: [{ id: "agent-1" }, { id: "agent-2" }],
    });

    const sentResult = await sendTool?.execute(
      "call",
      { runIds: ["agent-1", "agent-2"], message: "Conclude now." },
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

  it("routes focused reply, lifecycle, and rename operations", async () => {
    const operations: string[] = [];
    const service = subagentServiceDouble({
      start: () => Effect.succeed(view()),
      waitForForeground: () => Effect.succeed(view()),
      awaitTerminal: () => Effect.succeed([]),
      list: Effect.succeed([]),
      status: () => Effect.succeed(view()),
      send: () => Effect.succeed(view()),
      reply: (id, message) =>
        Effect.sync(() => (operations.push(`reply:${id}:${message}`), view({ id }))),
      interrupt: (id) =>
        Effect.sync(() => (operations.push(`interrupt:${id}`), view({ id, state: "paused" }))),
      resume: (id, message) =>
        Effect.sync(() => (operations.push(`resume:${id}:${message ?? ""}`), view({ id }))),
      rename: (id, name) =>
        Effect.sync(() => (operations.push(`rename:${id}:${name}`), view({ id, name }))),
      stop: (id) =>
        Effect.sync(() => (operations.push(`stop:${id}`), view({ id, state: "stopped" }))),
      projection: Effect.succeed({ revision: 0, runs: [] }),
    });
    const tools = captureSubagentTools(service);

    await tools
      .get("subagent_reply")
      ?.execute("call", { runId: "agent-1", message: "Proceed." }, undefined, undefined, context);
    await tools
      .get("subagent_lifecycle")
      ?.execute(
        "call",
        { action: "interrupt", runIds: ["agent-1", "agent-2"] },
        undefined,
        undefined,
        context,
      );
    await tools
      .get("subagent_lifecycle")
      ?.execute(
        "call",
        { action: "resume", runIds: ["agent-1"], message: "Continue carefully." },
        undefined,
        undefined,
        context,
      );
    await tools
      .get("subagent_lifecycle")
      ?.execute("call", { action: "stop", runIds: ["agent-2"] }, undefined, undefined, context);
    await tools
      .get("subagent_rename")
      ?.execute("call", { runId: "agent-1", name: "reviewer" }, undefined, undefined, context);

    expect(operations).toEqual([
      "reply:agent-1:Proceed.",
      "interrupt:agent-1",
      "interrupt:agent-2",
      "resume:agent-1:Continue carefully.",
      "stop:agent-2",
      "rename:agent-1:reviewer",
    ]);
  });

  it("enforces the combined target count and aggregate detailed-output budget", async () => {
    const runs = Array.from({ length: 13 }, (_, index) =>
      view({
        id: `agent-${index + 1}`,
        name: `review-${index + 1}`,
        state: "completed",
        finalText: "x".repeat(32 * 1024),
      }),
    );
    const consumed: Array<{ readonly id: string; readonly generation: number }> = [];
    const service = subagentServiceDouble({
      start: () => Effect.succeed(runs[0]!),
      waitForForeground: () => Effect.succeed(runs[0]!),
      awaitTerminal: (ids) => Effect.succeed(ids.map((id) => runs.find((run) => run.id === id)!)),
      list: Effect.succeed(runs),
      status: (id) => Effect.succeed(runs.find((run) => run.id === id)!),
      observeStatus: (id) =>
        Effect.succeed({
          run: runs.find((run) => run.id === id)!,
          completionReceipt: { id, generation: 1 },
        }),
      consumeCompletions: (receipts) =>
        Effect.sync(() => {
          consumed.push(...receipts);
        }),
      send: () => Effect.succeed(runs[0]!),
      reply: () => Effect.succeed(runs[0]!),
      interrupt: () => Effect.succeed(runs[0]!),
      resume: () => Effect.succeed(runs[0]!),
      rename: () => Effect.succeed(runs[0]!),
      stop: () => Effect.succeed(runs[0]!),
      projection: Effect.succeed({ revision: 0, runs }),
    });
    const tool = captureSubagentTools(service).get("subagent_status");

    await expect(
      tool?.execute(
        "call",
        {
          runIds: runs.map((run) => run.id),
        },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toThrow("at most 12 targets");

    const result = await tool?.execute(
      "call",
      { runIds: runs.slice(0, 12).map((run) => run.id) },
      undefined,
      undefined,
      context,
    );
    const text = result?.content[0]?.text ?? "";
    expect(text.length).toBeLessThanOrEqual(48_000);
    for (const run of runs.slice(0, 12)) expect(text).toContain(run.id);
    expect(text).toContain("[run output truncated]");
    expect(consumed).toEqual([]);

    await tool?.execute("call", { runIds: ["agent-1"] }, undefined, undefined, context);
    expect(consumed).toEqual([{ id: "agent-1", generation: 1 }]);
  });

  it("returns launch-ready discovery values that round-trip into start verbatim", async () => {
    const requests: StartSubagentRequest[] = [];
    const service = startCapturingService(requests);
    const ctx = registryContext([
      { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT 5.6 Sol", reasoning: true },
      { provider: "anthropic", id: "claude-opus-5", name: "Claude Opus 5", reasoning: true },
    ]);
    const tools = captureSubagentTools(service, ["read", "grep"]);

    const models = await tools
      .get("subagent_models")
      ?.execute("call", {}, undefined, undefined, ctx);
    const views = modelViews(models);
    expect(views.map((model) => `${model.backend} ${model.id}`)).toEqual([
      "pi openai-codex/gpt-5.6-sol",
      "pi anthropic/claude-opus-5",
      "claude-cli fable",
      "claude-cli sonnet",
      "claude-cli opus",
      "claude-cli haiku",
    ]);
    for (const model of views) {
      const started = await tools.get("subagent_start")?.execute(
        "call",
        {
          agents: [
            { task: "Probe", backend: model.backend, model: model.id, writeIntent: "read-only" },
          ],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(started?.details).not.toHaveProperty("startFailures");
    }
    expect(requests.map((request) => `${request.backend} ${request.model}`)).toEqual(
      views.map((model) => `${model.backend} ${model.id}`),
    );
  });

  it("narrows multi-term discovery queries with AND semantics and a backend filter", async () => {
    const service = startCapturingService([]);
    const ctx = registryContext([
      { provider: "openai-codex", id: "gpt-5.5", name: "GPT 5.5", reasoning: true },
      { provider: "xai", id: "grok-5-fast", name: "Grok 5 Fast", reasoning: true },
      { provider: "zai", id: "glm-5-air", name: "GLM 5 Air", reasoning: false },
      { provider: "anthropic", id: "claude-opus-5", name: "Claude Opus 5", reasoning: true },
    ]);
    const modelsTool = captureSubagentTools(service).get("subagent_models");

    const narrowed = await modelsTool?.execute(
      "call",
      { query: "opus 5" },
      undefined,
      undefined,
      ctx,
    );
    expect(modelViews(narrowed).map((model) => model.id)).toEqual(["anthropic/claude-opus-5"]);

    const filtered = await modelsTool?.execute(
      "call",
      { backend: "claude-cli" },
      undefined,
      undefined,
      ctx,
    );
    expect(modelViews(filtered).map((model) => model.id)).toEqual([
      "fable",
      "sonnet",
      "opus",
      "haiku",
    ]);
  });

  it("rejects duplicate bare Pi model IDs with canonical candidates instead of picking one", async () => {
    const requests: StartSubagentRequest[] = [];
    const service = startCapturingService(requests);
    const ctx = registryContext([
      { provider: "openai", id: "gpt-5.5", name: "GPT 5.5", reasoning: true },
      { provider: "openrouter", id: "gpt-5.5", name: "GPT 5.5 (OpenRouter)", reasoning: true },
      { provider: "anthropic", id: "claude-opus-5", name: "Claude Opus 5", reasoning: true },
    ]);
    const tool = captureSubagentTools(service, ["read"]).get("subagent_start");

    const ambiguous = await tool?.execute(
      "call",
      { agents: [{ task: "Probe", backend: "pi", model: "gpt-5.5", writeIntent: "read-only" }] },
      undefined,
      undefined,
      ctx,
    );
    expect(requests).toHaveLength(0);
    expect(ambiguous?.details).toMatchObject({
      startFailures: [{ index: 0, code: "pi_model_ambiguous" }],
    });
    expect(ambiguous?.content[0]?.text).toContain("openai/gpt-5.5, openrouter/gpt-5.5");

    await tool?.execute(
      "call",
      {
        agents: [
          { task: "Probe", backend: "pi", model: "claude-opus-5", writeIntent: "read-only" },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    expect(requests.map((request) => request.model)).toEqual(["anthropic/claude-opus-5"]);

    const unknown = await tool?.execute(
      "call",
      { agents: [{ task: "Probe", backend: "pi", model: "gpt-5.9", writeIntent: "read-only" }] },
      undefined,
      undefined,
      ctx,
    );
    expect(unknown?.details).toMatchObject({
      startFailures: [{ index: 0, code: "pi_model_unknown" }],
    });
    expect(requests).toHaveLength(1);
  });

  it("fails claude-cli launches that use Pi model selectors before any start", async () => {
    const requests: StartSubagentRequest[] = [];
    const service = startCapturingService(requests);
    const ctx = registryContext([
      { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT 5.6 Sol", reasoning: true },
    ]);
    const tool = captureSubagentTools(service, ["read"]).get("subagent_start");

    const result = await tool?.execute(
      "call",
      {
        agents: [
          {
            task: "Probe",
            backend: "claude-cli",
            model: "openai-codex/gpt-5.6-sol",
            writeIntent: "read-only",
          },
          { task: "Probe", backend: "claude-cli", model: "gpt-5.6-sol", writeIntent: "read-only" },
          { task: "Probe", backend: "claude-cli", model: "Opus 5", writeIntent: "read-only" },
        ],
      },
      undefined,
      undefined,
      ctx,
    );

    expect(requests).toHaveLength(0);
    expect(result?.details).toMatchObject({
      startFailures: [
        { index: 0, code: "backend_model_mismatch" },
        { index: 1, code: "backend_model_mismatch" },
        { index: 2, code: "claude_model_invalid" },
      ],
    });
    expect(result?.content[0]?.text).toContain('backend "pi"');
  });

  it("rejects claude-cli fork context and unsupported efforts before launch", async () => {
    const requests: StartSubagentRequest[] = [];
    const service = startCapturingService(requests);
    const tool = captureSubagentTools(service, ["read"]).get("subagent_start");

    const result = await tool?.execute(
      "call",
      {
        agents: [
          {
            task: "Probe",
            backend: "claude-cli",
            model: "sonnet",
            context: "fork",
            writeIntent: "read-only",
          },
          {
            task: "Probe",
            backend: "claude-cli",
            model: "sonnet",
            effort: "off",
            writeIntent: "read-only",
          },
        ],
      },
      undefined,
      undefined,
      context,
    );

    expect(requests).toHaveLength(0);
    expect(result?.details).toMatchObject({
      startFailures: [
        { index: 0, code: "claude_context_unsupported" },
        { index: 1, code: "claude_effort_unsupported" },
      ],
    });
  });

  it("requires launch policy fields in-schema and lists models without a runtime", async () => {
    const tools = captureSubagentTools({} as SubagentServiceShape);
    const modelsTool = tools.get("subagent_models");
    const startTool = tools.get("subagent_start");
    const startSchema = startTool?.parameters as
      | {
          readonly properties?: {
            readonly agents?: { readonly items?: { readonly required?: ReadonlyArray<string> } };
          };
        }
      | undefined;

    expect(startSchema?.properties?.agents?.items?.required).toEqual([
      "task",
      "backend",
      "writeIntent",
    ]);
    const piModels = await modelsTool?.execute(
      "call",
      { query: "sol" },
      undefined,
      undefined,
      context,
    );
    expect(piModels?.content[0]?.text).toContain("backend=pi model=openai-codex/gpt-5.6-sol");
    expect(piModels?.content[0]?.text).not.toContain("model=fable");
    const claudeModels = await modelsTool?.execute(
      "call",
      { query: "fable" },
      undefined,
      undefined,
      context,
    );
    expect(claudeModels?.content[0]?.text).toContain("backend=claude-cli model=fable");
  });
});
