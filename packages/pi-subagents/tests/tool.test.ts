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
import { resolveSubagentConfig } from "../src/config/options.ts";
import { decodeSubagentConfig } from "../src/config/schema.ts";
import { PROFILE_IDS } from "../src/profiles/model.ts";
import { makeSubagentProfileService, SubagentProfileService } from "../src/profiles/service.ts";
import { piToolsForWriteIntent } from "../src/run/coordination.ts";
import {
  InvalidSubagentRequestError,
  SubagentNotFoundError,
  SubagentProcessError,
} from "../src/run/errors.ts";
import {
  decodeSubagentEffort,
  type StartSubagentRequest,
  type SubagentRunView,
} from "../src/run/model.ts";
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
  type SubagentToolBoundaries,
  type SubagentToolDetails,
} from "../src/tools/subagent.ts";

interface CapturedTool {
  readonly name: string;
  readonly description?: string;
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
  selection: {
    source: "explicit",
    reason: "Explicit backend/model selection.",
    skippedCandidates: [],
  },
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

const profileServiceFor = (global: unknown, project?: unknown) =>
  makeSubagentProfileService(
    resolveSubagentConfig({
      globalConfigPath: "/agent/pi-subagents.json",
      projectConfigPath: "/project/.pi/pi-subagents.json",
      projectTrusted: true,
      globalConfigExists: global !== undefined,
      projectConfigExists: project !== undefined,
      global: decodeSubagentConfig(global ?? {}),
      ...(project === undefined ? {} : { project: decodeSubagentConfig(project) }),
    }),
  );

const defaultProfileService = profileServiceFor(undefined);

const captureSubagentTools = (
  service: SubagentServiceShape,
  activeTools: ReadonlyArray<string> = ["read"],
  profileService = defaultProfileService,
  boundaries?: SubagentToolBoundaries,
  environment = { cwd: "/project", projectTrusted: true },
  thinkingLevel: unknown = "high",
): ReadonlyMap<string, CapturedTool> => {
  const tools = new Map<string, CapturedTool>();
  const pi = {
    registerTool: (definition: unknown) => {
      const tool = definition as CapturedTool;
      tools.set(tool.name, tool);
    },
    getThinkingLevel: () => thinkingLevel,
    getActiveTools: () => [...activeTools],
  } as unknown as ExtensionAPI;
  registerSubagentTools(pi, {
    ...(boundaries ? { boundaries } : {}),
    environment,
    run: (effect, signal) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provideService(SubagentService, service),
          Effect.provideService(SubagentProfileService, profileService),
        ),
        signal ? { signal } : undefined,
      ),
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
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
  },
  modelRegistry: {
    find: () => ({
      provider: "openai-codex",
      id: "gpt-5.6-sol",
      name: "GPT 5.6 Sol",
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
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
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
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
    readonly thinkingLevelMap?: Readonly<Record<string, string | null>>;
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
        return view({
          id: `agent-${requests.length}`,
          backend: input.backend,
          model: input.model,
          selection: input.selection ?? view().selection,
          ...(input.profile ? { profile: input.profile } : {}),
        });
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
  (result?.details as { readonly modelSelectors?: ReadonlyArray<CapturedModelView> } | undefined)
    ?.modelSelectors ?? [];

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
            readonly additionalProperties?: boolean;
            readonly anyOf?: ReadonlyArray<{
              readonly properties?: Readonly<Record<string, unknown>>;
              readonly required?: ReadonlyArray<string>;
              readonly additionalProperties?: boolean;
            }>;
          }
        | undefined;
    const properties = (name: string): ReadonlyArray<string> =>
      Object.keys(schema(name)?.properties ?? {});
    expect(properties("subagent_models")).toEqual(["query", "backend", "profile"]);
    expect(properties("subagent_start")).toEqual(["agents"]);
    expect(properties("subagent_list")).toEqual([]);
    expect(properties("subagent_status")).toEqual(["runIds"]);
    expect(properties("subagent_await")).toEqual(["runIds", "until", "timeoutSeconds"]);
    expect(schema("subagent_status")?.required).toEqual(["runIds"]);
    expect(schema("subagent_await")?.required).toEqual(["runIds", "until", "timeoutSeconds"]);
    expect(properties("subagent_send")).toEqual(["runIds", "message"]);
    expect(properties("subagent_reply")).toEqual(["runId", "message"]);
    expect(properties("subagent_lifecycle")).toEqual([]);
    expect(
      schema("subagent_lifecycle")?.anyOf?.map((member) => Object.keys(member.properties ?? {})),
    ).toEqual([
      ["action", "runIds"],
      ["action", "runIds"],
      ["action", "runIds", "message"],
    ]);
    expect(
      schema("subagent_lifecycle")?.anyOf?.every((member) => member.additionalProperties === false),
    ).toBe(true);
    expect(properties("subagent_rename")).toEqual(["runId", "name"]);
    for (const name of [
      "subagent_models",
      "subagent_start",
      "subagent_list",
      "subagent_status",
      "subagent_await",
      "subagent_send",
      "subagent_reply",
      "subagent_rename",
    ])
      expect(schema(name)?.additionalProperties).toBe(false);
    const startSchema = schema("subagent_start") as {
      readonly properties?: {
        readonly agents?: {
          readonly items?: {
            readonly additionalProperties?: boolean;
            readonly properties?: { readonly task?: { readonly pattern?: string } };
          };
        };
      };
    };
    expect(startSchema.properties?.agents?.items?.additionalProperties).toBe(false);
    expect(startSchema.properties?.agents?.items?.properties?.task?.pattern).toBe(".*\\S.*");
    expect(tools.get("subagent_start")?.description).toContain("at most one foreground agent");
    expect(tools.get("subagent_status")?.description).toContain("backend capabilities");
    expect(tools.get("subagent_send")?.description).toContain(
      "claude-cli runs cannot receive mid-turn guidance",
    );
    expect(tools.get("subagent_reply")?.description).toContain(
      "claude-cli runs do not support parent questions",
    );
    expect(tools.get("subagent_lifecycle")?.description).toContain(
      "claude-cli runs cannot be interrupted",
    );
    for (const tool of tools.values()) {
      expect(tool.renderShell).toBe("default");
      expect(tool.renderCall).toBeTypeOf("function");
      expect(tool.renderResult).toBeTypeOf("function");
    }
  });

