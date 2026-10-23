import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import { resolvePiModelSelector, type PiCatalogModel } from "../run/model-catalog.ts";
import {
  clampSubagentEffort,
  subagentRuntimeEfforts,
  type SubagentContextMode,
  type SubagentEffort,
  type SubagentRuntime,
  type SubagentWriteIntent,
} from "../domain/routing.ts";
import { customAgentCandidate, type CustomAgent } from "./agents.ts";
import { PROFILE_DEFINITIONS } from "./definitions.ts";
import {
  isLocalPiProfileCandidate,
  isProfileId,
  skippedCandidateRoute,
  supportsSubagentFastMode,
  type LaunchRouteSource,
  type ProfileCandidate,
  type ProfileDefinition,
  type ProfileId,
  type ProfileRoute,
  type SkippedProfileCandidate,
  type SubagentSelectionSource,
} from "./model.ts";
import type { ResolvedSubagentConfig } from "../config/options.ts";

interface ParentProfileModel {
  readonly model: string;
  readonly effort: SubagentEffort;
}

export interface ProfileResolutionEnvironment {
  readonly availablePiModels: ReadonlyArray<PiCatalogModel>;
  readonly parentModel?: ParentProfileModel | undefined;
  readonly parentEffort?: SubagentEffort | undefined;
  readonly forkAvailable: boolean;
  /** Tokens in the parent's context, which a forked child inherits, when Pi knows them. */
  readonly parentContextTokens?: number | undefined;
}

// A forked child needs room beyond the inherited conversation to do its own work.
const FORK_CONTEXT_HEADROOM = 0.8;

export interface ProfileCandidateAttempt {
  readonly source: SubagentSelectionSource;
  readonly routeSource: LaunchRouteSource;
  readonly candidateIndex: number;
  readonly runtime: SubagentRuntime;
  readonly model: string;
  readonly effectiveContext: SubagentContextMode;
  readonly writeIntent: SubagentWriteIntent;
  readonly openaiFastMode: boolean;
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

interface ProfileResolutionFailure {
  readonly kind: "failed";
  readonly code: "profile_unknown" | "profile_no_eligible_model" | "fork_context_unavailable";
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
  const hardEffort = candidate.effort === "default" ? undefined : candidate.effort;
  const skipCandidate = (code: string, reason: string): CandidateResult => ({
    skipped: {
      candidateIndex,
      candidate: skippedCandidateRoute(candidate),
      code,
      reason,
    },
  });
  // Explicit efforts stay strict; soft defaults and the inherited parent level can name a level
  // this runtime or model lacks, such as "off" for Claude, so they move to the nearest one.
  const softEffort = (modelEfforts: ReadonlyArray<SubagentEffort> | undefined) =>
    clampSubagentEffort(
      profileDefaultEffort ?? environment.parentEffort ?? environment.parentModel?.effort ?? "high",
      Arr.filter(
        subagentRuntimeEfforts(candidate.runtime),
        (effort) => modelEfforts === undefined || modelEfforts.includes(effort),
      ),
    );
  const accept = (
    model = candidate.model,
    modelEfforts?: ReadonlyArray<SubagentEffort>,
  ): CandidateResult => ({
    attempt: {
      source: candidate.model === "parent" ? "profile-parent-candidate" : "profile-candidate",
      candidateIndex,
      runtime: candidate.runtime,
      model,
      effectiveContext: candidate.context,
      writeIntent: candidate.writeIntent,
      openaiFastMode: candidate.openaiFastMode ?? false,
      effort: hardEffort ?? softEffort(modelEfforts),
      effortWasExplicit: hardEffort !== undefined,
    },
  });
  const resolvePiModel = (selector: string, skips: PiModelSkips): CandidateResult => {
    const resolved = resolvePiModelSelector(selector, environment.availablePiModels);
    if (resolved.kind !== "resolved")
      return skipCandidate(
        resolved.kind === "ambiguous" ? skips.ambiguousCode : skips.unresolvedCode,
        resolved.kind === "ambiguous"
          ? `${skips.subject} is ambiguous: ${Arr.join(resolved.candidates, ", ")}.`
          : `${skips.subject} ${skips.unresolvedPredicate}${
              resolved.nearMatches.length > 0
                ? `; close matches: ${Arr.join(resolved.nearMatches, ", ")}`
                : ""
            }.`,
      );
    const resolvedModel = `${resolved.provider}/${resolved.id}`;
    const catalogModel = Option.getOrUndefined(
      Arr.findFirst(
        environment.availablePiModels,
        (model) => model.provider === resolved.provider && model.id === resolved.id,
      ),
    );
    const supportedEfforts = catalogModel?.supportedEfforts;
    const inherited = environment.parentContextTokens;
    if (
      candidate.context === "fork" &&
      inherited !== undefined &&
      catalogModel?.contextWindow !== undefined &&
      inherited > catalogModel.contextWindow * FORK_CONTEXT_HEADROOM
    )
      return skipCandidate(
        "fork_context_too_large",
        `Pi model ${resolvedModel} has a ${catalogModel.contextWindow}-token window, too small for the ${inherited}-token conversation a fork inherits.`,
      );
    if (hardEffort !== undefined && supportedEfforts && !supportedEfforts.includes(hardEffort))
      return skipCandidate(
        "pi_effort_unsupported",
        `Pi model ${resolvedModel} does not support required effort ${hardEffort}; supported efforts: ${Arr.join(supportedEfforts, ", ") || "none"}.`,
      );
    if (candidate.openaiFastMode && !supportsSubagentFastMode("pi", resolvedModel))
      return skipCandidate(
        "fast_mode_unsupported",
        `Pi model ${resolvedModel} does not support fast mode.`,
      );
    return accept(resolvedModel, supportedEfforts);
  };

