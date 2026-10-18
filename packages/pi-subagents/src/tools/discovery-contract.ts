import { MAX_PROFILE_MODEL_SELECTOR_CHARS, type ProfileId } from "../profiles/model.ts";
import type { SubagentRunView } from "../run/model.ts";
import { SUBAGENT_TOOL_NAME } from "../run/tool-policy.ts";
import { projectRunCardTree } from "../ui/run-tree-rows.ts";
import type { SubagentModelsContract, SubagentStatusListContract } from "./contract-schema.ts";
import { envelope, metadata, withheldTarget } from "./contract.ts";
import { MAX_DISCOVERY_TEXT_CHARS } from "./discovery-contract-schema.ts";
import type { SubagentProfileView } from "./model.ts";

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

export const modelsContract = (
  profiles: ReadonlyArray<SubagentProfileView>,
  fallbackProfile: ProfileId,
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
    // The v1 contract still reports the retired route fields, which are now constant.
    candidates: profile.candidates.map((candidate) => ({
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
    })),
  })),
});
