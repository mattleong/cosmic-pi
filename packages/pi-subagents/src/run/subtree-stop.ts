import * as Effect from "effect/Effect";
import type { SubagentError } from "./errors.ts";
import type { RunContext } from "./internal.ts";
import type { SubagentControlExpectation, SubagentRunView } from "./model.ts";
import { runSessionOwned } from "./session-owned.ts";
import { snapshotView } from "./state.ts";
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
          const ordered = [...descendantRunIds(records, id), root.view.id];
          for (const targetId of ordered) {
            const target = records.get(targetId);
            if (target) target.stoppedByParent = true;
          }
          return ordered;
        }),
      ),
      (orderedIds) =>
        Effect.gen(function* () {
          const [stopped, failures] = yield* Effect.partition(orderedIds, (targetId) =>
            stopRun(targetId),
          );
          if (failures[0]) return yield* failures[0];
          return stopped.at(-1) ?? snapshotView((yield* requireRecord(id)).view);
        }),
    );
  };
