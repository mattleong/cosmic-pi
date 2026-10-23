import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Str from "effect/String";
import {
  AskUserAsyncError,
  AskUserHostError,
  AskUserRuntimeClosedError,
  AskUserValidationError,
  asyncBusy,
} from "./errors.ts";
import { MAX_RETAINED_REQUESTS, type AsyncQuestionnaireSnapshot } from "./async-model.ts";
import {
  MAX_WORK_DESCRIPTION_LENGTH,
  type AskUserAsyncControl,
  type AskUserAsyncRequest,
  type AskUserRequest,
} from "./schema.ts";
import type { QuestionnaireQueue, QuestionnaireTicket } from "./queue.ts";
import type { AskUserHost, QuestionnaireActivity } from "./service.ts";
import { normalizeAskUserRequest, validateAskUserRequest } from "./validation.ts";

export type AsyncDelivery = (
  snapshot: AsyncQuestionnaireSnapshot,
) => Effect.Effect<void, AskUserHostError>;

interface Entry {
  readonly snapshot: AsyncQuestionnaireSnapshot;
  readonly opened: Deferred.Deferred<void, AskUserHostError | AskUserRuntimeClosedError>;
  readonly completed: Deferred.Deferred<void, AskUserRuntimeClosedError>;
  readonly cancel: Deferred.Deferred<void>;
  readonly waiter?: symbol;
  readonly deliveryAttempts: number;
}

const notFound = () =>
  AskUserAsyncError.make({
    reason: "not-found",
    message:
      "That questionnaire is no longer available. Use status without a requestId to list retained requests; it may have expired or belonged to an earlier session or branch.",
  });

