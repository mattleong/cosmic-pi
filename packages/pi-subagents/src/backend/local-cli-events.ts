import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import type { LocalCliWireEvent } from "../boundary/local-cli-transport.ts";
import type { BackendEvent } from "./model.ts";

export interface LocalCliRawEventOwnership<Raw = LocalCliWireEvent> {
  readonly offer: (event: BackendEvent, raw?: Raw) => Effect.Effect<void>;
  readonly release: (raw: Raw) => Effect.Effect<void>;
  readonly acknowledge: (event: BackendEvent) => void;
  readonly acknowledgeAll: () => void;
}

export const makeLocalCliRawEventOwnership = <Raw = LocalCliWireEvent>(
  events: Queue.Queue<BackendEvent, Cause.Done>,
  acknowledgeRaw: (raw: Raw) => void,
  label = "local-CLI",
): LocalCliRawEventOwnership<Raw> => {
  const rawOwners = new Map<BackendEvent, Raw>();
  // Activity only refreshes the run's throttled liveness timestamp, so one pending event per
  // assignment carries the same information as a delta burst without consuming queue capacity.
  const pendingActivity = new Map<number, BackendEvent>();
  const release = (raw: Raw): Effect.Effect<void> => Effect.sync(() => acknowledgeRaw(raw));
  const acknowledge = (event: BackendEvent): void => {
    if (event.type === "activity" && pendingActivity.get(event.assignmentEpoch) === event)
      pendingActivity.delete(event.assignmentEpoch);
    const raw = rawOwners.get(event);
    if (!raw) return;
    rawOwners.delete(event);
    acknowledgeRaw(raw);
  };
  const acknowledgeAll = (): void => {
    for (const raw of rawOwners.values()) acknowledgeRaw(raw);
    rawOwners.clear();
    pendingActivity.clear();
  };
  const dropDiagnostic = (event: BackendEvent): Effect.Effect<void> =>
    Effect.logWarning(
      `Subagent ${label} event ingress overflowed; dropped a ${event.type} event.`,
    ).pipe(Effect.andThen(Effect.sync(() => acknowledge(event))));
  const offer = (event: BackendEvent, raw?: Raw): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (event.type === "activity") {
        if (pendingActivity.has(event.assignmentEpoch)) return raw ? release(raw) : Effect.void;
        pendingActivity.set(event.assignmentEpoch, event);
      }
      if (raw) rawOwners.set(event, raw);
      return Queue.offer(events, event).pipe(
        Effect.flatMap((delivered) => (delivered ? Effect.void : dropDiagnostic(event))),
        Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : dropDiagnostic(event))),
      );
    });
  return { offer, release, acknowledge, acknowledgeAll };
};

export const localCliEventIngress = <Raw = LocalCliWireEvent>(
  acknowledgeRaw: (raw: Raw) => void,
  label?: string,
) =>
  Effect.gen(function* () {
    const events = yield* Queue.bounded<BackendEvent, Cause.Done>(512);
    const ownership = makeLocalCliRawEventOwnership(events, acknowledgeRaw, label);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        ownership.acknowledgeAll();
        Queue.endUnsafe(events);
      }),
    );
    return { events, ...ownership };
  });
