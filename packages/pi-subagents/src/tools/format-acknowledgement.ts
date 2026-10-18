import { absurd } from "effect/Function";
import { countLabel } from "pi-cosmic-core";
import type { SubagentRunView } from "../run/model.ts";
import { runStateLabel } from "../ui/run-state.ts";
import { cleanupRecoveryText, formatRun } from "./format.ts";
import type { SubagentToolAction } from "./schema.ts";

const stopAcknowledgement = (run: SubagentRunView): string =>
  [`${run.id}: ${runStateLabel(run.state)}.`, ...cleanupRecoveryText(run)].join("\n");

const sendAcknowledgement = (
  runs: ReadonlyArray<SubagentRunView>,
  answeredRunIds: ReadonlySet<string>,
): string => {
  const answered = runs.flatMap((run) => (answeredRunIds.has(run.id) ? [run.id] : []));
  const guided = runs.flatMap((run) => (answeredRunIds.has(run.id) ? [] : [run.id]));
  return [
    ...(answered.length > 0
      ? [`Answered ${countLabel(answered.length, "question")} from ${answered.join(", ")}.`]
      : []),
    ...(guided.length > 0
      ? [`Guidance delivered to ${countLabel(guided.length, "subagent")}: ${guided.join(", ")}.`]
      : []),
  ].join("\n");
};

export const managementAcknowledgement = (
  action: Exclude<SubagentToolAction, "models" | "start">,
  runs: ReadonlyArray<SubagentRunView>,
  answeredRunIds: ReadonlySet<string> = new Set(),
): string => {
  if (runs.length === 0) return "";
  const ids = runs.map((run) => run.id).join(", ");
  switch (action) {
    case "send":
      return sendAcknowledgement(runs, answeredRunIds);
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
    case "resume":
      return `Resumed ${ids}.`;
    case "stop":
      return runs.map(stopAcknowledgement).join("\n");
    case "list":
    case "status":
    case "await":
    case "workspace":
      return runs.map((run) => formatRun(run, true)).join("\n\n");
  }
  return absurd(action);
};
