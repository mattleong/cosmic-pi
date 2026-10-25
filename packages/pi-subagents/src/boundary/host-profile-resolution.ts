import * as Schema from "effect/Schema";

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { freezeSnapshot } from "pi-cosmic-core/projection";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { SubagentBackendRegistry } from "../backend/service.ts";
import { piChildToolSnapshot, piRootActiveToolSnapshot } from "../run/tool-policy.ts";
import {
  disallowedLaunchOverrideMessage,
  firstDisallowedLaunchOverride,
} from "../run/launch-validation.ts";
import { InvalidSubagentRequestError } from "../run/errors.ts";
import { resolvePiModelSelector } from "../run/model-catalog.ts";
import { sanitizeName } from "../run/state.ts";
import type { WriterWorkspaceMode } from "../config/schema.ts";
import type { SubagentEffort } from "../domain/routing.ts";
import type {
  RouteFallback,
  RouteFallbackRequest,
  RuntimeApiKey,
  StartCandidate,
  StartSubagentRequest,
  SubagentParentContext,
} from "../run/model.ts";
import { lookupCustomAgent, type CustomAgent } from "../profiles/agents.ts";
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
  const resolved = yield* resolvePiModel(
    attempt.model,
    attempt.effort,
    attempt.effortWasExplicit,
    modelRegistry,
  );
  if (attempt.openaiFastMode && !supportsSubagentFastMode(resolved.model))
    return yield* InvalidSubagentRequestError.make({
      code: "fast_mode_unsupported",
      message: `Fast mode is unavailable for ${resolved.model}.`,
    });
  yield* registry.preflight(
    { context: attempt.effectiveContext },
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
  /** A model override's place in the profile's route, which a failed run continues from. */
  readonly routeIndex?: number | undefined;
  readonly routeSource: LaunchRouteSource;
}

const modelOverrideLabel = ({ model, effort }: SubagentModelOverride): string =>
  `${model}${effort === undefined ? "" : `:${effort}`}`;

/**
 * The route candidate a model override names, as a failed run's next-candidate hint writes it:
 * the same selector and effort. An override without an effort matches the selector.
 */
const overrideRouteIndex = (
  candidates: ReadonlyArray<ProfileCandidate>,
  override: SubagentModelOverride,
): number | undefined => {
  const sameModel = (candidate: ProfileCandidate) => candidate.model === override.model;
  const exact = Arr.findFirstIndex(
    candidates,
    (candidate) => sameModel(candidate) && candidate.effort === (override.effort ?? "default"),
  );
  return Option.getOrUndefined(
    Option.isSome(exact) || override.effort !== undefined
      ? exact
      : Arr.findFirstIndex(candidates, sameModel),
  );
};

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
            ? `${planSubject(input.definition, input.agent)} sets worktree isolation but resolved read-only.\n\nA read-only run can't be isolated in a worktree. Set the agent's writeIntent to writer, or remove its isolation.`
            : `${planSubject(input.definition, input.agent)} resolved read-only, so it can't run in a worktree.\n\nA read-only run can't be isolated in a worktree. Use profile worker or a writer agent, or omit isolation.`,
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
 * agent supplies its defaults.
 */
const validatedModelOverride = (
  definition: ProfileDefinition,
  override: SubagentModelOverride,
  agent: CustomAgent | undefined,
): Effect.Effect<ProfileCandidate, InvalidSubagentRequestError> => {
  const candidate = modelOverrideCandidate(override, definition, agent);
  const issues = Arr.map(profileCandidateValidationIssues(candidate), (issue) => issue.code);
  if (issues.length === 0) return Effect.succeed(candidate);
  return Effect.fail(
    InvalidSubagentRequestError.make({
      code: "model_override_invalid",
      message: `Model override ${modelOverrideLabel(override)} is invalid for ${routeSubject(definition, agent)}\n\nViolations: ${Arr.join(issues, ", ")}. Use a provider/model selector or parent.`,
    }),
  );
};

