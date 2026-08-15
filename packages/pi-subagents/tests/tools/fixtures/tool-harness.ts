// Promise assertions are test-runner boundaries.
// @effect-diagnostics effect/asyncFunction:off
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import type { BackendDriver } from "../../../src/backend/model.ts";
import {
  SubagentBackendRegistry,
  type SubagentBackendRegistryShape,
} from "../../../src/backend/service.ts";
import { resolveSubagentConfig } from "../../../src/config/options.ts";
import { decodeSubagentConfig } from "../../../src/config/schema.ts";
import {
  makeSubagentProfileService,
  SubagentProfileService,
} from "../../../src/profiles/service.ts";
import type { SessionProfileOverrideSeed } from "../../../src/profiles/session-overrides.ts";
import { InvalidSubagentRequestError } from "../../../src/run/errors.ts";
import { type StartSubagentRequest, type SubagentRunView } from "../../../src/run/model.ts";
import { SubagentService, type SubagentServiceShape } from "../../../src/run/service.ts";
import { subagentServiceDouble } from "./subagent-service-double.ts";
import { registerSubagentTools, type SubagentToolRuntime } from "../../../src/tools/subagent.ts";

export interface CapturedTool {
  readonly name: string;
  readonly description?: string;
  readonly renderShell?: "default" | "self";
  readonly renderCall?: (...args: ReadonlyArray<unknown>) => unknown;
  readonly renderResult?: (...args: ReadonlyArray<unknown>) => unknown;
  readonly promptSnippet?: string;
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

export const view = (overrides: Partial<SubagentRunView> = {}): SubagentRunView => ({
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
  context: "fresh",
  writeIntent: "read-only",
  fastMode: false,
  host: "local",
  runtime: "pi",
  closeOnReport: true,
  reportGeneration: 0,
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

export const profileServiceFor = (
  global: unknown,
  project?: unknown,
  initialSessionOverrides?: SessionProfileOverrideSeed,
) =>
  Effect.runSync(
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
      { initialSessionOverrides },
    ),
  );

export const fallbackProfileService = profileServiceFor(undefined);
export const testBackendDriver = {
  host: "local",
  runtime: "pi",
  capabilities: [],
  supportsContext: () => true,
  preflight: () => Effect.void,
  spawn: () => Effect.die("unused"),
} satisfies BackendDriver;
export const testBackendRegistry = {
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

export const captureSubagentTools = (
  service: SubagentServiceShape,
  activeTools: ReadonlyArray<string> = ["read"],
  profileService = fallbackProfileService,
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

export const context = {
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
    getRegisteredProviderIds: () => [],
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

export const registryContext = (
  available: ReadonlyArray<{
    readonly provider: string;
    readonly id: string;
    readonly name: string;
    readonly reasoning: boolean;
    readonly thinkingLevelMap?: Readonly<Record<string, string | null>>;
  }>,
  registeredProviderIds: ReadonlyArray<string> = [],
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
      getRegisteredProviderIds: () => [...registeredProviderIds],
    },
  }) as unknown as ExtensionContext;

export const startCapturingService = (requests: StartSubagentRequest[]) =>
  subagentServiceDouble({
    start: (input) =>
      Effect.sync(() => {
        requests.push(input);
        return view({
          id: `agent-${requests.length}`,
          model: input.model,
          selection: input.selection ?? view().selection,
          ...(input.profile ? { profile: input.profile } : {}),
        });
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
