import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { ParentContactError } from "./local-pi-ipc.ts";

/**
 * The child bridge's waiters for parent answers, keyed by request id. Each call owns its exact
 * entry from before its send until its release, which deletes only that same waiter; an answer or
 * a rejection removes the entry first.
 */
export const makeParentCorrelations = <A>() => {
  const waiters = new Map<string, Deferred.Deferred<A, ParentContactError>>();
  const deleteExact = (requestId: string, waiter: Deferred.Deferred<A, ParentContactError>) => {
    if (waiters.get(requestId) !== waiter) return false;
    waiters.delete(requestId);
    return true;
  };
  return {
    /**
     * Sends, then waits for the parent's answer. `cancel` runs when a call that failed or was
     * interrupted still owned its entry; a send that definitely did not leave skips it unless
     * `cancelUnsent`.
     */
    await: (
      requestId: string,
      send: Effect.Effect<void, ParentContactError>,
      cancel: () => void = () => undefined,
      cancelUnsent = true,
    ): Effect.Effect<A, ParentContactError> =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const waiter = Deferred.makeUnsafe<A, ParentContactError>();
          waiters.set(requestId, waiter);
          return waiter;
        }),
        (waiter) =>
          send.pipe(
            Effect.tapError((error) =>
              Effect.sync(() => {
                if (!cancelUnsent && error.code === "transport_not_sent")
                  deleteExact(requestId, waiter);
              }),
            ),
            Effect.andThen(Deferred.await(waiter)),
          ),
        (waiter, exit) =>
          Effect.sync(() => {
            if (deleteExact(requestId, waiter) && Exit.isFailure(exit)) cancel();
          }),
      ),
    /** Answers the waiting call, if any, and reports whether one was waiting. */
    settle: (requestId: string, answer: Effect.Effect<A, ParentContactError>): boolean => {
      const waiter = waiters.get(requestId);
      if (!waiter) return false;
      waiters.delete(requestId);
      Deferred.doneUnsafe(waiter, answer);
      return true;
    },
    /** Fails every waiting call, for a disconnect or a replaced session. */
    rejectAll: (message: string): void => {
      for (const waiter of waiters.values())
        Deferred.doneUnsafe(waiter, Effect.fail(new ParentContactError({ message })));
      waiters.clear();
    },
  };
};

/** A Pi tool rejects with a plain Error carrying the parent's message. */
export const parentContactRejection = <E>(error: E): Error | E =>
  error instanceof ParentContactError ? new Error(error.message) : error;
