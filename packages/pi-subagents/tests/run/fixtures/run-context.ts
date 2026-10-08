import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { WriterLeaseService } from "../../../src/boundary/writer-lease.ts";
import { SubagentNotFoundError } from "../../../src/run/errors.ts";
import type { RunContext, RunRecord } from "../../../src/run/internal.ts";
import type { RunNotificationDelivery } from "../../../src/run/notification-delivery.ts";
import { makeRunSettlement } from "../../../src/run/settlement.ts";
import { fakeWriterLeaseLayer } from "./service-harness.ts";

/** Service-owned run primitives with inert defaults; a factory test overrides what it exercises. */
export const makeRunContext = (overrides: Partial<RunContext> = {}) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    const records = overrides.records ?? new Map<string, RunRecord>();
    let attempts = 0;
    const context: RunContext = {
      ownerScope: yield* Scope.Scope,
      withLock: lock.withPermits(1),
      publish: Effect.void,
      records,
      writerPools: new Map(),
      writerLeases: yield* WriterLeaseService,
      requireRecord: (id) => {
        const record = records.get(id);
        return record
          ? Effect.succeed(record)
          : Effect.fail(
              new SubagentNotFoundError({ id, message: `Subagent run not found: ${id}` }),
            );
      },
      sendPeerNotices: () => Effect.void,
      allocateAssignmentAttemptToken: () => `assignment-test-${++attempts}`,
      ...overrides,
    };
    return context;
  }).pipe(Effect.provide(fakeWriterLeaseLayer()));

/** Settlement over inert run primitives, for paths that never deliver or close a completion. */
export const makeTestSettlement = (overrides: Partial<RunContext> = {}) =>
  makeRunContext(overrides).pipe(
    Effect.map((context) =>
      makeRunSettlement({
        ...context,
        // SAFETY: The exercised paths neither deliver a completion nor discard a question.
        delivery: {} as RunNotificationDelivery,
        closeRecordScope: () => Effect.void,
      }),
    ),
  );

/** A record for a factory test whose exercised path reads only `fields`, themselves partial. */
export const partialRecord = (fields: {
  readonly [Field in keyof RunRecord]?: Partial<RunRecord[Field]>;
}): RunRecord =>
  // SAFETY: Each caller supplies every field its exercised code path reads.
  fields as RunRecord;

/** A started assignment at `epoch` with no buffered report or settlement. */
export const runningAssignment = (epoch: number): RunRecord["assignment"] => ({
  epoch,
  phase: "running",
  attemptToken: "current",
  startedObserved: true,
  outcomeUncertain: false,
  pendingRunSettled: false,
});
