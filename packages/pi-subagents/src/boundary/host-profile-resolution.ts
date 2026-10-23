import * as Schema from "effect/Schema";

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { freezeSnapshot } from "pi-cosmic-core";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import * as Option from "effect/Option";
import { SubagentBackendRegistry } from "../backend/service.ts";
import { customAgentToolSnapshot, piRootActiveToolSnapshot } from "../run/tool-policy.ts";
import {
  disallowedLaunchOverrideMessage,
  firstDisallowedLaunchOverride,
} from "../run/launch-validation.ts";
import {
  InvalidSubagentRequestError,
  isCleanupUnconfirmed,
  isOutcomeUncertain,
} from "../run/errors.ts";
import { resolvePiModelSelector } from "../run/model-catalog.ts";
import { sanitizeName } from "../run/state.ts";
import type { WriterWorkspaceMode } from "../config/schema.ts";
import type { SubagentEffort } from "../domain/routing.ts";
import type { RuntimeApiKey, StartSubagentRequest, SubagentParentContext } from "../run/model.ts";
import {
  hasCustomAgentToolPolicy,
  lookupCustomAgent,
  type CustomAgent,
} from "../profiles/agents.ts";
import {
  modelOverrideCandidate,
  PROFILE_IDS,
  profileCandidateValidationIssues,
  skippedCandidateRoute,
  supportsSubagentFastMode,
  type LaunchRouteSource,
  type ProfileCandidate,
  type ProfileDefinition,
  type SkippedProfileCandidate,
  type SubagentModelOverride,
  type SubagentSelectionProvenance,
} from "../profiles/model.ts";
import {
  resolveProfileOverridePlan,
  type ProfileCandidateAttempt,
  type ProfileResolutionEnvironment,
  type ProfileResolutionPlan,
} from "../profiles/resolve.ts";
import { SubagentProfileService } from "../profiles/service.ts";
import type { SessionProfileSnapshot } from "../profiles/session-overrides.ts";
import { forkPromptCacheRoute } from "./fork-prompt-cache.ts";
import { capturePiParentContext } from "./host-child-pi.ts";

export interface SubagentProfileStartSpec {
  readonly task: string;
  readonly name?: string | undefined;
  readonly profile?: string | undefined;
  readonly agent?: string | undefined;
  readonly isolation?: WriterWorkspaceMode | undefined;
  readonly model?: SubagentModelOverride | undefined;
}

export interface SubagentSessionEnvironment {
  readonly cwd: string;
  readonly projectTrusted: boolean;
  readonly parentContext?: SubagentParentContext | undefined;
}

type ModelRegistry = ExtensionContext["modelRegistry"];

/**
 * Pi's context getters and extension API throw once the session is replaced or reloaded. Effects
 * read them through this guard so a retired session fails the request instead of becoming a defect.
 */
const readHost = <A>(read: () => A): Effect.Effect<A, InvalidSubagentRequestError> =>
  Effect.try({
    try: read,
    catch: () =>
      InvalidSubagentRequestError.make({
        code: "host_session_unavailable",
        message:
          "The Pi session changed while this request was being prepared. Try again from the current session.",
      }),
  });

/** The invoking session's model, effort, and branch, read through the stale-session guard. */
export const captureHostParentContext = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Effect.Effect<SubagentParentContext, InvalidSubagentRequestError> =>
  readHost(() => capturePiParentContext(pi, ctx));

const sharesParentPromptCache = (
  registry: ModelRegistry,
  parent: SubagentParentContext,
  context: StartSubagentRequest["context"],
  model: string,
): boolean => {
  if (context !== "fork" || parent.model !== model) return false;
  const separator = Fn.pipe(
    model,
    Str.indexOf("/"),
    Option.getOrElse(() => -1),
  );
  const parentModel = registry.find(
    Fn.pipe(model, Str.slice(0, separator)),
    Fn.pipe(model, Str.slice(separator + 1)),
  );
  return parentModel !== undefined && forkPromptCacheRoute(parentModel) !== undefined;
};