export const acquireAsyncQuestionnaires = Effect.fn("AskUserService.acquireAsync")(function* (
  host: AskUserHost,
  queue: QuestionnaireQueue,
  delivery: AsyncDelivery | undefined,
  idPrefix: string,
  activity: QuestionnaireActivity,
) {
  const parentScope = yield* Effect.scope;
  const scope = yield* Scope.fork(parentScope, "sequential");
  const state = yield* Ref.make<ReadonlyArray<Entry>>([]);
  const counter = yield* Ref.make(0);
  const admission = yield* Semaphore.make(1);
  const closed = yield* Ref.make(false);
  // Runs before the presenter scope closes. Interrupted presenters cannot settle their entries,
  // so closure releases every opening and waiting caller. The admission permit keeps a start
  // from registering an entry after this snapshot.
  yield* Scope.addFinalizer(
    parentScope,
    admission.withPermit(
      Effect.gen(function* () {
        yield* Ref.set(closed, true);
        const error = AskUserRuntimeClosedError.make({
          message: "The questionnaire session closed before this questionnaire finished.",
        });
        for (const entry of yield* Ref.get(state)) {
          yield* Deferred.fail(entry.opened, error);
          yield* Deferred.fail(entry.completed, error);
        }
      }),
    ),
  );

  const get = (id: string) =>
    Ref.get(state).pipe(
      Effect.flatMap((entries) => {
        const entry = Option.getOrUndefined(
          Arr.findFirst(entries, (item) => item.snapshot.requestId === id),
        );
        return entry ? Effect.succeed(entry) : Effect.fail(notFound());
      }),
    );
  const update = (id: string, f: (entry: Entry) => Entry) =>
    Ref.update(state, (entries) =>
      Arr.map(entries, (entry) => (entry.snapshot.requestId === id ? f(entry) : entry)),
    );
  const patch = (
    id: string,
    change: (entry: Entry) => Partial<AsyncQuestionnaireSnapshot> | undefined,
  ) =>
    update(id, (entry) => {
      const next = change(entry);
      return next ? { ...entry, snapshot: { ...entry.snapshot, ...next } } : entry;
    });

  const deliver = Effect.fn("AskUserService.deliverAsync")(function* (
    id: string,
  ): Effect.fn.Return<void> {
    if (!delivery || (yield* Ref.get(closed))) return;
    const claimed = yield* Ref.modify(state, (entries) => {
      const entry = Option.getOrUndefined(
        Arr.findFirst(entries, (item) => item.snapshot.requestId === id),
      );
      if (
        !entry ||
        entry.waiter ||
        entry.snapshot.status === "pending" ||
        entry.snapshot.delivery !== "pending"
      )
        return [undefined, entries] as const;
      const next: Entry = {
        ...entry,
        snapshot: { ...entry.snapshot, delivery: "sending" },
        deliveryAttempts: entry.deliveryAttempts + 1,
      };
      return [next, Arr.map(entries, (item) => (item === entry ? next : item))] as const;
    });
    if (!claimed) return;
    const result = yield* Effect.exit(delivery(claimed.snapshot));
    yield* patch(id, () => ({ delivery: Exit.isSuccess(result) ? "sent" : "failed" }));
    if (Exit.isFailure(result) && claimed.deliveryAttempts < 3 && !(yield* Ref.get(closed))) {
      yield* Effect.forkIn(
        Effect.sleep("1 second").pipe(
          Effect.andThen(
            patch(id, (entry) =>
              entry.snapshot.delivery === "failed" && !entry.waiter
                ? { delivery: "pending" }
                : undefined,
            ),
          ),
          Effect.andThen(deliver(id)),
        ),
        scope,
      );
    }
  });

  const present = Effect.fn("AskUserService.presentAsync")(function* (
    entry: Entry,
    request: AskUserRequest,
    ticket: QuestionnaireTicket,
  ): Effect.fn.Return<void> {
    const id = entry.snapshot.requestId;
    const show = Effect.gen(function* () {
      yield* patch(id, () => ({ presentation: "opening" }));
      yield* activity.presenting(id);
      const visibility = yield* Queue.unbounded<"open" | "hidden">();
      yield* Effect.forkChild(
        Queue.take(visibility).pipe(
          Effect.flatMap((presentation) =>
            patch(id, (current) =>
              current.snapshot.status === "pending" ? { presentation } : undefined,
            ),
          ),
          Effect.forever,
        ),
      );
      return yield* host(request, { opened: entry.opened, visibility }, !ticket.immediate);
    });
    const result = yield* Effect.exit(
      Effect.raceFirst(
        ticket.run(show),
        Deferred.await(entry.cancel).pipe(
          Effect.as({ outcome: "cancelled", answers: [] } as const),
        ),
      ).pipe(Effect.ensuring(ticket.close)),
    );
    const outcome = Exit.isSuccess(result) ? result.value : undefined;
    yield* patch(id, () =>
      outcome
        ? { status: outcome.outcome, presentation: "settled", delivery: "pending", outcome }
        : { status: "failed", presentation: "settled", delivery: "none" },
    );
    yield* activity.settled(id, outcome?.outcome ?? "failed");
    const failure = Exit.isFailure(result) ? Cause.findErrorOption(result.cause) : Option.none();
    yield* Deferred.fail(
      entry.opened,
      Option.getOrElse(failure, () =>
        AskUserHostError.make({
          operation: "open",
          message: "The questionnaire closed before its overlay opened.",
        }),
      ),
    );
    // Queue closure can release this presenter before the shutdown finalizer reaches its entry;
    // its waiters still observe the same closed error.
    const closedError = Option.getOrUndefined(failure);
    yield* Predicate.isTagged(closedError, "AskUserRuntimeClosedError")
      ? Deferred.fail(entry.completed, closedError)
      : Deferred.succeed(entry.completed, undefined);
    yield* deliver(id);
  });

  const start = Effect.fn("AskUserService.startAsync")(function* (request: AskUserAsyncRequest) {
    const normalized = normalizeAskUserRequest(request);
    const validationError = validateAskUserRequest(normalized);
    if (validationError) return yield* validationError;
    if (
      Arr.some(
        [request.independentWork, request.blockedWork],
        (text) => !Str.trim(text) || text.length > MAX_WORK_DESCRIPTION_LENGTH,
      )
    ) {
      return yield* AskUserValidationError.make({
        message: "Work descriptions must be nonblank and at most 500 characters.",
      });
    }
    const admittedRequest = yield* admission.withPermit(
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (yield* Ref.get(closed)) return yield* notFound();
          const ticket = yield* queue.admit;
          const reserved = ticket.immediate;
          const sequence = yield* Ref.updateAndGet(counter, (n) => n + 1);
          const requestId = `${idPrefix}-${sequence}`;
          const snapshot: AsyncQuestionnaireSnapshot = {
            requestId,
            deliveryId: `${requestId}-answer`,
            status: "pending",
            presentation: reserved ? "opening" : "queued",
            delivery: "pending",
            independentWork: Str.trim(request.independentWork),
            blockedWork: Str.trim(request.blockedWork),
          };
          const entry: Entry = {
            snapshot,
            opened: yield* Deferred.make<void, AskUserHostError | AskUserRuntimeClosedError>(),
            completed: yield* Deferred.make<void, AskUserRuntimeClosedError>(),
            cancel: yield* Deferred.make<void>(),
            deliveryAttempts: 0,
          };
          const admitted = yield* Ref.modify(state, (entries) => {
            const evict =
              entries.length >= MAX_RETAINED_REQUESTS
                ? Option.getOrUndefined(
                    Arr.findFirst(
                      entries,
                      (item) =>
                        !item.waiter &&
                        item.snapshot.status !== "pending" &&
                        ["sent", "waiter"].includes(item.snapshot.delivery),
                    ),
                  )
                : undefined;
            if (entries.length >= MAX_RETAINED_REQUESTS && !evict)
              return [undefined, entries] as const;
            return [
              { evicted: evict?.snapshot.requestId },
              [...Arr.filter(entries, (item) => item !== evict), entry],
            ] as const;
          });
          if (!admitted) {
            yield* ticket.close;
            return yield* asyncBusy();
          }
          if (admitted.evicted) yield* activity.removed(admitted.evicted);
          yield* activity.admitted(
            requestId,
            normalized,
            Effect.asVoid(Deferred.succeed(entry.cancel, undefined)),
          );
          yield* Effect.forkIn(present(entry, normalized, ticket), scope, {
            startImmediately: true,
          });
          return { reserved, snapshot, entry };
        }),
      ),
    );
    if (admittedRequest.reserved) {
      yield* Deferred.await(admittedRequest.entry.opened);
      return { ...admittedRequest.snapshot, presentation: "open" as const };
    }
    return admittedRequest.snapshot;
  });

  const wait = (id: string, cancel: boolean) =>
    Effect.suspend(() => {
      const owner = Symbol();
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const claimed = yield* Ref.modify(
            state,
            (entries): readonly [Entry | "busy" | "missing", ReadonlyArray<Entry>] => {
              const entry = Option.getOrUndefined(
                Arr.findFirst(entries, (item) => item.snapshot.requestId === id),
              );
              if (!entry || entry.waiter) return [entry ? "busy" : "missing", entries] as const;
              return [
                entry,
                Arr.map(entries, (item) => (item === entry ? { ...item, waiter: owner } : item)),
              ] as const;
            },
          );
          if (claimed === "busy") {
            if (!cancel) return yield* asyncBusy();
            const entry = yield* get(id);
            yield* Deferred.succeed(entry.cancel, undefined);
            yield* restore(Deferred.await(entry.completed));
            return { requests: [(yield* get(id)).snapshot] };
          }
          if (claimed === "missing") return yield* notFound();
          if (cancel) yield* Deferred.succeed(claimed.cancel, undefined);
          yield* restore(Deferred.await(claimed.completed));
          const { snapshot } = yield* get(id);
          const acknowledge = ["pending", "failed", "none"].includes(snapshot.delivery);
          return {
            requests: [
              { ...snapshot, delivery: acknowledge ? ("waiter" as const) : snapshot.delivery },
            ],
          };
        }),
      ).pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            const release = (acknowledge: boolean) =>
              update(id, (current) => {
                if (current.waiter !== owner) return current;
                const { waiter: _waiter, ...rest } = current;
                return acknowledge
                  ? { ...rest, snapshot: { ...rest.snapshot, delivery: "waiter" } }
                  : rest;
              });
            const completion = Exit.isFailure(exit)
              ? exit
              : yield* Effect.exit(
                  Effect.interruptible(release(exit.value.requests[0]?.delivery === "waiter")),
                );
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
          : Arr.map(yield* Ref.get(state), (entry): AsyncQuestionnaireSnapshot => {
              const { outcome: _outcome, ...summary } = entry.snapshot;
              return summary;
            }),
      };
    }
    if (!input.requestId)
      return yield* AskUserAsyncError.make({
        reason: "invalid-control",
        message: "await and cancel require a requestId.",
      });
    return yield* wait(input.requestId, input.action === "cancel");
  });
  return { start, control };
});
