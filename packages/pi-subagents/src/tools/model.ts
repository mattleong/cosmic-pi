import type { ProfileCandidate, ProfileId, ProfileRouteSource } from "../profiles/model.ts";
import type {
  SubagentEffort,
  SubagentHost,
  SubagentRuntime,
  SubagentWriteIntent,
} from "../domain/routing.ts";
import type { FailedStartRecovery, SubagentRunView } from "../run/model.ts";

export interface SubagentStartFailure {
  readonly index: number;
  readonly name?: string;
  readonly message: string;
  /** Machine-actionable failure code (specific validation code or the error tag). */
  readonly code?: string;
  /** Present only when launch admission occurred and complete cleanup facts have settled. */
  readonly admittedRun?: FailedStartRecovery;
}

export interface SubagentStartResolvedRoute {
  readonly profile: string;
  readonly host: SubagentHost;
  readonly runtime: SubagentRuntime;
  readonly model: string;
  readonly effort: SubagentEffort;
  readonly openaiFastMode: boolean;
  readonly candidateIndex?: number | undefined;
  readonly warning?: string | undefined;
}

export type SubagentStartOutcome =
  | {
      readonly index: number;
      readonly run: SubagentRunView;
    }
  | {
      readonly index: number;
      readonly failure: SubagentStartFailure;
      /** Present only after a concrete route/model was selected and attempted. */
      readonly resolvedRoute?: SubagentStartResolvedRoute | undefined;
    };

export interface SubagentActionFailure {
  readonly id: string;
  readonly message: string;
  /** Machine-actionable failure code (specific validation code or the error tag). */
  readonly code?: string;
  /** The backend's typed pending-delivery flag, produced only for `send` steering. */
  readonly pendingDelivery?: true;
}

export interface ProfileCandidateDiscovery extends ProfileCandidate {
  readonly status: "eligible" | "skipped";
  readonly reason: string;
}

export interface SubagentProfileView {
  readonly id: ProfileId;
  readonly description: string;
  readonly source: ProfileRouteSource;
  readonly isDefault: boolean;
  readonly defaultContext: "fresh" | "fork";
  readonly defaultWriteIntent: SubagentWriteIntent;
  readonly defaultEffort?: SubagentEffort | undefined;
  readonly candidates: ReadonlyArray<ProfileCandidateDiscovery>;
}