const isTransferableRuntimeApiKey = Schema.is(
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(8_192),
    Schema.isPattern(/^[^\0\r\n]*$/u),
  ),
);

interface ResolvedModel {
  readonly model: string;
  readonly runtimeApiKey?: RuntimeApiKey | undefined;
}

const resolvePiModel = Effect.fn("HostProfileResolution.resolvePiModel")(function* (
  selector: string,
  effort: SubagentEffort,
  effortWasExplicit: boolean,
  registry: ModelRegistry,
): Effect.fn.Return<ResolvedModel, InvalidSubagentRequestError> {
  const availableModels = Arr.map(registry.getAvailable(), (model) => ({
    provider: model.provider,
    id: model.id,
  }));
  const resolution = resolvePiModelSelector(selector, availableModels);
  if (resolution.kind === "ambiguous")
    return yield* InvalidSubagentRequestError.make({
      code: "pi_model_ambiguous",
      message: `Pi model "${selector}" matches multiple authenticated providers: ${Arr.join(resolution.candidates, ", ")}. Configure one canonical provider/model value.`,
    });
  if (resolution.kind === "unknown")
    return yield* InvalidSubagentRequestError.make({
      code: "pi_model_unknown",
      message: `Profile route references unknown or unauthenticated Pi model "${selector}".${resolution.nearMatches.length > 0 ? ` Close authenticated matches: ${Arr.join(resolution.nearMatches, ", ")}.` : ""} Update the profile route and reload.`,
    });
  const modelId = `${resolution.provider}/${resolution.id}`;
  const model = registry.find(resolution.provider, resolution.id);
  if (!model || !registry.hasConfiguredAuth(model))
    return yield* InvalidSubagentRequestError.make({
      code: "pi_model_unauthenticated",
      message: `Model is unavailable or unauthenticated: ${modelId}`,
    });
  const supportedEfforts = getSupportedThinkingLevels(model);
  if (effortWasExplicit && !supportedEfforts.includes(effort))
    return yield* InvalidSubagentRequestError.make({
      code: "pi_effort_unsupported",
      message: `Pi model ${modelId} does not support required effort ${effort}; supported efforts: ${Arr.join(supportedEfforts, ", ") || "none"}.`,
    });
  const authSource = registry.getProviderAuthStatus(model.provider).source;
  if (authSource !== "runtime") return { model: modelId };
  const auth = yield* Effect.tryPromise({
    try: () => registry.getApiKeyAndHeaders(model),
    catch: () =>
      InvalidSubagentRequestError.make({
        code: "pi_auth_resolution_failed",
        message: `Unable to resolve runtime authentication for ${modelId}.`,
      }),
  });
  if (!auth.ok || !isTransferableRuntimeApiKey(auth.apiKey))
    return yield* InvalidSubagentRequestError.make({
      code: "pi_auth_unavailable",
      message: `Transferable runtime authentication is unavailable for ${modelId}.`,
    });
  return {
    model: modelId,
    runtimeApiKey: Redacted.make(auth.apiKey, { label: "Subagent runtime API key" }),
  };
});

const profileEnvironment = (
  registry: ModelRegistry,
  parent: SubagentParentContext,
): ProfileResolutionEnvironment => ({
  availablePiModels: Arr.map(registry.getAvailable(), (model) => ({
    provider: model.provider,
    id: model.id,
    supportedEfforts: getSupportedThinkingLevels(model),
    contextWindow: model.contextWindow,
  })),
  ...(parent.contextTokens !== undefined && { parentContextTokens: parent.contextTokens }),
  ...(parent.model && { parentModel: { model: parent.model, effort: parent.effort } }),
  parentEffort: parent.effort,
  forkAvailable: Boolean(parent.sessionFile && parent.leafId),
});

export const hostProfileEnvironment = Effect.fn("HostProfileResolution.hostProfileEnvironment")(
  function* (
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    parent?: SubagentParentContext,
  ): Effect.fn.Return<ProfileResolutionEnvironment, InvalidSubagentRequestError> {
    const captured = parent ?? (yield* captureHostParentContext(pi, ctx));
    return yield* readHost(() => profileEnvironment(ctx.modelRegistry, captured));
  },
);

