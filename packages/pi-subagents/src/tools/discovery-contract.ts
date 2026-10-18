import { MAX_CUSTOM_AGENT_DESCRIPTION_CHARS } from "../profiles/agents.ts";
import { MAX_PROFILE_MODEL_SELECTOR_CHARS, type ProfileId } from "../profiles/model.ts";
import type { SubagentRunView } from "../run/model.ts";
import { SUBAGENT_TOOL_NAME } from "../run/tool-policy.ts";
import { projectRunCardTree } from "../ui/run-tree-rows.ts";
import type { SubagentModelsContract, SubagentStatusListContract } from "./contract-schema.ts";
import { envelope, metadata, withheldTarget } from "./contract.ts";
import { MAX_DISCOVERY_TEXT_CHARS } from "./discovery-contract-schema.ts";
import type {
  ProfileCandidateDiscovery,
  SubagentAgentView,
  SubagentInvalidAgentView,
  SubagentProfileView,
} from "./model.ts";

export const statusListContract = (
  runs: ReadonlyArray<SubagentRunView>,
): SubagentStatusListContract => ({
  ...envelope(SUBAGENT_TOOL_NAME.status),
  runs: projectRunCardTree(runs).map(({ run }) =>
    Object.assign({}, withheldTarget(run), {
      parentRunId: run.parentRunId ?? "root",
      depth: run.depth ?? 1,
    }),
  ),
});

// The v1 contract still reports the retired route fields, which are now constant.
const contractCandidates = (candidates: ReadonlyArray<ProfileCandidateDiscovery>) =>
  candidates.map((candidate) => ({
    host: "local" as const,
    runtime: candidate.runtime,
    model: metadata(candidate.model, MAX_PROFILE_MODEL_SELECTOR_CHARS) ?? "[redacted]",
    effort: candidate.effort,
    context: candidate.context,
    writeIntent: candidate.writeIntent,
    openaiFastMode: candidate.openaiFastMode ?? false,
    closeOnReport: true,
    status: candidate.status,
    reason: metadata(candidate.reason, MAX_DISCOVERY_TEXT_CHARS) ?? "No eligibility reason.",
  }));

export const modelsContract = (
  profiles: ReadonlyArray<SubagentProfileView>,
  fallbackProfile: ProfileId,
  agents: ReadonlyArray<SubagentAgentView> = [],
  invalidAgents: ReadonlyArray<SubagentInvalidAgentView> = [],
): SubagentModelsContract => ({
  ...envelope(SUBAGENT_TOOL_NAME.models),
  fallbackProfile,
  profiles: profiles.map((profile) => ({
    id: profile.id,
    description: metadata(profile.description, MAX_DISCOVERY_TEXT_CHARS) ?? profile.id,
    source: profile.source,
    isDefault: profile.isDefault,
    defaultContext: profile.defaultContext,
    defaultWriteIntent: profile.defaultWriteIntent,
    ...(profile.defaultEffort !== undefined && { defaultEffort: profile.defaultEffort }),
    candidates: contractCandidates(profile.candidates),
  })),
  ...(agents.length > 0 && {
    agents: agents.map((agent) => ({
      name: agent.name,
      description:
        metadata(agent.description, MAX_CUSTOM_AGENT_DESCRIPTION_CHARS) ?? "Custom agent.",
      profile: agent.profile,
      source: agent.source,
      ...(agent.effort !== undefined && { effort: agent.effort }),
      ...(agent.context !== undefined && { context: agent.context }),
      ...(agent.writeIntent !== undefined && { writeIntent: agent.writeIntent }),
      ...(agent.isolation !== undefined && { isolation: agent.isolation }),
      ...(agent.tools !== undefined && {
        tools: {
          ...(agent.tools.allow !== undefined && { allow: [...agent.tools.allow] }),
          ...(agent.tools.deny !== undefined && { deny: [...agent.tools.deny] }),
        },
      }),
      candidates: contractCandidates(agent.candidates),
    })),
  }),
  ...(invalidAgents.length > 0 && {
    invalidAgents: invalidAgents.map((entry) => ({
      scope: entry.scope,
      ...(entry.name !== undefined && { name: entry.name }),
    })),
  }),
});
