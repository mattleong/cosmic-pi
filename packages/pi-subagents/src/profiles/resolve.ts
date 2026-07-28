import { modelPolicyFor, type ResolvedSubagentConfig } from "../config/options.ts";
import { resolvePiModelSelector, type PiCatalogModel } from "../run/model-catalog.ts";
import {
  isClaudeModelSelector,
  type SubagentBackend,
  type SubagentContextMode,
  type SubagentEffort,
} from "../run/model.ts";
import { profileDefinition } from "./definitions.ts";
import {
  isProfileId,
  type ProfileCandidate,
  type ProfileId,
  type SkippedProfileCandidate,
  type SubagentSelectionSource,
} from "./model.ts";

export interface ParentProfileModel {
  readonly model: string;
  readonly effort: SubagentEffort;
}

export interface ProfileResolutionEnvironment {
  readonly availablePiModels: ReadonlyArray<PiCatalogModel>;
  readonly parentModel?: ParentProfileModel | undefined;
  readonly projectTrusted: boolean;
  readonly forkAvailable: boolean;
}

export interface ProfileCandidateAttempt {
  readonly profile: ProfileId;
  readonly source: Exclude<SubagentSelectionSource, "explicit">;
  readonly candidateIndex?: number | undefined;
  readonly backend: SubagentBackend;
  readonly model: string;
  readonly effort: SubagentEffort;
  readonly effortWasExplicit: boolean;
  readonly reason: string;
  /** Pure-policy skips encountered after the prior attempt and before this attempt. */
  readonly skippedBefore?: ReadonlyArray<SkippedProfileCandidate> | undefined;
}

export interface ProfileResolutionPlan {
  readonly kind: "resolved";
  readonly profile: ProfileId;
  readonly context: SubagentContextMode;
  readonly attempts: ReadonlyArray<ProfileCandidateAttempt>;
  /** Every pure-policy skip, for discovery. */
  readonly skippedCandidates: ReadonlyArray<SkippedProfileCandidate>;
  /** Pure-policy skips after the last eligible attempt, used only if all attempts fail pre-start. */
  readonly trailingSkippedCandidates: ReadonlyArray<SkippedProfileCandidate>;
}

export interface ProfileResolutionFailure {
  readonly kind: "failed";
  readonly code: "profile_unknown" | "profile_no_eligible_model";
  readonly message: string;
  readonly profile?: ProfileId | undefined;
  readonly skippedCandidates: ReadonlyArray<SkippedProfileCandidate>;
}

export type ProfileResolution = ProfileResolutionPlan | ProfileResolutionFailure;

export const profileCandidateLabel = (candidate: ProfileCandidate): string =>
  candidate.source === "parent"
    ? "parent model"
    : `${candidate.backend}/${candidate.model}${candidate.effort ? `:${candidate.effort}` : ""}`;

const skip = (
  candidate: string,
  code: string,
  reason: string,
  candidateIndex?: number,
): SkippedProfileCandidate => ({
  ...(candidateIndex === undefined ? {} : { candidateIndex }),
  candidate,
  code,
  reason,
});

const automaticPolicySkip = (
  config: ResolvedSubagentConfig,
  backend: SubagentBackend,
  model: string,
  label: string,
  candidateIndex?: number,
): SkippedProfileCandidate | undefined => {
  const policy = modelPolicyFor(config, backend, model);
  if (policy === "denied")
    return skip(
      label,
      "model_denied",
      `Model ${backend}/${model} is denied by policy.`,
      candidateIndex,
    );
  if (policy === "discouraged")
    return skip(
      label,
      "model_discouraged",
      `Model ${backend}/${model} is discouraged and automatic selection excludes it.`,
      candidateIndex,
    );
  return undefined;
};

interface CandidateResult {
  readonly attempt?: ProfileCandidateAttempt | undefined;
  readonly skipped?: SkippedProfileCandidate | undefined;
}

