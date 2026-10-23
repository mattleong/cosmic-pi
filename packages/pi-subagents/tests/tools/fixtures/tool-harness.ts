import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  defineTool,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionToolContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import type { BackendDriver } from "../../../src/backend/model.ts";
import {
  SubagentBackendRegistry,
  type SubagentBackendRegistryContract,
} from "../../../src/backend/service.ts";
import { resolveSubagentConfig } from "../../../src/config/options.ts";
import { decodeSubagentConfig, type SubagentNestingPolicy } from "../../../src/config/schema.ts";
import {
  SubagentProfileService,
  subagentProfileServiceLayerFor,
  type SubagentProfileServiceContract,
} from "../../../src/profiles/service.ts";
import type { ProfileCandidate, ProfileId } from "../../../src/profiles/model.ts";
import type { SessionProfileOverrideSeed } from "../../../src/profiles/session-overrides.ts";
import { InvalidSubagentRequestError } from "../../../src/run/errors.ts";
import type { StartSubagentRequest } from "../../../src/run/model.ts";
import { SubagentService, type SubagentServiceContract } from "../../../src/run/service.ts";
import type { SubagentToolRuntime } from "../../../src/tools/execute.ts";
import { registerSubagentTools } from "../../../src/tools/subagent.ts";
import { subagentServiceDouble } from "./subagent-service-double.ts";
import type { JsonValue } from "pi-cosmic-core";
import { extensionApiFixture, extensionContextFixture, modelFixture } from "pi-cosmic-core/testing";
import { view } from "../../fixtures/run-view.ts";
import { maybe } from "../../support/effect-test.ts";

export { view };

type RegisteredTool = ToolDefinition;
type NativeExecute = RegisteredTool["execute"];
type CapturedToolResult = Omit<Awaited<ReturnType<NativeExecute>>, "content"> & {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
};

type CapturedTool = Omit<RegisteredTool, "execute"> & {
  readonly execute: (
    id: Parameters<NativeExecute>[0],
    params: Parameters<NativeExecute>[1],
    signal: Parameters<NativeExecute>[2],
    onUpdate: Parameters<NativeExecute>[3],
    ctx: Parameters<NativeExecute>[4],
  ) => Promise<CapturedToolResult>;
};

interface ProfileDocumentInput {
  readonly profiles?: Partial<
    Readonly<Record<ProfileId, ProfileCandidate | ReadonlyArray<ProfileCandidate> | JsonValue>>
  >;
  readonly nesting?: SubagentNestingPolicy;
  readonly agents?: JsonValue;
}

const profileDocument = (input: ProfileDocumentInput | undefined) => {
  if (input === undefined) return { version: 6 };
  const { profiles, ...rest } = input;
  return {
    version: 6,
    ...rest,
    ...(profiles !== undefined && {
      defaultProfileSet: "default",
      profileSets: { default: { profiles } },
    }),
  };
};

export const profileServiceFor = (
  global: ProfileDocumentInput | undefined,
  project?: ProfileDocumentInput,
  initialSessionOverrides?: SessionProfileOverrideSeed,
) =>
  Effect.runSync(
    Effect.provide(
      SubagentProfileService.use(Effect.succeed),
      subagentProfileServiceLayerFor(
        resolveSubagentConfig({
          globalConfigPath: "/agent/pi-subagents.json",
          projectConfigPath: "/project/.pi/pi-subagents.json",
          projectTrusted: true,
          global: decodeSubagentConfig(profileDocument(global)),
          ...(project !== undefined && { project: decodeSubagentConfig(profileDocument(project)) }),
        }),
        { initialSessionOverrides },
      ),
    ),
  );

export const fallbackProfileService = profileServiceFor(undefined);
export const testBackendDriver = {
  runtime: "pi",
  capabilities: [],
  supportsContext: () => true,
  preflight: () => Effect.void,
  spawn: () => Effect.die("unused"),
} satisfies BackendDriver;
const fixtureBackend = (selection: { readonly runtime: string }) =>
  selection.runtime === "pi"
    ? Effect.succeed(testBackendDriver)
    : Effect.fail(
        InvalidSubagentRequestError.make({
          code: "backend_not_implemented",
          message: `local/${selection.runtime} is unavailable in this fixture.`,
        }),
      );
export const testBackendRegistry = { resolve: fixtureBackend, preflight: fixtureBackend };

export type CaptureOptions = {
  readonly activeTools?: ReadonlyArray<string>;
  readonly profiles?: SubagentProfileServiceContract;
  readonly registry?: SubagentBackendRegistryContract;
  readonly environment?: SubagentToolRuntime["environment"];
  readonly thinkingLevel?: ReturnType<ExtensionAPI["getThinkingLevel"]>;
  readonly startUiTicker?: SubagentToolRuntime["startUiTicker"];
  readonly toolPresentation?: SubagentToolRuntime["toolPresentation"];
};

