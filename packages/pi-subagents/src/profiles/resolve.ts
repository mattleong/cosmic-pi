import { supportsSubagentFastMode } from "../run/fast-mode.ts";
import { resolvePiModelSelector, type PiCatalogModel } from "../run/model-catalog.ts";
import type {
  SubagentContextMode,
  SubagentEffort,
  SubagentHost,
  SubagentRuntime,
  SubagentWriteIntent,
} from "../run/model.ts";
import { profileDefinition } from "./definitions.ts";
import {
  isProfileId,
  type ProfileCandidate,
  type ProfileId,
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
  readonly profile: ProfileId;
  readonly source: SubagentSelectionSource;
  readonly candidateIndex: number;
  readonly host: SubagentHost;
  readonly runtime: SubagentRuntime;
  readonly model: string;
  readonly effectiveContext: SubagentContextMode;
  readonly writeIntent: SubagentWriteIntent;
  readonly fastMode: boolean;
  readonly closeOnReport: boolean;
  readonly effort: SubagentEffort;
  readonly effortWasExplicit: boolean;
  readonly reason: string;
  readonly skippedBefore?: ReadonlyArray<SkippedProfileCandidate> | undefined;
}

export interface ProfileResolutionPlan {
  readonly kind: "resolved";
  readonly profile: ProfileId;
  readonly attempts: ReadonlyArray<ProfileCandidateAttempt>;
  readonly skippedCandidates: ReadonlyArray<SkippedProfileCandidate>;
  readonly trailingSkippedCandidates: ReadonlyArray<SkippedProfileCandidate>;
}

export interface ProfileResolutionFailure {
  readonly kind: "failed";
  readonly code: "profile_unknown" | "profile_no_eligible_model" | "fork_context_unavailable";
  readonly message: string;
  readonly profile?: ProfileId | undefined;
  readonly skippedCandidates: ReadonlyArray<SkippedProfileCandidate>;
}

export type ProfileResolution = ProfileResolutionPlan | ProfileResolutionFailure;

export const profileCandidateLabel = (candidate: ProfileCandidate): string =>
  `${candidate.host}/${candidate.runtime}/${candidate.model}:${candidate.effort}:${candidate.context}:${candidate.writeIntent}:fastMode=${candidate.fastMode}:closeOnReport=${candidate.closeOnReport}`;

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

interface CandidateResult {
  readonly attempt?: ProfileCandidateAttempt | undefined;
  readonly skipped?: SkippedProfileCandidate | undefined;
}

const softEffort = (
  profileDefault: SubagentEffort | undefined,
  parent: ParentProfileModel | undefined,
): SubagentEffort => profileDefault ?? parent?.effort ?? "high";

const baseAttempt = (
  profile: ProfileId,
  candidate: ProfileCandidate,
  candidateIndex: number,
  effort: SubagentEffort,
  effortWasExplicit: boolean,
  model = candidate.model,
): ProfileCandidateAttempt => ({
  profile,
  source: candidate.model === "parent" ? "profile-parent-candidate" : "profile-candidate",
  candidateIndex,
  host: candidate.host,
  runtime: candidate.runtime,
  model,
  effectiveContext: candidate.context,
  writeIntent: candidate.writeIntent,
  fastMode: candidate.fastMode,
  closeOnReport: candidate.closeOnReport,
  effort,
  effortWasExplicit,
  reason: `Profile ${profile} selected ${candidate.host}/${candidate.runtime} candidate ${candidateIndex + 1}.`,
});