const resolveConcreteModel = Effect.fn("HostProfileResolution.resolveConcreteModel")(function* (
  attempt: ProfileCandidateAttempt,
  modelRegistry: ModelRegistry,
  cwd: string,
): Effect.fn.Return<ResolvedModel, InvalidSubagentRequestError, SubagentBackendRegistry> {
  const registry = yield* SubagentBackendRegistry;
  const resolved =
    attempt.runtime === "pi"
      ? yield* resolvePiModel(
          attempt.model,
          attempt.effort,
          attempt.effortWasExplicit,
          modelRegistry,
        )
      : { model: attempt.model };
  if (attempt.openaiFastMode && !supportsSubagentFastMode(attempt.runtime, resolved.model))
    return yield* InvalidSubagentRequestError.make({
      code: "fast_mode_unsupported",
      message: `Fast mode is unavailable for ${attempt.runtime}/${resolved.model}.`,
    });
  yield* registry.preflight(
    {
      runtime: attempt.runtime,
      context: attempt.effectiveContext,
    },
    {
      context: attempt.effectiveContext,
      writeIntent: attempt.writeIntent,
      model: resolved.model,
      effort: attempt.effort,
      cwd,
    },
  );
  return resolved;
});

const dynamicCandidateSkip = (
  attempt: ProfileCandidateAttempt,
  error: InvalidSubagentRequestError,
): SkippedProfileCandidate => ({
  candidateIndex: attempt.candidateIndex,
  candidate: skippedCandidateRoute(attempt),
  code: (error.code ?? "") || error._tag,
  reason: error.message,
});

interface PlannedStartInput {
  readonly rawInput: SubagentProfileStartSpec;
  readonly definition: ProfileDefinition;
  readonly agent?: CustomAgent | undefined;
  readonly plan: ProfileResolutionPlan;
  readonly routeCandidates: ReadonlyArray<ProfileCandidate>;
  readonly routeSource: LaunchRouteSource;
}

const modelOverrideLabel = ({ runtime, model, effort }: SubagentModelOverride): string =>
  `${runtime}/${model}${effort === undefined ? "" : `:${effort}`}`;

const routeSubject = (definition: ProfileDefinition, agent: CustomAgent | undefined): string =>
  agent ? `agent ${agent.name}` : `profile ${definition.id}`;

const planSubject = (definition: ProfileDefinition, agent: CustomAgent | undefined): string =>
  agent ? `Agent ${agent.name} (profile ${definition.id})` : `Profile ${definition.id}`;

const isolationFromAgent = (input: PlannedStartInput): boolean =>
  input.rawInput.isolation === undefined && input.agent !== undefined;

/**
 * Isolation chooses a writer's workspace. A read-only run still has write-capable tools, so a
 * requested worktree fails closed; a shared checkout asks for nothing stronger and is ignored.
 */
const readOnlyIsolation = (
  input: PlannedStartInput,
  isolation: WriterWorkspaceMode,
): Effect.Effect<string, InvalidSubagentRequestError> =>
  isolation === "worktree"
    ? Effect.fail(
        InvalidSubagentRequestError.make({
          code: "isolation_requires_writer",
          message: isolationFromAgent(input)
            ? `${planSubject(input.definition, input.agent)} sets worktree isolation but resolved read-only\n\nA read-only run can't be isolated in a worktree. Set the agent's writeIntent to writer, or remove its isolation.`
            : `${planSubject(input.definition, input.agent)} resolved read-only, so it can't run in a worktree\n\nA read-only run can't be isolated in a worktree. Use profile worker or a writer agent, or omit isolation.`,
        }),
      )
    : Effect.succeed(
        isolationFromAgent(input)
          ? `Ignored the agent's isolation: ${planSubject(input.definition, input.agent)} resolved read-only and shares the checkout.`
          : `Ignored isolation: ${planSubject(input.definition, input.agent)} resolved read-only and shares the checkout.`,
      );

