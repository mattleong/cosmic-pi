import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { WorkflowNotFoundError } from "./errors.ts";
import { isWorkflowRunFinished } from "./model.ts";
import type { WorkflowRuns } from "./runs.ts";
import { skipWorkflowPlanned } from "./state.ts";

/**
 * Skips a workflow agent by its subagent run id. A planned agent no call has claimed is marked
 * skipped under the views' lock, so the call that claims it later resolves null without starting
 * anything; a planned agent a call claimed meanwhile is queued or running by then, and its skip
 * resolves that call to null like any other.
 */
export const makeWorkflowSkip =
  (runs: WorkflowRuns) =>
  (agentRunId: string): Effect.Effect<void, WorkflowNotFoundError> =>
    Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis;
      const holders = (yield* runs.list).filter(
        (run) =>
          !isWorkflowRunFinished(run.state) &&
          run.planned.some((agent) => agent.runId === agentRunId),
      );
      for (const holder of holders)
        if (yield* runs.modify(holder.id, (run) => skipWorkflowPlanned(run, agentRunId, at)))
          return;
      const skip = runs.controls.skipOf(agentRunId);
      if (skip) return yield* Deferred.succeed(skip, undefined).pipe(Effect.asVoid);
      return yield* new WorkflowNotFoundError({
        message: `No planned, queued or running workflow agent ${agentRunId}.`,
      });
    });
