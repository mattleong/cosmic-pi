import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { MAX_TARGET_RUNS } from "../run/limits.ts";
import {
  isAssignmentFinishedRunState,
  isParentActionRequiredRun,
  type SubagentRunView,
} from "../run/model.ts";
import type { SubagentAwaitUntil } from "../run/service.ts";
import { projectRunCardTree } from "../ui/run-tree-rows.ts";
import { makeAwaitDetails } from "./details.ts";
import { attentionRecoveryText, boundToolOutput } from "./format.ts";
import { formatAwaitProgress } from "./render-await.ts";

/** Observe the actual Effect exit, not a later signal state or a squashed error string.
 * The tiny mask installs the observer even for an already-aborted host call. Owned
 * work stays interruptible; the Promise boundary translates only after finalizers join. */
export const observeAwaitInterruption = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  onInterruption?: () => void,
): Effect.Effect<A, E, R> =>
  onInterruption
    ? Effect.uninterruptibleMask((restore) =>
        restore(effect).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) onInterruption();
            }),
          ),
        ),
      )
    : effect;

/** Call-local bounded cancellation evidence, never a second completion owner. */
export function makeAwaitExecution(
  ids: ReadonlyArray<string>,
  until: SubagentAwaitUntil,
  onUpdate?: AgentToolUpdateCallback<unknown>,
) {
  const requestedIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))].slice(
    0,
    MAX_TARGET_RUNS,
  );
  let latestRuns: ReadonlyArray<SubagentRunView> = [];
  let contextRuns: ReadonlyArray<SubagentRunView> = [];
  let lastUpdate = "";
  let interrupted = false;
  const progressText = (runs: ReadonlyArray<SubagentRunView>) =>
    formatAwaitProgress(
      runs,
      until,
      projectRunCardTree(contextRuns)
        .map((row) => row.run)
        .slice(0, Math.max(0, MAX_TARGET_RUNS - runs.length)),
    );
  const update = (
    runs: ReadonlyArray<SubagentRunView>,
    projection?: ReadonlyArray<SubagentRunView>,
  ) => {
    latestRuns = runs;
    const scope = projection ?? runs;
    const targetIds = new Set(runs.map((run) => run.id));
    const byId = new Map(scope.map((run) => [run.id, run]));
    contextRuns = scope.filter((run) => {
      if (targetIds.has(run.id)) return false;
      const visited = new Set<string>([run.id]);
      let parentRunId = run.parentRunId;
      while (parentRunId && !visited.has(parentRunId)) {
        visited.add(parentRunId);
        if (targetIds.has(parentRunId)) return true;
        parentRunId = byId.get(parentRunId)?.parentRunId;
      }
      return false;
    });
    const details = makeAwaitDetails({
      runs,
      contextRuns,
      awaitedRunIds: requestedIds,
      awaitUntil: until,
    });
    const key = JSON.stringify(details);
    if (key === lastUpdate) return;
    lastUpdate = key;
    onUpdate?.({ content: [{ type: "text", text: progressText(runs) }], details });
  };
  const cancelled = (proxyCleanupUnconfirmed = false): AgentToolResult<unknown> => {
    const unfinished = latestRuns.filter((run) => !isAssignmentFinishedRunState(run.state)).length;
    const summary =
      latestRuns.length === 0
        ? "Await cancelled before progress was observed; selected run states are unobserved."
        : `Await cancelled; ${unfinished} subagent${unfinished === 1 ? " is" : "s are"} unfinished in the latest observation.`;
    const text = boundToolOutput(
      [
        summary,
        `Requested runs: ${requestedIds.join(", ")}.`,
        "Only this local wait was cancelled. Children continue; this cancellation did not stop or retry any run.",
        proxyCleanupUnconfirmed
          ? "Root completion-claim cleanup is unconfirmed. Claims may still be held; an immediate replacement await may fail with completion_claim_conflict. This receipt does not acknowledge root cleanup."
          : "Wait cleanup is complete. Await these IDs again when their results are needed.",
        latestRuns.length > 0 ? progressText(latestRuns) : "",
        attentionRecoveryText(latestRuns),
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
    return {
      content: [{ type: "text", text }],
      details: makeAwaitDetails({
        runs: latestRuns,
        contextRuns,
        awaitedRunIds: requestedIds,
        awaitUntil: until,
        cancelled: true,
        ...(proxyCleanupUnconfirmed && { cancellationCleanup: "unconfirmed" as const }),
        ...(latestRuns.some(isParentActionRequiredRun) && { attentionRequired: true }),
      }),
    };
  };
  return {
    requestedIds,
    progressText,
    update,
    contextRuns: () => contextRuns,
    markInterrupted: () => {
      interrupted = true;
    },
    wasInterrupted: () => interrupted,
    cancelled,
  };
}

export type AwaitExecution = ReturnType<typeof makeAwaitExecution>;
