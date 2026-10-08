import { resolvePiModelSelector, type PiCatalogModel } from "../run/model-catalog.ts";
import type {
  SubagentContextMode,
  SubagentEffort,
  SubagentHost,
  SubagentRuntime,
  SubagentWriteIntent,
} from "../domain/routing.ts";
import { PROFILE_DEFINITIONS } from "./definitions.ts";
import {
  isLocalPiProfileCandidate,
  isProfileId,
  profileCandidateLabel,
  supportsSubagentFastMode,
  type ProfileCandidate,
  type ProfileDefinition,
  type ProfileId,
  type ProfileRoute,
  type ProfileRouteContinuation,
  type ProfileRouteSource,
  type SkippedProfileCandidate,
  type SubagentSelectionSource,
} from "./model.ts";
import type { ResolvedSubagentConfig } from "../config/options.ts";

export interface ParentProfileModel {
  readonly model: string;
  readonly effort: SubagentEffort;
}

export interface ProfileResolutionEnvironment {
  readonly availablePiModels: ReadonlyArray<PiCatalogModel>;
  readonly parentModel?: ParentProfileModel | undefined;
  readonly forkAvailable: boolean;
}

export interface ProfileCandidateAttempt {
  readonly source: SubagentSelectionSource;
  readonly routeSource: ProfileRouteSource;
  readonly candidateIndex: number;
  readonly host: SubagentHost;
  readonly runtime: SubagentRuntime;
  readonly model: string;
  readonly effectiveContext: SubagentContextMode;
  readonly writeIntent: SubagentWriteIntent;
  readonly openaiFastMode: boolean;
  readonly closeOnReport: boolean;
  readonly effort: SubagentEffort;
  readonly effortWasExplicit: boolean;
  readonly reason: string;
  readonly skippedBefore?: ReadonlyArray<SkippedProfileCandidate> | undefined;
}

export interface ProfileResolutionPlan {
  readonly kind: "resolved";
  readonly attempts: ReadonlyArray<ProfileCandidateAttempt>;
  readonly skippedCandidates: ReadonlyArray<SkippedProfileCandidate>;
  readonly trailingSkippedCandidates: ReadonlyArray<SkippedProfileCandidate>;
}

export interface ProfileResolutionFailure {
  readonly kind: "failed";
  readonly code:
    | "profile_unknown"
    | "profile_no_eligible_model"
    | "fork_context_unavailable"
    | "retry_route_exhausted";
  readonly message: string;
  readonly skippedCandidates: ReadonlyArray<SkippedProfileCandidate>;
}

export type ProfileResolution = ProfileResolutionPlan | ProfileResolutionFailure;

type UnscopedProfileCandidateAttempt = Omit<
  ProfileCandidateAttempt,
  "routeSource" | "reason" | "skippedBefore"
>;

interface CandidateResult {
  readonly attempt?: UnscopedProfileCandidateAttempt | undefined;
  readonly skipped?: SkippedProfileCandidate | undefined;
}

/** Exact skip codes and message fragments distinguishing parent from explicit local-Pi selectors. */
type PiModelSkips = typeof PARENT_MODEL_SKIPS | typeof LOCAL_PI_MODEL_SKIPS;

const PARENT_MODEL_SKIPS = {
  ambiguousCode: "parent_model_ambiguous",
  unresolvedCode: "parent_model_unavailable",
  subject: "Parent model",
  unresolvedPredicate: "is unavailable",
} as const;

const LOCAL_PI_MODEL_SKIPS = {
  ambiguousCode: "pi_model_ambiguous",
  unresolvedCode: "pi_model_unknown",
  subject: "Pi candidate",
  unresolvedPredicate: "is unknown or unauthenticated",
} as const;

const resolveCandidate = (
  candidate: ProfileCandidate,
  candidateIndex: number,
  environment: ProfileResolutionEnvironment,
  profileDefaultEffort: SubagentEffort | undefined,
): CandidateResult => {
  const label = profileCandidateLabel(candidate);
  const hardEffort = candidate.effort === "default" ? undefined : candidate.effort;
  const skipCandidate = (code: string, reason: string): CandidateResult => ({
    skipped: { candidateIndex, candidate: label, code, reason },
  });
  const accept = (model = candidate.model): CandidateResult => ({
    attempt: {
      source: candidate.model === "parent" ? "profile-parent-candidate" : "profile-candidate",
      candidateIndex,
      host: candidate.host,
      runtime: candidate.runtime,
      model,
      effectiveContext: candidate.context,
      writeIntent: candidate.writeIntent,
      openaiFastMode: candidate.openaiFastMode ?? false,
      closeOnReport: candidate.closeOnReport,
      effort: hardEffort ?? profileDefaultEffort ?? environment.parentModel?.effort ?? "high",
      effortWasExplicit: hardEffort !== undefined,
    },
  });
  /** Shared tail for parent and explicit local-Pi model selection: resolve, effort, fast mode. */
  const resolvePiModel = (selector: string, skips: PiModelSkips): CandidateResult => {
    const resolved = resolvePiModelSelector(selector, environment.availablePiModels);
    if (resolved.kind !== "resolved")
      return skipCandidate(
        resolved.kind === "ambiguous" ? skips.ambiguousCode : skips.unresolvedCode,
        resolved.kind === "ambiguous"
          ? `${skips.subject} is ambiguous: ${resolved.candidates.join(", ")}.`
          : `${skips.subject} ${skips.unresolvedPredicate}${
              resolved.nearMatches.length > 0
                ? `; close matches: ${resolved.nearMatches.join(", ")}`
                : ""
            }.`,
      );
    const resolvedModel = `${resolved.provider}/${resolved.id}`;
    const supportedEfforts = environment.availablePiModels.find(
      (model) => model.provider === resolved.provider && model.id === resolved.id,
    )?.supportedEfforts;
    if (hardEffort !== undefined && supportedEfforts && !supportedEfforts.includes(hardEffort))
      return skipCandidate(
        "pi_effort_unsupported",
        `Pi model ${resolvedModel} does not support required effort ${hardEffort}; supported efforts: ${supportedEfforts.join(", ") || "none"}.`,
      );
    if (candidate.openaiFastMode && !supportsSubagentFastMode("pi", resolvedModel))
      return skipCandidate(
        "fast_mode_unsupported",
        `Pi model ${resolvedModel} does not support fast mode.`,
      );
    return accept(resolvedModel);
  };

  if (candidate.context === "fork" && !environment.forkAvailable)
    return skipCandidate(
      "fork_context_unavailable",
      "Forked context requires a persisted parent session with a stable leaf.",
    );

  // Unsupported adapters remain syntactically and statically representable. Host resolution
  // dynamically classifies them so ordered fallback is visible in launch provenance.
  if (!isLocalPiProfileCandidate(candidate)) return accept();

  if (candidate.model === "parent") {
    const parent = environment.parentModel;
    if (!parent)
      return skipCandidate("parent_model_missing", "No active parent model is available.");
    return resolvePiModel(parent.model, PARENT_MODEL_SKIPS);
  }
  return resolvePiModel(candidate.model, LOCAL_PI_MODEL_SKIPS);
};