const resolveParent = (
  profile: ProfileId,
  source: "profile-parent-candidate" | "profile-parent-fallback",
  candidateIndex: number | undefined,
  label: string,
  config: ResolvedSubagentConfig,
  environment: ProfileResolutionEnvironment,
  profileDefaultEffort: SubagentEffort | undefined,
  effortOverride: SubagentEffort | undefined,
): CandidateResult => {
  const parent = environment.parentModel;
  if (!parent)
    return {
      skipped: skip(
        label,
        "parent_model_missing",
        "No active parent model is available.",
        candidateIndex,
      ),
    };
  const resolved = resolvePiModelSelector(parent.model, environment.availablePiModels);
  if (resolved.kind !== "resolved")
    return {
      skipped: skip(
        label,
        resolved.kind === "ambiguous" ? "parent_model_ambiguous" : "parent_model_unavailable",
        resolved.kind === "ambiguous"
          ? `Parent model is ambiguous: ${resolved.candidates.join(", ")}.`
          : `Parent model is unavailable${resolved.nearMatches.length > 0 ? `; close matches: ${resolved.nearMatches.join(", ")}` : ""}.`,
        candidateIndex,
      ),
    };
  const model = `${resolved.provider}/${resolved.id}`;
  const policySkip = automaticPolicySkip(config, "pi", model, label, candidateIndex);
  if (policySkip) return { skipped: policySkip };
  return {
    attempt: {
      profile,
      source,
      ...(candidateIndex === undefined ? {} : { candidateIndex }),
      backend: "pi",
      model,
      effort: effortOverride ?? profileDefaultEffort ?? parent.effort,
      // Profile defaults are soft preferences; only a per-call effort is a hard requirement here.
      effortWasExplicit: effortOverride !== undefined,
      reason:
        source === "profile-parent-fallback"
          ? `Profile ${profile} explicitly fell back to the parent model.`
          : `Profile ${profile} selected its parent-model candidate.`,
    },
  };
};

const resolveConfiguredCandidate = (
  profile: ProfileId,
  candidate: ProfileCandidate,
  candidateIndex: number,
  context: SubagentContextMode,
  config: ResolvedSubagentConfig,
  environment: ProfileResolutionEnvironment,
  profileDefaultEffort: SubagentEffort | undefined,
  effortOverride?: SubagentEffort,
): CandidateResult => {
  const label = profileCandidateLabel(candidate);
  if (candidate.source === "parent")
    return resolveParent(
      profile,
      "profile-parent-candidate",
      candidateIndex,
      label,
      config,
      environment,
      profileDefaultEffort,
      effortOverride,
    );
  if (candidate.backend === "claude-cli") {
    if (!environment.projectTrusted)
      return {
        skipped: skip(
          label,
          "claude_untrusted",
          "Claude CLI candidates require a trusted project.",
          candidateIndex,
        ),
      };
    if (context === "fork")
      return {
        skipped: skip(
          label,
          "claude_context_unsupported",
          "Claude CLI candidates cannot use forked Pi context.",
          candidateIndex,
        ),
      };
    if (!isClaudeModelSelector(candidate.model))
      return {
        skipped: skip(
          label,
          "claude_model_invalid",
          "Candidate is not a valid Claude alias or full Claude model ID.",
          candidateIndex,
        ),
      };
    // Only per-call and candidate-configured efforts are hard requirements; profile defaults and
    // inherited parent effort are soft preferences coerced into Claude's supported range.
    const hardEffort = effortOverride ?? candidate.effort;
    if (hardEffort === "off" || hardEffort === "minimal")
      return {
        skipped: skip(
          label,
          "claude_effort_unsupported",
          `Claude CLI does not support effort ${hardEffort}.`,
          candidateIndex,
        ),
      };
    const policySkip = automaticPolicySkip(
      config,
      candidate.backend,
      candidate.model,
      label,
      candidateIndex,
    );
    if (policySkip) return { skipped: policySkip };
    const softEffort = profileDefaultEffort ?? environment.parentModel?.effort ?? "high";
    return {
      attempt: {
        profile,
        source: "profile-candidate",
        candidateIndex,
        backend: candidate.backend,
        model: candidate.model,
        effort:
          hardEffort ?? (softEffort === "off" || softEffort === "minimal" ? "low" : softEffort),
        effortWasExplicit: hardEffort !== undefined,
        reason: `Profile ${profile} selected configured candidate ${candidateIndex + 1}.`,
      },
    };
  }

  const configuredPolicySkip = automaticPolicySkip(
    config,
    "pi",
    candidate.model,
    label,
    candidateIndex,
  );
  if (configuredPolicySkip) return { skipped: configuredPolicySkip };
  const resolved = resolvePiModelSelector(candidate.model, environment.availablePiModels);
  if (resolved.kind !== "resolved")
    return {
      skipped: skip(
        label,
        resolved.kind === "ambiguous" ? "pi_model_ambiguous" : "pi_model_unknown",
        resolved.kind === "ambiguous"
          ? `Pi candidate is ambiguous: ${resolved.candidates.join(", ")}.`
          : `Pi candidate is unknown or unauthenticated${resolved.nearMatches.length > 0 ? `; close matches: ${resolved.nearMatches.join(", ")}` : ""}.`,
        candidateIndex,
      ),
    };
  const model = `${resolved.provider}/${resolved.id}`;
  const policySkip = automaticPolicySkip(config, "pi", model, label, candidateIndex);
  if (policySkip) return { skipped: policySkip };
  return {
    attempt: {
      profile,
      source: "profile-candidate",
      candidateIndex,
      backend: "pi",
      model,
      effort:
        effortOverride ??
        candidate.effort ??
        profileDefaultEffort ??
        environment.parentModel?.effort ??
        "high",
      // Profile defaults stay soft so non-reasoning Pi models report their effective level.
      effortWasExplicit: effortOverride !== undefined || candidate.effort !== undefined,
      reason: `Profile ${profile} selected configured candidate ${candidateIndex + 1}.`,
    },
  };
};

