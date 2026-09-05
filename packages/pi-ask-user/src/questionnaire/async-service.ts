import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import type * as Semaphore from "effect/Semaphore";
import { AskUserAsyncError, AskUserHostError, AskUserValidationError } from "./errors.ts";
import { MAX_RETAINED_REQUESTS, type AsyncQuestionnaireSnapshot } from "./async-model.ts";
import {
  MAX_WORK_DESCRIPTION_LENGTH,
  type AskUserAsyncControl,
  type AskUserAsyncRequest,
} from "./schema.ts";
import type { AskUserHost } from "./service.ts";
import { normalizeAskUserRequest, validateAskUserRequest } from "./validation.ts";

export type AsyncDelivery = (
  snapshot: AsyncQuestionnaireSnapshot,
) => Effect.Effect<void, AskUserHostError>;

interface Entry {
  readonly snapshot: AsyncQuestionnaireSnapshot;
  readonly opened: Deferred.Deferred<void, AskUserHostError>;
  readonly completed: Deferred.Deferred<void>;
  readonly cancel: Deferred.Deferred<void>;
  readonly waiter?: symbol;
  readonly deliveryAttempts: number;
}

export const asyncBusy = () =>
  new AskUserAsyncError({
    reason: "busy",
    message:
      "A questionnaire is already active. Use ask_user_async_control for the pending request.",
  });
const notFound = () =>
  new AskUserAsyncError({
    reason: "not-found",
    message:
      "Request is not retained in this runtime. It may have expired or belonged to an earlier session or branch.",
  });