const resolveCandidate = (
  profile: ProfileId,
  candidate: ProfileCandidate,
  candidateIndex: number,
  environment: ProfileResolutionEnvironment,
  profileDefaultEffort: SubagentEffort | undefined,
): CandidateResult => {
  const label = profileCandidateLabel(candidate);
  const hardEffort = candidate.effort === "default" ? undefined : candidate.effort;
  const selectedEffort = hardEffort ?? softEffort(profileDefaultEffort, environment.parentModel);

  if (candidate.context === "fork" && !environment.forkAvailable)
    return {
      skipped: skip(
        label,
        "fork_context_unavailable",
        "Forked context requires a persisted parent session with a stable leaf.",
        candidateIndex,
      ),
    };

  // Unsupported adapters remain syntactically and statically representable. Host resolution
  // dynamically classifies them so ordered fallback is visible in launch provenance.
  if (candidate.host !== "local" || candidate.runtime !== "pi")
    return {
      attempt: baseAttempt(
        profile,
        candidate,
        candidateIndex,
        selectedEffort,
        hardEffort !== undefined,
      ),
    };

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
    const effortSkip = unsupportedPiEffort(
      environment,
      resolved.provider,
      resolved.id,
      hardEffort,
      label,
      candidateIndex,
    );
    if (effortSkip) return { skipped: effortSkip };
    const resolvedModel = `${resolved.provider}/${resolved.id}`;
    if (candidate.fastMode && !supportsSubagentFastMode("pi", resolvedModel))
      return {
        skipped: skip(
          label,
          "fast_mode_unsupported",
          `Pi model ${resolvedModel} does not support fast mode.`,
          candidateIndex,
        ),
      };
    return {
      attempt: baseAttempt(
        profile,
        candidate,
        candidateIndex,
        selectedEffort,
        hardEffort !== undefined,
        resolvedModel,
      ),
    };
  }

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
  const effortSkip = unsupportedPiEffort(
    environment,
    resolved.provider,
    resolved.id,
    hardEffort,
    label,
    candidateIndex,
  );
  if (effortSkip) return { skipped: effortSkip };
  const resolvedModel = `${resolved.provider}/${resolved.id}`;
  if (candidate.fastMode && !supportsSubagentFastMode("pi", resolvedModel))
    return {
      skipped: skip(
        label,
        "fast_mode_unsupported",
        `Pi model ${resolvedModel} does not support fast mode.`,
        candidateIndex,
      ),
    };
  return {
    attempt: baseAttempt(
      profile,
      candidate,
      candidateIndex,
      selectedEffort,
      hardEffort !== undefined,
      resolvedModel,
    ),
  };
};

/** Pure deterministic profile planning. Foreign readiness checks happen while consuming attempts. */
export function resolveProfilePlan(
  requestedProfile: string,
  config: ResolvedSubagentConfig,
  environment: ProfileResolutionEnvironment,
): ProfileResolution {
  if (!isProfileId(requestedProfile))
    return {
      kind: "failed",
      code: "profile_unknown",
      message: `Unknown subagent profile "${requestedProfile}". Available profiles: ${Object.keys(config.profiles).join(", ")}.`,
      skippedCandidates: [],
    };
  const definition = profileDefinition(requestedProfile);
  const route = config.profiles[requestedProfile];
  if (route.candidates.length === 0) {
    const source = config.profileSources[requestedProfile];
    const message =
      source === "global-invalid" || source === "project-invalid"
        ? `Profile ${requestedProfile} has an invalid ${source === "project-invalid" ? "project" : "global"} route and fails closed; repair ${source === "project-invalid" ? config.projectConfigPath : config.globalConfigPath}.`
        : `Profile ${requestedProfile} is disabled and has no eligible candidate.`;
    return {
      kind: "failed",
      code: "profile_no_eligible_model",
      profile: requestedProfile,
      message,
      skippedCandidates: [],
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
      environment,
      definition.defaultEffort,
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
      attempts,
      skippedCandidates,
      trailingSkippedCandidates: pendingSkipped,
    };
  const forkUnavailable =
    skippedCandidates.length > 0 &&
    skippedCandidates.every((candidate) => candidate.code === "fork_context_unavailable");
  return {
    kind: "failed",
    code: forkUnavailable ? "fork_context_unavailable" : "profile_no_eligible_model",
    profile: requestedProfile,
    message: forkUnavailable
      ? `Profile ${requestedProfile} requires forked context, but the parent session has no stable persisted leaf.`
      : `Profile ${requestedProfile} has no eligible candidate.${skippedCandidates.length > 0 ? ` ${skippedCandidates.map((candidate) => candidate.reason).join(" ")}` : ""}`,
    skippedCandidates,
  };
}
