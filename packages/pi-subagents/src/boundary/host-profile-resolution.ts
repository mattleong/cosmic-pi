import * as Predicate from "effect/Predicate";

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { freezeSnapshot } from "pi-cosmic-core";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import { SubagentBackendRegistry } from "../backend/service.ts";
import { piRootActiveToolSnapshot } from "../run/tool-policy.ts";
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
import {
  decodeSubagentEffort,
  type SubagentEffort,
  type SubagentHost,
  type SubagentRuntime,
} from "../domain/routing.ts";
import type { RuntimeApiKey, StartSubagentRequest } from "../run/model.ts";
import { normalizeWriteClaims } from "../domain/write-claims.ts";
import type { SubagentRetryClaim } from "../run/retry.ts";
import {
  profileCandidateLabel,
  PROFILE_IDS,
  supportsSubagentFastMode,
  type ProfileCandidate,
  type ProfileDefinition,
  type ProfileRouteSource,
  type SkippedProfileCandidate,
  type SubagentSelectionProvenance,
} from "../profiles/model.ts";
import {
  resolveProfileContinuationPlan,
  type ProfileCandidateAttempt,
  type ProfileResolutionEnvironment,
  type ProfileResolutionPlan,
} from "../profiles/resolve.ts";
import { SubagentProfileService } from "../profiles/service.ts";
import type { SessionProfileSnapshot } from "../profiles/session-overrides.ts";

export interface SubagentProfileStartSpec {
  readonly task: string;
  readonly name?: string | undefined;
  readonly profile?: string | undefined;
  readonly writes?: ReadonlyArray<string> | undefined;
}

export interface SubagentSessionEnvironment {
  readonly cwd: string;
  readonly projectTrusted: boolean;
}

