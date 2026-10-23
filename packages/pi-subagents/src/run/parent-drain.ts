import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { hasEligibleCompletion } from "./completion.ts";
import type { SubagentRuntimeClosedError } from "./errors.ts";
import type { RunRecord, WithRunLock } from "./internal.ts";
import { SUBAGENT_ROOT_RUN_ID } from "./model.ts";

const WORKING_STATES: ReadonlySet<RunRecord["view"]["state"]> = new Set([
  "starting",
  "running",
  "stopping",
]);

const drainSettled = (records: ReadonlyMap<string, RunRecord>): boolean => {
  if (hasEligibleCompletion(records)) return false;
  let working = false;
  for (const { view } of records.values()) {
    if (
      (view.parentRunId ?? SUBAGENT_ROOT_RUN_ID) === SUBAGENT_ROOT_RUN_ID &&
      view.question !== undefined
    )
      return true;
    if (WORKING_STATES.has(view.state)) working = true;
  }
  return !working;
};

interface ParentDrainDependencies {
  readonly records: ReadonlyMap<string, RunRecord>;
  readonly withLock: WithRunLock;
  readonly revision: Effect.Effect<number>;
  readonly waitForRevision: (after: number) => Effect.Effect<void, SubagentRuntimeClosedError>;
  /** Completes once completions leave the outbox or are claimed, which publish no revision. */
  readonly outboxChangedLocked: () => Deferred.Deferred<void>;
}

/**
 * Waits until no run is working and every completion has been handed to its notifier, or until a
 * direct child waits for the parent's reply. A headless parent uses it before ending its turn so
 * reports reach the conversation instead of dying with the process.
 */
export const parentDrainAwaiter = Effect.fn("SubagentParentDrain.await")(function* ({
  records,
  withLock,
  revision,
  waitForRevision,
  outboxChangedLocked,
}: ParentDrainDependencies): Effect.fn.Return<void, SubagentRuntimeClosedError> {
  while (true) {
    const observed = yield* revision;
    const outboxChanged = yield* withLock(
      Effect.sync(() => (drainSettled(records) ? undefined : outboxChangedLocked())),
    );
    if (!outboxChanged) return;
    yield* Effect.raceFirst(waitForRevision(observed), Deferred.await(outboxChanged));
  }
});
