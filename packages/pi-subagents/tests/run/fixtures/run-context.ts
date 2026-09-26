import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { WriterLeaseService } from "../../../src/boundary/writer-lease.ts";
import { SubagentNotFoundError } from "../../../src/run/errors.ts";
import type { RunContext, RunRecord } from "../../../src/run/internal.ts";
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