const exhaustedRoute = (
  input: PlannedStartInput,
  exhausted: ReadonlyArray<SkippedProfileCandidate>,
): InvalidSubagentRequestError => {
  if (input.routeSource === "override" && input.rawInput.model)
    return modelOverrideUnavailable(input.definition, input.rawInput.model, exhausted, input.agent);
  const skipCodes = Arr.join(
    Arr.map(
      exhausted,
      (candidate) =>
        `${candidate.candidateIndex === undefined ? "route" : `candidate ${candidate.candidateIndex + 1}`}[${candidate.code}]`,
    ),
    ", ",
  );
  return InvalidSubagentRequestError.make({
    code: "profile_no_eligible_model",
    message: `${planSubject(input.definition, input.agent)} has no eligible candidate after pre-start checks.${skipCodes ? ` Skipped: ${skipCodes}.` : ""}${
      exhausted.length > 0
        ? ` ${Arr.join(
            Arr.map(exhausted, (candidate) => candidate.reason),
            " ",
          )}`
        : ""
    }`,
  });
};

interface SelectedCandidate {
  readonly attempt: ProfileCandidateAttempt;
  readonly resolved: ResolvedModel;
  readonly skipped: ReadonlyArray<SkippedProfileCandidate>;
}

interface CandidateSearch {
  readonly selected?: SelectedCandidate | undefined;
  /** Every candidate passed over, in route order; the route's trailing skips once none is ready. */
  readonly skipped: ReadonlyArray<SkippedProfileCandidate>;
}

interface CandidateSearchStart {
  readonly skippedBefore: ReadonlyArray<SkippedProfileCandidate>;
  /** Only attempts after this route position are considered. */
  readonly afterIndex: number;
}

/** The first planned attempt after the start position whose model resolves and passes preflight. */
const firstReadyCandidate = Effect.fn("HostProfileResolution.firstReadyCandidate")(function* (
  input: PlannedStartInput,
  registry: ModelRegistry,
  cwd: string,
  start: CandidateSearchStart = { skippedBefore: [], afterIndex: -1 },
): Effect.fn.Return<CandidateSearch, InvalidSubagentRequestError, SubagentBackendRegistry> {
  const skipped = [...start.skippedBefore];
  for (const attempt of input.plan.attempts) {
    if (attempt.candidateIndex <= start.afterIndex) continue;
    skipped.push(...(attempt.skippedBefore ?? []));
    const outcome = yield* Effect.result(resolveConcreteModel(attempt, registry, cwd));
    if (Result.isSuccess(outcome))
      return { selected: { attempt, resolved: outcome.success, skipped }, skipped };
    skipped.push(dynamicCandidateSkip(attempt, outcome.failure));
  }
  return { skipped: [...skipped, ...input.plan.trailingSkippedCandidates] };
});

