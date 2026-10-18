import { absurd } from "effect/Function";
import type { SubagentRunView } from "../run/model.ts";
import { runStateLabel } from "../ui/run-state.ts";
import { cleanupRecoveryText, formatRun } from "./format.ts";
import type { SubagentToolAction } from "./schema.ts";

const stopAcknowledgement = (run: SubagentRunView): string =>
  [`${run.id}: ${runStateLabel(run.state)}.`, ...cleanupRecoveryText(run)].join("\n");

export const managementAcknowledgement = (
  action: Exclude<SubagentToolAction, "models" | "start">,
  runs: ReadonlyArray<SubagentRunView>,
): string => {
  if (runs.length === 0) return "";
  const ids = runs.map((run) => run.id).join(", ");
  switch (action) {
    case "retry":
      return runs
        .map((run) =>
          run.predecessorRunId
            ? `Continued ${run.predecessorRunId} as ${run.id} on profile ${run.profile ?? "generalist"} candidate ${(run.selection.candidateIndex ?? 0) + 1}.`
            : `Started next profile candidate as ${run.id}.`,
        )
        .join("\n");
    case "interrupt":
      return `Interrupted ${ids}; state is paused.`;
    case "stop":
      return runs.map(stopAcknowledgement).join("\n");
    case "await":
    case "workspace":
      return runs.map((run) => formatRun(run, true)).join("\n\n");
  }
  return absurd(action);
};
