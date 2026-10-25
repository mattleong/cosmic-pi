import type {
  ProfileCandidate,
  ProfileId,
  ProfileRouteSource,
  SubagentModelOverride,
} from "../profiles/model.ts";
import type {
  SubagentContextMode,
  SubagentEffort,
  SubagentWriteIntent,
} from "../domain/routing.ts";
import type { WriterWorkspaceMode } from "../config/schema.ts";
import type { CustomAgentScope, CustomAgentTools, InvalidCustomAgent } from "../profiles/agents.ts";
import type { FailedStartRecovery, SubagentRunView } from "../run/model.ts";

export interface SubagentStartFailure {
  readonly index: number;
  readonly name?: string;
  readonly message: string;
  readonly code?: string;
  readonly admittedRun?: FailedStartRecovery;
}

export interface SubagentStartResolvedRoute {
  readonly profile: string;
  readonly agent?: string | undefined;
  readonly model: string;
  readonly effort: SubagentEffort;
  readonly openaiFastMode: boolean;
  readonly candidateIndex?: number | undefined;
  readonly warning?: string | undefined;
  readonly modelOverride?: SubagentModelOverride | undefined;
}

export type SubagentStartOutcome =
  | {
      readonly index: number;
      readonly run: SubagentRunView;
    }
  | {
      readonly index: number;
      readonly failure: SubagentStartFailure;
      readonly resolvedRoute?: SubagentStartResolvedRoute | undefined;
    };

export interface SubagentActionFailure {
  readonly id: string;
  readonly message: string;
  readonly code?: string;
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

/** A custom agent's declaration and its routed profile's candidates after its overrides. */
export interface SubagentAgentView {
  readonly name: string;
  readonly description: string;
  readonly profile: ProfileId;
  readonly source: CustomAgentScope;
  readonly effort?: SubagentEffort | undefined;
  readonly context?: SubagentContextMode | undefined;
  readonly writeIntent?: SubagentWriteIntent | undefined;
  readonly isolation?: WriterWorkspaceMode | undefined;
  readonly tools?: CustomAgentTools | undefined;
  readonly candidates: ReadonlyArray<ProfileCandidateDiscovery>;
}

export type SubagentInvalidAgentView = InvalidCustomAgent;
