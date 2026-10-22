import * as Predicate from "effect/Predicate";

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { freezeSnapshot } from "pi-cosmic-core";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
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
 * Pi's context getters and extension API throw once the session is replaced or reloaded. A launch
 * reads them through this guard so a retired session fails the launch instead of becoming a defect.
 */
const readHost = <A>(read: () => A): Effect.Effect<A, InvalidSubagentRequestError> =>
  Effect.try({
    try: read,
    catch: () =>
      new InvalidSubagentRequestError({
        code: "host_session_unavailable",
        message:
          "The Pi session changed while this launch was being prepared. Start the agent again from the current session.",
      }),
  });

const sharesParentPromptCache = (
  registry: ModelRegistry,
  parent: SubagentParentContext,
  context: StartSubagentRequest["context"],
  model: string,
): boolean => {
  if (context !== "fork" || parent.model !== model) return false;
  const separator = model.indexOf("/");
  const parentModel = registry.find(model.slice(0, separator), model.slice(separator + 1));
  return parentModel !== undefined && forkPromptCacheRoute(parentModel) !== undefined;
};

const transferableRuntimeApiKey = (value: string | undefined): value is string =>
  Predicate.isString(value) &&
  value.length > 0 &&
  value.length <= 8_192 &&
  !value.includes("\0") &&
  !value.includes("\r") &&
  !value.includes("\n");

interface ResolvedModel {
  readonly model: string;
  readonly runtimeApiKey?: RuntimeApiKey | undefined;
}

