import * as Predicate from "effect/Predicate";

import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { freezeSnapshot } from "pi-cosmic-core";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { SubagentBackendRegistry } from "../backend/service.ts";
import { ORCHESTRATION_TOOL_DENYLIST, piToolsForWriteIntent } from "../run/tool-policy.ts";
import {
  disallowedLaunchOverrideMessage,
  firstDisallowedLaunchOverride,
} from "../run/launch-validation.ts";
import {
  InvalidSubagentRequestError,
  isCleanupUnconfirmed,
  isOutcomeUncertain,
} from "../run/errors.ts";
import { supportsSubagentFastMode } from "../run/fast-mode.ts";
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

const resolvePiModel = (
  host: SubagentHost,
  selector: string,
  effort: SubagentEffort,
  effortWasExplicit: boolean,
  ctx: ExtensionContext,
): Effect.Effect<
  { readonly model: string; readonly runtimeApiKey?: RuntimeApiKey | undefined },
  InvalidSubagentRequestError
> =>
  Effect.gen(function* () {
    // Herdr Pi now performs normal global extension discovery under --no-approve. Project-local
    // providers remain blocked by Pi's trust loader, while global provider models are eligible.
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
    // SAFETY: The boundary adapter's ownership and validation checks establish this host contract before use.
    const supportedEfforts = getSupportedThinkingLevels(model) as ReadonlyArray<SubagentEffort>;
    if (effortWasExplicit && !supportedEfforts.includes(effort))
      return yield* new InvalidSubagentRequestError({
        code: "pi_effort_unsupported",
        message: `Pi model ${modelId} does not support required effort ${effort}; supported efforts: ${supportedEfforts.join(", ") || "none"}.`,
      });
    const authSource = ctx.modelRegistry.getProviderAuthStatus(model.provider).source;
    const requiresPrivateTransfer =
      authSource === "runtime" || (host === "herdr" && authSource === "environment");
    if (!requiresPrivateTransfer) return { model: modelId };
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

interface ResolvedConcreteModel {
  readonly host: SubagentHost;
  readonly runtime: SubagentRuntime;
  readonly closeOnReport: boolean;
  readonly fastMode: boolean;
  readonly model: string;
  readonly effort: SubagentEffort;
  readonly effortWasExplicit: boolean;
  readonly runtimeApiKey?: RuntimeApiKey | undefined;
}

/** Unknown host values clamp to the existing conservative inheritance default. */
const inheritedParentEffort = (pi: ExtensionAPI): SubagentEffort =>
  decodeSubagentEffort(pi.getThinkingLevel()) ?? "high";

// SAFETY: The boundary adapter's ownership and validation checks establish this host contract before use.
export const hostProfileEnvironment = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): ProfileResolutionEnvironment =>
  (() => {
    const baseResult = {
      availablePiModels: ctx.modelRegistry.getAvailable().map((model) => ({
        provider: model.provider,
        id: model.id,
        supportedEfforts: getSupportedThinkingLevels(model).flatMap((effort) => {
          const decoded = decodeSubagentEffort(effort);
          return decoded === undefined ? [] : [decoded];
        }),
      })),
    };
    const withParentModel = ctx.model
      ? {
          ...baseResult,
          parentModel: {
            model: `${ctx.model.provider}/${ctx.model.id}`,
            effort: inheritedParentEffort(pi),
          },
        }
      : baseResult;
    const withForkAvailable = {
      ...withParentModel,
      forkAvailable: Boolean(ctx.sessionManager.getSessionFile() && stableParentLeaf(ctx)),
    };
    return withForkAvailable;
  })();

const resolveConcreteModel = (
  attempt: ProfileCandidateAttempt,
  ctx: ExtensionContext,
  cwd: string,
): Effect.Effect<ResolvedConcreteModel, InvalidSubagentRequestError, SubagentBackendRegistry> =>
  Effect.gen(function* () {
    const registry = yield* SubagentBackendRegistry;
    const resolved =
      attempt.runtime === "pi"
        ? yield* resolvePiModel(
            attempt.host,
            attempt.model,
            attempt.effort,
            attempt.effortWasExplicit,
            ctx,
          )
        : { model: attempt.model };
    if (attempt.fastMode && !supportsSubagentFastMode(attempt.runtime, resolved.model))
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
    return {
      host: attempt.host,
      runtime: attempt.runtime,
      closeOnReport: attempt.closeOnReport,
      fastMode: attempt.fastMode,
      ...resolved,
      effort: attempt.effort,
      effortWasExplicit: attempt.effortWasExplicit,
    };
  });

interface CandidateReadinessFailure {
  readonly message: string;
  readonly _tag: string;
  readonly code?: string | undefined;
}

const dynamicCandidateSkip = (
  attempt: ProfileCandidateAttempt,
  error: CandidateReadinessFailure,
): SkippedProfileCandidate => ({
  candidateIndex: attempt.candidateIndex,
  candidate: `${attempt.host}/${attempt.runtime}/${attempt.model}:${attempt.effort}`,
  code: error.code || error._tag,
  reason: error.message,
});

const HERDR_PROTOCOL_FALLBACK_CODES = new Set([
  "herdr_upgrade_required",
  "herdr_protocol_unsupported",
  "herdr_protocol_mismatch",
]);

const shouldFallBackFromHerdrProtocol = (
  attempt: ProfileCandidateAttempt,
  error: CandidateReadinessFailure,
): boolean =>
  attempt.host === "herdr" &&
  error.code !== undefined &&
  HERDR_PROTOCOL_FALLBACK_CODES.has(error.code);

const localProtocolFallbackAttempt = (
  attempt: ProfileCandidateAttempt,
): ProfileCandidateAttempt => ({
  ...attempt,
  host: "local",
  closeOnReport: true,
  reason: `Configured Herdr candidate ${attempt.candidateIndex + 1} required an automatic local/${attempt.runtime} protocol fallback.`,
});

const localProtocolFallbackWarning = (
  attempt: ProfileCandidateAttempt,
  error: CandidateReadinessFailure,
): string =>
  `${error.message} Fell back automatically to local/${attempt.runtime}.${
    attempt.closeOnReport
      ? ""
      : " closeOnReport was forced to true because local runs close after reporting."
  }`;

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

    const tryAttempt = (
      index: number,
      skippedCandidates: ReadonlyArray<SkippedProfileCandidate>,
    ): Effect.Effect<
      {
        readonly attempt: ProfileCandidateAttempt;
        readonly concrete: ResolvedConcreteModel;
        readonly selection: SubagentSelectionProvenance;
      },
      InvalidSubagentRequestError,
      SubagentBackendRegistry
    > => {
      const attempt = input.plan.attempts[index];
      if (!attempt) {
        const exhausted = [...skippedCandidates, ...input.plan.trailingSkippedCandidates];
        const allUnsupported =
          exhausted.length > 0 &&
          exhausted.every((candidate) => candidate.code === "backend_not_implemented");
        const skipCodes = exhausted
          .map(
            (candidate) =>
              `${candidate.candidateIndex === undefined ? "route" : `candidate ${candidate.candidateIndex + 1}`}[${candidate.code}]`,
          )
          .join(", ");
        return Effect.fail(
          new InvalidSubagentRequestError({
            code: input.retry
              ? "retry_route_exhausted"
              : allUnsupported
                ? "backend_not_implemented"
                : "profile_no_eligible_model",
            message: `Profile ${input.definition.id} has no eligible ${input.retry ? "remaining candidate" : "implemented backend"} after pre-start checks.${skipCodes ? ` Skipped: ${skipCodes}.` : ""}${exhausted.length > 0 ? ` ${exhausted.map((candidate) => candidate.reason).join(" ")}` : ""}`,
          }),
        );
      }
      const precedingSkips = [...skippedCandidates, ...(attempt.skippedBefore ?? [])];
      if (normalizedClaims && attempt.writeIntent !== "writer") {
        const configuredCandidate = input.routeCandidates[attempt.candidateIndex];
        return tryAttempt(index + 1, [
          ...precedingSkips,
          {
            candidateIndex: attempt.candidateIndex,
            candidate: configuredCandidate
              ? profileCandidateLabel(configuredCandidate)
              : `${attempt.host}/${attempt.runtime}/${attempt.model}:${attempt.effort}`,
            code: "write_claims_read_only",
            reason: "writes may be supplied only for a writer profile candidate.",
          },
        ]);
      }
      const selectedResult = (
        selectedAttempt: ProfileCandidateAttempt,
        concrete: ResolvedConcreteModel,
        selectedSkips: ReadonlyArray<SkippedProfileCandidate>,
        warning?: string,
      ) => {
        const selectionBase = {
          source: selectedAttempt.source,
          routeSource: selectedAttempt.routeSource,
          host: concrete.host,
          runtime: concrete.runtime,
          closeOnReport: concrete.closeOnReport,
          candidateIndex: selectedAttempt.candidateIndex,
          reason: input.retry
            ? `Profile ${input.definition.id} continued failed run ${input.retry.sourceRunId} with frozen route candidate ${selectedAttempt.candidateIndex + 1} (${selectedAttempt.host}/${selectedAttempt.runtime}).`
            : selectedAttempt.reason,
          skippedCandidates: selectedSkips,
        };
        return {
          attempt: selectedAttempt,
          concrete,
          selection: warning === undefined ? selectionBase : { ...selectionBase, warning },
        };
      };
      return resolveConcreteModel(attempt, ctx, environment.cwd).pipe(
        Effect.matchEffect({
          onFailure: (error) => {
            if (isCleanupUnconfirmed(error) || isOutcomeUncertain(error)) return Effect.fail(error);
            const herdrSkip = dynamicCandidateSkip(attempt, error);
            if (!shouldFallBackFromHerdrProtocol(attempt, error))
              return tryAttempt(index + 1, [...precedingSkips, herdrSkip]);
            const fallbackAttempt = localProtocolFallbackAttempt(attempt);
            const fallbackSkips = [...precedingSkips, herdrSkip];
            return resolveConcreteModel(fallbackAttempt, ctx, environment.cwd).pipe(
              Effect.matchEffect({
                onFailure: (fallbackError) =>
                  isCleanupUnconfirmed(fallbackError) || isOutcomeUncertain(fallbackError)
                    ? Effect.fail(fallbackError)
                    : tryAttempt(index + 1, [
                        ...fallbackSkips,
                        dynamicCandidateSkip(fallbackAttempt, fallbackError),
                      ]),
                onSuccess: (concrete) =>
                  Effect.succeed(
                    selectedResult(
                      fallbackAttempt,
                      concrete,
                      fallbackSkips,
                      localProtocolFallbackWarning(attempt, error),
                    ),
                  ),
              }),
            );
          },
          onSuccess: (concrete) =>
            Effect.succeed(selectedResult(attempt, concrete, precedingSkips)),
        }),
      );
    };

    const selected = yield* tryAttempt(0, input.priorSkippedCandidates);
    const parentSessionFile = ctx.sessionManager.getSessionFile();
    const parentLeafId = stableParentLeaf(ctx);
    if (selected.attempt.effectiveContext === "fork" && (!parentSessionFile || !parentLeafId))
      return yield* new InvalidSubagentRequestError({
        code: "fork_context_unavailable",
        message: "Forked context requires a persisted parent session with a stable leaf.",
      });
    const concrete = selected.concrete;
    if (normalizedClaims && selected.attempt.writeIntent !== "writer")
      return yield* new InvalidSubagentRequestError({
        code: "write_claims_read_only",
        message: `Profile ${input.definition.id} resolved to read-only; writes may be supplied only for a writer profile.`,
      });
    const routeContinuation = freezeSnapshot({
      profile: input.definition.id,
      routeSource: input.routeSource,
      candidates: input.routeCandidates.map((candidate) => ({ ...candidate })),
      selectedCandidateIndex: selected.attempt.candidateIndex,
      skippedCandidates: selected.selection.skippedCandidates.map((candidate) => ({
        ...candidate,
      })),
    });
    return (() => {
      const baseResult = {};
      const withName = input.rawInput.name?.trim()
        ? { ...baseResult, name: input.rawInput.name.trim() }
        : baseResult;
      const withWrites = normalizedClaims
        ? { ...withName, writes: normalizedClaims.claims }
        : withName;
      const withHostAndAdditionalFields = {
        ...withWrites,
        host: concrete.host,
        runtime: concrete.runtime,
        closeOnReport: concrete.closeOnReport,
        fastMode: concrete.fastMode,
        task,
        profile: input.definition.id,
        profileGuidance: input.definition.guidance,
        selection: selected.selection,
        routeContinuation,
        cwd: environment.cwd,
        context: selected.attempt.effectiveContext,
        writeIntent: selected.attempt.writeIntent,
        model: concrete.model,
      };
      const withSupersedes = input.retry
        ? {
            ...withHostAndAdditionalFields,
            supersedes: {
              runId: input.retry.sourceRunId,
              claimToken: input.retry.claimToken,
            },
          }
        : withHostAndAdditionalFields;
      const withRuntimeApiKey = concrete.runtimeApiKey
        ? { ...withSupersedes, runtimeApiKey: concrete.runtimeApiKey }
        : withSupersedes;
      const withEffortAndAdditionalFields = {
        ...withRuntimeApiKey,
        effort: concrete.effort,
        effortWasExplicit: concrete.effortWasExplicit,
        activeTools: piToolsForWriteIntent(
          pi.getActiveTools().filter((name) => !ORCHESTRATION_TOOL_DENYLIST.has(name)),
          selected.attempt.writeIntent,
        ),
        projectTrusted: environment.projectTrusted,
        parentSessionId: ctx.sessionManager.getSessionId(),
      };
      const withParentSessionFile = parentSessionFile
        ? { ...withEffortAndAdditionalFields, parentSessionFile }
        : withEffortAndAdditionalFields;
      const withParentLeafId = parentLeafId
        ? { ...withParentSessionFile, parentLeafId }
        : withParentSessionFile;
      return withParentLeafId;
    })() satisfies StartSubagentRequest;
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
        : `${claim.source.host}/${claim.source.runtime}/${claim.source.model}:${claim.source.effort}`,
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
    if (!request.supersedes)
      return yield* new InvalidSubagentRequestError({
        code: "retry_claim_stale",
        message: `Subagent ${claim.source.id} retry resolution lost its predecessor claim.`,
      });
    return { ...request, supersedes: request.supersedes };
  });