const textResult = <Details>(result: AgentToolResult<Details>): CapturedToolResult => ({
  ...result,
  content: result.content.filter((part) => part.type === "text"),
});

const capturedTool = (tool: RegisteredTool): CapturedTool => ({
  ...tool,
  execute: (id, params, signal, onUpdate, ctx) =>
    tool.execute(id, params, signal, onUpdate, ctx).then(textResult),
});

export const captureSubagentTools = (
  service: SubagentServiceContract,
  {
    activeTools = ["read"],
    profiles = fallbackProfileService,
    registry = testBackendRegistry,
    environment = { cwd: "/project", projectTrusted: true },
    thinkingLevel = "high",
    startUiTicker,
    toolPresentation,
  }: CaptureOptions = {},
): ReadonlyMap<string, CapturedTool> => {
  const tools = new Map<string, CapturedTool>();
  const pi = extensionApiFixture({
    registerTool: (tool) => {
      tools.set(tool.name, capturedTool(defineTool(tool)));
    },
    getThinkingLevel: () => thinkingLevel,
    getActiveTools: () => [...activeTools],
  });
  registerSubagentTools(pi, {
    startUiTicker,
    toolPresentation,
    environment,
    agents: Effect.runSync(profiles.capture).effectiveConfig.agents,
    run: (effect, signal) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provideService(SubagentService, service),
          Effect.provideService(SubagentProfileService, profiles),
          Effect.provideService(SubagentBackendRegistry, registry),
        ),
        signal ? { signal } : undefined,
      ),
  });
  return tools;
};

const parentModel = modelFixture({
  provider: "openai-codex",
  id: "gpt-5.6-sol",
  name: "GPT 5.6 Sol",
  reasoning: true,
  thinkingLevelMap: { xhigh: "xhigh", max: "max" },
});

export const context: ExtensionToolContext = extensionContextFixture({
  cwd: "/project",
  mode: "tui" as const,
  hasUI: true,
  ui: {
    confirm: () => Promise.resolve(true),
  },
  model: parentModel,
  modelRegistry: {
    find: () => parentModel,
    hasConfiguredAuth: () => true,
    getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
    getApiKeyAndHeaders: () => Promise.resolve({ ok: true, apiKey: "stored-key" }),
    getRegisteredProviderIds: () => [],
    getAvailable: () => [parentModel],
  },
  sessionManager: {
    getSessionFile: () => "/sessions/parent.jsonl",
    getSessionId: () => "parent-session",
    getLeafEntry: () => ({
      type: "message",
      id: "assistant-1",
      parentId: "user-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: fauxAssistantMessage(""),
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
});

type InvocationOptions = {
  readonly callID?: Parameters<NativeExecute>[0];
  readonly signal?: Parameters<NativeExecute>[2];
  readonly update?: Parameters<NativeExecute>[3];
  readonly context?: Parameters<NativeExecute>[4];
};

export const executeTool = <Result>(
  tool: {
    readonly execute: (
      id: Parameters<NativeExecute>[0],
      params: Parameters<NativeExecute>[1],
      signal: Parameters<NativeExecute>[2],
      onUpdate: Parameters<NativeExecute>[3],
      ctx: Parameters<NativeExecute>[4],
    ) => Promise<Result>;
  },
  params: Parameters<NativeExecute>[1],
  options: InvocationOptions = {},
) =>
  tool.execute(
    options.callID ?? "call",
    params,
    options.signal,
    options.update,
    options.context ?? context,
  );

export const invokeOptionalTool = (
  tool: CapturedTool | undefined,
  params: Parameters<NativeExecute>[1],
  options: InvocationOptions = {},
) => maybe(() => (tool ? executeTool(tool, params, options) : undefined));

export const startCapturingService = (requests: StartSubagentRequest[]) =>
  subagentServiceDouble({
    start: (input) =>
      Effect.sync(() => {
        requests.push(input);
        return view({
          id: `agent-${requests.length}`,
          runtime: input.runtime,
          openaiFastMode: input.openaiFastMode,
          context: input.context,
          writeIntent: input.writeIntent,
          model: input.model,
          effort: input.effort,
          selection: input.selection ?? view().selection,
          ...(input.modelOverride && { modelOverride: input.modelOverride }),
          ...(input.name !== undefined && { name: input.name }),
          ...(input.profile && { profile: input.profile }),
          ...(input.agent && { agent: input.agent }),
        });
      }),
  });
