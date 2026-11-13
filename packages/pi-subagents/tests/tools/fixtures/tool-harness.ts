import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  defineTool,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionToolContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { getTextContent, type CompactSummaryProvider } from "pi-code-previews";
import { issueMessageStyleProblems, renderContextFixture } from "pi-code-previews/testing";
import type { BackendDriver } from "../../../src/backend/model.ts";
import type { SubagentNotification } from "../../../src/boundary/host-notifier.ts";
import { SubagentBackendRegistry } from "../../../src/backend/service.ts";
import { resolveSubagentConfig } from "../../../src/config/options.ts";
import { decodeSubagentConfig, type SubagentNestingPolicy } from "../../../src/config/schema.ts";
import {
  SubagentProfileService,
  subagentProfileServiceLayerFor,
  type SubagentProfileServiceContract,
} from "../../../src/profiles/service.ts";
import type { ProfileCandidate, ProfileId } from "../../../src/profiles/model.ts";
import type { SessionProfileOverrideSeed } from "../../../src/profiles/session-overrides.ts";
import type { StartSubagentRequest } from "../../../src/run/model.ts";
import { SubagentService, type SubagentServiceContract } from "../../../src/run/service.ts";
import { SubagentStartDetailsSchema } from "../../../src/tools/details-schema.ts";
import type { SubagentToolRuntime } from "../../../src/tools/execute.ts";
import { registerSubagentTools } from "../../../src/tools/subagent.ts";
import { subagentServiceDouble } from "./subagent-service-double.ts";
import { makePiManagedRuntime, type JsonValue } from "pi-cosmic-core";
import {
  extensionApiFixture,
  extensionContextFixture,
  modelFixture,
  recordingExtensionHost,
} from "pi-cosmic-core/testing";
import { view } from "../../fixtures/run-view.ts";
import { inertDriver } from "../../run/fixtures/run-context.ts";
import type { eventBackendServiceFixture } from "../../run/fixtures/service-harness.ts";
import { maybe, step } from "../../support/effect-test.ts";
import * as Arr from "effect/Array";

export { view };

type RegisteredTool = ToolDefinition;
type NativeExecute = RegisteredTool["execute"];
type CapturedToolResult = Omit<Awaited<ReturnType<NativeExecute>>, "content"> & {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
};

type CapturedTool = Omit<RegisteredTool, "execute"> & {
  readonly execute: (...args: Parameters<NativeExecute>) => Promise<CapturedToolResult>;
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

export type CaptureOptions = {
  readonly activeTools?: ReadonlyArray<string>;
  readonly profiles?: SubagentProfileServiceContract;
  readonly registry?: BackendDriver;
  readonly environment?: SubagentToolRuntime["environment"];
  readonly thinkingLevel?: ReturnType<ExtensionAPI["getThinkingLevel"]>;
  readonly startUiTicker?: SubagentToolRuntime["startUiTicker"];
  readonly toolPresentation?: SubagentToolRuntime["toolPresentation"];
  /** The clock tool effects run on, such as the test's. */
  readonly clock?: Clock.Clock;
};

/** Provides a tool effect `service`, and by default the fallback profiles and the test backend. */
export const provideToolServices =
  (
    service: SubagentServiceContract,
    {
      profiles = fallbackProfileService,
      registry = inertDriver,
    }: {
      readonly profiles?: SubagentProfileServiceContract;
      readonly registry?: BackendDriver;
    } = {},
  ) =>
  <A, E>(
    effect: Effect.Effect<A, E, SubagentService | SubagentProfileService | SubagentBackendRegistry>,
  ): Effect.Effect<A, E> =>
    effect.pipe(
      Effect.provideService(SubagentService, service),
      Effect.provideService(SubagentProfileService, profiles),
      Effect.provideService(SubagentBackendRegistry, registry),
    );

const textResult = <Details>(result: AgentToolResult<Details>): CapturedToolResult => ({
  ...result,
  content: Arr.filter(result.content, (part) => part.type === "text"),
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
    registry = inertDriver,
    environment = { cwd: "/project", projectTrusted: true },
    thinkingLevel = "high",
    startUiTicker,
    toolPresentation,
    clock,
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
        effect.pipe(provideToolServices(service, { profiles, registry }), (provided) =>
          clock ? Effect.provideService(provided, Clock.Clock, clock) : provided,
        ),
        signal ? { signal } : undefined,
      ),
  });
  return tools;
};

