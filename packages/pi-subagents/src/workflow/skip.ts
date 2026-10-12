import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { WorkflowNotFoundError } from "./errors.ts";
import { isWorkflowRunFinished } from "./model.ts";
import type { WorkflowRuns } from "./runs.ts";
import { skipWorkflowPlanned } from "./state.ts";

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
          return undefined;
      const skip = [...runs.controls.values()]
        .map((control) => control.skips.get(agentRunId))
        .find((candidate) => candidate !== undefined);
      if (skip) return yield* Deferred.succeed(skip, undefined).pipe(Effect.asVoid);
      return yield* new WorkflowNotFoundError({
        message: `No planned, queued or running workflow agent ${agentRunId}.`,
      });
    });
