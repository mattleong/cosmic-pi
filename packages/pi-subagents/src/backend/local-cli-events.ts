import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import type { LocalCliWireEvent } from "../boundary/local-cli-transport.ts";
import type { BackendEvent } from "./model.ts";

/**
 * Shared raw wire-event ownership for the local Claude/Codex adapters. A raw
 * transport event (and its byte budget) stays owned until run orchestration
 * consumes the normalized backend event that carries it; a normalized event
 * that could not be enqueued acknowledges its raw event immediately so the
 * bounded transport cannot stall behind an abandoned offer.
 */
export interface LocalCliRawEventOwnership {
  /** Enqueues one normalized event; a raw event transfers ownership on success. */
  readonly offer: (event: BackendEvent, raw?: LocalCliWireEvent) => Effect.Effect<void>;
  /** Releases the raw wire event owned by a consumed normalized event. */
  readonly acknowledge: (event: BackendEvent) => void;
  /** Releases every still-owned raw wire event during transport/scope shutdown. */
  readonly acknowledgeAll: () => void;
}

export const makeLocalCliRawEventOwnership = (
  events: Queue.Queue<BackendEvent, Cause.Done>,
  acknowledgeRaw: (raw: LocalCliWireEvent) => void,
): LocalCliRawEventOwnership => {
  const rawOwners = new Map<BackendEvent, LocalCliWireEvent>();
  const acknowledge = (event: BackendEvent): void => {
    const raw = rawOwners.get(event);
    if (!raw) return;
    rawOwners.delete(event);
    acknowledgeRaw(raw);
  };
  const acknowledgeAll = (): void => {
    for (const raw of rawOwners.values()) acknowledgeRaw(raw);
    rawOwners.clear();
  };
  const dropDiagnostic = (event: BackendEvent): Effect.Effect<void> =>
    // Make overflow losses diagnosable instead of acknowledging them silently.
    Effect.logWarning(
      `Subagent local-CLI event ingress overflowed; dropped a ${event.type} event.`,
    ).pipe(Effect.andThen(Effect.sync(() => acknowledge(event))), Effect.asVoid);
  const offer = (event: BackendEvent, raw?: LocalCliWireEvent): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (raw) rawOwners.set(event, raw);
      // A delivered offer settles inline; every other exit (ended queue, failure, defect,
      // interruption of a suspended offer) takes the same diagnostic path.
      return Queue.offer(events, event).pipe(
        Effect.flatMap((delivered) => (delivered ? Effect.void : dropDiagnostic(event))),
        Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : dropDiagnostic(event))),
        Effect.asVoid,
      );
    });
  return { offer, acknowledge, acknowledgeAll };
};