/**
 * A tool registered without a service behind it, for tests that only render. `panel` says whether
 * the Activity panel draws a running wait's hierarchy.
 */
export const renderOnlyTool = (
  name: string,
  { panel }: { readonly panel?: boolean } = {},
): CapturedTool =>
  captureSubagentTools(subagentServiceDouble({}), {
    environment: { cwd: "/project", projectTrusted: false },
    ...(panel !== undefined && {
      startUiTicker: () => () => undefined,
      toolPresentation: {
        beginStart: () => () => undefined,
        beginAwait: () => () => undefined,
        isLiveHierarchyAvailable: () => panel,
      },
    }),
  }).get(name)!;

/**
 * A recording host with the subagent tools registered on a managed runtime that runs `fixture`'s
 * service and backend until scope close. `overrides` replaces parts of the tools' runtime, given
 * the default runner and the service.
 */
export const managedToolHost = (
  fixture: Pick<ReturnType<typeof eventBackendServiceFixture>, "layer" | "backend">,
  overrides: (host: {
    readonly run: SubagentToolRuntime["run"];
    readonly service: SubagentServiceContract;
  }) => Partial<SubagentToolRuntime> = () => ({}),
) =>
  Effect.gen(function* () {
    const { pi, tools } = recordingExtensionHost();
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(() =>
        makePiManagedRuntime(pi, Layer.merge(fixture.layer, fixture.backend.layer)),
      ),
      (owned) => step(() => owned.dispose()),
    );
    const service = yield* step(() => runtime.run(SubagentService));
    const run: SubagentToolRuntime["run"] = (effect, signal) => runtime.run(effect, signal);
    registerSubagentTools(pi, {
      environment: { cwd: "/project", projectTrusted: true },
      run,
      ...overrides({ run, service }),
    });
    return { tools, runtime, service };
  });

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
    readonly execute: (...args: Parameters<NativeExecute>) => Promise<Result>;
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

/**
 * Starts a call whose `observing` resolves once a progress update satisfies `ready`, so a test can
 * act while the call is still running.
 */
export const observedCall = <Result>(
  tool: { readonly execute: (...args: Parameters<NativeExecute>) => Promise<Result> },
  params: Parameters<NativeExecute>[1],
  {
    ready = () => true,
    update,
    ...options
  }: InvocationOptions & { readonly ready?: (result: AgentToolResult<unknown>) => boolean } = {},
) => {
  const observing = Deferred.makeUnsafe<void>();
  const pending = executeTool(tool, params, {
    ...options,
    update: (result) => {
      update?.(result);
      if (ready(result)) Deferred.doneUnsafe(observing, Effect.void);
    },
  });
  return { observing: Deferred.await(observing), pending, result: step(() => pending) };
};

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

export const decodeStartDetails = Schema.decodeUnknownSync(SubagentStartDetailsSchema);

/** The start tool over a service that records each request it launches. */
export const startToolFor = (requests: StartSubagentRequest[], options?: CaptureOptions) =>
  captureSubagentTools(startCapturingService(requests), options).get("agent_start");

export const resultText = (result: { readonly content: Parameters<typeof getTextContent>[0] }) =>
  getTextContent(result.content);

/** A finished run's completion claim, as an await observes it. */
export const receiptFor = (id: string) => ({ id, generation: 1, claimToken: `claim-${id}` });

/** The runs completion notices delivered. */
export const noticedRuns = (notifications: ReadonlyArray<SubagentNotification>) =>
  Arr.flatMap(notifications, (notification) =>
    notification.type === "completed" ? notification.runs : [],
  );

/** A settled result's compact summary, from the details its producer wrote. */
export const settledSummary = (
  provider: CompactSummaryProvider,
  args: Parameters<CompactSummaryProvider>[0]["args"],
  {
    details,
    isError = false,
    text = "",
  }: { readonly details: unknown; readonly isError?: boolean; readonly text?: string },
) =>
  provider({
    phase: "settled",
    args,
    result: { content: [{ type: "text", text }], details },
    context: renderContextFixture({ isError }),
  });

/** The style problems of every issue message a summary raises. */
export const issueStyle = (
  summary: ReturnType<typeof settledSummary>,
  options?: Parameters<typeof issueMessageStyleProblems>[1],
) =>
  Arr.flatMap(summary?.issues ?? [], (issue) => issueMessageStyleProblems(issue.message, options));
