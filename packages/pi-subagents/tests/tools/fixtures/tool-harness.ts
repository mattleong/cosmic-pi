// Promise assertions are test-runner boundaries.
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import type { BackendDriver } from "../../../src/backend/model.ts";
import {
  SubagentBackendRegistry,
  type SubagentBackendRegistryContract,
} from "../../../src/backend/service.ts";
import { resolveSubagentConfig } from "../../../src/config/options.ts";
import { decodeSubagentConfig } from "../../../src/config/schema.ts";
import {
  makeSubagentProfileService,
  SubagentProfileService,
} from "../../../src/profiles/service.ts";
import type { DeclaredProfileRoute, ProfileId } from "../../../src/profiles/model.ts";
import type { SessionProfileOverrideSeed } from "../../../src/profiles/session-overrides.ts";
import { InvalidSubagentRequestError } from "../../../src/run/errors.ts";
import { type StartSubagentRequest, type SubagentRunView } from "../../../src/run/model.ts";
import { SubagentService, type SubagentServiceContract } from "../../../src/run/service.ts";
import type { SubagentToolRuntime } from "../../../src/tools/execute.ts";
import { registerSubagentTools } from "../../../src/tools/subagent.ts";
import { subagentServiceDouble } from "./subagent-service-double.ts";

type NativeCapturedTool = ToolDefinition<any, any, any>;
type NativeExecute = NativeCapturedTool["execute"];
type NativeRenderResult = NonNullable<NativeCapturedTool["renderResult"]>;
type CapturedToolResult = Omit<Awaited<ReturnType<NativeExecute>>, "content"> & {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
};

type CapturedRenderResult = {
  readonly content: ReadonlyArray<{
    readonly type: string;
    readonly text?: string;
    readonly data?: string;
    readonly mimeType?: string;
  }>;
  readonly details?: unknown;
};

export type CapturedTool = Omit<NativeCapturedTool, "execute" | "renderResult"> & {
  readonly execute: (
    id: Parameters<NativeExecute>[0],
    params: Parameters<NativeExecute>[1],
    signal?: Parameters<NativeExecute>[2],
    onUpdate?: Parameters<NativeExecute>[3],
    ctx?: Parameters<NativeExecute>[4],
  ) => Promise<CapturedToolResult>;
  readonly renderResult?: (
    result: CapturedRenderResult,
    options: Parameters<NativeRenderResult>[1],
    theme: Parameters<NativeRenderResult>[2],
    context?: Parameters<NativeRenderResult>[3],
  ) => ReturnType<NativeRenderResult>;
};

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
  openaiFastMode: false,
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

const profileDocument = <Input extends object>(input: Input | undefined) => {
  // SAFETY: This harness accepts only JSON-shaped profile fixtures and immediately decodes them.
  const value = (input ?? {}) as Input & {
    readonly profiles?: Partial<Readonly<Record<ProfileId, DeclaredProfileRoute>>>;
  };
  const { profiles, ...rest } = value;
  return {
    version: 6,
    ...rest,
    ...(profiles !== undefined && {
      defaultProfileSet: "default",
      profileSets: { default: { profiles } },
    }),
  };
};

export const profileServiceFor = <Global extends object = never, Project extends object = never>(
  global: Global | undefined,
  project?: Project,
  initialSessionOverrides?: SessionProfileOverrideSeed,
) =>
  Effect.runSync(
    makeSubagentProfileService(
      resolveSubagentConfig(
        (() => {
          const baseResult = {
            globalConfigPath: "/agent/pi-subagents.json",
            projectConfigPath: "/project/.pi/pi-subagents.json",
            projectTrusted: true,
            globalConfigExists: global !== undefined,
            projectConfigExists: project !== undefined,
            global: decodeSubagentConfig(profileDocument(global)),
          };
          const withProject =
            project === undefined
              ? baseResult
              : { ...baseResult, project: decodeSubagentConfig(profileDocument(project)) };
          return withProject;
        })(),
      ),
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
  service: SubagentServiceContract,
  activeTools: ReadonlyArray<string> = ["read"],
  profileService = fallbackProfileService,
  backendRegistry: SubagentBackendRegistryContract | undefined = undefined,
  environment = { cwd: "/project", projectTrusted: true },
  thinkingLevel: string | number = "high",
  startUiTicker?: SubagentToolRuntime["startUiTicker"],
  toolPresentation?: SubagentToolRuntime["toolPresentation"],
): ReadonlyMap<string, CapturedTool> => {
  const tools = new Map<string, CapturedTool>();
  const piFixture = {
    registerTool: (tool: CapturedTool) => tools.set(tool.name, tool),
    getThinkingLevel: () => thinkingLevel,
    getActiveTools: () => [...activeTools],
  };
  // SAFETY: registerSubagentTools uses only the three ExtensionAPI methods implemented by this fixture.
  const pi = piFixture as typeof piFixture & ExtensionAPI;
  const run: SubagentToolRuntime["run"] = (effect, signal) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(SubagentService, service),
        Effect.provideService(SubagentProfileService, profileService),
        Effect.provideService(SubagentBackendRegistry, backendRegistry ?? testBackendRegistry),
      ),
      signal ? { signal } : undefined,
    );
  registerSubagentTools(
    pi,
    (() => {
      const baseResult = {};
      const withStartUiTicker = startUiTicker ? { ...baseResult, startUiTicker } : baseResult;
      const withToolPresentation = toolPresentation
        ? { ...withStartUiTicker, toolPresentation }
        : withStartUiTicker;
      return { ...withToolPresentation, environment, run };
    })(),
  );
  return tools;
};

const contextFixture = {
  cwd: "/project",
  mode: "tui" as const,
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
  scopedModels: [],
  thinkingLevel: "high" as const,
  isIdle: () => true,
  isProjectTrusted: () => true,
  signal: undefined,
  abort: () => undefined,
  hasPendingMessages: () => false,
  shutdown: () => undefined,
  getContextUsage: () => undefined,
  compact: () => undefined,
  getSystemPrompt: () => "",
};
const makeContextFixture = (): ExtensionContext => {
  // SAFETY: The fixture implements every ExtensionContext member used by subagent tool registration and execution.
  return contextFixture as typeof contextFixture & ExtensionContext;
};
export const context = makeContextFixture();

export const startCapturingService = (requests: StartSubagentRequest[]) =>
  subagentServiceDouble({
    start: (input) =>
      Effect.sync(() => {
        requests.push(input);
        return view(
          (() => {
            const baseResult = {
              id: `agent-${requests.length}`,
              host: input.host,
              runtime: input.runtime,
              closeOnReport: input.closeOnReport,
              openaiFastMode: input.openaiFastMode,
              context: input.context,
              writeIntent: input.writeIntent,
              model: input.model,
              effort: input.effort,
              selection: input.selection ?? view().selection,
            };
            const withProfile = input.profile
              ? { ...baseResult, profile: input.profile }
              : baseResult;
            return withProfile;
          })(),
        );
      }),
  });
