import * as Duration from "effect/Duration";
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

// Completion delivery can settle without publishing a new revision, so the wait also rechecks.
const DRAIN_RECHECK = Duration.millis(500);

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
}

/**
 * Waits until no run is working and every completion has been handed to its notifier, or until a
 * direct child waits for the parent's reply. A headless parent uses it before ending its turn so
 * reports reach the conversation instead of dying with the process.
 */
export const parentDrainAwaiter = ({
  records,
  withLock,
  revision,
  waitForRevision,
}: ParentDrainDependencies): Effect.Effect<void, SubagentRuntimeClosedError> =>
  Effect.gen(function* () {
    while (true) {
      const observed = yield* revision;
      if (yield* withLock(Effect.sync(() => drainSettled(records)))) return;
      yield* waitForRevision(observed).pipe(Effect.timeoutOption(DRAIN_RECHECK));
    }
  });