/** Pure deterministic profile planning. Foreign readiness checks happen while consuming attempts. */
export function resolveProfilePlan(
  requestedProfile: string,
  config: ResolvedSubagentConfig,
  environment: ProfileResolutionEnvironment,
  contextOverride?: SubagentContextMode,
  effortOverride?: SubagentEffort,
): ProfileResolution {
  if (!isProfileId(requestedProfile))
    return {
      kind: "failed",
      code: "profile_unknown",
      message: `Unknown subagent profile "${requestedProfile}". Available profiles: ${Object.keys(config.profiles).join(", ")}.`,
      skippedCandidates: [],
    };
  const definition = profileDefinition(requestedProfile);
  const context = contextOverride ?? definition.defaultContext;
  const route = config.profiles[requestedProfile];
  if (context === "fork" && !environment.forkAvailable) {
    const unavailable = [
      // Claude candidates can never run forked context, so they keep that more specific reason
      // even when the parent session additionally lacks a stable persisted leaf.
      ...route.candidates.map((candidate, candidateIndex) =>
        candidate.source === "model" && candidate.backend === "claude-cli"
          ? skip(
              profileCandidateLabel(candidate),
              "claude_context_unsupported",
              "Claude CLI candidates cannot use forked Pi context.",
              candidateIndex,
            )
          : skip(
              profileCandidateLabel(candidate),
              "fork_context_unavailable",
              "Forked context requires a persisted parent session with a stable leaf.",
              candidateIndex,
            ),
      ),
      ...(route.fallback === "parent"
        ? [
            skip(
              "parent fallback",
              "fork_context_unavailable",
              "Forked context requires a persisted parent session with a stable leaf.",
            ),
          ]
        : []),
    ];
    return {
      kind: "failed",
      code: "profile_no_eligible_model",
      profile: requestedProfile,
      message: `Profile ${requestedProfile} cannot use forked context because the parent session has no stable persisted leaf.`,
      skippedCandidates: unavailable,
    };
  }
  const attempts: ProfileCandidateAttempt[] = [];
  const skippedCandidates: SkippedProfileCandidate[] = [];
  let pendingSkipped: SkippedProfileCandidate[] = [];
  const collect = (result: CandidateResult) => {
    if (result.attempt) {
      attempts.push({ ...result.attempt, skippedBefore: pendingSkipped });
      pendingSkipped = [];
    }
    if (result.skipped) {
      skippedCandidates.push(result.skipped);
      pendingSkipped.push(result.skipped);
    }
  };
  route.candidates.forEach((candidate, candidateIndex) => {
    collect(
      resolveConfiguredCandidate(
        requestedProfile,
        candidate,
        candidateIndex,
        context,
        config,
        environment,
        definition.defaultEffort,
        effortOverride,
      ),
    );
  });
  if (route.fallback === "parent") {
    if (route.candidates.some((candidate) => candidate.source === "parent"))
      collect({
        skipped: skip(
          "parent fallback",
          "duplicate_parent_fallback",
          "Parent fallback duplicates an earlier parent-model candidate.",
        ),
      });
    else
      collect(
        resolveParent(
          requestedProfile,
          "profile-parent-fallback",
          undefined,
          "parent fallback",
          config,
          environment,
          definition.defaultEffort,
          effortOverride,
        ),
      );
  }
  if (attempts.length > 0)
    return {
      kind: "resolved",
      profile: requestedProfile,
      context,
      attempts,
      skippedCandidates,
      trailingSkippedCandidates: pendingSkipped,
    };
  const reasons = skippedCandidates.map((candidate) => candidate.reason);
  return {
    kind: "failed",
    code: "profile_no_eligible_model",
    profile: requestedProfile,
    message: `Profile ${requestedProfile} has no eligible model.${reasons.length > 0 ? ` ${reasons.join(" ")}` : " Its route has no candidates and fallback is fail."}`,
    skippedCandidates,
  };
}