const resolveKnownProfileRoute = (
  profile: ProfileId,
  route: ProfileRoute,
  routeSource: ProfileRouteSource,
  environment: ProfileResolutionEnvironment,
  startCandidateIndex: number,
): ProfileResolution => {
  const { defaultEffort }: ProfileDefinition = PROFILE_DEFINITIONS[profile];
  const routeLabel =
    routeSource === "builtin"
      ? "built-in route"
      : routeSource === "session"
        ? "session override"
        : `${routeSource} route`;
  const attempts: ProfileCandidateAttempt[] = [];
  const skippedCandidates: SkippedProfileCandidate[] = [];
  let pendingSkipped: SkippedProfileCandidate[] = [];
  route.candidates.forEach((candidate, candidateIndex) => {
    if (candidateIndex < startCandidateIndex) return;
    const result = resolveCandidate(candidate, candidateIndex, environment, defaultEffort);
    if (result.attempt) {
      attempts.push({
        ...result.attempt,
        reason: `Profile ${profile} selected ${routeLabel} candidate ${result.attempt.candidateIndex + 1} (${result.attempt.host}/${result.attempt.runtime}).`,
        routeSource,
        skippedBefore: pendingSkipped,
      });
      pendingSkipped = [];
    }
    if (result.skipped) {
      skippedCandidates.push(result.skipped);
      pendingSkipped.push(result.skipped);
    }
  });
  const skippedReasons = skippedCandidates.map((candidate) => ` ${candidate.reason}`).join("");
  if (attempts.length > 0)
    return {
      kind: "resolved",
      attempts,
      skippedCandidates,
      trailingSkippedCandidates: pendingSkipped,
    };
  if (startCandidateIndex > 0)
    return {
      kind: "failed",
      code: "retry_route_exhausted",
      message: `Profile ${profile} has no eligible remaining candidate after candidate ${startCandidateIndex}.${skippedReasons}`,
      skippedCandidates,
    };
  const forkUnavailable =
    skippedCandidates.length > 0 &&
    skippedCandidates.every((candidate) => candidate.code === "fork_context_unavailable");
  return {
    kind: "failed",
    code: forkUnavailable ? "fork_context_unavailable" : "profile_no_eligible_model",
    message: forkUnavailable
      ? `Profile ${profile} requires forked context, but the parent session has no stable persisted leaf.`
      : `Profile ${profile} has no eligible candidate.${skippedReasons}`,
    skippedCandidates,
  };
};

/** Pure deterministic profile planning. Foreign readiness checks happen while consuming attempts. */
export function resolveProfilePlan(
  profile: string,
  config: ResolvedSubagentConfig,
  environment: ProfileResolutionEnvironment,
): ProfileResolution {
  if (!isProfileId(profile))
    return {
      kind: "failed",
      code: "profile_unknown",
      message: `Unknown subagent profile "${profile}". Available profiles: ${Object.keys(config.profiles).join(", ")}.`,
      skippedCandidates: [],
    };
  const route = config.profiles[profile];
  if (route.candidates.length === 0) {
    const source = config.profileSources[profile];
    const message =
      source === "global-invalid" || source === "project-invalid"
        ? `Profile ${profile} has an invalid ${source === "project-invalid" ? "project" : "global"} route and fails closed; repair ${source === "project-invalid" ? config.projectConfigPath : config.globalConfigPath}.`
        : source === "session"
          ? `Profile ${profile} is temporarily disabled by a session override; clear it in /subagents profiles to reveal the loaded persistent route.`
          : `Profile ${profile} is disabled and has no eligible candidate.`;
    return {
      kind: "failed",
      code: "profile_no_eligible_model",
      message,
      skippedCandidates: [],
    };
  }
  return resolveKnownProfileRoute(profile, route, config.profileSources[profile], environment, 0);
}

/** Re-evaluates only candidates after the failed run's frozen route cursor. */
export const resolveProfileContinuationPlan = (
  continuation: ProfileRouteContinuation,
  environment: ProfileResolutionEnvironment,
): ProfileResolution =>
  resolveKnownProfileRoute(
    continuation.profile,
    { candidates: continuation.candidates },
    continuation.routeSource,
    environment,
    continuation.selectedCandidateIndex + 1,
  );