const resolvePiModel = (
  selector: string,
  effort: SubagentEffort,
  effortWasExplicit: boolean,
  registry: ModelRegistry,
): Effect.Effect<ResolvedModel, InvalidSubagentRequestError> =>
  Effect.gen(function* () {
    const availableModels = registry
      .getAvailable()
      .map((model) => ({ provider: model.provider, id: model.id }));
    const resolution = resolvePiModelSelector(selector, availableModels);
    if (resolution.kind === "ambiguous")
      return yield* new InvalidSubagentRequestError({
        code: "pi_model_ambiguous",
        message: `Pi model "${selector}" matches multiple authenticated providers: ${resolution.candidates.join(", ")}. Configure one canonical provider/model value.`,
      });
    if (resolution.kind === "unknown")
      return yield* new InvalidSubagentRequestError({
        code: "pi_model_unknown",
        message: `Profile route references unknown or unauthenticated Pi model "${selector}".${resolution.nearMatches.length > 0 ? ` Close authenticated matches: ${resolution.nearMatches.join(", ")}.` : ""} Update the profile route and reload.`,
      });
    const modelId = `${resolution.provider}/${resolution.id}`;
    const model = registry.find(resolution.provider, resolution.id);
    if (!model || !registry.hasConfiguredAuth(model))
      return yield* new InvalidSubagentRequestError({
        code: "pi_model_unauthenticated",
        message: `Model is unavailable or unauthenticated: ${modelId}`,
      });
    const supportedEfforts = getSupportedThinkingLevels(model);
    if (effortWasExplicit && !supportedEfforts.includes(effort))
      return yield* new InvalidSubagentRequestError({
        code: "pi_effort_unsupported",
        message: `Pi model ${modelId} does not support required effort ${effort}; supported efforts: ${supportedEfforts.join(", ") || "none"}.`,
      });
    const authSource = registry.getProviderAuthStatus(model.provider).source;
    if (authSource !== "runtime") return { model: modelId };
    const auth = yield* Effect.tryPromise({
      try: () => registry.getApiKeyAndHeaders(model),
      catch: () =>
        new InvalidSubagentRequestError({
          code: "pi_auth_resolution_failed",
          message: `Unable to resolve runtime authentication for ${modelId}.`,
        }),
    });
    if (!auth.ok || !transferableRuntimeApiKey(auth.apiKey))
      return yield* new InvalidSubagentRequestError({
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
  availablePiModels: registry.getAvailable().map((model) => ({
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

export const hostProfileEnvironment = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  parent: SubagentParentContext = capturePiParentContext(pi, ctx),
): ProfileResolutionEnvironment => profileEnvironment(ctx.modelRegistry, parent);

const resolveConcreteModel = (
  attempt: ProfileCandidateAttempt,
  modelRegistry: ModelRegistry,
  cwd: string,
): Effect.Effect<ResolvedModel, InvalidSubagentRequestError, SubagentBackendRegistry> =>
  Effect.gen(function* () {
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
      return yield* new InvalidSubagentRequestError({
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

const modelOverrideUnavailable = (
  definition: ProfileDefinition,
  override: SubagentModelOverride,
  skipped: ReadonlyArray<SkippedProfileCandidate>,
  agent?: CustomAgent,
): InvalidSubagentRequestError =>
  new InvalidSubagentRequestError({
    code: "model_override_unavailable",
    message: `Model override ${modelOverrideLabel(override)} is unavailable\n\nAn override never falls back to the profile route.${skipped.map((skip) => ` [${skip.code}] ${skip.reason}`).join("")} Fix the override, or omit it to use ${routeSubject(definition, agent)}'s route.`,
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
    ...profileCandidateValidationIssues(candidate).map((issue) => issue.code),
    ...(agent && hasCustomAgentToolPolicy(agent) && candidate.runtime !== "pi"
      ? ["agent_tools_unsupported"]
      : []),
  ];
  if (issues.length === 0) return Effect.succeed(candidate);
  return Effect.fail(
    new InvalidSubagentRequestError({
      code: "model_override_invalid",
      message: `Model override ${modelOverrideLabel(override)} is invalid for ${routeSubject(definition, agent)}\n\nViolations: ${issues.join(", ")}. Use a native selector the runtime accepts. This launch uses ${candidate.context} context; forked context, the parent model, and agent tool lists need runtime pi.`,
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
    exhausted.every((candidate) => candidate.code === "backend_not_implemented");
  const skipCodes = exhausted
    .map(
      (candidate) =>
        `${candidate.candidateIndex === undefined ? "route" : `candidate ${candidate.candidateIndex + 1}`}[${candidate.code}]`,
    )
    .join(", ");
  return new InvalidSubagentRequestError({
    code: allUnsupported ? "backend_not_implemented" : "profile_no_eligible_model",
    message: `${planSubject(input.definition, input.agent)} has no eligible implemented backend after pre-start checks.${skipCodes ? ` Skipped: ${skipCodes}.` : ""}${exhausted.length > 0 ? ` ${exhausted.map((candidate) => candidate.reason).join(" ")}` : ""}`,
  });
};

const selectCandidate = (input: PlannedStartInput, registry: ModelRegistry, cwd: string) =>
  Effect.gen(function* () {
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

const validatedStartInput = (rawInput: SubagentProfileStartSpec) =>
  Effect.gen(function* () {
    const task = rawInput.task.trim();
    if (!task)
      return yield* new InvalidSubagentRequestError({
        code: "task_required",
        message: "agent_start requires every agent to have a task.",
      });
    const disallowedField = firstDisallowedLaunchOverride(rawInput);
    if (disallowedField)
      return yield* new InvalidSubagentRequestError({
        code: "launch_override_not_allowed",
        message: disallowedLaunchOverrideMessage(disallowedField),
      });
    return task;
  });

const resolvePlannedStart = (
  pi: ExtensionAPI,
  input: PlannedStartInput,
  registry: ModelRegistry,
  environment: SubagentSessionEnvironment,
  parent: SubagentParentContext,
): Effect.Effect<StartSubagentRequest, InvalidSubagentRequestError, SubagentBackendRegistry> =>
  Effect.gen(function* () {
    const task = yield* validatedStartInput(input.rawInput);
    const { attempt, resolved, skipped } = yield* selectCandidate(input, registry, environment.cwd);
    const modelOverride = input.routeSource === "override" ? input.rawInput.model : undefined;
    const selection: SubagentSelectionProvenance = {
      source: attempt.source,
      routeSource: attempt.routeSource,
      candidateIndex: attempt.candidateIndex,
      reason: attempt.reason,
      skippedCandidates: skipped,
    };
    const parentSessionFile = parent.sessionFile;
    const parentLeafId = parent.leafId;
    if (attempt.effectiveContext === "fork" && (!parentSessionFile || !parentLeafId))
      return yield* new InvalidSubagentRequestError({
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
    const name = input.rawInput.name?.trim();
    // An item's isolation wins over the agent's; either one requires a writer route.
    const isolation = input.rawInput.isolation ?? input.agent?.isolation;
    if (isolation !== undefined && attempt.writeIntent !== "writer")
      return yield* new InvalidSubagentRequestError({
        code: "isolation_requires_writer",
        message:
          input.rawInput.isolation === undefined && input.agent
            ? `${planSubject(input.definition, input.agent)} sets isolation but resolved read-only, and isolation applies only to writers. Set the agent's writeIntent to writer, or remove its isolation.`
            : `${planSubject(input.definition, input.agent)} resolved read-only, and isolation applies only to writers. Omit isolation, or use profile worker.`,
      });
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
  const name = rawInput.agent?.trim();
  if (!name) return Effect.succeed(undefined);
  if (rawInput.profile !== undefined)
    return Effect.fail(
      new InvalidSubagentRequestError({
        code: "agent_profile_conflict",
        message: `Agent ${name} can't be combined with a profile\n\nAn agent already routes through its configured profile. Set either agent or profile on the start item, not both.`,
      }),
    );
  const config = profileSnapshot.effectiveConfig;
  const lookup = lookupCustomAgent(config, name);
  if (lookup.kind === "found") return Effect.succeed(lookup.agent);
  const available = config.agents.map((agent) => agent.name).join(", ") || "none";
  return Effect.fail(
    lookup.kind === "invalid"
      ? new InvalidSubagentRequestError({
          code: "agent_invalid",
          message: `Agent ${name} is invalid and fails closed\n\nRepair its entry under agents in ${lookup.scope === "project" ? config.projectConfigPath : config.globalConfigPath}, then reload. /subagents doctor lists the invalid fields.`,
        })
      : new InvalidSubagentRequestError({
          code: "agent_unknown",
          message: `Unknown agent ${name}\n\nConfigured agents: ${available}. Call agent_profiles to list them, or launch a profile instead.`,
        }),
  );
};

export const resolveProfileStart = (
  pi: ExtensionAPI,
  rawInput: SubagentProfileStartSpec,
  ctx: ExtensionContext,
  environment: SubagentSessionEnvironment,
  capturedProfiles?: SessionProfileSnapshot,
): Effect.Effect<
  StartSubagentRequest,
  InvalidSubagentRequestError,
  SubagentProfileService | SubagentBackendRegistry
> =>
  Effect.gen(function* () {
    const profiles = yield* SubagentProfileService;
    const profileSnapshot = capturedProfiles ?? (yield* profiles.capture);
    const agent = yield* launchedAgent(rawInput, profileSnapshot);
    const selectedProfile = agent?.profile ?? ((rawInput.profile?.trim() ?? "") || "generalist");
    const definition = profiles.definition(selectedProfile);
    if (!definition)
      return yield* new InvalidSubagentRequestError({
        code: "profile_unknown",
        message: `Unknown subagent profile "${selectedProfile}". Available profiles: ${PROFILE_IDS.join(", ")}.`,
      });
    const parent =
      environment.parentContext ?? (yield* readHost(() => capturePiParentContext(pi, ctx)));
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
      return yield* new InvalidSubagentRequestError({ code: plan.code, message: plan.message });
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
  });