const modelOverrideUnavailable = (
  definition: ProfileDefinition,
  override: SubagentModelOverride,
  skipped: ReadonlyArray<SkippedProfileCandidate>,
  agent?: CustomAgent,
): InvalidSubagentRequestError =>
  InvalidSubagentRequestError.make({
    code: "model_override_unavailable",
    message: `Model override ${modelOverrideLabel(override)} is unavailable\n\nAn override never falls back to the profile route.${Arr.join(
      Arr.map(skipped, (skip) => ` [${skip.code}] ${skip.reason}`),
      "",
    )} Fix the override, or omit it to use ${routeSubject(definition, agent)}'s route.`,
  });

/**
 * Static override checks share the configuration's selector grammar and cross-field policy. An
 * agent supplies its defaults, and its tool lists need a Pi child.
 */
const validatedModelOverride = (
  definition: ProfileDefinition,
  override: SubagentModelOverride,
  agent: CustomAgent | undefined,
): Effect.Effect<ProfileCandidate, InvalidSubagentRequestError> => {
  const candidate = modelOverrideCandidate(override, definition, agent);
  const issues = [
    ...Arr.map(profileCandidateValidationIssues(candidate), (issue) => issue.code),
    ...(agent && hasCustomAgentToolPolicy(agent) && candidate.runtime !== "pi"
      ? ["agent_tools_unsupported"]
      : []),
  ];
  if (issues.length === 0) return Effect.succeed(candidate);
  return Effect.fail(
    InvalidSubagentRequestError.make({
      code: "model_override_invalid",
      message: `Model override ${modelOverrideLabel(override)} is invalid for ${routeSubject(definition, agent)}\n\nViolations: ${Arr.join(issues, ", ")}. Use a native selector the runtime accepts. This launch uses ${candidate.context} context; forked context, the parent model, and agent tool lists need runtime pi.`,
    }),
  );
};

const exhaustedRoute = (
  input: PlannedStartInput,
  exhausted: ReadonlyArray<SkippedProfileCandidate>,
): InvalidSubagentRequestError => {
  if (input.routeSource === "override" && input.rawInput.model)
    return modelOverrideUnavailable(input.definition, input.rawInput.model, exhausted, input.agent);
  const allUnsupported =
    exhausted.length > 0 &&
    Arr.every(exhausted, (candidate) => candidate.code === "backend_not_implemented");
  const skipCodes = Arr.join(
    Arr.map(
      exhausted,
      (candidate) =>
        `${candidate.candidateIndex === undefined ? "route" : `candidate ${candidate.candidateIndex + 1}`}[${candidate.code}]`,
    ),
    ", ",
  );
  return InvalidSubagentRequestError.make({
    code: allUnsupported ? "backend_not_implemented" : "profile_no_eligible_model",
    message: `${planSubject(input.definition, input.agent)} has no eligible implemented backend after pre-start checks.${skipCodes ? ` Skipped: ${skipCodes}.` : ""}${
      exhausted.length > 0
        ? ` ${Arr.join(
            Arr.map(exhausted, (candidate) => candidate.reason),
            " ",
          )}`
        : ""
    }`,
  });
};

const selectCandidate = Effect.fn("HostProfileResolution.selectCandidate")(function* (
  input: PlannedStartInput,
  registry: ModelRegistry,
  cwd: string,
) {
  const skipped: SkippedProfileCandidate[] = [];
  for (const attempt of input.plan.attempts) {
    skipped.push(...(attempt.skippedBefore ?? []));
    const outcome = yield* Effect.result(resolveConcreteModel(attempt, registry, cwd));
    if (Result.isSuccess(outcome)) return { attempt, resolved: outcome.success, skipped };
    if (isCleanupUnconfirmed(outcome.failure) || isOutcomeUncertain(outcome.failure))
      return yield* outcome.failure;
    skipped.push(dynamicCandidateSkip(attempt, outcome.failure));
  }
  return yield* exhaustedRoute(input, [...skipped, ...input.plan.trailingSkippedCandidates]);
});