const stableParentLeaf = (ctx: ExtensionContext): string | undefined => {
  const leaf = ctx.sessionManager.getLeafEntry();
  if (!leaf) return undefined;
  if (leaf.type === "message" && leaf.message.role === "assistant")
    return leaf.parentId ?? undefined;
  return leaf.id;
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

/** A candidate's route as one label, such as `local/pi/openai/gpt:high`. */
const routeLabel = (route: {
  readonly host: SubagentHost;
  readonly runtime: SubagentRuntime;
  readonly model: string;
  readonly effort: SubagentEffort;
}): string => `${route.host}/${route.runtime}/${route.model}:${route.effort}`;

const resolvePiModel = (
  selector: string,
  effort: SubagentEffort,
  effortWasExplicit: boolean,
  ctx: ExtensionContext,
): Effect.Effect<ResolvedModel, InvalidSubagentRequestError> =>
  Effect.gen(function* () {
    // The root registry already reflects the current project-trust decision. Local Pi mirrors
    // that decision, so every authenticated canonical model is eligible for resolution.
    const availableModels = ctx.modelRegistry
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
    const model = ctx.modelRegistry.find(resolution.provider, resolution.id);
    if (!model || !ctx.modelRegistry.hasConfiguredAuth(model))
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
    const authSource = ctx.modelRegistry.getProviderAuthStatus(model.provider).source;
    if (authSource !== "runtime") return { model: modelId };
    const auth = yield* Effect.tryPromise({
      try: () => ctx.modelRegistry.getApiKeyAndHeaders(model),
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

/** Unknown host values clamp to the existing conservative inheritance default. */
const inheritedParentEffort = (pi: ExtensionAPI): SubagentEffort =>
  decodeSubagentEffort(pi.getThinkingLevel()) ?? "high";

export const hostProfileEnvironment = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): ProfileResolutionEnvironment => ({
  availablePiModels: ctx.modelRegistry.getAvailable().map((model) => ({
    provider: model.provider,
    id: model.id,
    supportedEfforts: getSupportedThinkingLevels(model),
  })),
  ...(ctx.model && {
    parentModel: {
      model: `${ctx.model.provider}/${ctx.model.id}`,
      effort: inheritedParentEffort(pi),
    },
  }),
  forkAvailable: Boolean(ctx.sessionManager.getSessionFile() && stableParentLeaf(ctx)),
});

const resolveConcreteModel = (
  attempt: ProfileCandidateAttempt,
  ctx: ExtensionContext,
  cwd: string,
): Effect.Effect<ResolvedModel, InvalidSubagentRequestError, SubagentBackendRegistry> =>
  Effect.gen(function* () {
    const registry = yield* SubagentBackendRegistry;
    const resolved =
      attempt.runtime === "pi"
        ? yield* resolvePiModel(attempt.model, attempt.effort, attempt.effortWasExplicit, ctx)
        : { model: attempt.model };
    if (attempt.openaiFastMode && !supportsSubagentFastMode(attempt.runtime, resolved.model))
      return yield* new InvalidSubagentRequestError({
        code: "fast_mode_unsupported",
        message: `Fast mode is unavailable for ${attempt.runtime}/${resolved.model}.`,
      });
    yield* registry.preflight(
      {
        host: attempt.host,
        runtime: attempt.runtime,
        context: attempt.effectiveContext,
      },
      {
        context: attempt.effectiveContext,
        writeIntent: attempt.writeIntent,
        closeOnReport: attempt.closeOnReport,
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
  candidate: routeLabel(attempt),
  code: error.code || error._tag,
  reason: error.message,
});

interface PlannedStartInput {
  readonly rawInput: SubagentProfileStartSpec;
  readonly definition: ProfileDefinition;
  readonly plan: ProfileResolutionPlan;
  readonly routeCandidates: ReadonlyArray<ProfileCandidate>;
  readonly routeSource: ProfileRouteSource;
  readonly priorSkippedCandidates: ReadonlyArray<SkippedProfileCandidate>;
  readonly retry?:
    | {
        readonly sourceRunId: string;
        readonly claimToken: string;
      }
    | undefined;
}

const exhaustedRoute = (
  input: PlannedStartInput,
  exhausted: ReadonlyArray<SkippedProfileCandidate>,
): InvalidSubagentRequestError => {
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
    code: input.retry
      ? "retry_route_exhausted"
      : allUnsupported
        ? "backend_not_implemented"
        : "profile_no_eligible_model",
    message: `Profile ${input.definition.id} has no eligible ${input.retry ? "remaining candidate" : "implemented backend"} after pre-start checks.${skipCodes ? ` Skipped: ${skipCodes}.` : ""}${exhausted.length > 0 ? ` ${exhausted.map((candidate) => candidate.reason).join(" ")}` : ""}`,
  });
};

/**
 * Readiness-only fallback: the first candidate that resolves and passes preflight, with every
 * candidate skipped before it. Uncertain cleanup or outcomes stop the walk.
 */
const selectCandidate = (
  input: PlannedStartInput,
  writesClaimed: boolean,
  ctx: ExtensionContext,
  cwd: string,
) =>
  Effect.gen(function* () {
    let skipped = input.priorSkippedCandidates;
    for (const attempt of input.plan.attempts) {
      skipped = [...skipped, ...(attempt.skippedBefore ?? [])];
      if (writesClaimed && attempt.writeIntent !== "writer") {
        const configuredCandidate = input.routeCandidates[attempt.candidateIndex];
        skipped = [
          ...skipped,
          {
            candidateIndex: attempt.candidateIndex,
            candidate: configuredCandidate
              ? profileCandidateLabel(configuredCandidate)
              : routeLabel(attempt),
            code: "write_claims_read_only",
            reason: "writes may be supplied only for a writer profile candidate.",
          },
        ];
        continue;
      }
      const outcome = yield* Effect.result(resolveConcreteModel(attempt, ctx, cwd));
      if (Result.isSuccess(outcome)) return { attempt, resolved: outcome.success, skipped };
      if (isCleanupUnconfirmed(outcome.failure) || isOutcomeUncertain(outcome.failure))
        return yield* outcome.failure;
      skipped = [...skipped, dynamicCandidateSkip(attempt, outcome.failure)];
    }
    return yield* exhaustedRoute(input, [...skipped, ...input.plan.trailingSkippedCandidates]);
  });

const resolvePlannedStart = (
  pi: ExtensionAPI,
  input: PlannedStartInput,
  ctx: ExtensionContext,
  environment: SubagentSessionEnvironment,
): Effect.Effect<StartSubagentRequest, InvalidSubagentRequestError, SubagentBackendRegistry> =>
  Effect.gen(function* () {
    const task = input.rawInput.task.trim();
    if (!task)
      return yield* new InvalidSubagentRequestError({
        code: "task_required",
        message: "subagent_start requires every agent to have a task.",
      });
    const disallowedField = firstDisallowedLaunchOverride(input.rawInput);
    if (disallowedField)
      return yield* new InvalidSubagentRequestError({
        code: "launch_override_not_allowed",
        message: disallowedLaunchOverrideMessage(disallowedField),
      });
    const normalizedClaims = input.rawInput.writes
      ? normalizeWriteClaims(input.rawInput.writes)
      : undefined;
    if (normalizedClaims && !normalizedClaims.ok)
      return yield* new InvalidSubagentRequestError({
        code: normalizedClaims.code,
        message: normalizedClaims.message,
      });

    const { attempt, resolved, skipped } = yield* selectCandidate(
      input,
      normalizedClaims !== undefined,
      ctx,
      environment.cwd,
    );
    const selection: SubagentSelectionProvenance = {
      source: attempt.source,
      routeSource: attempt.routeSource,
      candidateIndex: attempt.candidateIndex,
      reason: input.retry
        ? `Profile ${input.definition.id} continued failed run ${input.retry.sourceRunId} with frozen route candidate ${attempt.candidateIndex + 1} (${attempt.host}/${attempt.runtime}).`
        : attempt.reason,
      skippedCandidates: skipped,
    };
    const parentSessionFile = ctx.sessionManager.getSessionFile();
    const parentLeafId = stableParentLeaf(ctx);
    if (attempt.effectiveContext === "fork" && (!parentSessionFile || !parentLeafId))
      return yield* new InvalidSubagentRequestError({
        code: "fork_context_unavailable",
        message: "Forked context requires a persisted parent session with a stable leaf.",
      });
    const routeContinuation = freezeSnapshot({
      profile: input.definition.id,
      routeSource: input.routeSource,
      candidates: input.routeCandidates,
      selectedCandidateIndex: attempt.candidateIndex,
      skippedCandidates: skipped,
    });
    const activeTools =
      attempt.runtime === "pi" ? yield* piRootActiveToolSnapshot(pi.getActiveTools()) : [];
    const name = input.rawInput.name?.trim();
    const request: StartSubagentRequest = {
      ...(name && { name }),
      ...(normalizedClaims && { writes: normalizedClaims.claims }),
      host: attempt.host,
      runtime: attempt.runtime,
      closeOnReport: attempt.closeOnReport,
      openaiFastMode: attempt.openaiFastMode,
      task,
      profile: input.definition.id,
      profileGuidance: input.definition.guidance,
      selection,
      routeContinuation,
      cwd: environment.cwd,
      context: attempt.effectiveContext,
      writeIntent: attempt.writeIntent,
      model: resolved.model,
      ...(input.retry && {
        supersedes: {
          runId: input.retry.sourceRunId,
          claimToken: input.retry.claimToken,
        },
      }),
      ...(resolved.runtimeApiKey && { runtimeApiKey: resolved.runtimeApiKey }),
      effort: attempt.effort,
      effortWasExplicit: attempt.effortWasExplicit,
      activeTools,
      projectTrusted: environment.projectTrusted,
      parentSessionId: ctx.sessionManager.getSessionId(),
      ...(parentSessionFile && { parentSessionFile }),
      ...(parentLeafId && { parentLeafId }),
    };
    return request;
  });

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
    const selectedProfile = rawInput.profile?.trim() || "generalist";
    const definition = profiles.definition(selectedProfile);
    if (!definition)
      return yield* new InvalidSubagentRequestError({
        code: "profile_unknown",
        message: `Unknown subagent profile "${selectedProfile}". Available profiles: ${PROFILE_IDS.join(", ")}.`,
      });
    const plan = profiles.resolve(profileSnapshot, definition.id, hostProfileEnvironment(pi, ctx));
    if (plan.kind === "failed")
      return yield* new InvalidSubagentRequestError({ code: plan.code, message: plan.message });
    const route = profileSnapshot.effectiveConfig.profiles[definition.id];
    return yield* resolvePlannedStart(
      pi,
      {
        rawInput,
        definition,
        plan,
        routeCandidates: route.candidates,
        routeSource: profileSnapshot.effectiveConfig.profileSources[definition.id],
        priorSkippedCandidates: [],
      },
      ctx,
      environment,
    );
  });

export const resolveProfileRetry = (
  pi: ExtensionAPI,
  claim: SubagentRetryClaim,
  ctx: ExtensionContext,
  environment: SubagentSessionEnvironment,
): Effect.Effect<
  StartSubagentRequest & {
    readonly supersedes: { readonly runId: string; readonly claimToken: string };
  },
  InvalidSubagentRequestError,
  SubagentProfileService | SubagentBackendRegistry
> =>
  Effect.gen(function* () {
    const profiles = yield* SubagentProfileService;
    const definition = profiles.definition(claim.continuation.profile);
    if (!definition)
      return yield* new InvalidSubagentRequestError({
        code: "profile_unknown",
        message: `Unknown subagent profile "${claim.continuation.profile}".`,
      });
    const failedCandidate =
      claim.continuation.candidates[claim.continuation.selectedCandidateIndex];
    const failedSkip: SkippedProfileCandidate = {
      candidateIndex: claim.continuation.selectedCandidateIndex,
      candidate: failedCandidate
        ? profileCandidateLabel(failedCandidate)
        : routeLabel(claim.source),
      code: "previous_run_failed",
      reason: `Candidate ${claim.continuation.selectedCandidateIndex + 1} failed in ${claim.source.id}: ${claim.source.error ?? "Run failed without a diagnostic."}`,
    };
    const plan = resolveProfileContinuationPlan(
      claim.continuation,
      hostProfileEnvironment(pi, ctx),
    );
    if (plan.kind === "failed")
      return yield* new InvalidSubagentRequestError({ code: plan.code, message: plan.message });
    const request = yield* resolvePlannedStart(
      pi,
      {
        rawInput: {
          task: claim.source.task,
          name: claim.source.name,
          profile: claim.continuation.profile,
          writes: claim.source.writeClaims,
        },
        definition,
        plan,
        routeCandidates: claim.continuation.candidates,
        routeSource: claim.continuation.routeSource,
        priorSkippedCandidates: [...claim.continuation.skippedCandidates, failedSkip],
        retry: { sourceRunId: claim.source.id, claimToken: claim.claimToken },
      },
      ctx,
      environment,
    );
    // The retry above always yields this exact predecessor claim.
    return { ...request, supersedes: { runId: claim.source.id, claimToken: claim.claimToken } };
  });