  if (candidate.context === "fork" && !environment.forkAvailable)
    return skipCandidate(
      "fork_context_unavailable",
      "Forked context requires a persisted parent session with a stable leaf.",
    );

  if (!isLocalPiProfileCandidate(candidate)) return accept();

  if (candidate.model === "parent") {
    const parent = environment.parentModel;
    if (!parent)
      return skipCandidate("parent_model_missing", "No active parent model is available.");
    return resolvePiModel(parent.model, PARENT_MODEL_SKIPS);
  }
  return resolvePiModel(candidate.model, LOCAL_PI_MODEL_SKIPS);
};

/** An agent's overrides apply to each candidate before planning; a misfit skips it. */
const resolveRouteCandidate = (
  candidate: ProfileCandidate,
  candidateIndex: number,
  environment: ProfileResolutionEnvironment,
  profileDefaultEffort: SubagentEffort | undefined,
  agent: CustomAgent | undefined,
): CandidateResult => {
  if (!agent) return resolveCandidate(candidate, candidateIndex, environment, profileDefaultEffort);
  const applied = customAgentCandidate(candidate, agent);
  if (applied.kind === "skipped")
    return {
      skipped: {
        candidateIndex,
        candidate: skippedCandidateRoute(candidate),
        code: applied.code,
        reason: applied.reason,
      },
    };
  return resolveCandidate(applied.candidate, candidateIndex, environment, profileDefaultEffort);
};

const resolveKnownProfileRoute = (
  profile: ProfileId,
  route: ProfileRoute,
  routeSource: LaunchRouteSource,
  environment: ProfileResolutionEnvironment,
  agent?: CustomAgent,
): ProfileResolution => {
  const { defaultEffort }: ProfileDefinition = PROFILE_DEFINITIONS[profile];
  const subject = agent ? `Agent ${agent.name} (profile ${profile})` : `Profile ${profile}`;
  const routeLabel = Match.value(routeSource).pipe(
    Match.when("builtin", () => "built-in route"),
    Match.when("session", () => "session override"),
    Match.when("override", () => "model override"),
    Match.orElse((source) => `${source} route`),
  );
  const attempts: ProfileCandidateAttempt[] = [];
  const skippedCandidates: SkippedProfileCandidate[] = [];
  let pendingSkipped: SkippedProfileCandidate[] = [];
  Arr.forEach(route.candidates, (candidate, candidateIndex) => {
    const result = resolveRouteCandidate(
      candidate,
      candidateIndex,
      environment,
      defaultEffort,
      agent,
    );
    if (result.attempt) {
      attempts.push({
        ...result.attempt,
        reason: `${subject} selected ${routeLabel} candidate ${result.attempt.candidateIndex + 1} (local/${result.attempt.runtime}).`,
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
  const skippedReasons = Fn.pipe(
    skippedCandidates,
    Arr.map((candidate) => ` ${candidate.reason}`),
    Arr.join(""),
  );
  if (attempts.length > 0)
    return {
      kind: "resolved",
      attempts,
      skippedCandidates,
      trailingSkippedCandidates: pendingSkipped,
    };
  const forkUnavailable =
    skippedCandidates.length > 0 &&
    Arr.every(skippedCandidates, (candidate) => candidate.code === "fork_context_unavailable");
  return {
    kind: "failed",
    code: forkUnavailable ? "fork_context_unavailable" : "profile_no_eligible_model",
    message: forkUnavailable
      ? `${subject} requires forked context, but the parent session has no stable persisted leaf.`
      : `${subject} has no eligible candidate.${skippedReasons}`,
    skippedCandidates,
  };
};

export function resolveProfilePlan(
  profile: string,
  config: ResolvedSubagentConfig,
  environment: ProfileResolutionEnvironment,
  agent?: CustomAgent,
): ProfileResolution {
  if (!isProfileId(profile))
    return {
      kind: "failed",
      code: "profile_unknown",
      message: `Unknown subagent profile "${profile}". Available profiles: ${Arr.join(Rec.keys(config.profiles), ", ")}.`,
      skippedCandidates: [],
    };
  const route = config.profiles[profile];
  if (route.candidates.length === 0) {
    const source = config.profileSources[profile];
    const profileMessage =
      source === "global-invalid" || source === "project-invalid"
        ? `Profile ${profile} has an invalid ${source === "project-invalid" ? "project" : "global"} route and fails closed; repair ${source === "project-invalid" ? config.projectConfigPath : config.globalConfigPath}.`
        : source === "session"
          ? `Profile ${profile} is temporarily disabled by a session override; clear it in /subagents profiles to reveal the loaded persistent route.`
          : `Profile ${profile} is disabled and has no eligible candidate.`;
    const message = agent
      ? `Agent ${agent.name} routes to profile ${profile}. ${profileMessage}`
      : profileMessage;
    return {
      kind: "failed",
      code: "profile_no_eligible_model",
      message,
      skippedCandidates: [],
    };
  }
  return resolveKnownProfileRoute(
    profile,
    route,
    config.profileSources[profile],
    environment,
    agent,
  );
}

/**
 * Plans a launch whose only candidate is its per-launch model override, which already carries any
 * agent's defaults.
 */
export const resolveProfileOverridePlan = (
  profile: ProfileId,
  candidate: ProfileCandidate,
  environment: ProfileResolutionEnvironment,
): ProfileResolution =>
  resolveKnownProfileRoute(profile, { candidates: [candidate] }, "override", environment);