const validatedStartInput = Effect.fn("HostProfileResolution.validatedStartInput")(function* (
  rawInput: SubagentProfileStartSpec,
) {
  const task = Str.trim(rawInput.task);
  if (!task)
    return yield* InvalidSubagentRequestError.make({
      code: "task_required",
      message: "agent_start requires every agent to have a task.",
    });
  const disallowedField = firstDisallowedLaunchOverride(rawInput);
  if (disallowedField)
    return yield* InvalidSubagentRequestError.make({
      code: "launch_override_not_allowed",
      message: disallowedLaunchOverrideMessage(disallowedField),
    });
  return task;
});

const resolvePlannedStart = Effect.fn("HostProfileResolution.resolvePlannedStart")(function* (
  pi: ExtensionAPI,
  input: PlannedStartInput,
  registry: ModelRegistry,
  environment: SubagentSessionEnvironment,
  parent: SubagentParentContext,
): Effect.fn.Return<StartSubagentRequest, InvalidSubagentRequestError, SubagentBackendRegistry> {
  const task = yield* validatedStartInput(input.rawInput);
  const { attempt, resolved, skipped } = yield* selectCandidate(input, registry, environment.cwd);
  const modelOverride = input.routeSource === "override" ? input.rawInput.model : undefined;
  // An item's isolation wins over the agent's.
  const requestedIsolation = input.rawInput.isolation ?? input.agent?.isolation;
  const writer = attempt.writeIntent === "writer";
  const isolation = writer ? requestedIsolation : undefined;
  const isolationWarning =
    !writer && requestedIsolation !== undefined
      ? yield* readOnlyIsolation(input, requestedIsolation)
      : undefined;
  const selection: SubagentSelectionProvenance = {
    source: attempt.source,
    routeSource: attempt.routeSource,
    candidateIndex: attempt.candidateIndex,
    reason: attempt.reason,
    skippedCandidates: skipped,
    ...(isolationWarning && { warning: isolationWarning }),
  };
  const parentSessionFile = parent.sessionFile;
  const parentLeafId = parent.leafId;
  if (attempt.effectiveContext === "fork" && (!parentSessionFile || !parentLeafId))
    return yield* InvalidSubagentRequestError.make({
      code: "fork_context_unavailable",
      message: "Forked context requires a persisted parent session with a stable leaf.",
    });
  const routeContinuation = freezeSnapshot({
    candidates: input.routeCandidates,
    selectedCandidateIndex: attempt.candidateIndex,
  });
  const activeTools =
    attempt.runtime === "pi"
      ? customAgentToolSnapshot(
          yield* piRootActiveToolSnapshot(yield* readHost(() => pi.getActiveTools())),
          input.agent?.tools,
        )
      : [];
  // Every copy of the name, including a worktree's recorded launch, keeps the display bound.
  const name = sanitizeName(input.rawInput.name ?? "");
  const request: StartSubagentRequest = {
    ...(name && { name }),
    ...(isolation && { writerWorkspaceModeOverride: isolation }),
    runtime: attempt.runtime,
    openaiFastMode: attempt.openaiFastMode,
    task,
    profile: input.definition.id,
    ...(input.agent && { agent: input.agent.name }),
    // An agent's instructions replace its routed profile's guidance.
    profileGuidance: input.agent?.instructions ?? input.definition.guidance,
    selection,
    ...(modelOverride && { modelOverride }),
    routeContinuation,
    cwd: environment.cwd,
    context: attempt.effectiveContext,
    writeIntent: attempt.writeIntent,
    model: resolved.model,
    ...(resolved.runtimeApiKey && { runtimeApiKey: resolved.runtimeApiKey }),
    effort: attempt.effort,
    effortWasExplicit: attempt.effortWasExplicit,
    activeTools,
    projectTrusted: environment.projectTrusted,
    parentSessionId: parent.sessionId,
    ...(parentSessionFile && { parentSessionFile }),
    ...(parentLeafId && { parentLeafId }),
    ...(sharesParentPromptCache(registry, parent, attempt.effectiveContext, resolved.model) && {
      sharesParentPromptCache: true,
    }),
  };
  return request;
});

