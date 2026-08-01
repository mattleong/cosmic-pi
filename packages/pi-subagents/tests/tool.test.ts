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
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  resolveProfileStart,
  type SubagentProfileStartSpec,
} from "../src/boundary/host-profile-resolution.ts";
import type { BackendDriver } from "../src/backend/model.ts";
import {
  SubagentBackendRegistry,
  type SubagentBackendRegistryShape,
} from "../src/backend/service.ts";
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
import { makeCompactToolDetails, makeStartAwaitCardDetails } from "../src/tools/details.ts";
import {
  awaitResultBanner,
  registerSubagentTools,
  renderAwaitProgressComponent,
  renderExpandedStartAwaitResult,
  renderStartAwaitOverviewComponent,
  type SubagentToolRuntime,
} from "../src/tools/subagent.ts";

interface CapturedTool {
  readonly name: string;
  readonly description?: string;
  readonly renderShell?: "default" | "self";
  readonly renderCall?: (...args: ReadonlyArray<unknown>) => unknown;
  readonly renderResult?: (...args: ReadonlyArray<unknown>) => unknown;
  readonly promptGuidelines?: ReadonlyArray<string>;
  readonly parameters?: unknown;
  readonly prepareArguments?: (args: unknown) => unknown;
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
    source: "profile-candidate",
    reason: "Profile model selection.",
    skippedCandidates: [],
  },
  cwd: "/project",
  state: "running",
  execution: "background",
  context: "fresh",
  writeIntent: "read-only",
  fastMode: false,
  reportGeneration: 0,
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
      global: decodeSubagentConfig({ version: 4, ...((global ?? {}) as object) }),
      ...(project === undefined
        ? {}
        : { project: decodeSubagentConfig({ version: 4, ...(project as object) }) }),
    }),
  );

const defaultProfileService = profileServiceFor(undefined);
const testBackendDriver = {
  host: "local",
  runtime: "pi",
  capabilities: [],
  supportsContext: () => true,
  spawn: () => Effect.die("unused"),
} satisfies BackendDriver;
const testBackendRegistry = {
  resolve: (selection: { readonly host: string; readonly runtime: string }) =>
    selection.host === "local" && selection.runtime === "pi"
      ? Effect.succeed(testBackendDriver)
      : Effect.fail(
          new InvalidSubagentRequestError({
            code: "backend_not_implemented",
            message: `${selection.host}/${selection.runtime} is unavailable in this fixture.`,
          }),
        ),
  preflight: (selection: { readonly host: string; readonly runtime: string }) =>
    selection.host === "local" && selection.runtime === "pi"
      ? Effect.succeed(testBackendDriver)
      : Effect.fail(
          new InvalidSubagentRequestError({
            code: "backend_not_implemented",
            message: `${selection.host}/${selection.runtime} is unavailable in this fixture.`,
          }),
        ),
};

const captureSubagentTools = (
  service: SubagentServiceShape,
  activeTools: ReadonlyArray<string> = ["read"],
  profileService = defaultProfileService,
  backendRegistry: SubagentBackendRegistryShape | undefined = undefined,
  environment = { cwd: "/project", projectTrusted: true },
  thinkingLevel: unknown = "high",
  startUiTicker?: SubagentToolRuntime["startUiTicker"],
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
    ...(startUiTicker ? { startUiTicker } : {}),
    environment,
    run: (effect, signal) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provideService(SubagentService, service),
          Effect.provideService(SubagentProfileService, profileService),
          Effect.provideService(SubagentBackendRegistry, backendRegistry ?? testBackendRegistry),
        ),
        signal ? { signal } : undefined,
      ),
  });
  return tools;
};

