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
  readonly source: SubagentSelectionSource;
  readonly candidateIndex: number;
  readonly backend: SubagentBackend;
  readonly model: string;
  readonly effort: SubagentEffort;
  readonly effortWasExplicit: boolean;
  readonly reason: string;
  readonly skippedBefore?: ReadonlyArray<SkippedProfileCandidate> | undefined;
}

export interface ProfileResolutionPlan {
  readonly kind: "resolved";
  readonly profile: ProfileId;
  readonly context: SubagentContextMode;
  readonly attempts: ReadonlyArray<ProfileCandidateAttempt>;
  readonly skippedCandidates: ReadonlyArray<SkippedProfileCandidate>;
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
  `${candidate.model}:${candidate.effort}`;

const skip = (
  candidate: string,
  code: string,
  reason: string,
  candidateIndex: number,
): SkippedProfileCandidate => ({ candidateIndex, candidate, code, reason });

const unsupportedPiEffort = (
  environment: ProfileResolutionEnvironment,
  provider: string,
  id: string,
  effort: SubagentEffort | undefined,
  label: string,
  candidateIndex: number,
): SkippedProfileCandidate | undefined => {
  if (effort === undefined) return undefined;
  const model = environment.availablePiModels.find(
    (candidate) => candidate.provider === provider && candidate.id === id,
  );
  if (!model?.supportedEfforts || model.supportedEfforts.includes(effort)) return undefined;
  return skip(
    label,
    "pi_effort_unsupported",
    `Pi model ${provider}/${id} does not support required effort ${effort}; supported efforts: ${model.supportedEfforts.join(", ") || "none"}.`,
    candidateIndex,
  );
};

const automaticPolicySkip = (
  config: ResolvedSubagentConfig,
  backend: SubagentBackend,
  model: string,
  label: string,
  candidateIndex: number,
): SkippedProfileCandidate | undefined => {
  const policy = modelPolicyFor(config, backend, model);
  if (policy === "denied")
    return skip(
      label,
      "model_denied",
      `Model ${backend}/${model} is denied by policy.`,
      candidateIndex,
    );
  return undefined;
};

interface CandidateResult {
  readonly attempt?: ProfileCandidateAttempt | undefined;
  readonly skipped?: SkippedProfileCandidate | undefined;
}

const softEffort = (
  profileDefault: SubagentEffort | undefined,
  parent: ParentProfileModel | undefined,
): SubagentEffort => profileDefault ?? parent?.effort ?? "high";

const resolveCandidate = (
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
  const configuredEffort = candidate.effort === "default" ? undefined : candidate.effort;
  const hardEffort = effortOverride ?? configuredEffort;
  const selectedEffort = hardEffort ?? softEffort(profileDefaultEffort, environment.parentModel);

  if (candidate.model === "parent") {
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
    const effortSkip = unsupportedPiEffort(
      environment,
      resolved.provider,
      resolved.id,
      hardEffort,
      label,
      candidateIndex,
    );
    if (effortSkip) return { skipped: effortSkip };
    return {
      attempt: {
        profile,
        source: "profile-parent-candidate",
        candidateIndex,
        backend: "pi",
        model,
        effort: selectedEffort,
        effortWasExplicit: hardEffort !== undefined,
        reason: `Profile ${profile} selected parent candidate ${candidateIndex + 1}.`,
      },
    };
  }

  if (candidate.model.startsWith("claude-cli/")) {
    const model = candidate.model.slice("claude-cli/".length);
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
    if (!isClaudeModelSelector(model))
      return {
        skipped: skip(
          label,
          "claude_model_invalid",
          "Candidate is not a valid Claude alias or full Claude model ID.",
          candidateIndex,
        ),
      };
    if (hardEffort === "off" || hardEffort === "minimal")
      return {
        skipped: skip(
          label,
          "claude_effort_unsupported",
          `Claude CLI does not support effort ${hardEffort}.`,
          candidateIndex,
        ),
      };
    const policySkip = automaticPolicySkip(config, "claude-cli", model, label, candidateIndex);
    if (policySkip) return { skipped: policySkip };
    const effort =
      hardEffort ??
      (selectedEffort === "off" || selectedEffort === "minimal" ? "low" : selectedEffort);
    return {
      attempt: {
        profile,
        source: "profile-candidate",
        candidateIndex,
        backend: "claude-cli",
        model,
        effort,
        effortWasExplicit: hardEffort !== undefined,
        reason: `Profile ${profile} selected configured candidate ${candidateIndex + 1}.`,
      },
    };
  }

  const selector = candidate.model.slice("pi/".length);
  const configuredPolicySkip = automaticPolicySkip(config, "pi", selector, label, candidateIndex);
  if (configuredPolicySkip) return { skipped: configuredPolicySkip };
  const resolved = resolvePiModelSelector(selector, environment.availablePiModels);
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
  const effortSkip = unsupportedPiEffort(
    environment,
    resolved.provider,
    resolved.id,
    hardEffort,
    label,
    candidateIndex,
  );
  if (effortSkip) return { skipped: effortSkip };
  return {
    attempt: {
      profile,
      source: "profile-candidate",
      candidateIndex,
      backend: "pi",
      model,
      effort: selectedEffort,
      effortWasExplicit: hardEffort !== undefined,
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
  if (route.candidates.length === 0) {
    const source = config.profileSources[requestedProfile];
    const message =
      source === "global-invalid" || source === "project-invalid"
        ? `Profile ${requestedProfile} has an invalid ${source === "project-invalid" ? "project" : "global"} route and fails closed; repair ${source === "project-invalid" ? config.projectConfigPath : config.globalConfigPath}.`
        : `Profile ${requestedProfile} is disabled and has no eligible model.`;
    return {
      kind: "failed",
      code: "profile_no_eligible_model",
      profile: requestedProfile,
      message,
      skippedCandidates: [],
    };
  }
  if (context === "fork" && !environment.forkAvailable) {
    const unavailable = route.candidates.map((candidate, candidateIndex) =>
      candidate.model.startsWith("claude-cli/")
        ? skip(
            candidate.model,
            "claude_context_unsupported",
            "Claude CLI candidates cannot use forked Pi context.",
            candidateIndex,
          )
        : skip(
            candidate.model,
            "fork_context_unavailable",
            "Forked context requires a persisted parent session with a stable leaf.",
            candidateIndex,
          ),
    );
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
  route.candidates.forEach((candidate, candidateIndex) => {
    const result = resolveCandidate(
      requestedProfile,
      candidate,
      candidateIndex,
      context,
      config,
      environment,
      definition.defaultEffort,
      effortOverride,
    );
    if (result.attempt) {
      attempts.push({ ...result.attempt, skippedBefore: pendingSkipped });
      pendingSkipped = [];
    }
    if (result.skipped) {
      skippedCandidates.push(result.skipped);
      pendingSkipped.push(result.skipped);
    }
  });
  if (attempts.length > 0)
    return {
      kind: "resolved",
      profile: requestedProfile,
      context,
      attempts,
      skippedCandidates,
      trailingSkippedCandidates: pendingSkipped,
    };
  return {
    kind: "failed",
    code: "profile_no_eligible_model",
    profile: requestedProfile,
    message: `Profile ${requestedProfile} has no eligible model.${skippedCandidates.length > 0 ? ` ${skippedCandidates.map((candidate) => candidate.reason).join(" ")}` : ""}`,
    skippedCandidates,
  };
}