/** The agent a start item names, from the batch's captured configuration. */
const launchedAgent = (
  rawInput: SubagentProfileStartSpec,
  profileSnapshot: SessionProfileSnapshot,
): Effect.Effect<CustomAgent | undefined, InvalidSubagentRequestError> => {
  const name = Str.trim(rawInput.agent ?? "");
  if (!name) return Effect.undefined;
  if (rawInput.profile !== undefined)
    return Effect.fail(
      InvalidSubagentRequestError.make({
        code: "agent_profile_conflict",
        message: `Agent ${name} can't be combined with a profile\n\nAn agent already routes through its configured profile. Set either agent or profile on the start item, not both.`,
      }),
    );
  const config = profileSnapshot.effectiveConfig;
  const lookup = lookupCustomAgent(config, name);
  if (lookup.kind === "found") return Effect.succeed(lookup.agent);
  const available =
    Arr.join(
      Arr.map(config.agents, (agent) => agent.name),
      ", ",
    ) || "none";
  return Effect.fail(
    lookup.kind === "invalid"
      ? InvalidSubagentRequestError.make({
          code: "agent_invalid",
          message: `Agent ${name} is invalid and fails closed\n\nRepair its entry under agents in ${lookup.scope === "project" ? config.projectConfigPath : config.globalConfigPath}, then reload. /subagents doctor lists the invalid fields.`,
        })
      : InvalidSubagentRequestError.make({
          code: "agent_unknown",
          message: `Unknown agent ${name}\n\nConfigured agents: ${available}. Call agent_profiles to list them, or launch a profile instead.`,
        }),
  );
};

export const resolveProfileStart = Effect.fn("HostProfileResolution.resolveProfileStart")(
  function* (
    pi: ExtensionAPI,
    rawInput: SubagentProfileStartSpec,
    ctx: ExtensionContext,
    environment: SubagentSessionEnvironment,
    capturedProfiles?: SessionProfileSnapshot,
  ): Effect.fn.Return<
    StartSubagentRequest,
    InvalidSubagentRequestError,
    SubagentProfileService | SubagentBackendRegistry
  > {
    const profiles = yield* SubagentProfileService;
    const profileSnapshot = capturedProfiles ?? (yield* profiles.capture);
    const agent = yield* launchedAgent(rawInput, profileSnapshot);
    const selectedProfile = agent?.profile ?? (Str.trim(rawInput.profile ?? "") || "generalist");
    const definition = profiles.definition(selectedProfile);
    if (!definition)
      return yield* InvalidSubagentRequestError.make({
        code: "profile_unknown",
        message: `Unknown subagent profile "${selectedProfile}". Available profiles: ${Arr.join(PROFILE_IDS, ", ")}.`,
      });
    const parent = environment.parentContext ?? (yield* captureHostParentContext(pi, ctx));
    // Candidate probes can outlast the session, so later registry reads use this capture.
    const registry = yield* readHost(() => ctx.modelRegistry);
    if (rawInput.model) {
      const candidate = yield* validatedModelOverride(definition, rawInput.model, agent);
      const plan = resolveProfileOverridePlan(
        definition.id,
        candidate,
        profileEnvironment(registry, parent),
      );
      if (plan.kind === "failed")
        return yield* modelOverrideUnavailable(
          definition,
          rawInput.model,
          plan.skippedCandidates,
          agent,
        );
      return yield* resolvePlannedStart(
        pi,
        {
          rawInput,
          definition,
          ...(agent && { agent }),
          plan,
          routeCandidates: [candidate],
          routeSource: "override",
        },
        registry,
        environment,
        parent,
      );
    }
    const plan = profiles.resolve(
      profileSnapshot,
      definition.id,
      profileEnvironment(registry, parent),
      agent,
    );
    if (plan.kind === "failed")
      return yield* InvalidSubagentRequestError.make({ code: plan.code, message: plan.message });
    const route = profileSnapshot.effectiveConfig.profiles[definition.id];
    return yield* resolvePlannedStart(
      pi,
      {
        rawInput,
        definition,
        ...(agent && { agent }),
        plan,
        routeCandidates: route.candidates,
        routeSource: profileSnapshot.effectiveConfig.profileSources[definition.id],
      },
      registry,
      environment,
      parent,
    );
  },
);