  it("does not let caller-owned fields override a focused tool action", async () => {
    const models = await captureSubagentTools({} as SubagentServiceShape)
      .get("subagent_models")
      ?.execute("call", { action: "start", query: "fable" }, undefined, undefined, context);
    expect(models?.details).toMatchObject({ action: "models" });
    expect(models?.content[0]?.text).toContain("backend=claude-cli model=fable");
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
      text: "Await timed out · 1 unfinished",
    });
    expect(awaitResultBanner({ action: "await", runs: [running], cancelled: true })).toEqual({
      color: "warning",
      text: "Await cancelled · 1 unfinished",
    });
    expect(
      awaitResultBanner({
        action: "await",
        runs: [view({ state: "waiting_for_parent" })],
        attentionRequired: true,
      }),
    ).toEqual({
      color: "warning",
      text: "Parent reply required for 1 agent",
    });
    expect(
      awaitResultBanner({
        action: "await",
        runs: [running, completed],
        awaitUntil: "any_finished",
      }),
    ).toEqual({
      color: "accent",
      text: "first-agent finished first · 1 unfinished",
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

  it("sanitizes provenance and falls back to bounded text for malformed persisted details", () => {
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as unknown as Theme;
    const malicious = view({
      selection: {
        source: "profile-candidate",
        reason: "selected\u001b[31m\nforged-row",
        skippedCandidates: [
          { candidate: "bad\nmodel", code: "bad\u001b[2J", reason: "reason\rforged" },
        ],
      },
    });
    const rendered = renderExpandedStartAwaitResult([malicious], theme).render(100).join("\n");
    expect(rendered).not.toContain("\u001b");
    expect(rendered).not.toContain("\nforged-row");

    const tool = captureSubagentTools(startCapturingService([])).get("subagent_start");
    const component = tool?.renderResult?.(
      {
        content: [{ type: "text", text: `Safe fallback\u001b[31m${"x".repeat(100_000)}` }],
        details: { version: 1, action: "start", cards: [{ hostile: true }] },
      },
      { isPartial: false, expanded: true },
      theme,
    ) as { readonly render: (width: number) => ReadonlyArray<string> } | undefined;
    expect(() => component?.render(100_000)).not.toThrow();
    const fallback =
      component
        ?.render(100_000)
        .map((line) => line.trimEnd())
        .join("\n") ?? "";
    expect(fallback).toContain("Safe fallback");
    expect(fallback).toContain("tool output truncated; narrow the request");
    expect(fallback.length).toBeLessThanOrEqual(48_000);
    expect(fallback).not.toContain("\u001b");
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
    expect(tool?.promptGuidelines?.join(" ")).toContain(
      "claude-cli supports await, stop, local rename, and resume after completion",
    );
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

  it("routes backend auto through the neutral delegate profile and records provenance", async () => {
    const requests: StartSubagentRequest[] = [];
    const tool = captureSubagentTools(startCapturingService(requests), ["read"]).get(
      "subagent_start",
    );

    await tool?.execute(
      "call",
      { agents: [{ backend: "auto", task: "Inspect auth", writeIntent: "read-only" }] },
      undefined,
      undefined,
      context,
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      backend: "pi",
      profile: "delegate",
      context: "fresh",
      model: "openai-codex/gpt-5.6-sol",
      selection: {
        source: "profile-parent-candidate",
        reason: "Profile delegate selected parent candidate 1.",
        skippedCandidates: [],
      },
    });
    expect(requests[0]?.profileGuidance).toContain("general delegate");
  });

  it("routes every built-in profile through the tool boundary with its guidance and context", async () => {
    const requests: StartSubagentRequest[] = [];
    const tool = captureSubagentTools(startCapturingService(requests)).get("subagent_start");

    await tool?.execute(
      "call",
      {
        agents: PROFILE_IDS.map((profile) => ({
          backend: "auto" as const,
          profile,
          task: `Smoke test ${profile}`,
          writeIntent: "read-only" as const,
        })),
      },
      undefined,
      undefined,
      context,
    );

    expect(requests.map((request) => request.profile)).toEqual(PROFILE_IDS);
    const expectedEffort = {
      scout: "low",
      researcher: "medium",
      planner: "medium",
      worker: "high",
      reviewer: "high",
      oracle: "high",
      delegate: "high",
    } as const;
    for (const request of requests) {
      expect(request.backend).toBe("pi");
      expect(request.context).toBe(request.profile === "oracle" ? "fork" : "fresh");
      expect(request.effort).toBe(expectedEffort[request.profile ?? "delegate"]);
      // Built-in profile effort defaults are soft preferences, never hard requirements.
      expect(request.effortWasExplicit).toBe(false);
      expect(request.profileGuidance?.length).toBeGreaterThan(20);
      expect(request.selection).toMatchObject({
        source: "profile-parent-candidate",
        skippedCandidates: [],
      });
    }
  });

  it("uses the configured default profile when backend auto omits profile", async () => {
    const requests: StartSubagentRequest[] = [];
    const profiles = profileServiceFor({ defaultProfile: "reviewer" });
    const tool = captureSubagentTools(startCapturingService(requests), ["read"], profiles).get(
      "subagent_start",
    );

    await tool?.execute(
      "call",
      { agents: [{ backend: "auto", task: "Review", writeIntent: "read-only" }] },
      undefined,
      undefined,
      context,
    );

    expect(requests[0]).toMatchObject({
      profile: "reviewer",
      context: "fresh",
      selection: { source: "profile-parent-candidate" },
    });
    expect(requests[0]?.profileGuidance).toContain("independent reviewer");
  });

  it("uses profile context defaults and never degrades oracle forks to fresh", async () => {
    const requests: StartSubagentRequest[] = [];
    const tool = captureSubagentTools(startCapturingService(requests)).get("subagent_start");

    await tool?.execute(
      "call",
      {
        agents: [
          { backend: "auto", profile: "reviewer", task: "Review", writeIntent: "read-only" },
          { backend: "auto", profile: "oracle", task: "Advise", writeIntent: "read-only" },
        ],
      },
      undefined,
      undefined,
      context,
    );

    expect(requests.map((request) => [request.profile, request.context])).toEqual([
      ["reviewer", "fresh"],
      ["oracle", "fork"],
    ]);

    const ephemeral = {
      ...context,
      sessionManager: {
        ...context.sessionManager,
        getSessionFile: () => undefined,
        getLeafEntry: () => undefined,
      },
    } as unknown as ExtensionContext;
    const failed = await tool?.execute(
      "call",
      {
        agents: [{ backend: "auto", profile: "oracle", task: "Advise", writeIntent: "read-only" }],
      },
      undefined,
      undefined,
      ephemeral,
    );
    expect(failed?.details).toMatchObject({
      startFailures: [{ code: "fork_context_unavailable" }],
    });
  });

  it("skips discouraged automatic candidates in order and selects the next eligible model", async () => {
    const requests: StartSubagentRequest[] = [];
    const profiles = profileServiceFor({
      discouraged: [{ backend: "pi", model: "openai/gpt-first" }],
      profiles: {
        reviewer: [
          { model: "pi/openai/gpt-first", effort: "default" },
          { model: "pi/openai/gpt-second", effort: "xhigh" },
        ],
      },
    });
    const ctx = registryContext([
      { provider: "openai", id: "gpt-first", name: "First", reasoning: true },
      {
        provider: "openai",
        id: "gpt-second",
        name: "Second",
        reasoning: true,
        thinkingLevelMap: { xhigh: "xhigh" },
      },
    ]);
    const tool = captureSubagentTools(startCapturingService(requests), ["read"], profiles).get(
      "subagent_start",
    );

    await tool?.execute(
      "call",
      {
        agents: [
          { backend: "auto", profile: "reviewer", task: "Review", writeIntent: "read-only" },
        ],
      },
      undefined,
      undefined,
      ctx,
    );

    expect(requests[0]).toMatchObject({
      backend: "pi",
      model: "openai/gpt-second",
      effort: "xhigh",
      selection: {
        source: "profile-candidate",
        candidateIndex: 1,
        skippedCandidates: [{ candidateIndex: 0, code: "model_discouraged" }],
      },
    });
  });

  it("memoizes automatic Claude preflight per resolution and falls back only before start", async () => {
    const requests: StartSubagentRequest[] = [];
    let preflightCalls = 0;
    const profiles = profileServiceFor({
      profiles: {
        reviewer: [
          { model: "claude-cli/fable", effort: "default" },
          { model: "claude-cli/opus", effort: "default" },
          { model: "pi/openai-codex/gpt-5.6-sol", effort: "default" },
        ],
      },
    });
    const tool = captureSubagentTools(startCapturingService(requests), ["read"], profiles, {
      ensureClaudeReady: () => {
        preflightCalls += 1;
        return Effect.fail(
          new SubagentProcessError({
            operation: "preflight",
            code: "claude_cli_unauthenticated",
            message: "Claude CLI is not authenticated.",
          }),
        );
      },
    }).get("subagent_start");

    await tool?.execute(
      "call",
      {
        agents: [
          {
            backend: "auto",
            profile: "reviewer",
            task: "Review",
            effort: "max",
            writeIntent: "read-only",
          },
        ],
      },
      undefined,
      undefined,
      context,
    );

    expect(preflightCalls).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      backend: "pi",
      model: "openai-codex/gpt-5.6-sol",
      effort: "max",
      selection: {
        candidateIndex: 2,
        skippedCandidates: [
          {
            candidateIndex: 0,
            candidate: "claude-cli/fable:max",
            code: "claude_cli_unauthenticated",
          },
          {
            candidateIndex: 1,
            candidate: "claude-cli/opus:max",
            code: "claude_cli_unauthenticated",
          },
        ],
      },
    });
  });

  it("does not fall through to another candidate after the selected start reaches the service", async () => {
    const profiles = profileServiceFor({
      profiles: {
        reviewer: [
          { model: "claude-cli/fable", effort: "default" },
          { model: "pi/openai-codex/gpt-5.6-sol", effort: "default" },
        ],
      },
    });
    let starts = 0;
    const base = startCapturingService([]);
    const service = subagentServiceDouble({
      ...base,
      start: () => {
        starts += 1;
        return Effect.fail(
          new SubagentProcessError({
            operation: "spawn",
            code: "post_selection_start_failed",
            message: "Selected candidate failed after start ownership began.",
          }),
        );
      },
    });
    const result = await captureSubagentTools(service, ["read"], profiles, {
      ensureClaudeReady: () => Effect.void,
    })
      .get("subagent_start")
      ?.execute(
        "call",
        {
          agents: [
            {
              backend: "auto",
              profile: "reviewer",
              task: "Review",
              writeIntent: "read-only",
            },
          ],
        },
        undefined,
        undefined,
        context,
      );
    expect(starts).toBe(1);
    expect(result?.details).toMatchObject({
      startFailures: [{ code: "post_selection_start_failed" }],
    });
  });

  it("applies request effort before Claude compatibility checks and preflight", async () => {
    const requests: StartSubagentRequest[] = [];
    let preflightCalls = 0;
    const profiles = profileServiceFor({
      profiles: {
        reviewer: [
          { model: "claude-cli/fable", effort: "default" },
          { model: "pi/openai-codex/gpt-5.6-sol", effort: "default" },
        ],
      },
    });
    const tool = captureSubagentTools(startCapturingService(requests), ["read"], profiles, {
      ensureClaudeReady: () => {
        preflightCalls += 1;
        return Effect.void;
      },
    }).get("subagent_start");

    await tool?.execute(
      "call",
      {
        agents: [
          {
            backend: "auto",
            profile: "reviewer",
            task: "Review with Claude",
            effort: "high",
            writeIntent: "read-only",
          },
        ],
      },
      undefined,
      undefined,
      context,
    );
    await tool?.execute(
      "call",
      {
        agents: [
          {
            backend: "auto",
            profile: "reviewer",
            task: "Review without Claude",
            effort: "off",
            writeIntent: "read-only",
          },
        ],
      },
      undefined,
      undefined,
      context,
    );

    expect(preflightCalls).toBe(1);
    expect(requests[0]).toMatchObject({ backend: "claude-cli", model: "fable", effort: "high" });
    expect(requests[1]).toMatchObject({
      backend: "pi",
      effort: "off",
      selection: {
        candidateIndex: 1,
        skippedCandidates: [{ candidateIndex: 0, code: "claude_effort_unsupported" }],
      },
    });
  });

  it("enforces denied models while honoring explicit discouraged profile overrides visibly", async () => {
    const deniedRequests: StartSubagentRequest[] = [];
    const deniedProfiles = profileServiceFor({
      denied: [{ backend: "pi", model: "openai-codex/gpt-5.6-sol" }],
    });
    const deniedTool = captureSubagentTools(
      startCapturingService(deniedRequests),
      ["read"],
      deniedProfiles,
    ).get("subagent_start");
    const denied = await deniedTool?.execute(
      "call",
      {
        agents: [{ backend: "pi", profile: "reviewer", task: "Review", writeIntent: "read-only" }],
      },
      undefined,
      undefined,
      context,
    );
    expect(deniedRequests).toEqual([]);
    expect(denied?.details).toMatchObject({ startFailures: [{ code: "model_denied" }] });

    const requests: StartSubagentRequest[] = [];
    const discouragedProfiles = profileServiceFor({
      discouraged: [{ backend: "pi", model: "gpt-5.6-sol" }],
    });
    const tool = captureSubagentTools(
      startCapturingService(requests),
      ["read"],
      discouragedProfiles,
    ).get("subagent_start");
    const result = await tool?.execute(
      "call",
      {
        agents: [{ backend: "pi", profile: "reviewer", task: "Review", writeIntent: "read-only" }],
      },
      undefined,
      undefined,
      context,
    );
    expect(requests[0]).toMatchObject({
      profile: "reviewer",
      effort: "high",
      // The reviewer default supplies the effort but stays a soft preference.
      effortWasExplicit: false,
      selection: {
        source: "explicit",
        warning: expect.stringContaining("discouraged by policy"),
      },
    });
    expect(result?.content[0]?.text).toContain("discouraged by policy");
  });

  it("denies explicit selectors before any registry auth lookup or Claude preflight work", async () => {
    const requests: StartSubagentRequest[] = [];
    let findCalls = 0;
    let authStatusCalls = 0;
    let apiKeyCalls = 0;
    let preflightCalls = 0;
    const profiles = profileServiceFor({
      denied: [
        { backend: "pi", model: "openai-codex/gpt-5.6-sol" },
        { backend: "claude-cli", model: "fable" },
      ],
    });
    const spyContext = {
      ...(context as unknown as Record<string, unknown>),
      modelRegistry: {
        getAvailable: () => [
          { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT 5.6 Sol", reasoning: true },
        ],
        find: () => {
          findCalls += 1;
          return { provider: "openai-codex", id: "gpt-5.6-sol", reasoning: true };
        },
        hasConfiguredAuth: () => true,
        getProviderAuthStatus: () => {
          authStatusCalls += 1;
          return { configured: true, source: "runtime" };
        },
        getApiKeyAndHeaders: () => {
          apiKeyCalls += 1;
          return Promise.resolve({ ok: true, apiKey: "runtime-key" });
        },
      },
    } as unknown as ExtensionContext;
    const tool = captureSubagentTools(startCapturingService(requests), ["read"], profiles, {
      ensureClaudeReady: () => {
        preflightCalls += 1;
        return Effect.void;
      },
    }).get("subagent_start");

    const result = await tool?.execute(
      "call",
      {
        agents: [
          {
            task: "Probe",
            backend: "pi",
            model: "openai-codex/gpt-5.6-sol",
            writeIntent: "read-only",
          },
          // Backend-only launch whose deterministic inherited parent model is denied.
          { task: "Probe", backend: "pi", writeIntent: "read-only" },
          { task: "Probe", backend: "claude-cli", model: "fable", writeIntent: "read-only" },
          // Bare selector that only the resolved canonical model matches against the deny list;
          // the deny must still fire before registry auth lookups.
          { task: "Probe", backend: "pi", model: "gpt-5.6-sol", writeIntent: "read-only" },
        ],
      },
      undefined,
      undefined,
      spyContext,
    );

    expect(requests).toEqual([]);
    expect(result?.details).toMatchObject({
      startFailures: [
        { index: 0, code: "model_denied" },
        { index: 1, code: "model_denied" },
        { index: 2, code: "model_denied" },
        { index: 3, code: "model_denied" },
      ],
    });
    expect(findCalls).toBe(0);
    expect(authStatusCalls).toBe(0);
    expect(apiKeyCalls).toBe(0);
    expect(preflightCalls).toBe(0);
  });

  it("clamps unknown host thinking levels to high instead of forwarding them to children", async () => {
    expect(decodeSubagentEffort("xhigh")).toBe("xhigh");
    expect(decodeSubagentEffort(" MAX ")).toBe("max");
    expect(decodeSubagentEffort("ultra")).toBeUndefined();
    expect(decodeSubagentEffort(42)).toBeUndefined();
    expect(decodeSubagentEffort(undefined)).toBeUndefined();

    const startWithLevel = async (thinkingLevel: unknown) => {
      const requests: StartSubagentRequest[] = [];
      const tool = captureSubagentTools(
        startCapturingService(requests),
        ["read"],
        defaultProfileService,
        undefined,
        { cwd: "/project", projectTrusted: true },
        thinkingLevel,
      ).get("subagent_start");
      await tool?.execute(
        "call",
        {
          agents: [
            // Profile-environment inheritance path (delegate inherits the parent effort).
            { backend: "auto", profile: "delegate", task: "Probe", writeIntent: "read-only" },
            // Explicit-launch inheritance path.
            { backend: "pi", task: "Probe", writeIntent: "read-only" },
          ],
        },
        undefined,
        undefined,
        context,
      );
      return requests.map((request) => request.effort);
    };

    expect(await startWithLevel("low")).toEqual(["low", "low"]);
    // Future or malformed host levels clamp to the shared "high" inheritance default.
    expect(await startWithLevel("ultra")).toEqual(["high", "high"]);
    expect(await startWithLevel(42)).toEqual(["high", "high"]);
    expect(await startWithLevel(" MEDIUM ")).toEqual(["medium", "medium"]);
  });

  it("distinguishes backend-only overrides from explicit backend+model overrides in provenance", async () => {
    const requests: StartSubagentRequest[] = [];
    const tool = captureSubagentTools(startCapturingService(requests), ["read"], undefined, {
      ensureClaudeReady: () => Effect.void,
    }).get("subagent_start");

    await tool?.execute(
      "call",
      {
        agents: [
          { task: "Probe", backend: "pi", writeIntent: "read-only" },
          {
            task: "Probe",
            backend: "pi",
            model: "openai-codex/gpt-5.6-sol",
            writeIntent: "read-only",
          },
          { task: "Probe", backend: "pi", profile: "reviewer", writeIntent: "read-only" },
          { task: "Probe", backend: "claude-cli", writeIntent: "read-only" },
          {
            task: "Probe",
            backend: "claude-cli",
            model: "fable",
            profile: "reviewer",
            writeIntent: "read-only",
          },
        ],
      },
      undefined,
      undefined,
      context,
    );

    expect(requests.map((request) => request.selection?.reason)).toEqual([
      "Explicit backend selection; the parent session model was inherited.",
      "Explicit backend/model selection.",
      "Explicit backend routing overrode profile reviewer; the parent session model was inherited, and profile guidance was retained.",
      "Explicit backend selection; Claude CLI defaulted to the sonnet alias.",
      "Explicit backend/model routing overrode profile reviewer; profile guidance was retained.",
    ]);
    expect(requests.map((request) => request.model)).toEqual([
      "openai-codex/gpt-5.6-sol",
      "openai-codex/gpt-5.6-sol",
      "openai-codex/gpt-5.6-sol",
      "sonnet",
      "fable",
    ]);
  });

  it("returns model-visible profile_unknown and profile_no_eligible_model codes", async () => {
    const requests: StartSubagentRequest[] = [];
    const emptyRoute = profileServiceFor({ profiles: { reviewer: "disabled" } });
    const tool = captureSubagentTools(startCapturingService(requests), ["read"], emptyRoute).get(
      "subagent_start",
    );
    const result = await tool?.execute(
      "call",
      {
        agents: [
          { backend: "auto", profile: "future", task: "Unknown", writeIntent: "read-only" },
          { backend: "auto", profile: "reviewer", task: "Review", writeIntent: "read-only" },
        ],
      },
      undefined,
      undefined,
      context,
    );
    expect(requests).toEqual([]);
    expect(result?.details).toMatchObject({
      startFailures: [
        { index: 0, code: "profile_unknown" },
        { index: 1, code: "profile_no_eligible_model" },
      ],
    });
    expect(result?.content[0]?.text).toContain("[profile_unknown]");
    expect(result?.content[0]?.text).toContain("[profile_no_eligible_model]");
  });

  it("rejects a model combined with backend auto before any launch", async () => {
    const requests: StartSubagentRequest[] = [];
    const tool = captureSubagentTools(startCapturingService(requests)).get("subagent_start");
    const result = await tool?.execute(
      "call",
      {
        agents: [
          {
            backend: "auto",
            profile: "worker",
            model: "openai-codex/gpt-5.6-sol",
            task: "Implement",
            writeIntent: "writer",
          },
        ],
      },
      undefined,
      undefined,
      context,
    );
    expect(requests).toEqual([]);
    expect(result?.details).toMatchObject({
      startFailures: [{ code: "auto_model_conflict" }],
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
      "Review storage",
      "Review auth",
      "Fail launch",
    ]);
    expect(requests[0]).toMatchObject({
      backend: "claude-cli",
      model: "opus",
      execution: "foreground",
      effort: "medium",
    });
    expect(waited).toEqual(["agent-1"]);
    expect(result?.content[0]?.text).toContain("Failed starts (1)");
    expect(result?.content[0]?.text).toContain(
      "#2 broken [SubagentProcessError]: simulated launch failure",
    );
    expect(result?.content[0]?.text).toContain("agent-1");
    expect(result?.content[0]?.text).toContain("agent-2");
    expect(result?.details).toMatchObject({
      action: "start",
      cards: [{ id: "agent-2" }, { id: "agent-1" }],
      startFailures: [{ index: 1, name: "broken", message: "simulated launch failure" }],
    });
  });

  it("rejects multiple foreground agents before any launch side effect", async () => {
    const requests: StartSubagentRequest[] = [];
    const tool = captureSubagentTools(startCapturingService(requests)).get("subagent_start");

    await expect(
      tool?.execute(
        "call",
        {
          agents: [
            {
              task: "Review auth",
              backend: "pi",
              execution: "foreground",
              writeIntent: "read-only",
            },
            {
              task: "Review storage",
              backend: "pi",
              execution: "foreground",
              writeIntent: "read-only",
            },
          ],
        },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toThrow("at most one foreground agent");
    expect(requests).toEqual([]);
  });

  it("publishes start progress before waiting on a foreground run", async () => {
    const requests: StartSubagentRequest[] = [];
    const updates: string[] = [];
    const tool = captureSubagentTools(startCapturingService(requests)).get("subagent_start");

    await tool?.execute(
      "call",
      {
        agents: [
          {
            task: "Review auth",
            backend: "pi",
            execution: "foreground",
            writeIntent: "read-only",
          },
        ],
      },
      undefined,
      (result) => updates.push(result.content[0]?.text ?? ""),
      context,
    );

    expect(updates).toEqual(["Started 1 of 1 subagent; waiting for the foreground run."]);
  });

  it("does not let a failed partial renderer turn a successful launch into failure", async () => {
    const requests: StartSubagentRequest[] = [];
    const tool = captureSubagentTools(startCapturingService(requests)).get("subagent_start");

    const result = await tool?.execute(
      "call",
      {
        agents: [{ task: "Review auth", backend: "pi", writeIntent: "read-only" }],
      },
      undefined,
      () => {
        throw new Error("stale renderer");
      },
      context,
    );

    expect(requests).toHaveLength(1);
    expect(result?.content[0]?.text).toContain("agent-1");
    expect(result?.details).not.toHaveProperty("startFailures");
  });

  it("accepts exactly twelve batch starts at the runtime boundary", async () => {
    const requests: StartSubagentRequest[] = [];
    const start = (input: StartSubagentRequest) =>
      Effect.sync(() => {
        requests.push(input);
        return view({ id: `agent-${requests.length}`, task: input.task });
      });
    const service = {
      start,
      startSessionOwned: start,
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
      | { readonly cards?: ReadonlyArray<SubagentRunView> }
      | undefined;
    expect(details?.cards).toHaveLength(12);
  });

  it("consumes foreground completion only after a fully rendered start result", async () => {
    const consumed: Array<{ readonly id: string; readonly generation: number }> = [];
    let next = 1;
    const base = startCapturingService([]);
    const start = (request: StartSubagentRequest) =>
      Effect.sync(() =>
        view({
          id: `agent-${next++}`,
          name: request.name ?? "foreground",
          execution: request.execution,
        }),
      );
    const service = subagentServiceDouble({
      ...base,
      start,
      withForegroundStartObservation: (request, use) =>
        start(request).pipe(
          Effect.flatMap((started) =>
            use(
              started,
              Effect.succeed({
                run: view({
                  id: started.id,
                  state: "completed",
                  finalText: "Fully rendered foreground report.",
                }),
                completionReceipt: { id: started.id, generation: 1 },
              }),
            ),
          ),
        ),
      consumeCompletions: (receipts) =>
        Effect.sync(() => {
          consumed.push(...receipts);
        }),
    });
    const result = await captureSubagentTools(service)
      .get("subagent_start")
      ?.execute(
        "call",
        {
          agents: [
            {
              task: "Report",
              backend: "pi",
              execution: "foreground",
              writeIntent: "read-only",
            },
          ],
        },
        undefined,
        undefined,
        context,
      );
    expect(result?.content[0]?.text).toContain("Fully rendered foreground report.");
    expect(consumed).toEqual([{ id: "agent-1", generation: 1 }]);
  });

  it("requeues foreground completion claims when 12-run rendering truncates or start is cancelled", async () => {
    const consumed: Array<{ readonly id: string; readonly generation: number }> = [];
    let next = 1;
    const base = startCapturingService([]);
    const start = (request: StartSubagentRequest) =>
      Effect.sync(() =>
        view({
          id: `agent-${next++}`,
          name: request.name ?? "run",
          execution: request.execution,
          finalText: request.execution === "foreground" ? "x".repeat(32_000) : undefined,
        }),
      );
    const service = subagentServiceDouble({
      ...base,
      start,
      withForegroundStartObservation: (request, use) =>
        start(request).pipe(
          Effect.flatMap((started) =>
            use(
              started,
              Effect.succeed({
                run: view({ id: started.id, state: "completed", finalText: "x".repeat(32_000) }),
                completionReceipt: { id: started.id, generation: 1 },
              }),
            ),
          ),
        ),
      consumeCompletions: (receipts) =>
        Effect.sync(() => {
          consumed.push(...receipts);
        }),
    });
    const agents = Array.from({ length: 12 }, (_, index) => ({
      task: `Task ${index + 1}`,
      name: `run-${index + 1}`,
      backend: "pi" as const,
      execution: index === 0 ? ("foreground" as const) : ("background" as const),
      writeIntent: "read-only" as const,
    }));
    const result = await captureSubagentTools(service)
      .get("subagent_start")
      ?.execute("call", { agents }, undefined, undefined, context);
    expect(result?.content[0]?.text.length).toBeLessThanOrEqual(48_000);
    expect(result?.content[0]?.text).toContain("[run output truncated]");
    expect(consumed).toEqual([]);

    let released = 0;
    const cancellingService = subagentServiceDouble({
      ...base,
      start: () => Effect.succeed(view({ id: "agent-cancel", execution: "foreground" })),
      withForegroundStartObservation: (_request, use) =>
        Effect.acquireUseRelease(
          Effect.succeed(view({ id: "agent-cancel", execution: "foreground" })),
          (started) => use(started, Effect.never),
          () => Effect.sync(() => void (released += 1)),
        ),
    });
    const controller = new AbortController();
    const executing = captureSubagentTools(cancellingService)
      .get("subagent_start")
      ?.execute(
        "call",
        {
          agents: [
            {
              task: "Cancel",
              backend: "pi",
              execution: "foreground",
              writeIntent: "read-only",
            },
          ],
        },
        controller.signal,
        undefined,
        context,
      );
    await Promise.resolve();
    controller.abort();
    await expect(executing).rejects.toBeDefined();
    expect(released).toBe(1);
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
      profile: "reviewer",
      selection: {
        source: "profile-candidate",
        candidateIndex: 1,
        reason: "Profile reviewer selected configured candidate 2.",
        skippedCandidates: [
          {
            candidateIndex: 0,
            candidate: "pi/old-model",
            code: "model_discouraged",
            reason: "Old model is discouraged.",
          },
        ],
      },
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
    expect(text).toContain("Profile    reviewer");
    expect(text).toContain("Model      pi/openai-codex/gpt-5.6-sol · high");
    expect(text).toContain("Selection  profile-candidate candidate 2");
    expect(text).toContain("Reason     Profile reviewer selected configured candidate 2.");
    expect(text).toContain("Skipped    candidate 1 [model_discouraged]");
    expect(text).toContain(
      "Capabilities steer, interrupt, resume, rename-display, parent-contact, peer-notice, native-fork",
    );
    expect(text).toContain("Final report\nViewport report.");
    expect(text).not.toContain("Activity:");
    expect(text.match(/Viewport report\./g)).toHaveLength(1);
    expect(result?.details).toEqual({
      version: 1,
      action: "status",
      runIds: ["agent-1"],
      runCount: 1,
    });

    const listed = await captureSubagentTools(service)
      .get("subagent_list")
      ?.execute("call", {}, undefined, undefined, context);
    expect(listed?.details).toEqual({
      version: 1,
      action: "list",
      runIds: ["agent-1"],
      runCount: 1,
    });
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
      cards: [{ id: "agent-1" }, { id: "agent-2" }],
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

  it("handles real tool-level await timeout and cancellation with retained attention", async () => {
    const running = view({ id: "agent-timeout", state: "running" });
    const timeoutBase = startCapturingService([]);
    const timeoutService = subagentServiceDouble({
      ...timeoutBase,
      withAwaitTerminalObservations: () => Effect.never,
      withStatusObservations: (_ids, use) =>
        use({ observations: [{ run: running }], missingIds: [] }),
    });
    const timeout = await captureSubagentTools(timeoutService)
      .get("subagent_await")
      ?.execute(
        "call",
        { runIds: [running.id], until: "all_finished", timeoutSeconds: 0.01 },
        undefined,
        undefined,
        context,
      );
    expect(timeout?.content[0]?.text).toContain("Await timed out; 1 subagent is unfinished.");
    expect(timeout?.details).toMatchObject({ action: "await", timedOut: true });

    const waiting = view({
      id: "agent-question",
      state: "waiting_for_parent",
      question: { requestId: "question", message: "Which fixture?", createdAt: 2 },
    });
    const cancelService = subagentServiceDouble({
      ...timeoutBase,
      withAwaitTerminalObservations: (_ids, _until, onUpdate) =>
        Effect.sync(() => onUpdate?.([waiting])).pipe(Effect.andThen(Effect.never)),
    });
    const updates: Array<{ readonly content: ReadonlyArray<{ readonly text: string }> }> = [];
    const controller = new AbortController();
    const executing = captureSubagentTools(cancelService)
      .get("subagent_await")
      ?.execute(
        "call",
        { runIds: [waiting.id], until: "all_finished", timeoutSeconds: 0 },
        controller.signal,
        (result) => updates.push(result),
        context,
      );
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    await expect(executing).rejects.toBeDefined();
    const cancelled = updates.at(-1)?.content[0]?.text ?? "";
    expect(cancelled).toContain("Await cancelled; 1 subagent is unfinished.");
    expect(cancelled).toContain("Question from auth-review: Which fixture?");
    expect(cancelled).toContain('subagent_reply({ runId: "agent-question", message: "..." })');
  });

  it("reports per-target management outcomes without hiding successful side effects", async () => {
    const sent: string[] = [];
    const interrupted: string[] = [];
    const service = subagentServiceDouble({
      start: () => Effect.succeed(view()),
      waitForForeground: () => Effect.succeed(view()),
      awaitTerminal: () => Effect.succeed([]),
      list: Effect.succeed([]),
      status: () => Effect.succeed(view()),
      send: (id) =>
        id === "agent-2"
          ? Effect.fail(
              new InvalidSubagentRequestError({
                code: "not_running",
                message: "agent-2 is paused",
              }),
            )
          : Effect.sync(() => (sent.push(id), view({ id }))),
      reply: () => Effect.succeed(view()),
      interrupt: (id) =>
        id === "agent-2"
          ? Effect.fail(
              new InvalidSubagentRequestError({
                code: "already_paused",
                message: "agent-2 is already paused",
              }),
            )
          : Effect.sync(() => (interrupted.push(id), view({ id, state: "paused" }))),
      resume: () => Effect.succeed(view()),
      rename: () => Effect.succeed(view()),
      stop: () => Effect.succeed(view()),
      projection: Effect.succeed({ revision: 0, runs: [] }),
    });
    const tools = captureSubagentTools(service);

    const sendResult = await tools
      .get("subagent_send")
      ?.execute(
        "call",
        { runIds: ["agent-1", "agent-2"], message: "Conclude." },
        undefined,
        undefined,
        context,
      );
    expect(sent).toEqual(["agent-1"]);
    expect(sendResult?.content[0]?.text).toContain("Guidance delivered to 1 subagent: agent-1.");
    expect(sendResult?.content[0]?.text).toContain("Failed targets (1)");
    expect(sendResult?.content[0]?.text).toContain("agent-2 [not_running]: agent-2 is paused");
    expect(sendResult?.details).toMatchObject({
      version: 1,
      action: "send",
      runIds: ["agent-1"],
      actionFailures: [{ id: "agent-2", code: "not_running" }],
    });

    const lifecycleResult = await tools
      .get("subagent_lifecycle")
      ?.execute(
        "call",
        { action: "interrupt", runIds: ["agent-1", "agent-2"] },
        undefined,
        undefined,
        context,
      );
    expect(interrupted).toEqual(["agent-1"]);
    expect(lifecycleResult?.content[0]?.text).toContain("Paused agent-1.");
    expect(lifecycleResult?.content[0]?.text).toContain("agent-2 is already paused");
    expect(lifecycleResult?.details).toMatchObject({
      action: "interrupt",
      actionFailures: [{ id: "agent-2", code: "already_paused" }],
    });
  });

  it("rejects lifecycle messages for actions that cannot deliver them", async () => {
    const service = {
      ...startCapturingService([]),
      interrupt: () => Effect.succeed(view({ state: "paused" })),
    };
    const tool = captureSubagentTools(service).get("subagent_lifecycle");

    await expect(
      tool?.execute(
        "call",
        { action: "interrupt", runIds: ["agent-1"], message: "Pause after this step." },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toThrow('message is valid only when action="resume"');
  });

  it("deduplicates repeated target IDs before applying management operations", async () => {
    const sent: string[] = [];
    const service = {
      ...startCapturingService([]),
      send: (id: string) => Effect.sync(() => (sent.push(id), view({ id }))),
    };
    const tool = captureSubagentTools(service).get("subagent_send");

    const result = await tool?.execute(
      "call",
      { runIds: ["agent-1", "agent-1"], message: "Conclude." },
      undefined,
      undefined,
      context,
    );

    expect(sent).toEqual(["agent-1"]);
    expect(result?.content[0]?.text).toBe("Guidance delivered to 1 subagent: agent-1.");
  });

  it("renders state-aware stop acknowledgements for terminal no-ops", async () => {
    const base = startCapturingService([]);
    const service = subagentServiceDouble({
      ...base,
      stop: (id) =>
        Effect.succeed(
          view({
            id,
            state:
              id === "agent-complete" ? "completed" : id === "agent-failed" ? "failed" : "stopped",
          }),
        ),
    });
    const result = await captureSubagentTools(service)
      .get("subagent_lifecycle")
      ?.execute(
        "call",
        {
          action: "stop",
          runIds: ["agent-complete", "agent-failed", "agent-stopped"],
        },
        undefined,
        undefined,
        context,
      );
    expect(result?.content[0]?.text).toContain("agent-complete was already finished");
    expect(result?.content[0]?.text).toContain("agent-failed had already failed");
    expect(result?.content[0]?.text).toContain("agent-stopped is stopped.");
  });

  it("returns structured failures for single-target reply and rename operations", async () => {
    const service = {
      ...startCapturingService([]),
      reply: (id: string) =>
        Effect.fail(
          new InvalidSubagentRequestError({
            code: "no_parent_question",
            message: `Subagent ${id} has no pending parent question.`,
          }),
        ),
      rename: (id: string) =>
        Effect.fail(new SubagentNotFoundError({ id, message: `Subagent run not found: ${id}` })),
    };
    const tools = captureSubagentTools(service);

    const replied = await tools
      .get("subagent_reply")
      ?.execute("call", { runId: "agent-1", message: "Proceed." }, undefined, undefined, context);
    expect(replied?.content[0]?.text).toContain(
      "agent-1 [no_parent_question]: Subagent agent-1 has no pending parent question.",
    );
    expect(replied?.details).toMatchObject({
      actionFailures: [{ id: "agent-1", code: "no_parent_question" }],
    });

    const renamed = await tools
      .get("subagent_rename")
      ?.execute(
        "call",
        { runId: "agent-missing", name: "reviewer" },
        undefined,
        undefined,
        context,
      );
    expect(renamed?.content[0]?.text).toContain(
      "agent-missing [SubagentNotFoundError]: Subagent run not found: agent-missing",
    );
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

  it("returns status for found IDs and model-visible failures for stale IDs", async () => {
    const completed = view({ state: "completed", finalText: "Done." });
    const withStatusObservations: SubagentServiceShape["withStatusObservations"] = (ids, use) =>
      use({
        observations: ids.includes("agent-1") ? [{ run: completed }] : [],
        missingIds: ids.filter((id) => id !== "agent-1"),
      });
    const service = {
      ...startCapturingService([]),
      withStatusObservations,
    };
    const tool = captureSubagentTools(service).get("subagent_status");

    const result = await tool?.execute(
      "call",
      { runIds: ["agent-1", "agent-stale"] },
      undefined,
      undefined,
      context,
    );

    expect(result?.content[0]?.text).toContain("Final report\nDone.");
    expect(result?.content[0]?.text).toContain(
      "agent-stale [SubagentNotFoundError]: Subagent run not found: agent-stale",
    );
    expect(result?.details).toMatchObject({
      action: "status",
      actionFailures: [{ id: "agent-stale", code: "SubagentNotFoundError" }],
    });
  });

  it("returns await immediately when a subagent needs a parent reply", async () => {
    const waiting = view({
      state: "waiting_for_parent",
      question: {
        requestId: "question-1",
        message: "Should I update the fixture?",
        createdAt: 2,
      },
    });
    const withAwaitTerminalObservations: SubagentServiceShape["withAwaitTerminalObservations"] = (
      _ids,
      _until,
      _onUpdate,
      use,
    ) => use([{ run: waiting }]);
    const service = {
      ...startCapturingService([]),
      withAwaitTerminalObservations,
    };
    const tool = captureSubagentTools(service).get("subagent_await");

    const result = await tool?.execute(
      "call",
      { runIds: ["agent-1"], until: "all_finished", timeoutSeconds: 0 },
      undefined,
      undefined,
      context,
    );

    expect(result?.content[0]?.text).toContain(
      'Reply with subagent_reply({ runId: "agent-1", message: "..." }), then call subagent_await again.',
    );
    expect(result?.content[0]?.text).toContain("Question   Should I update the fixture?");
    expect(result?.details).toMatchObject({
      action: "await",
      attentionRequired: true,
      cards: [{ state: "waiting_for_parent" }],
    });
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

  it("enforces the final model-visible output bound for list, zero-run, and all-failure paths", async () => {
    const oversizedRuns = Array.from({ length: 12 }, (_, index) =>
      view({
        id: `agent-${index + 1}`,
        name: `run-${index + 1}`,
        model: `provider/${"m".repeat(8_000)}`,
      }),
    );
    const base = startCapturingService([]);
    const service = subagentServiceDouble({
      ...base,
      list: Effect.succeed(oversizedRuns),
      start: () =>
        Effect.fail(
          new InvalidSubagentRequestError({
            code: "all_failed",
            message: "f".repeat(64_000),
          }),
        ),
    });
    const tools = captureSubagentTools(service);
    const listed = await tools
      .get("subagent_list")
      ?.execute("call", {}, undefined, undefined, context);
    expect(listed?.content[0]?.text.length).toBeLessThanOrEqual(48_000);
    expect(listed?.content[0]?.text).toContain("tool output truncated; narrow the request");

    const emptyService = subagentServiceDouble({ ...base, list: Effect.succeed([]) });
    const empty = await captureSubagentTools(emptyService)
      .get("subagent_list")
      ?.execute("call", {}, undefined, undefined, context);
    expect(empty?.content[0]?.text).toBe("No subagent runs.");
    expect(empty?.content[0]?.text.length).toBeLessThanOrEqual(48_000);

    const failed = await tools.get("subagent_start")?.execute(
      "call",
      {
        agents: Array.from({ length: 12 }, (_, index) => ({
          task: `Fail ${index + 1}`,
          backend: "pi" as const,
          writeIntent: "read-only" as const,
        })),
      },
      undefined,
      undefined,
      context,
    );
    expect(failed?.content[0]?.text.length).toBeLessThanOrEqual(48_000);
    expect(failed?.content[0]?.text).toContain("Failed starts (12)");
  });

  it("returns launch-ready discovery values that round-trip into start verbatim", async () => {
    const requests: StartSubagentRequest[] = [];
    const service = startCapturingService(requests);
    const ctx = registryContext([
      { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT 5.6 Sol", reasoning: true },
      { provider: "anthropic", id: "claude-opus-5", name: "Claude Opus 5", reasoning: true },
    ]);
    const tools = captureSubagentTools(service, ["read", "grep"], defaultProfileService, {
      ensureClaudeReady: () => Effect.void,
    });

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

  it("discovers profiles, hides denied selectors, and marks discouraged selectors", async () => {
    const profiles = profileServiceFor({
      defaultProfile: "reviewer",
      denied: [{ backend: "pi", model: "openai-codex/gpt-5.6-sol" }],
      discouraged: [{ backend: "claude-cli", model: "fable" }],
    });
    const models = await captureSubagentTools(startCapturingService([]), ["read"], profiles)
      .get("subagent_models")
      ?.execute("call", { profile: "reviewer" }, undefined, undefined, context);
    const text = models?.content[0]?.text ?? "";
    expect(text).toContain("Configured default profile: reviewer");
    expect(text).toContain("reviewer · context=fresh · effort=high");
    expect(text).toContain("parent:default · skipped");
    expect(text).not.toContain("backend=pi model=openai-codex/gpt-5.6-sol");
    expect(text).toContain(
      "backend=claude-cli model=fable · Claude Fable (CLI alias) · reasoning · efforts=low,medium,high,xhigh,max · discouraged (explicit selection only)",
    );
    expect(models?.details as SubagentToolDetails | undefined).toMatchObject({
      version: 1,
      defaultProfile: "reviewer",
      profileIds: ["reviewer"],
    });
  });

  it("discovers and falls back past hard-incompatible Pi effort candidates", async () => {
    const requests: StartSubagentRequest[] = [];
    const profiles = profileServiceFor({
      profiles: {
        worker: [
          { model: "pi/zai/no-reasoning", effort: "high" },
          { model: "pi/openai/reasoning", effort: "high" },
        ],
      },
    });
    const ctx = registryContext([
      { provider: "zai", id: "no-reasoning", name: "No reasoning", reasoning: false },
      { provider: "openai", id: "reasoning", name: "Reasoning", reasoning: true },
    ]);
    const tools = captureSubagentTools(startCapturingService(requests), ["read"], profiles);
    const discovery = await tools
      .get("subagent_models")
      ?.execute("call", { profile: "worker" }, undefined, undefined, ctx);
    expect(discovery?.content[0]?.text).toContain("efforts=off");
    expect(discovery?.content[0]?.text).toContain("does not support required effort high");
    const started = await tools.get("subagent_start")?.execute(
      "call",
      {
        agents: [{ backend: "auto", profile: "worker", task: "Work", writeIntent: "read-only" }],
      },
      undefined,
      undefined,
      ctx,
    );
    expect(started?.details).not.toHaveProperty("startFailures");
    expect(requests[0]).toMatchObject({
      model: "openai/reasoning",
      selection: {
        candidateIndex: 1,
        skippedCandidates: [{ candidateIndex: 0, code: "pi_effort_unsupported" }],
      },
    });
  });

  it("uses captured cwd and trust even when invocation getters later change or throw", async () => {
    const requests: StartSubagentRequest[] = [];
    let cwdReads = 0;
    let trustReads = 0;
    const mutable = {
      ...(context as unknown as Record<string, unknown>),
    } as unknown as ExtensionContext;
    Object.defineProperty(mutable, "cwd", {
      configurable: true,
      get: () => {
        cwdReads += 1;
        throw new Error("stale cwd getter");
      },
    });
    Object.defineProperty(mutable, "isProjectTrusted", {
      configurable: true,
      get: () => {
        trustReads += 1;
        return () => true;
      },
    });
    const tools = captureSubagentTools(
      startCapturingService(requests),
      ["read"],
      defaultProfileService,
      undefined,
      { cwd: "/captured/project", projectTrusted: false },
    );
    const models = await tools
      .get("subagent_models")
      ?.execute("call", {}, undefined, undefined, mutable);
    expect(models?.content[0]?.text).not.toContain("backend=claude-cli");
    await tools.get("subagent_start")?.execute(
      "call",
      {
        agents: [
          {
            task: "Use captured environment",
            backend: "pi",
            writeIntent: "read-only",
          },
        ],
      },
      undefined,
      undefined,
      mutable,
    );
    expect(requests[0]).toMatchObject({ cwd: "/captured/project", projectTrusted: false });
    expect(cwdReads).toBe(0);
    expect(trustReads).toBe(0);
  });

  it("does not advertise claude-cli selectors when project trust is unavailable", async () => {
    const untrusted = {
      ...(context as unknown as Record<string, unknown>),
      isProjectTrusted: () => false,
    } as unknown as ExtensionContext;
    const models = await captureSubagentTools(
      startCapturingService([]),
      ["read"],
      defaultProfileService,
      undefined,
      { cwd: "/project", projectTrusted: false },
    )
      .get("subagent_models")
      ?.execute("call", {}, undefined, undefined, untrusted);
    expect(modelViews(models).map((model) => model.backend)).toEqual(["pi"]);
    expect(models?.content[0]?.text).not.toContain("backend=claude-cli");
  });

  it("marks oracle routing unavailable when the parent cannot be forked", async () => {
    const ephemeral = {
      ...(context as unknown as Record<string, unknown>),
      sessionManager: {
        ...context.sessionManager,
        getSessionFile: () => undefined,
        getLeafEntry: () => undefined,
      },
    } as unknown as ExtensionContext;
    const models = await captureSubagentTools(startCapturingService([]))
      .get("subagent_models")
      ?.execute("call", { profile: "oracle" }, undefined, undefined, ephemeral);
    const text = models?.content[0]?.text ?? "";
    expect(text).toContain("oracle · context=fork · effort=high");
    expect(text).toContain("parent:default · skipped");
    expect(text).toContain("Forked context requires a persisted parent session");
  });

  it("states that discovery eligibility uses each profile's default context and can change with an override", async () => {
    const ephemeral = {
      ...(context as unknown as Record<string, unknown>),
      sessionManager: {
        ...context.sessionManager,
        getSessionFile: () => undefined,
        getLeafEntry: () => undefined,
      },
    } as unknown as ExtensionContext;
    const models = await captureSubagentTools(startCapturingService([]))
      .get("subagent_models")
      ?.execute("call", { profile: "oracle" }, undefined, undefined, ephemeral);
    const text = models?.content[0]?.text ?? "";
    // Oracle's skips below reflect its default fork context; an explicit context=fresh launch can
    // still be eligible, and the output must say so.
    expect(text).toContain(
      "Candidate eligibility below is evaluated with each profile's default context",
    );
    expect(text).toContain(
      "an explicit context override at launch (for example oracle with context=fresh) can change which candidates are eligible",
    );
  });

  it("renders explicitly repeated parent candidates in declared order", async () => {
    const profiles = profileServiceFor({
      profiles: {
        delegate: [
          { model: "parent", effort: "default" },
          { model: "parent", effort: "high" },
        ],
      },
    });
    const models = await captureSubagentTools(startCapturingService([]), ["read"], profiles)
      .get("subagent_models")
      ?.execute("call", { profile: "delegate" }, undefined, undefined, context);
    const text = models?.content[0]?.text ?? "";
    expect(text).toContain("1. parent:default · eligible");
    expect(text).toContain("2. parent:high · eligible");
    expect(text).not.toContain("fallback");
  });

  it("renders parent_model_missing skips when no parent model is active", async () => {
    const noParent = {
      ...(context as unknown as Record<string, unknown>),
      model: undefined,
    } as unknown as ExtensionContext;
    const models = await captureSubagentTools(startCapturingService([]))
      .get("subagent_models")
      ?.execute("call", { profile: "delegate" }, undefined, undefined, noParent);
    const text = models?.content[0]?.text ?? "";
    expect(text).toContain("parent:default · skipped · No active parent model is available.");
  });

  it("bounds aggregate profile and selector discovery output", async () => {
    const selector = `provider/${"x".repeat(244)}`;
    const profiles = profileServiceFor({
      profiles: Object.fromEntries(
        PROFILE_IDS.map((profile) => [
          profile,
          Array.from({ length: 32 }, () => ({
            model: `pi/${selector}`,
            effort: "default",
          })),
        ]),
      ),
    });
    const models = await captureSubagentTools(startCapturingService([]), ["read"], profiles)
      .get("subagent_models")
      ?.execute("call", {}, undefined, undefined, context);
    const text = models?.content[0]?.text ?? "";
    expect(text.length).toBeLessThanOrEqual(48_000);
    expect(text).toContain("[tool output truncated; narrow the request");
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

  it("marks discovery output only when matching selectors were actually truncated", async () => {
    const catalogOf = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        provider: "provider",
        id: `model-${index + 1}`,
        name: `Model ${index + 1}`,
        reasoning: true,
      }));
    const tool = captureSubagentTools(startCapturingService([])).get("subagent_models");

    const truncated = await tool?.execute(
      "call",
      {},
      undefined,
      undefined,
      registryContext(catalogOf(105)),
    );
    expect(modelViews(truncated)).toHaveLength(32);
    expect(truncated?.details).toMatchObject({ modelCount: 100 });
    expect(truncated?.content[0]?.text).toContain(
      "Showing the first 100 matching selectors; narrow query or backend to search further.",
    );

    // Exactly at the cap: nothing was dropped, so the marker would be untruthful.
    const exact = await tool?.execute(
      "call",
      { backend: "pi" },
      undefined,
      undefined,
      registryContext(catalogOf(100)),
    );
    expect(modelViews(exact)).toHaveLength(32);
    expect(exact?.details).toMatchObject({ modelCount: 100 });
    expect(exact?.content[0]?.text).not.toContain("matching selectors; narrow query");
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
          { task: "Probe", backend: "claude-cli", model: "gpt-4o", writeIntent: "read-only" },
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
        { index: 3, code: "claude_model_invalid" },
      ],
    });
    expect(result?.content[0]?.text).toContain('backend "pi"');
  });

  it("returns Claude fork incompatibility before malformed parent state or preflight", async () => {
    const requests: StartSubagentRequest[] = [];
    let preflightCalls = 0;
    const tool = captureSubagentTools(
      startCapturingService(requests),
      ["read"],
      defaultProfileService,
      {
        ensureClaudeReady: () => {
          preflightCalls += 1;
          return Effect.void;
        },
      },
    ).get("subagent_start");
    const malformedParent = {
      ...(context as unknown as Record<string, unknown>),
      sessionManager: {
        getSessionFile: () => {
          throw new Error("ephemeral session file");
        },
        getLeafEntry: () => {
          throw new Error("malformed leaf");
        },
        getSessionId: () => "parent",
      },
    } as unknown as ExtensionContext;

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
        ],
      },
      undefined,
      undefined,
      malformedParent,
    );
    expect(result?.details).toMatchObject({
      startFailures: [{ code: "claude_context_unsupported" }],
    });
    expect(preflightCalls).toBe(0);
    expect(requests).toEqual([]);
  });

  it("rejects claude-cli fork context and unsupported efforts before launch", async () => {
    const requests: StartSubagentRequest[] = [];
    const service = startCapturingService(requests);
    let preflightCalls = 0;
    const tool = captureSubagentTools(service, ["read"], defaultProfileService, {
      ensureClaudeReady: () => {
        preflightCalls += 1;
        return Effect.void;
      },
    }).get("subagent_start");

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
    expect(preflightCalls).toBe(0);
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
