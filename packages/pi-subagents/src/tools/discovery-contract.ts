/** Report-free discovery and rename contracts projected from authoritative domain values. */
import { MAX_PROFILE_MODEL_SELECTOR_CHARS, type ProfileId } from "../profiles/model.ts";
import type { SubagentRunView } from "../run/model.ts";
import { SUBAGENT_TOOL_NAME } from "../run/tool-policy.ts";
import { projectRunCardTree } from "../ui/run-tree-rows.ts";
import type {
  SubagentListContract,
  SubagentModelsContract,
  SubagentRenameContract,
} from "./contract-schema.ts";
import {
  envelope,
  metadata,
  projectFailure,
  withheldTarget,
  type LifecycleContractOutcome,
} from "./contract.ts";
import { MAX_DISCOVERY_TEXT_CHARS } from "./discovery-contract-schema.ts";
import type { SubagentProfileView } from "./model.ts";

export const listContract = (runs: ReadonlyArray<SubagentRunView>): SubagentListContract => ({
  ...envelope(SUBAGENT_TOOL_NAME.list),
  // The shared pure traversal orders the full input; display bounds belong to its other callers.
  runs: projectRunCardTree(runs).map(({ run }) => ({
    ...withheldTarget(run),
    parentRunId: run.parentRunId ?? "root",
    depth: run.depth ?? 1,
  })),
});

/** Uses the returned run, not the requested name; rename never reads or delivers reports. */
export const renameContract = (outcome: LifecycleContractOutcome): SubagentRenameContract => ({
  ...envelope(SUBAGENT_TOOL_NAME.rename),
  requestedRunId: outcome.runId,
  ...("run" in outcome
    ? { outcome: "succeeded" as const, target: withheldTarget(outcome.run) }
    : { outcome: "failed" as const, failure: projectFailure("rename", outcome.failure) }),
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
    candidates: profile.candidates.map((candidate) => ({
      host: candidate.host,
      runtime: candidate.runtime,
      model: metadata(candidate.model, MAX_PROFILE_MODEL_SELECTOR_CHARS) ?? "[redacted]",
      effort: candidate.effort,
      context: candidate.context,
      writeIntent: candidate.writeIntent,
      openaiFastMode: candidate.openaiFastMode ?? false,
      closeOnReport: candidate.closeOnReport,
      status: candidate.status,
      reason: metadata(candidate.reason, MAX_DISCOVERY_TEXT_CHARS) ?? "No eligibility reason.",
    })),
  })),
});