const selectCandidate = Effect.fn("HostProfileResolution.selectCandidate")(function* (
  input: PlannedStartInput,
  registry: ModelRegistry,
  cwd: string,
) {
  const { selected, skipped } = yield* firstReadyCandidate(input, registry, cwd);
  if (!selected) return yield* exhaustedRoute(input, skipped);
  return selected;
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

/** The launch facts that follow from one selected candidate. */
const plannedCandidate = Effect.fn("HostProfileResolution.plannedCandidate")(function* (
  pi: ExtensionAPI,
  input: PlannedStartInput,
  parent: SubagentParentContext,
  { attempt, resolved, skipped }: SelectedCandidate,
  isolationWarning: string | undefined,
): Effect.fn.Return<StartCandidate, InvalidSubagentRequestError> {
  if (attempt.effectiveContext === "fork" && (!parent.sessionFile || !parent.leafId))
    return yield* InvalidSubagentRequestError.make({
      code: "fork_context_unavailable",
      message: "Forked context requires a persisted parent session with a stable leaf.",
    });
  const routeContinuation = freezeSnapshot({
    candidates: input.routeCandidates,
    selectedCandidateIndex: input.routeIndex ?? attempt.candidateIndex,
  });
  const tools = piChildToolSnapshot(
    yield* piRootActiveToolSnapshot(yield* readHost(() => pi.getActiveTools())),
    input.agent?.tools,
    attempt.writeIntent,
  );
  const withheldToolsWarning =
    tools.withheld.length > 0
      ? `Withheld the agent's ${Arr.join(tools.withheld, ", ")}: ${planSubject(input.definition, input.agent)} resolved read-only, so it doesn't get Pi's edit and write tools.`
      : undefined;
  const warning = Arr.join(
    Arr.filter([isolationWarning, withheldToolsWarning], Predicate.isNotUndefined),
    " ",
  );
  const selection: SubagentSelectionProvenance = {
    source: attempt.source,
    routeSource: attempt.routeSource,
    candidateIndex: attempt.candidateIndex,
    reason: attempt.reason,
    skippedCandidates: skipped,
    ...(warning && { warning }),
  };
  return {
    openaiFastMode: attempt.openaiFastMode,
    selection,
    routeContinuation,
    context: attempt.effectiveContext,
    writeIntent: attempt.writeIntent,
    model: resolved.model,
    ...(resolved.runtimeApiKey && { runtimeApiKey: resolved.runtimeApiKey }),
    effort: attempt.effort,
    effortWasExplicit: attempt.effortWasExplicit,
    activeTools: tools.tools,
  };
});

/**
 * Continues a profile route past a candidate whose startup failed before its task was issued:
 * the next planned attempt that passes the same model resolution and preflight the first did.
 */
const routeFallbackFor = (
  pi: ExtensionAPI,
  input: PlannedStartInput,
  registry: ModelRegistry,
  environment: SubagentSessionEnvironment,
  parent: SubagentParentContext,
  isolationWarning: string | undefined,
  backends: Context.Context<SubagentBackendRegistry>,
): RouteFallback =>
  Effect.fn("HostProfileResolution.routeFallback")(function* ({
    selection,
    failed,
  }: RouteFallbackRequest) {
    const { selected, skipped } = yield* firstReadyCandidate(input, registry, environment.cwd, {
      skippedBefore: [...selection.skippedCandidates, failed],
      afterIndex: failed.candidateIndex ?? Number.POSITIVE_INFINITY,
    });
    if (!selected) return { skippedCandidates: skipped };
    const next = yield* plannedCandidate(pi, input, parent, selected, isolationWarning);
    return { skippedCandidates: skipped, next };
  }, Effect.provideContext(backends));

const resolvePlannedStart = Effect.fn("HostProfileResolution.resolvePlannedStart")(function* (
  pi: ExtensionAPI,
  input: PlannedStartInput,
  registry: ModelRegistry,
  environment: SubagentSessionEnvironment,
  parent: SubagentParentContext,
): Effect.fn.Return<StartSubagentRequest, InvalidSubagentRequestError, SubagentBackendRegistry> {
  const task = yield* validatedStartInput(input.rawInput);
  const selected = yield* selectCandidate(input, registry, environment.cwd);
  const modelOverride = input.routeSource === "override" ? input.rawInput.model : undefined;
  // An item's isolation wins over the agent's.
  const requestedIsolation = input.rawInput.isolation ?? input.agent?.isolation;
  const writer = selected.attempt.writeIntent === "writer";
  const isolation = writer ? requestedIsolation : undefined;
  const isolationWarning =
    !writer && requestedIsolation !== undefined
      ? yield* readOnlyIsolation(input, requestedIsolation)
      : undefined;
  const candidate = yield* plannedCandidate(pi, input, parent, selected, isolationWarning);
  // Every copy of the name, including a worktree's recorded launch, keeps the display bound.
  const name = sanitizeName(input.rawInput.name ?? "");
  const request: StartSubagentRequest = {
    ...(name && { name }),
    ...(isolation && { writerWorkspaceModeOverride: isolation }),
    task,
    profile: input.definition.id,
    ...(input.agent && { agent: input.agent.name }),
    // An agent's instructions replace its routed profile's guidance.
    profileGuidance: input.agent?.instructions ?? input.definition.guidance,
    ...(modelOverride
      ? { modelOverride }
      : {
          routeFallback: routeFallbackFor(
            pi,
            input,
            registry,
            environment,
            parent,
            isolationWarning,
            yield* Effect.context<SubagentBackendRegistry>(),
          ),
        }),
    cwd: environment.cwd,
    projectTrusted: environment.projectTrusted,
    parentSessionId: parent.sessionId,
    ...(parent.sessionFile && { parentSessionFile: parent.sessionFile }),
    ...(parent.leafId && { parentLeafId: parent.leafId }),
    ...candidate,
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
    const route = profileSnapshot.effectiveConfig.profiles[definition.id];
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
      // An override of one of the route's candidates keeps the rest of the route for its hint.
      const routeIndex = overrideRouteIndex(route.candidates, rawInput.model);
      return yield* resolvePlannedStart(
        pi,
        {
          rawInput,
          definition,
          ...(agent && { agent }),
          plan,
          ...(routeIndex === undefined
            ? { routeCandidates: [candidate] }
            : { routeCandidates: route.candidates, routeIndex }),
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
