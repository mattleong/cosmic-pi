import type {
  SubagentContextMode,
  SubagentEffort,
  SubagentHost,
  SubagentRuntime,
  SubagentWriteIntent,
} from "../run/model.ts";

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

/** A v4 route candidate. Every routing and capability choice is profile-owned. */
export interface ProfileCandidate {
  readonly host: SubagentHost;
  readonly runtime: SubagentRuntime;
  readonly model: string;
  readonly effort: ProfileCandidateEffort;
  readonly context: SubagentContextMode;
  readonly writeIntent: SubagentWriteIntent;
  /** Omitted configuration values normalize to true. */
  readonly closeOnReport: boolean;
}

/** Runtime-normalized route. The configured `disabled` value is represented by zero candidates. */
export interface ProfileRoute {
  readonly candidates: ReadonlyArray<ProfileCandidate>;
}

export type DeclaredProfileCandidate = Omit<ProfileCandidate, "closeOnReport"> & {
  readonly closeOnReport?: boolean | undefined;
};
export type DeclaredProfileRoute =
  | DeclaredProfileCandidate
  | ReadonlyArray<DeclaredProfileCandidate>
  | "disabled";
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
  readonly defaultWriteIntent: SubagentWriteIntent;
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

export type SubagentSelectionSource = "profile-candidate" | "profile-parent-candidate";

export interface SubagentSelectionProvenance {
  readonly source: SubagentSelectionSource;
  readonly host?: SubagentHost | undefined;
  readonly runtime?: SubagentRuntime | undefined;
  readonly closeOnReport?: boolean | undefined;
  /** Zero-based configured candidate index. */
  readonly candidateIndex?: number | undefined;
  readonly reason: string;
  readonly skippedCandidates: ReadonlyArray<SkippedProfileCandidate>;
  readonly warning?: string | undefined;
}
