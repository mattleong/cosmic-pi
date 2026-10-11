import * as Effect from "effect/Effect";
import { runNotFound, type SubagentNotFoundError } from "./errors.ts";
import type { RunContext } from "./internal.ts";
import type { SubagentRunView } from "./model.ts";
import { sortRuns } from "./projection.ts";
import { isRunInSubtree, projectRunTree } from "./tree.ts";

export function makeRunVisibility(dependencies: Pick<RunContext, "records" | "withLock">) {
  const { records, withLock } = dependencies;
  const visibleList = (callerRunId: string): Effect.Effect<ReadonlyArray<SubagentRunView>> =>
    withLock(
      Effect.sync(() =>
        sortRuns(
          projectRunTree(records).filter((run) => isRunInSubtree(records, callerRunId, run.id)),
        ),
      ),
    );
  const authorizeTargets = (
    callerRunId: string,
    ids: ReadonlyArray<string>,
  ): Effect.Effect<void, SubagentNotFoundError> =>
    withLock(
      Effect.gen(function* () {
        if (!records.has(callerRunId)) return yield* runNotFound(callerRunId);
        for (const id of ids)
          if (!isRunInSubtree(records, callerRunId, id)) return yield* runNotFound(id);
      }),
    );
  return { visibleList, authorizeTargets };
}
