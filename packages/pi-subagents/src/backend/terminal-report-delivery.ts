import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import type { BackendEvent } from "./model.ts";

/** Transfer terminal evidence before ending ingress, without waiting on the consumer
 * in transport cleanup. The backend scope owns the pending transfer and interrupts
 * it on shutdown; either completion or interruption ends the queue.
 */
export const deliverTerminalReport = (
  events: Queue.Queue<BackendEvent, Cause.Done>,
  delivery: Effect.Effect<void>,
  scope: Scope.Scope,
): Effect.Effect<void> =>
  delivery.pipe(
    Effect.interruptible,
    Effect.ensuring(Effect.sync(() => Queue.endUnsafe(events))),
    Effect.forkIn(scope),
    Effect.asVoid,
  );
