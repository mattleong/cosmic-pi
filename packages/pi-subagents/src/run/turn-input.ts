import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type { RunRecord, WithRunLock } from "./internal.ts";

interface TurnInputAdmission {
  count: number;
  readonly drained: Array<Deferred.Deferred<void>>;
}

export function turnInputGates(withLock: WithRunLock) {
  const turnInputs = new WeakMap<RunRecord, TurnInputAdmission>();
  const admitTurnInput = (record: RunRecord): void => {
    const admission = turnInputs.get(record);
    if (admission) admission.count += 1;
    else turnInputs.set(record, { count: 1, drained: [] });
  };
  const releaseTurnInput = (record: RunRecord): Effect.Effect<void> =>
    withLock(
      Effect.sync(() => {
        const admission = turnInputs.get(record);
        if (!admission) return;
        admission.count -= 1;
        if (admission.count > 0) return;
        turnInputs.delete(record);
        for (const drained of admission.drained) Deferred.doneUnsafe(drained, Effect.void);
      }),
    );
  const claimTurnInputDrain = (record: RunRecord, drained: Deferred.Deferred<void>): void => {
    const admission = turnInputs.get(record);
    if (admission && admission.count > 0) admission.drained.push(drained);
    else Deferred.doneUnsafe(drained, Effect.void);
  };
  return { admitTurnInput, releaseTurnInput, claimTurnInputDrain };
}
