import type { SubagentRunView } from "../run/model.ts";
import { formatRunBlocks, runViewBlock, type RunBlockOutcome } from "./run-block.ts";
import type { SubagentLifecycleInput } from "./schema.ts";

const retriedOutcome = (run: SubagentRunView): RunBlockOutcome => ({
  kind: "note",
  text: `Started profile ${run.profile ?? "generalist"} candidate ${(run.selection.candidateIndex ?? 0) + 1}.`,
});

const ACKNOWLEDGEMENT_HEADINGS = {
  retry: "Continued on the next profile candidate.",
  interrupt: "Interrupted; these runs are paused.",
  stop: "Stop requested.",
} as const satisfies Record<SubagentLifecycleInput["action"], string>;

/** One block per target, without its report, which only an await or notice delivers. */
export const managementAcknowledgement = (
  action: SubagentLifecycleInput["action"],
  runs: ReadonlyArray<SubagentRunView>,
): string =>
  runs.length === 0
    ? ""
    : formatRunBlocks(
        [ACKNOWLEDGEMENT_HEADINGS[action]],
        runs.map((run) => runViewBlock(run, action === "retry" ? retriedOutcome(run) : undefined)),
      );
