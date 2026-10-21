import * as Effect from "effect/Effect";
import type { SubagentError } from "./errors.ts";
import { snapshotRun, type RunContext, type RunRecord } from "./internal.ts";
import type { SubagentControlExpectation, SubagentRunView } from "./model.ts";
import { runSessionOwned } from "./session-owned.ts";
import { descendantRunIds } from "./tree.ts";
import { requireControlExpectation } from "./control-admission.ts";

interface RunSubtreeStopDependencies extends Pick<
  RunContext,
  "ownerScope" | "withLock" | "records" | "requireRecord"
> {
  readonly stopRun: (id: string) => Effect.Effect<SubagentRunView, SubagentError>;
}

export const subtreeStopper =
  (dependencies: RunSubtreeStopDependencies) =>
  (
    id: string,
    expected?: SubagentControlExpectation,
  ): Effect.Effect<SubagentRunView, SubagentError> => {
    const { ownerScope, withLock, records, requireRecord, stopRun } = dependencies;
    return runSessionOwned(
      ownerScope,
      withLock(
        Effect.gen(function* () {
          const root = yield* requireRecord(id);
          yield* requireControlExpectation(root, expected);
          const ordered = [...descendantRunIds(records, id), root.view.id].flatMap(
            (targetId): ReadonlyArray<RunRecord> => {
              const target = records.get(targetId);
              return target ? [target] : [];
            },
          );
          for (const target of ordered) target.stoppedByParent = true;
          return ordered;
        }),
      ),
      (ordered) =>
        Effect.gen(function* () {
          const [stopped, failures] = yield* Effect.partition(ordered, (target) =>
            stopRun(target.view.id),
          );
          if (failures[0]) return yield* failures[0];
          return stopped.at(-1) ?? snapshotRun(yield* requireRecord(id));
        }),
    );
  };
