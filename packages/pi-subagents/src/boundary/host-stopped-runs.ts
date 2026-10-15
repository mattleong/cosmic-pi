import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  clipText,
  countLabel,
  invokeHostCallback,
  notifyAtHostBoundary,
  sanitizeTerminalLine,
} from "pi-cosmic-core";
import { isActiveRunState, type SubagentRunView } from "../run/model.ts";

export const STOPPED_RUNS_MESSAGE_TYPE = "pi-subagents-stopped";

/** Why the session's subagent runtime is being replaced while the transcript stays. */
export type RuntimeRetirement = "reload" | "session";

const LISTED_RUNS = 20;

const CAUSE: Record<RuntimeRetirement, string> = {
  reload: "Reloading Pi",
  session: "Leaving this session",
};

const runLine = (run: SubagentRunView): string =>
  `- ${clipText(sanitizeTerminalLine(run.name), 60)} (${run.id}): ${run.state.replaceAll("_", " ")}`;

export const stoppedRunsContent = (
  runs: ReadonlyArray<SubagentRunView>,
  cause: RuntimeRetirement,
): string => {
  const omitted = runs.length - LISTED_RUNS;
  return [
    `${CAUSE[cause]} stopped ${countLabel(runs.length, "subagent")}:`,
    [
      ...runs.slice(0, LISTED_RUNS).map(runLine),
      ...(omitted > 0 ? [`- ${countLabel(omitted, "more subagent")}`] : []),
    ].join("\n"),
    "They will not report. Partial work they left in the checkout remains; inspect it before relying on it or starting replacements.",
  ].join("\n\n");
};

/** Active runs that replacing the runtime is about to stop. */
export const runsStoppedByReplacement = (
  runs: ReadonlyArray<SubagentRunView>,
): ReadonlyArray<SubagentRunView> => runs.filter((run) => isActiveRunState(run.state));

/**
 * Tells the model and the user which subagents a runtime replacement stops. The message is appended
 * without starting a turn.
 */
export function reportStoppedRuns(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  runs: ReadonlyArray<SubagentRunView>,
  cause: RuntimeRetirement,
): void {
  if (runs.length === 0) return;
  invokeHostCallback(() => {
    pi.sendMessage(
      {
        customType: STOPPED_RUNS_MESSAGE_TYPE,
        content: stoppedRunsContent(runs, cause),
        display: true,
        details: {
          version: 1,
          kind: "stopped",
          total: runs.length,
          ...(runs.length === 1 &&
            runs[0] !== undefined && { name: clipText(sanitizeTerminalLine(runs[0].name), 60) }),
        },
      },
      { triggerTurn: false },
    );
  }, undefined);
  notifyStoppedRuns(ctx, runs);
}

/** Tells only the user which subagents a runtime replacement stopped. */
export function notifyStoppedRuns(
  ctx: ExtensionContext,
  runs: ReadonlyArray<SubagentRunView>,
): void {
  if (runs.length > 0 && invokeHostCallback(() => ctx.hasUI, false))
    notifyAtHostBoundary(
      ctx,
      `${countLabel(runs.length, "subagent")} stopped; partial work remains in the checkout`,
      "warning",
    );
}