/** Private controller under AskUserService's Layer scope, sharing its dialog permit. */
export const makeAsyncQuestionnaires = Effect.fn("AskUserService.makeAsync")(function* (
  host: AskUserHost,
  lock: Semaphore.Semaphore,
  delivery: AsyncDelivery | undefined,
  idPrefix: string,
) {
  const parentScope = yield* Effect.scope;
  const scope = yield* Scope.fork(parentScope, "sequential");
  const state = yield* Ref.make<ReadonlyArray<Entry>>([]);
  const counter = yield* Ref.make(0);
  const closed = yield* Ref.make(false);
  yield* Scope.addFinalizer(parentScope, Ref.set(closed, true));

  const get = (id: string) =>
    Ref.get(state).pipe(
      Effect.flatMap((entries) => {
        const entry = entries.find((item) => item.snapshot.requestId === id);
        return entry ? Effect.succeed(entry) : Effect.fail(notFound());
      }),
    );
  const update = (id: string, f: (entry: Entry) => Entry) =>
    Ref.update(state, (entries) =>
      entries.map((entry) => (entry.snapshot.requestId === id ? f(entry) : entry)),
    );

  const deliver = (id: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (yield* Ref.get(closed)) return;
      const claimed = yield* Ref.modify(state, (entries) => {
        const entry = entries.find((item) => item.snapshot.requestId === id);
        if (
          !entry ||
          entry.waiter ||
          entry.snapshot.status === "pending" ||
          entry.snapshot.delivery !== "pending"
        )
          return [undefined, entries] as const;
        if (entry.deliveryAttempts >= 3) {
          return [
            undefined,
            entries.map((item) =>
              item === entry
                ? { ...entry, snapshot: { ...entry.snapshot, delivery: "failed" as const } }
                : item,
            ),
          ] as const;
        }
        const snapshot = { ...entry.snapshot, delivery: "sending" as const };
        const deliveryAttempts = entry.deliveryAttempts + 1;
        return [
          { snapshot, deliveryAttempts },
          entries.map((item) => (item === entry ? { ...entry, snapshot, deliveryAttempts } : item)),
        ] as const;
      });
      if (!claimed || !delivery) return;
      const result = yield* Effect.exit(delivery(claimed.snapshot));
      yield* update(id, (entry) => ({
        ...entry,
        snapshot: { ...entry.snapshot, delivery: Exit.isSuccess(result) ? "sent" : "failed" },
      }));
      if (Exit.isFailure(result) && claimed.deliveryAttempts < 3 && !(yield* Ref.get(closed))) {
        yield* Effect.forkIn(
          Effect.sleep("1 second").pipe(
            Effect.andThen(
              update(id, (entry) =>
                entry.snapshot.delivery === "failed" && !entry.waiter
                  ? { ...entry, snapshot: { ...entry.snapshot, delivery: "pending" } }
                  : entry,
              ),
            ),
            Effect.andThen(deliver(id)),
          ),
          scope,
        );
      }
    });

  const present = (entry: Entry, request: AskUserAsyncRequest): Effect.Effect<void> =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        Effect.raceFirst(
          host(request, entry.opened),
          Deferred.await(entry.cancel).pipe(
            Effect.as({ outcome: "cancelled", answers: [] } as const),
          ),
        ),
      );
      const outcome = Exit.isSuccess(result) ? result.value : undefined;
      yield* update(entry.snapshot.requestId, (current) => ({
        ...current,
        snapshot: outcome
          ? { ...current.snapshot, status: outcome.outcome, delivery: "pending", outcome }
          : { ...current.snapshot, status: "failed", delivery: "none" },
      }));
      yield* Deferred.fail(
        entry.opened,
        new AskUserHostError({
          operation: "open",
          message: "The questionnaire closed before its overlay opened.",
        }),
      );
      yield* Deferred.succeed(entry.completed, undefined);
      yield* deliver(entry.snapshot.requestId);
    }).pipe(Effect.ensuring(lock.release(1)));

  const start = Effect.fn("AskUserService.startAsync")(function* (request: AskUserAsyncRequest) {
    if (!delivery)
      return yield* new AskUserAsyncError({
        reason: "unavailable",
        message: "Async questionnaires require TUI mode.",
      });
    const normalized = normalizeAskUserRequest(request);
    const validationError = validateAskUserRequest(normalized);
    if (validationError) return yield* validationError;
    if (
      [request.independentWork, request.blockedWork].some(
        (text) => !text.trim() || text.length > MAX_WORK_DESCRIPTION_LENGTH,
      )
    ) {
      return yield* new AskUserValidationError({
        message: "Work descriptions must be nonblank and at most 500 characters.",
      });
    }
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (!(yield* lock.takeIfAvailable(1))) return yield* asyncBusy();
        const sequence = yield* Ref.updateAndGet(counter, (n) => n + 1);
        const requestId = `${idPrefix}-${sequence}`;
        const snapshot: AsyncQuestionnaireSnapshot = {
          requestId,
          deliveryId: `${requestId}-answer`,
          status: "pending",
          delivery: "pending",
          independentWork: request.independentWork.trim(),
          blockedWork: request.blockedWork.trim(),
        };
        const entry: Entry = {
          snapshot,
          opened: yield* Deferred.make<void, AskUserHostError>(),
          completed: yield* Deferred.make<void>(),
          cancel: yield* Deferred.make<void>(),
          deliveryAttempts: 0,
        };
        const admitted = yield* Ref.modify(state, (entries) => {
          const evict =
            entries.length >= MAX_RETAINED_REQUESTS
              ? entries.find(
                  (item) =>
                    !item.waiter &&
                    item.snapshot.status !== "pending" &&
                    ["sent", "waiter"].includes(item.snapshot.delivery),
                )
              : undefined;
          if (entries.length >= MAX_RETAINED_REQUESTS && !evict) return [false, entries] as const;
          return [true, [...entries.filter((item) => item !== evict), entry]] as const;
        });
        if (!admitted) {
          yield* lock.release(1);
          return yield* asyncBusy();
        }
        yield* Effect.forkIn(present(entry, { ...request, ...normalized }), scope, {
          startImmediately: true,
        });
        yield* restore(Deferred.await(entry.opened));
        return snapshot;
      }),
    );
  });

  const wait = (id: string, cancel: boolean) =>
    Effect.suspend(() => {
      const owner = Symbol();
      let acknowledge = false;
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const claimed = yield* Ref.modify(
            state,
            (entries): readonly [Entry | "busy" | "missing", ReadonlyArray<Entry>] => {
              const entry = entries.find((item) => item.snapshot.requestId === id);
              if (!entry || entry.waiter) return [entry ? "busy" : "missing", entries] as const;
              return [
                entry,
                entries.map((item) => (item === entry ? { ...item, waiter: owner } : item)),
              ] as const;
            },
          );
          if (claimed === "busy") {
            if (!cancel) return yield* asyncBusy();
            // A live await owns delivery, but cannot prevent presenter cancellation.
            const entry = yield* get(id);
            yield* Deferred.succeed(entry.cancel, undefined);
            yield* restore(Deferred.await(entry.completed));
            return { requests: [(yield* get(id)).snapshot] };
          }
          if (claimed === "missing") return yield* notFound();
          const entry = claimed;
          if (cancel) yield* Deferred.succeed(entry.cancel, undefined);
          return yield* restore(Deferred.await(entry.completed)).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                const { snapshot } = yield* get(id);
                acknowledge = ["pending", "failed", "none"].includes(snapshot.delivery);
                return {
                  requests: [
                    {
                      ...snapshot,
                      delivery: acknowledge ? ("waiter" as const) : snapshot.delivery,
                    },
                  ],
                };
              }),
            ),
          );
        }),
      ).pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            const release = (commit: boolean) =>
              update(id, (current) => {
                if (current.waiter !== owner) return current;
                const { waiter: _waiter, ...rest } = current;
                return acknowledge && commit
                  ? { ...rest, snapshot: { ...rest.snapshot, delivery: "waiter" } }
                  : rest;
              });
            // Ref.update is the acknowledgement linearization point: publication
            // and claim release are one synchronous transition. Re-enable
            // interruption for that transition so a pending interrupt cannot
            // publish a stale Success captured before masked cleanup yielded.
            const completion = Exit.isFailure(exit)
              ? exit
              : yield* Effect.exit(Effect.interruptible(release(true)));
            // If interruption won, only release our still-owned claim. If the
            // commit won, ownership is gone and later cancellation cannot undo it.
            if (Exit.isFailure(completion)) yield* release(false);
            if (!(yield* Ref.get(closed))) yield* Effect.forkIn(deliver(id), scope);
          }),
        ),
      );
    });

  const control = Effect.fn("AskUserService.controlAsync")(function* (input: AskUserAsyncControl) {
    if (input.action === "status") {
      return {
        requests: input.requestId
          ? [(yield* get(input.requestId)).snapshot]
          : (yield* Ref.get(state)).map((entry) => {
              const { outcome: _outcome, ...summary } = entry.snapshot;
              return summary;
            }),
      };
    }
    if (!input.requestId)
      return yield* new AskUserAsyncError({
        reason: "invalid-control",
        message: "await and cancel require a requestId.",
      });
    return yield* wait(input.requestId, input.action === "cancel");
  });
  return {
    start,
    control,
    hasPending: Ref.get(state).pipe(
      Effect.map((entries) => entries.some((entry) => entry.snapshot.status === "pending")),
    ),
  };
});
