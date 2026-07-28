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
export type ProfileFallback = "fail" | "parent";

export const isProfileId = (value: string): value is ProfileId =>
  (PROFILE_IDS as ReadonlyArray<string>).includes(value);

export interface ModelPolicySelector {
  readonly backend: SubagentBackend;
  readonly model: string;
}

export type ProfileCandidate =
  | {
      readonly source: "model";
      readonly backend: SubagentBackend;
      readonly model: string;
      readonly effort?: SubagentEffort | undefined;
    }
  | { readonly source: "parent" };

export interface ProfileRoute {
  readonly candidates: ReadonlyArray<ProfileCandidate>;
  readonly fallback: ProfileFallback;
}

export interface ProfileDefinition {
  readonly id: ProfileId;
  readonly description: string;
  readonly guidance: string;
  readonly defaultContext: SubagentContextMode;
  /**
   * Soft effort preference; omitted when the profile should inherit the parent session's effort.
   * Only per-call overrides and candidate-configured efforts are hard requirements.
   */
  readonly defaultEffort?: SubagentEffort | undefined;
}

export interface SkippedProfileCandidate {
  /** Zero-based configured candidate index. Omitted for fallback candidates. */
  readonly candidateIndex?: number | undefined;
  readonly candidate: string;
  readonly code: string;
  readonly reason: string;
}

export type SubagentSelectionSource =
  | "explicit"
  | "profile-candidate"
  | "profile-parent-candidate"
  | "profile-parent-fallback";

export interface SubagentSelectionProvenance {
  readonly source: SubagentSelectionSource;
  /** Zero-based configured candidate index. */
  readonly candidateIndex?: number | undefined;
  readonly reason: string;
  readonly skippedCandidates: ReadonlyArray<SkippedProfileCandidate>;
  readonly warning?: string | undefined;
}
