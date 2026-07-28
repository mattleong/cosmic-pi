import type { SubagentBackend, SubagentContextMode, SubagentEffort } from "../run/model.ts";

export const PROFILE_IDS = [
  "scout",
  "researcher",
  "planner",
  "worker",
  "reviewer",
  "oracle",
  "delegate",
] as const;

export type ProfileId = (typeof PROFILE_IDS)[number];

export const isProfileId = (value: string): value is ProfileId =>
  (PROFILE_IDS as ReadonlyArray<string>).includes(value);

export const PROFILE_CANDIDATE_EFFORTS = [
  "default",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ProfileCandidateEffort = (typeof PROFILE_CANDIDATE_EFFORTS)[number];

export interface ModelPolicySelector {
  readonly backend: SubagentBackend;
  readonly model: string;
}

/** A v2 route candidate. Selectors are canonical and effort is always declared. */
export interface ProfileCandidate {
  readonly model: string;
  readonly effort: ProfileCandidateEffort;
}

/** Runtime-normalized route. The configured `disabled` value is represented by zero candidates. */
export interface ProfileRoute {
  readonly candidates: ReadonlyArray<ProfileCandidate>;
}

export type DeclaredProfileRoute = ProfileCandidate | ReadonlyArray<ProfileCandidate> | "disabled";
export type ProfileRouteSource =
  | "project"
  | "global"
  | "builtin"
  | "project-invalid"
  | "global-invalid";

export interface ProfileDefinition {
  readonly id: ProfileId;
  readonly description: string;
  readonly guidance: string;
  readonly defaultContext: SubagentContextMode;
  /** Soft built-in preference used by candidates whose effort is `default`. */
  readonly defaultEffort?: SubagentEffort | undefined;
}

export interface SkippedProfileCandidate {
  /** Zero-based configured candidate index. */
  readonly candidateIndex?: number | undefined;
  readonly candidate: string;
  readonly code: string;
  readonly reason: string;
}

export type SubagentSelectionSource = "explicit" | "profile-candidate" | "profile-parent-candidate";

export interface SubagentSelectionProvenance {
  readonly source: SubagentSelectionSource;
  /** Zero-based configured candidate index. */
  readonly candidateIndex?: number | undefined;
  readonly reason: string;
  readonly skippedCandidates: ReadonlyArray<SkippedProfileCandidate>;
  readonly warning?: string | undefined;
}