const context = {
  cwd: "/project",
  hasUI: true,
  ui: {
    confirm: () => Promise.resolve(true),
  },
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

describe("subagent tool", () => {
  beforeAll(() => initTheme("dark", false));

  it("enforces the Pi read-only tool policy", () => {
    const tools = ["read", "grep", "edit", "write", "bash", "mcp"];
    expect(piToolsForWriteIntent(tools, "read-only")).toEqual(["read", "grep"]);
    expect(piToolsForWriteIntent(tools, "writer")).toEqual(tools);
  });

  it("removes every Herdr orchestration tool from parent-resolved writer tools", async () => {
    const herdrTools = [
      "herdr_agent_start",
      "herdr_agent_list",
      "herdr_agent_status",
      "herdr_agent_await",
      "herdr_agent_read",
      "herdr_agent_send",
      "herdr_agent_stop",
    ];
    const requests: StartSubagentRequest[] = [];
    const tool = captureSubagentTools(startCapturingService(requests), [
      "read",
      "edit",
      ...herdrTools,
    ]).get("subagent_start");

    await tool?.execute(
      "call",
      { agents: [{ task: "Implement auth", profile: "worker" }] },
      undefined,
      undefined,
      context,
    );

    expect(requests[0]?.writeIntent).toBe("writer");
    expect(requests[0]?.activeTools).toEqual(["read", "edit"]);
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
    expect(properties("subagent_models")).toEqual(["profile"]);
    expect(properties("subagent_start")).toEqual(["agents"]);
    expect(properties("subagent_list")).toEqual([]);
    expect(properties("subagent_status")).toEqual(["runIds"]);
    expect(properties("subagent_await")).toEqual(["runIds", "until"]);
    expect(schema("subagent_status")?.required).toEqual(["runIds"]);
    expect(schema("subagent_await")?.required).toEqual(["runIds", "until"]);
    expect(properties("subagent_send")).toEqual(["runIds", "message"]);
    expect(properties("subagent_reply")).toEqual(["runId", "message"]);
    expect(properties("subagent_lifecycle")).toEqual([]);
    const lifecycleBranches = schema("subagent_lifecycle")?.anyOf ?? [];
    expect(lifecycleBranches).toHaveLength(2);
    expect(Object.keys(lifecycleBranches[0]?.properties ?? {})).toEqual([
      "action",
      "runIds",
      "message",
    ]);
    expect(Object.keys(lifecycleBranches[1]?.properties ?? {})).toEqual(["action", "runIds"]);
    expect(lifecycleBranches.every((branch) => branch.additionalProperties === false)).toBe(true);
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
            readonly properties?: Readonly<
              Record<string, { readonly pattern?: string; readonly description?: string }>
            >;
            readonly required?: ReadonlyArray<string>;
          };
        };
      };
    };
    const startItem = startSchema.properties?.agents?.items;
    expect(startItem?.additionalProperties).toBe(false);
    expect(startItem?.required).toEqual(["task"]);
    expect(startItem?.properties?.task?.pattern).toBe(".*\\S.*");
    expect(startItem?.properties).not.toHaveProperty("backend");
    expect(startItem?.properties).not.toHaveProperty("model");
    const startTool = tools.get("subagent_start");
    const startParameters = startTool?.parameters as TSchema;
    expect(Check(startParameters, { agents: [{ profile: "scout", task: "Inspect" }] })).toBe(true);
    expect(
      Check(startParameters, {
        agents: [{ model: "pi/openai-codex/gpt-5.6-sol", profile: "scout", task: "Inspect" }],
      }),
    ).toBe(false);
    expect(
      Check(startParameters, {
        agents: [{ backend: "auto", profile: "scout", task: "Inspect" }],
      }),
    ).toBe(false);
    expect(
      Check(startParameters, {
        agents: [{ model: "openai-codex/gpt-5.6-sol", profile: "scout", task: "Inspect" }],
      }),
    ).toBe(false);
    expect(() => startTool?.prepareArguments?.({ task: "Inspect", profile: "scout" })).toThrow(
      "[legacy_start_shape]",
    );
    expect(() =>
      startTool?.prepareArguments?.({
        agents: [{ backend: "auto", profile: "scout", task: "Inspect" }],
      }),
    ).toThrow("[legacy_launch_override]");
    expect(() =>
      startTool?.prepareArguments?.({
        agents: [{ model: "openai/model", profile: "scout", task: "Inspect" }],
      }),
    ).toThrow("[legacy_launch_override]");
    for (const field of ["execution", "context", "writeIntent", "effort"])
      expect(() =>
        startTool?.prepareArguments?.({
          agents: [{ task: "Inspect", [field]: "legacy" }],
        }),
      ).toThrow("[legacy_launch_override]");
    expect(tools.get("subagent_start")?.description).toContain("background subagents");
    expect(tools.get("subagent_start")?.description).toContain(
      "selected profile supplies host, runtime, model, effort, context, write intent, fast mode, and closeOnReport",
    );
    expect(tools.get("subagent_status")?.description).toContain("capabilities");
    expect(tools.get("subagent_send")?.description).toContain("running subagents");
    expect(tools.get("subagent_reply")?.description).toContain("one subagent");
    expect(tools.get("subagent_lifecycle")?.description).toContain(
      "Message is accepted only for resume",
    );
    for (const tool of tools.values()) {
      expect(tool.renderShell).toBe("default");
      expect(tool.renderCall).toBeTypeOf("function");
      expect(tool.renderResult).toBeTypeOf("function");
    }
  });

  it("summarizes tool calls with user-facing actions and bounded task or message context", () => {
    const tools = captureSubagentTools({} as SubagentServiceShape);
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as unknown as Theme;
    const rendered = (name: string, args: unknown): string => {
      const component = tools.get(name)?.renderCall?.(args, theme) as
        | { readonly render: (width: number) => ReadonlyArray<string> }
        | undefined;
      return component?.render(240).join("\n") ?? "";
    };

    expect(
      rendered("subagent_start", {
        agents: [{ name: "auth-review", profile: "reviewer", task: "Review token refresh" }],
      }),
    ).toContain("Start 1 subagent auth-review [reviewer]: Review token refresh");
    expect(
      rendered("subagent_await", { runIds: ["agent-1", "agent-2"], until: "all_finished" }),
    ).toContain("Await 2 subagents until all finish · agent-1, agent-2");
    expect(
      rendered("subagent_send", { runIds: ["agent-1"], message: "Check migration tests" }),
    ).toContain("Guide 1 subagent agent-1 · “Check migration tests”");
    expect(
      rendered("subagent_reply", { runId: "agent-1", message: "Use the existing fixture" }),
    ).toContain("Reply to subagent agent-1 · “Use the existing fixture”");
    expect(
      rendered("subagent_lifecycle", {
        action: "resume",
        runIds: ["agent-1"],
        message: "Continue from the report",
      }),
    ).toContain("Resume 1 subagent agent-1 · “Continue from the report”");
    expect(rendered("subagent_models", { profile: "reviewer" })).toContain(
      "Inspect profile routes reviewer",
    );
    expect(rendered("subagent_send", { runIds: ["agent-1"], message: "x".repeat(500) })).toContain(
      "… [truncated]",
    );
  });

  it("does not let caller-owned fields override a focused tool action", async () => {
    const models = await captureSubagentTools({} as SubagentServiceShape)
      .get("subagent_models")
      ?.execute("call", { action: "start", profile: "scout" }, undefined, undefined, context);
    expect(models?.details).toMatchObject({ action: "models", profileIds: ["scout"] });
    expect(models?.content[0]?.text).toContain("scout —");
    expect(models?.content[0]?.text).toContain("source=builtin · defaults: context=fresh");
  });

  it("renders profile routes and management outcomes from structured persisted details", async () => {
    const tools = captureSubagentTools({} as SubagentServiceShape);
    const theme = {
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      bold: (text: string) => text,
    } as unknown as Theme;
    const models = await tools
      .get("subagent_models")
      ?.execute("call", { profile: "reviewer" }, undefined, undefined, context);
    const modelCard = tools
      .get("subagent_models")
      ?.renderResult?.(models, { isPartial: false, expanded: true }, theme) as
      | { readonly render: (width: number) => ReadonlyArray<string> }
      | undefined;
    const modelText = modelCard?.render(160).join("\n") ?? "";
    expect(modelText).toContain("Profile routes · static eligibility only · default generalist");
    expect(modelText).toContain("reviewer · built-in");
    expect(modelText).toContain("close after report");
    expect(modelText).toContain("Launch checks pending");

    const fastProfileTools = captureSubagentTools(
      {} as SubagentServiceShape,
      ["read"],
      profileServiceFor({
        profiles: {
          reviewer: {
            host: "local",
            runtime: "pi",
            model: "parent",
            effort: "default",
            context: "fresh",
            writeIntent: "read-only",
            fastMode: true,
          },
        },
      }),
    );
    const fastModels = await fastProfileTools
      .get("subagent_models")
      ?.execute("call", { profile: "reviewer" }, undefined, undefined, context);
    const fastModelCard = fastProfileTools
      .get("subagent_models")
      ?.renderResult?.(fastModels, { isPartial: false, expanded: true }, theme) as
      | { readonly render: (width: number) => ReadonlyArray<string> }
      | undefined;
    expect(fastModelCard?.render(160).join("\n")).toContain("local/pi · parent:default ⚡");

    const management = makeCompactToolDetails({
      action: "send",
      runs: [view({ id: "agent-1", name: "auth-review", state: "running" })],
      actionFailures: [
        { id: "missing-agent", code: "SubagentNotFoundError", message: "Run not found." },
      ],
    });
    const managementCard = tools
      .get("subagent_send")
      ?.renderResult?.(
        { content: [{ type: "text", text: "legacy acknowledgement" }], details: management },
        { isPartial: false, expanded: false },
        theme,
      ) as { readonly render: (width: number) => ReadonlyArray<string> } | undefined;
    const managementText = managementCard?.render(160).join("\n") ?? "";
    expect(managementText).toContain("Guidance · 1 delivered · 1 failed");
    expect(managementText).toContain("auth-review · agent-1");
    expect(managementText).toContain("Refresh run IDs with subagent_list");

    const pausedDetails = makeCompactToolDetails({
      action: "list",
      runs: [view({ state: "paused", capabilities: [] })],
    });
    const pausedCard = tools
      .get("subagent_list")
      ?.renderResult?.(
        { content: [{ type: "text", text: "paused" }], details: pausedDetails },
        { isPartial: false, expanded: false },
        theme,
      ) as { readonly render: (width: number) => ReadonlyArray<string> } | undefined;
    expect(pausedCard?.render(160).join("\n")).toContain(
      "cannot resume · stop it and start a replacement",
    );

    const statusDetails = makeCompactToolDetails({
      action: "status",
      runs: [view({ state: "completed", finalText: "## Summary\nEverything passed." })],
      includeReports: true,
    });
    const statusCard = tools
      .get("subagent_status")
      ?.renderResult?.(
        { content: [{ type: "text", text: "status fallback" }], details: statusDetails },
        { isPartial: false, expanded: true },
        theme,
      ) as { readonly render: (width: number) => ReadonlyArray<string> } | undefined;
    expect(statusCard?.render(160).join("\n")).toContain("Report 1 of 1 — auth-review");
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
        "<error>Waiting for all subagents · 2 of 4 subagents finished · 1 running · 1 waiting for reply</error>",
      );
      expect(rendered).toContain("<success>⠋ running-agent · agent-1</success>");
      expect(rendered).toContain("<warning>? waiting-agent · agent-2</warning>");
      expect(rendered).toContain("<warning>waiting for reply</warning>");
      expect(rendered).toContain(
        "<toolOutput>local/pi · openai-codex/gpt-5.6-sol:high</toolOutput>",
      );
      expect(rendered).toContain("<error>× failed-agent · agent-3</error>");
      expect(rendered).toContain("<muted>■ stopped-agent · agent-4</muted>");
      expect(progress([view({ state: "running" })], "any_finished")).toContain(
        "Waiting for first subagent · 0 of 1 subagents finished · 1 running",
      );
      expect(progress([view({ state: "completed" })], "all_finished")).toContain(
        "<success>1 subagent finished</success>",
      );
      expect(
        progress(
          [view({ state: "reported", reportGeneration: 2, closeOnReport: false })],
          "all_finished",
        ),
      ).toContain("<success>1 subagent finished</success>");
      expect(progress([view({ state: "running" })], "all_finished")).toContain(
        "<success>⠋ auth-review · agent-1</success>",
      );
      vi.setSystemTime(320);
      expect(progress([view({ state: "running" })], "all_finished")).toContain(
        "<success>⠹ auth-review · agent-1</success>",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows bounded elapsed activity and humanized aggregate usage", () => {
    const theme = {
      fg: (_color: string, text: string) => text,
    } as unknown as Theme;
    vi.useFakeTimers();
    try {
      vi.setSystemTime(11_000);
      const rendered = renderAwaitProgressComponent(
        [
          view({
            state: "running",
            startedAt: 1_000,
            lastActivityAt: 9_000,
            usage: {
              input: 10_000,
              output: 8_400,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 18_400,
              cost: 0.042,
            },
          }),
        ],
        "all_finished",
        theme,
      )
        .render(120)
        .join("\n");
      expect(rendered).toContain("Total usage · 18k tokens · $0.04");
      expect(rendered).toContain("running · 10s · active 2s ago");
    } finally {
      vi.useRealTimers();
    }
  });

  it("owns a repaint ticker while partial await cards contain animated runs", () => {
    let tick: (() => void) | undefined;
    const stop = vi.fn();
    const startUiTicker = vi.fn((_intervalMs: number, next: () => void) => {
      tick = next;
      return stop;
    });
    const awaitTool = captureSubagentTools(
      {} as SubagentServiceShape,
      ["read"],
      defaultProfileService,
      undefined,
      { cwd: "/project", projectTrusted: true },
      "high",
      startUiTicker,
    ).get("subagent_await");
    const invalidate = vi.fn();
    const state: Record<string, unknown> = {};
    const renderContext = {
      args: { runIds: ["agent-1"], until: "all_finished" },
      toolCallId: "await-call",
      invalidate,
      lastComponent: undefined,
      state,
      cwd: "/project",
      executionStarted: true,
      argsComplete: true,
      isPartial: true,
      expanded: false,
      showImages: false,
      isError: false,
    };
    const runningDetails = makeStartAwaitCardDetails({
      action: "await",
      runs: [view()],
      awaitUntil: "all_finished",
    });
    const partial = { content: [{ type: "text", text: "Waiting" }], details: runningDetails };
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as unknown as Theme;

    awaitTool?.renderResult?.(partial, { expanded: false, isPartial: true }, theme, renderContext);
    awaitTool?.renderResult?.(partial, { expanded: false, isPartial: true }, theme, renderContext);

    expect(startUiTicker).toHaveBeenCalledOnce();
    expect(startUiTicker).toHaveBeenCalledWith(160, expect.any(Function));
    tick?.();
    expect(invalidate).toHaveBeenCalledOnce();

    awaitTool?.renderResult?.(
      {
        content: [{ type: "text", text: "Cancelled" }],
        details: makeStartAwaitCardDetails({
          action: "await",
          runs: [view()],
          awaitUntil: "all_finished",
          cancelled: true,
        }),
      },
      { expanded: false, isPartial: true },
      theme,
      renderContext,
    );
    expect(stop).toHaveBeenCalledOnce();
    expect(state.piSubagentsAwaitTicker).toBeUndefined();
    expect(state.piSubagentsAwaitInvalidate).toBeUndefined();
  });

  it("renders partial batch starts as structured run cards", () => {
    const startTool = captureSubagentTools({} as SubagentServiceShape).get("subagent_start");
    const theme = {
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      bold: (text: string) => text,
    } as unknown as Theme;
    const component = startTool?.renderResult?.(
      {
        content: [{ type: "text", text: "Started 1 of 3 background subagents." }],
        details: makeStartAwaitCardDetails({
          action: "start",
          runs: [view({ name: "scout-one" })],
        }),
      },
      { expanded: false, isPartial: true },
      theme,
    ) as { render: (width: number) => string[] } | undefined;
    const rendered = component?.render(100).join("\n") ?? "";
    expect(rendered).toContain("Started 1 of 3");
    expect(rendered).toMatch(/<success>[^ ]+ scout-one · agent-1<\/success>/);
  });

  it("keeps partial batch-start outcomes in requested order, including pending launches", () => {
    const startTool = captureSubagentTools({} as SubagentServiceShape).get("subagent_start");
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as unknown as Theme;
    const component = startTool?.renderResult?.(
      {
        content: [{ type: "text", text: "legacy progress" }],
        details: makeStartAwaitCardDetails({
          action: "start",
          runs: [view({ id: "agent-2", name: "second-started" })],
          startEntries: [
            { index: 0, name: "first-pending", profile: "scout", status: "pending" },
            {
              index: 1,
              name: "second-started",
              profile: "reviewer",
              status: "started",
              runId: "agent-2",
            },
            { index: 2, name: "third-failed", profile: "worker", status: "failed" },
          ],
          startFailures: [{ index: 2, name: "third-failed", message: "No route" }],
        }),
      },
      { expanded: false, isPartial: true },
      theme,
    ) as { render: (width: number) => string[] } | undefined;
    const rendered = component?.render(120).join("\n") ?? "";
    expect(rendered).toContain("Processed 2 of 3 launches · 1 started · 1 failed · 1 pending");
    expect(rendered.indexOf("first-pending")).toBeLessThan(rendered.indexOf("second-started"));
    expect(rendered.indexOf("second-started")).toBeLessThan(rendered.indexOf("third-failed"));
  });

  it("projects legacy timeout, cancellation, and first-finished await outcomes", () => {
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
      text: "Parent reply required for 1 subagent",
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
    expect(
      awaitResultBanner({
        action: "await",
        runs: [
          view({
            name: "retained-agent",
            state: "reported",
            reportGeneration: 1,
            closeOnReport: false,
            endedAt: 5,
          }),
        ],
        awaitUntil: "any_finished",
      }),
    ).toEqual({ color: "accent", text: "retained-agent reported first · backend retained" });
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
      fastMode: true,
      state: "completed",
      finalText: "## Findings\nEverything passed.",
    });

    const compact = renderStartAwaitOverviewComponent([run], theme).render(120);
    expect(compact).toHaveLength(3);
    expect(compact[0]).toContain("✓ review-agent · …ent-secret-id");
    expect(compact[0]).toContain(
      "<toolOutput>local/pi · openai-codex/gpt-5.6-sol:high ⚡</toolOutput>",
    );
    expect(compact[0]).toContain("<success>finished</success>");
    expect(compact[1]).toContain("↳ review-agent: Findings");
    expect(compact[2]).toBe("<dim>▸ final report · expand to view</dim>");

    const expanded = renderExpandedStartAwaitResult([run], theme).render(120).join("\n");
    expect(expanded).toContain("<dim>▾ final report</dim>");
    expect(expanded).toContain("Report 1 of 1 — review-agent");
    expect(expanded).toContain("agent-secret-id");

    const markdown = renderExpandedStartAwaitResult([run], theme).render(80).join("\n");
    expect(markdown).toContain("Findings");
    expect(markdown).not.toContain("## Findings");
  });

  it("renders both a final report and failure when a run preserves both", () => {
    const theme = {
      fg: (_color: string, text: string) => text,
    } as unknown as Theme;
    const rendered = renderExpandedStartAwaitResult(
      [view({ state: "failed", finalText: "Partial findings", error: "Transport failed" })],
      theme,
    )
      .render(100)
      .join("\n");
    expect(rendered).toContain("Report 1 of 2 — auth-review");
    expect(rendered).toContain("Partial findings");
    expect(rendered).toContain("Failure 2 of 2 — auth-review");
    expect(rendered).toContain("Transport failed");
  });

  it("marks omitted card content and report truncation explicitly", () => {
    const theme = {
      fg: (_color: string, text: string) => text,
    } as unknown as Theme;
    const rendered = renderExpandedStartAwaitResult(
      [
        {
          ...view({ state: "completed", finalText: "Partial report" }),
          finalTextTruncated: true,
        },
      ],
      theme,
    )
      .render(100)
      .join("\n");
    expect(rendered).toContain("content truncated; use subagent_status");

    const compact = renderStartAwaitOverviewComponent(
      [view({ state: "completed", finalText: undefined })],
      theme,
    )
      .render(100)
      .join("\n");
    expect(compact).toContain("completed without a final report");
  });

  it("shows bounded raw tool output when persisted card content was omitted", () => {
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as unknown as Theme;
    const tool = captureSubagentTools(startCapturingService([])).get("subagent_start");
    const details = makeStartAwaitCardDetails({
      action: "start",
      runs: [
        {
          ...view({ state: "completed", finalText: undefined }),
          finalTextTruncated: true,
        },
      ],
      contentOmitted: true,
    });
    const component = tool?.renderResult?.(
      { content: [{ type: "text", text: "Recovered bounded report text." }], details },
      { isPartial: false, expanded: true },
      theme,
    ) as { readonly render: (width: number) => ReadonlyArray<string> } | undefined;
    const rendered = component?.render(100).join("\n") ?? "";
    expect(rendered).toContain("Recovered omitted output");
    expect(rendered).toContain("Recovered bounded report text.");
    expect(rendered).not.toContain("completed without a final report");
    const collapsed = tool?.renderResult?.(
      { content: [{ type: "text", text: "Recovered bounded report text." }], details },
      { isPartial: false, expanded: false },
      theme,
    ) as { readonly render: (width: number) => ReadonlyArray<string> } | undefined;
    expect(collapsed?.render(120).join("\n")).toContain("Some report content was omitted");
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
    expect(narrow[1]).toContain(":high");
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
    expect(compact).toContain("<success>● good-agent · agent-1</success>");
    expect(compact).toContain("<error>× broken-agent</error> · <error>failed to start</error>");
    expect(compact).toContain("<dim>spawn failed</dim>");
    expect(compact).toContain("▸ failure details · expand to view");

    const expanded = renderExpandedStartAwaitResult([view({ name: "good-agent" })], theme, failures)
      .render(120)
      .join("\n");
    expect(expanded).toContain("spawn failed");
  });

  it("uses short-form profile defaults, inherits model effort, and strips recursive tools", async () => {
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
        agents: [{ task: "Review auth" }],
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
      "Each agent item accepts task, optional profile, and optional name",
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

  it("does not request confirmation when launches use profile routing", async () => {
    const confirm = vi.fn(() => Promise.resolve(true));
    const requests: StartSubagentRequest[] = [];
    const tool = captureSubagentTools(startCapturingService(requests)).get("subagent_start");

    await tool?.execute(
      "call",
      { agents: [{ task: "Inspect auth", profile: "scout" }] },
      undefined,
      undefined,
      {
        ...(context as unknown as Record<string, unknown>),
        ui: { confirm },
      } as unknown as ExtensionContext,
    );

    expect(confirm).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.selection?.source).toBe("profile-parent-candidate");
  });

  it("routes the short form through the neutral generalist profile and records provenance", async () => {
    const requests: StartSubagentRequest[] = [];
    const tool = captureSubagentTools(startCapturingService(requests), ["read"]).get(
      "subagent_start",
    );

    await tool?.execute(
      "call",
      { agents: [{ task: "Inspect auth" }] },
      undefined,
      undefined,
      context,
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      backend: "pi",
      profile: "generalist",
      context: "fresh",
      model: "openai-codex/gpt-5.6-sol",
      selection: {
        source: "profile-parent-candidate",
        reason: "Profile generalist selected local/pi candidate 1.",
        skippedCandidates: [],
      },
    });
    expect(requests[0]?.profileGuidance).toContain("Act as a generalist");
  });

  it("accepts delegate as a compatibility alias but records generalist", async () => {
    const requests: StartSubagentRequest[] = [];
    const tools = captureSubagentTools(startCapturingService(requests), ["read"]);
    const tool = tools.get("subagent_start");

    const result = await tool?.execute(
      "call",
      { agents: [{ task: "Inspect auth", profile: "delegate" }] },
      undefined,
      undefined,
      context,
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.profile).toBe("generalist");
    expect(result?.details).toMatchObject({
      startEntries: [expect.objectContaining({ profile: "generalist" })],
    });

    const models = await tools
      .get("subagent_models")
      ?.execute("call", { profile: "delegate" }, undefined, undefined, context);
    expect(models?.details).toMatchObject({ profileIds: ["generalist"] });
  });

  it("routes every built-in profile through the tool boundary with its guidance and context", async () => {
    const requests: StartSubagentRequest[] = [];
    const tool = captureSubagentTools(startCapturingService(requests)).get("subagent_start");

    await tool?.execute(
      "call",
      {
        agents: PROFILE_IDS.map((profile) => ({
          profile,
          task: `Smoke test ${profile}`,
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
      planner: "xhigh",
      worker: "high",
      reviewer: "high",
      oracle: "high",
      generalist: "high",
    } as const;
    const expectedIntent = {
      scout: "read-only",
      researcher: "read-only",
      planner: "read-only",
      worker: "writer",
      reviewer: "read-only",
      oracle: "read-only",
      generalist: "read-only",
    } as const;
    for (const request of requests) {
      expect(request.backend).toBe("pi");
      expect(request.context).toBe(request.profile === "oracle" ? "fork" : "fresh");
      expect(request.effort).toBe(expectedEffort[request.profile ?? "generalist"]);
      expect(request.writeIntent).toBe(expectedIntent[request.profile ?? "generalist"]);
      // Built-in profile effort defaults are soft preferences, never hard requirements.
      expect(request.effortWasExplicit).toBe(false);
      expect(request.profileGuidance?.length).toBeGreaterThan(20);
      expect(request.selection).toMatchObject({
        source: "profile-parent-candidate",
        skippedCandidates: [],
      });
    }
  });

  it("uses the configured default profile when the short form omits profile", async () => {
    const requests: StartSubagentRequest[] = [];
    const profiles = profileServiceFor({ defaultProfile: "reviewer" });
    const tool = captureSubagentTools(startCapturingService(requests), ["read"], profiles).get(
      "subagent_start",
    );

    await tool?.execute("call", { agents: [{ task: "Review" }] }, undefined, undefined, context);

    expect(requests[0]).toMatchObject({
      profile: "reviewer",
      context: "fresh",
      selection: { source: "profile-parent-candidate" },
    });
    expect(requests[0]?.profileGuidance).toContain("independent reviewer");
  });

  it("uses profile context defaults and never degrades a Pi oracle fork to fresh", async () => {
    const requests: StartSubagentRequest[] = [];
    const tool = captureSubagentTools(startCapturingService(requests)).get("subagent_start");

    await tool?.execute(
      "call",
      {
        agents: [
          { profile: "reviewer", task: "Review" },
          { profile: "oracle", task: "Advise" },
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
        agents: [{ profile: "oracle", task: "Advise" }],
      },
      undefined,
      undefined,
      ephemeral,
    );
    expect(failed?.details).toMatchObject({
      startFailures: [{ code: "fork_context_unavailable" }],
    });
  });

  it("falls back from configured unsupported backends before local Pi service start", async () => {
    const requests: StartSubagentRequest[] = [];
    const profiles = profileServiceFor({
      profiles: {
        reviewer: [
          {
            host: "herdr",
            runtime: "claude",
            model: "sonnet",
            effort: "high",
            context: "fresh",
            writeIntent: "read-only",
            closeOnReport: false,
          },
          {
            host: "local",
            runtime: "pi",
            model: "parent",
            effort: "default",
            context: "fresh",
            writeIntent: "read-only",
          },
        ],
      },
    });
    const tool = captureSubagentTools(startCapturingService(requests), ["read"], profiles).get(
      "subagent_start",
    );

    await tool?.execute(
      "call",
      { agents: [{ profile: "reviewer", task: "Review" }] },
      undefined,
      undefined,
      context,
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      host: "local",
      runtime: "pi",
      closeOnReport: true,
      selection: {
        candidateIndex: 1,
        skippedCandidates: [{ candidateIndex: 0, code: "backend_not_implemented" }],
      },
    });
  });

  it("falls back across local auth and effort preflight skips before service ownership", async () => {
    const requests: StartSubagentRequest[] = [];
    const profiles = profileServiceFor({
      profiles: {
        reviewer: [
          {
            host: "local",
            runtime: "claude",
            model: "sonnet",
            effort: "xhigh",
            context: "fresh",
            writeIntent: "read-only",
          },
          {
            host: "local",
            runtime: "codex",
            model: "gpt-5.6-sol",
            effort: "max",
            context: "fresh",
            writeIntent: "read-only",
          },
          {
            host: "local",
            runtime: "pi",
            model: "parent",
            effort: "high",
            context: "fresh",
            writeIntent: "read-only",
          },
        ],
      },
    });
    const registry: SubagentBackendRegistryShape = {
      resolve: () => Effect.succeed(testBackendDriver),
      preflight: (selection) =>
        selection.runtime === "claude"
          ? Effect.fail(
              new InvalidSubagentRequestError({
                code: "claude_unauthenticated",
                message: "Claude fixture auth unavailable.",
              }),
            )
          : selection.runtime === "codex"
            ? Effect.fail(
                new InvalidSubagentRequestError({
                  code: "codex_effort_unsupported",
                  message: "Codex fixture effort unavailable.",
                }),
              )
            : Effect.succeed(testBackendDriver),
    };
    await captureSubagentTools(startCapturingService(requests), ["read"], profiles, registry)
      .get("subagent_start")
      ?.execute(
        "call",
        { agents: [{ profile: "reviewer", task: "Review" }] },
        undefined,
        undefined,
        context,
      );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      host: "local",
      runtime: "pi",
      selection: {
        candidateIndex: 2,
        skippedCandidates: [
          { candidateIndex: 0, code: "claude_unauthenticated" },
          { candidateIndex: 1, code: "codex_effort_unsupported" },
        ],
      },
    });
  });

  it("does not fall through after uncertain readiness-process cleanup", async () => {
    const requests: StartSubagentRequest[] = [];
    const profiles = profileServiceFor({
      profiles: {
        reviewer: [
          {
            host: "local",
            runtime: "claude",
            model: "sonnet",
            effort: "xhigh",
            context: "fresh",
            writeIntent: "read-only",
          },
          {
            host: "local",
            runtime: "pi",
            model: "parent",
            effort: "high",
            context: "fresh",
            writeIntent: "read-only",
          },
        ],
      },
    });
    const registry: SubagentBackendRegistryShape = {
      resolve: () => Effect.succeed(testBackendDriver),
      preflight: (selection) =>
        selection.runtime === "claude"
          ? Effect.fail(
              new InvalidSubagentRequestError({
                code: "claude_preflight_cleanup_unconfirmed",
                message: "Fixture readiness process cleanup is uncertain.",
              }),
            )
          : Effect.succeed(testBackendDriver),
    };
    const result = await captureSubagentTools(
      startCapturingService(requests),
      ["read"],
      profiles,
      registry,
    )
      .get("subagent_start")
      ?.execute(
        "call",
        { agents: [{ profile: "reviewer", task: "Review" }] },
        undefined,
        undefined,
        context,
      );
    expect(requests).toEqual([]);
    expect(result?.details).toMatchObject({
      startFailures: [{ code: "claude_preflight_cleanup_unconfirmed" }],
    });
  });

  it("fails an unsupported-only route before service start", async () => {
    const requests: StartSubagentRequest[] = [];
    const profiles = profileServiceFor({
      profiles: {
        reviewer: {
          host: "herdr",
          runtime: "codex",
          model: "gpt-5.4",
          effort: "high",
          context: "fresh",
          writeIntent: "read-only",
          closeOnReport: false,
        },
      },
    });
    const result = await captureSubagentTools(startCapturingService(requests), ["read"], profiles)
      .get("subagent_start")
      ?.execute(
        "call",
        { agents: [{ profile: "reviewer", task: "Review" }] },
        undefined,
        undefined,
        context,
      );
    expect(requests).toEqual([]);
    expect(result?.details).toMatchObject({
      startFailures: [{ code: "backend_not_implemented" }],
    });
  });

  it("does not fall through to another candidate after the selected start reaches the service", async () => {
    const profiles = profileServiceFor({
      profiles: {
        reviewer: [
          {
            host: "local",
            runtime: "pi",
            model: "openai-codex/gpt-5.6-sol",
            effort: "default",
            context: "fresh",
            writeIntent: "read-only",
          },
          {
            host: "local",
            runtime: "pi",
            model: "parent",
            effort: "default",
            context: "fresh",
            writeIntent: "read-only",
          },
        ],
      },
    });
    let starts = 0;
    const base = startCapturingService([]);
    const failStart: SubagentServiceShape["start"] = () => {
      starts += 1;
      return Effect.fail(
        new SubagentProcessError({
          operation: "spawn",
          code: "post_selection_start_failed",
          message: "Selected candidate failed after start ownership began.",
        }),
      );
    };
    const service = subagentServiceDouble({
      ...base,
      start: failStart,
      startSessionOwned: failStart,
    });
    const result = await captureSubagentTools(service, ["read"], profiles)
      .get("subagent_start")
      ?.execute(
        "call",
        {
          agents: [{ profile: "reviewer", task: "Review" }],
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

  it("clamps unknown host thinking levels to high instead of forwarding them to children", async () => {
    expect(decodeSubagentEffort("xhigh")).toBe("xhigh");
    expect(decodeSubagentEffort(" MAX ")).toBe("max");
    expect(decodeSubagentEffort("ultra")).toBeUndefined();
    expect(decodeSubagentEffort(42)).toBeUndefined();
    expect(decodeSubagentEffort(undefined)).toBeUndefined();

    const startWithLevel = async (thinkingLevel: unknown) => {
      const requests: StartSubagentRequest[] = [];
      const tools = captureSubagentTools(
        startCapturingService(requests),
        ["read"],
        defaultProfileService,
        undefined,
        { cwd: "/project", projectTrusted: true },
        thinkingLevel,
      );
      await tools
        .get("subagent_start")
        ?.execute(
          "automatic",
          { agents: [{ profile: "generalist", task: "Probe" }] },
          undefined,
          undefined,
          context,
        );
      return requests.map((request) => request.effort);
    };

    expect(await startWithLevel("low")).toEqual(["low"]);
    // Future or malformed host levels clamp to the shared "high" inheritance default.
    expect(await startWithLevel("ultra")).toEqual(["high"]);
    expect(await startWithLevel(42)).toEqual(["high"]);
    expect(await startWithLevel(" MEDIUM ")).toEqual(["medium"]);
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
          { profile: "future", task: "Unknown" },
          { profile: "reviewer", task: "Review" },
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
          { task: "Review auth", name: "auth" },
          { task: "Fail launch", name: "broken" },
          {
            task: "Review storage",
            name: "storage",
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
    expect(requests[0]).toMatchObject({
      host: "local",
      runtime: "pi",
      model: "openai-codex/gpt-5.6-sol",
      execution: "background",
      effort: "high",
    });
    expect(waited).toEqual([]);
    expect(result?.content[0]?.text).toContain("Failed starts (1)");
    expect(result?.content[0]?.text).toContain(
      "#2 broken [SubagentProcessError]: simulated launch failure",
    );
    expect(result?.content[0]?.text).toContain("agent-1");
    expect(result?.content[0]?.text).toContain("agent-3");
    expect(result?.details).toMatchObject({
      action: "start",
      cards: [{ id: "agent-1" }, { id: "agent-3" }],
      startFailures: [{ index: 1, name: "broken", message: "simulated launch failure" }],
    });
  });

  it("rejects foreground and other legacy launch overrides before side effects", async () => {
    const requests: StartSubagentRequest[] = [];
    const tool = captureSubagentTools(startCapturingService(requests)).get("subagent_start");

    for (const fields of [
      { execution: "foreground" },
      { context: "fresh" },
      { writeIntent: "writer" },
      { effort: "high" },
    ])
      await expect(
        tool?.execute(
          "call",
          { agents: [{ task: "Review auth", ...fields }] },
          undefined,
          undefined,
          context,
        ),
      ).rejects.toMatchObject({ code: "legacy_launch_override" });
    expect(requests).toEqual([]);
  });
  it("does not let a failed partial renderer turn a successful launch into failure", async () => {
    const requests: StartSubagentRequest[] = [];
    const tool = captureSubagentTools(startCapturingService(requests)).get("subagent_start");

    const result = await tool?.execute(
      "call",
      {
        agents: [{ task: "Review auth" }],
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

  it("launches through the cancellation-safe session owner", async () => {
    let sessionOwnedStarts = 0;
    const service = {
      start: () => Effect.die("interruptible start must not be used by the public tool"),
      startSessionOwned: (input: StartSubagentRequest) =>
        Effect.sync(() => {
          sessionOwnedStarts += 1;
          return view({ task: input.task });
        }),
    } as unknown as SubagentServiceShape;
    const tool = captureSubagentTools(service).get("subagent_start");

    const result = await tool?.execute(
      "call",
      { agents: [{ task: "Review auth" }] },
      undefined,
      undefined,
      context,
    );

    expect(sessionOwnedStarts).toBe(1);
    expect(result?.content[0]?.text).toContain("agent-1");
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
      tool?.execute(
        "call",
        { agents: [{ task: "Probe", model: " " }] },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toMatchObject({ code: "legacy_launch_override" });
    await expect(
      tool?.execute(
        "call",
        { agents: [{ task: "Probe", backend: "claude-cli" }] },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toMatchObject({ code: "legacy_launch_override" });
    await expect(
      tool?.execute("call", { agents: [] }, undefined, undefined, context),
    ).rejects.toThrow("requires between 1 and 12 agents");
    await expect(
      tool?.execute(
        "call",
        {
          agents: Array.from({ length: 13 }, (_, index) => ({
            task: `Review area ${index + 1}`,
          })),
        },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toThrow("requires between 1 and 12 agents");
  });

  it("rejects forged routing fields again at the host profile boundary", async () => {
    const pi = {
      getThinkingLevel: () => "high",
      getActiveTools: () => ["read"],
    } as unknown as ExtensionAPI;
    const reject = (input: SubagentProfileStartSpec) =>
      Effect.runPromise(
        resolveProfileStart(pi, input, context, {
          cwd: "/project",
          projectTrusted: true,
        }).pipe(
          Effect.provideService(SubagentProfileService, defaultProfileService),
          Effect.provideService(SubagentBackendRegistry, testBackendRegistry),
        ),
      );

    await expect(
      reject({ task: "Probe", model: "pi/openai/other" } as SubagentProfileStartSpec),
    ).rejects.toMatchObject({ code: "legacy_launch_override" });
    await expect(
      reject({ task: "Probe", backend: "claude-cli" } as SubagentProfileStartSpec),
    ).rejects.toMatchObject({ code: "legacy_launch_override" });
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
        agents: [{ task: "Review auth" }],
      },
      undefined,
      undefined,
      runtimeContext,
    );

    expect(request?.runtimeApiKey).toBe("runtime-key");
    expect(request?.model).toBe("openai-codex/gpt-5.6-sol");
  });

  it("privately transfers environment-authenticated models to Herdr Pi before ownership", async () => {
    const requests: StartSubagentRequest[] = [];
    const profiles = profileServiceFor({
      profiles: {
        reviewer: {
          host: "herdr",
          runtime: "pi",
          model: "openai-codex/gpt-5.6-sol",
          effort: "xhigh",
          context: "fresh",
          writeIntent: "read-only",
          closeOnReport: true,
        },
      },
    });
    const herdrPiDriver = {
      ...testBackendDriver,
      host: "herdr",
    } satisfies BackendDriver;
    let preflights = 0;
    const registry: SubagentBackendRegistryShape = {
      resolve: () => Effect.succeed(herdrPiDriver),
      preflight: () =>
        Effect.sync(() => {
          preflights += 1;
          return herdrPiDriver;
        }),
    };
    const environmentKey = "environment-only-private-key";
    const environmentContext = {
      ...context,
      modelRegistry: {
        ...context.modelRegistry,
        getProviderAuthStatus: () => ({ configured: true, source: "environment" }),
        getApiKeyAndHeaders: () => Promise.resolve({ ok: true as const, apiKey: environmentKey }),
      },
    } as unknown as ExtensionContext;

    const result = await captureSubagentTools(
      startCapturingService(requests),
      ["read"],
      profiles,
      registry,
    )
      .get("subagent_start")
      ?.execute(
        "call",
        { agents: [{ profile: "reviewer", task: "Review auth" }] },
        undefined,
        undefined,
        environmentContext,
      );

    expect(preflights).toBe(1);
    expect(requests[0]).toMatchObject({
      host: "herdr",
      runtime: "pi",
      runtimeApiKey: environmentKey,
    });
    expect(JSON.stringify(result)).not.toContain(environmentKey);

    const unavailableContext = {
      ...environmentContext,
      modelRegistry: {
        ...environmentContext.modelRegistry,
        getApiKeyAndHeaders: () => Promise.resolve({ ok: true as const }),
      },
    } as unknown as ExtensionContext;
    const skipped = await captureSubagentTools(
      startCapturingService(requests),
      ["read"],
      profiles,
      registry,
    )
      .get("subagent_start")
      ?.execute(
        "call",
        { agents: [{ profile: "reviewer", task: "Review auth" }] },
        undefined,
        undefined,
        unavailableContext,
      );
    expect(preflights).toBe(1);
    expect(skipped?.details).toMatchObject({
      startFailures: [{ code: "profile_no_eligible_model" }],
    });
    expect(JSON.stringify(skipped)).not.toContain(environmentKey);
  });

  it("returns formatted status metadata and one final report without activity duplication", async () => {
    const completed = view({
      state: "completed",
      endedAt: 2,
      profile: "reviewer",
      fastMode: true,
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
    expect(text).toContain("Route      local/pi · openai-codex/gpt-5.6-sol:high ⚡");
    expect(text).toContain("Retention  close after report · assignment 1");
    expect(text).toContain("Selection  profile-candidate candidate 2");
    expect(text).toContain("Reason     Profile reviewer selected configured candidate 2.");
    expect(text).toContain("Skipped    candidate 1 [model_discouraged]");
    expect(text).toContain(
      "Capabilities steer, interrupt, resume, rename-display, parent-contact, peer-notice, native-fork",
    );
    expect(text).toContain("Final report\nViewport report.");
    expect(text).not.toContain("Activity:");
    expect(text.match(/Viewport report\./g)).toHaveLength(1);
    expect(result?.details).toMatchObject({
      version: 1,
      action: "status",
      runIds: ["agent-1"],
      runCount: 1,
      cards: [{ id: "agent-1", finalText: "Viewport report." }],
    });

    const listed = await captureSubagentTools(service)
      .get("subagent_list")
      ?.execute("call", {}, undefined, undefined, context);
    expect(listed?.details).toMatchObject({
      version: 1,
      action: "list",
      runIds: ["agent-1"],
      runCount: 1,
      cards: [{ id: "agent-1" }],
    });
    const listDetails = listed?.details as
      | { cards?: ReadonlyArray<{ finalText?: string }> }
      | undefined;
    expect(listDetails?.cards?.[0]?.finalText).toBeUndefined();
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
      { runIds: ["agent-1", "agent-2"], until: "all_finished" },
      undefined,
      (result) => updates.push(result.content[0]?.text ?? ""),
      context,
    );
    expect(updates).toEqual([
      "Waiting for all subagents · 0 of 2 subagents finished · 2 running\n● auth-review (agent-1) · running\n● test-review (agent-2) · running",
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

  it("handles tool-level await cancellation with retained attention", async () => {
    const base = startCapturingService([]);
    const noProgressService = subagentServiceDouble({
      ...base,
      withAwaitTerminalObservations: () => Effect.never,
    });
    const waiting = view({
      id: "agent-question",
      state: "waiting_for_parent",
      question: { requestId: "question", message: "Which fixture?", createdAt: 2 },
    });
    const cancelService = subagentServiceDouble({
      ...base,
      withAwaitTerminalObservations: (_ids, _until, onUpdate) =>
        Effect.sync(() => onUpdate?.([waiting])).pipe(Effect.andThen(Effect.never)),
    });
    const updates: Array<{ readonly content: ReadonlyArray<{ readonly text: string }> }> = [];
    const controller = new AbortController();
    const executing = captureSubagentTools(cancelService)
      .get("subagent_await")
      ?.execute(
        "call",
        { runIds: [waiting.id], until: "all_finished" },
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

    const immediateUpdates: Array<{ readonly content: ReadonlyArray<{ readonly text: string }> }> =
      [];
    const immediateController = new AbortController();
    immediateController.abort();
    const immediate = captureSubagentTools(noProgressService)
      .get("subagent_await")
      ?.execute(
        "call",
        { runIds: [waiting.id], until: "all_finished" },
        immediateController.signal,
        (result) => immediateUpdates.push(result),
        context,
      );
    await expect(immediate).rejects.toBeDefined();
    expect(immediateUpdates.at(-1)?.content[0]?.text).toContain(
      "Await cancelled before progress was observed",
    );
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
      { runIds: ["agent-1"], until: "all_finished" },
      undefined,
      undefined,
      context,
    );

    expect(result?.content[0]?.text).toContain(
      'Reply with subagent_reply({ runId: "agent-1", message: "..." }), then call subagent_await again.',
    );
    expect(result?.content[0]?.text).toContain("Needs reply Should I update the fixture?");
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
          completionReceipt: { id, generation: 1, claimToken: `claim-${id}` },
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
    expect(consumed).toEqual([{ id: "agent-1", generation: 1, claimToken: "claim-agent-1" }]);
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
    const failStart: SubagentServiceShape["start"] = () =>
      Effect.fail(
        new InvalidSubagentRequestError({
          code: "all_failed",
          message: "f".repeat(64_000),
        }),
      );
    const service = subagentServiceDouble({
      ...base,
      list: Effect.succeed(oversizedRuns),
      start: failStart,
      startSessionOwned: failStart,
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
        })),
      },
      undefined,
      undefined,
      context,
    );
    expect(failed?.content[0]?.text.length).toBeLessThanOrEqual(48_000);
    expect(failed?.content[0]?.text).toContain("Failed starts (12)");
  });

  it("discovers and falls back past hard-incompatible Pi effort candidates", async () => {
    const requests: StartSubagentRequest[] = [];
    const profiles = profileServiceFor({
      profiles: {
        worker: [
          {
            host: "local",
            runtime: "pi",
            model: "zai/no-reasoning",
            effort: "high",
            context: "fresh",
            writeIntent: "writer",
          },
          {
            host: "local",
            runtime: "pi",
            model: "openai/reasoning",
            effort: "high",
            context: "fresh",
            writeIntent: "writer",
          },
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
    expect(discovery?.content[0]?.text).toContain("does not support required effort high");
    const started = await tools.get("subagent_start")?.execute(
      "call",
      {
        agents: [{ profile: "worker", task: "Work" }],
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
    expect(models?.content[0]?.text).toContain("Default profile: generalist");
    await tools.get("subagent_start")?.execute(
      "call",
      {
        agents: [{ task: "Use captured environment" }],
      },
      undefined,
      undefined,
      mutable,
    );
    expect(requests[0]).toMatchObject({ cwd: "/captured/project", projectTrusted: false });
    expect(cwdReads).toBe(0);
    expect(trustReads).toBe(0);
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
    expect(text).toContain("oracle —");
    expect(text).toContain(
      "source=builtin · defaults: context=fork · intent=read-only · effort=high",
    );
    expect(text).toContain(
      "local/pi/parent:default:fork:read-only:fastMode=false:closeOnReport=true · skipped",
    );
    expect(text).toContain("Forked context requires a persisted parent session");
  });

  it("states that complete context and capability choices come from v4 candidates", async () => {
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
    expect(text).toContain(
      "Each candidate lists host/runtime/model, effort, context, write intent, fast mode, and retention.",
    );
    expect(text).toContain("Forked context requires a persisted parent session");
  });

  it("renders explicitly repeated parent candidates in declared order", async () => {
    const profiles = profileServiceFor({
      profiles: {
        generalist: [
          {
            host: "local",
            runtime: "pi",
            model: "parent",
            effort: "default",
            context: "fresh",
            writeIntent: "read-only",
          },
          {
            host: "local",
            runtime: "pi",
            model: "parent",
            effort: "high",
            context: "fresh",
            writeIntent: "read-only",
          },
        ],
      },
    });
    const models = await captureSubagentTools(startCapturingService([]), ["read"], profiles)
      .get("subagent_models")
      ?.execute("call", { profile: "generalist" }, undefined, undefined, context);
    const text = models?.content[0]?.text ?? "";
    expect(text).toContain(
      "1. local/pi/parent:default:fresh:read-only:fastMode=false:closeOnReport=true · eligible",
    );
    expect(text).toContain(
      "2. local/pi/parent:high:fresh:read-only:fastMode=false:closeOnReport=true · eligible",
    );
    expect(
      text.match(
        /Candidate adapter is statically eligible before native authentication\/integration\/harness readiness\./g,
      ),
    ).toHaveLength(2);
    expect(text).not.toContain("Profile generalist selected");
    expect(text).not.toContain("Profile generalist selected");
  });

  it("renders parent_model_missing skips when no parent model is active", async () => {
    const noParent = {
      ...(context as unknown as Record<string, unknown>),
      model: undefined,
    } as unknown as ExtensionContext;
    const models = await captureSubagentTools(startCapturingService([]))
      .get("subagent_models")
      ?.execute("call", { profile: "generalist" }, undefined, undefined, noParent);
    const text = models?.content[0]?.text ?? "";
    expect(text).toContain(
      "local/pi/parent:default:fresh:read-only:fastMode=false:closeOnReport=true · skipped",
    );
    expect(text).toContain("No active parent model is available.");
  });
});
