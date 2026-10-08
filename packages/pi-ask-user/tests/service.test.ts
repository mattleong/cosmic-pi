import { asyncRequest, defaultQuestion } from "./support/questionnaire.ts";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { MAX_PENDING_QUESTIONNAIRES } from "../src/questionnaire/queue.ts";
import { AskUserHostError } from "../src/questionnaire/errors.ts";
import type { AskUserOutcome } from "../src/questionnaire/model.ts";
import type { AskUserRequest } from "../src/questionnaire/schema.ts";
import {
  AskUserService,
  noQuestionnaireActivity,
  type AskUserHost,
} from "../src/questionnaire/service.ts";

const request = { questions: [defaultQuestion] } satisfies AskUserRequest;

const invalidRequest: AskUserRequest = {
  questions: [
    {
      ...request.questions[0]!,
      title: " \t ",
      choices: request.questions[0]!.choices.map((choice) => ({ ...choice })),
    },
  ],
};

const outcome: AskUserOutcome = { outcome: "submitted", answers: [] };

it.effect(
  "async, owned and ordinary requests share FIFO; cancelled callers never mount or steer answers",
  () =>
    Effect.gen(function* () {
      const firstAnswer = yield* Deferred.make<AskUserOutcome>();
      const calls: string[] = [];
      const owners: string[] = [];
      let delivered = 0;
      const host: AskUserHost = (input, presence) =>
        Effect.gen(function* () {
          calls.push(presence ? "async" : input.questions[0]!.key);
          if (presence) yield* Deferred.succeed(presence.opened, undefined);
          return presence ? yield* Deferred.await(firstAnswer) : outcome;
        });
      const keyed = (key: string) => ({ questions: [{ ...request.questions[0]!, key }] });
      yield* Effect.gen(function* () {
        const service = yield* AskUserService;
        const receipt = yield* service.startAsync(asyncRequest);
        const fork = <A, E>(effect: Effect.Effect<A, E>) =>
          Effect.forkChild(effect, { startImmediately: true });
        const cancelled = yield* fork(
          service.askOwned(request, {
            runId: "cancelled",
            assignmentEpoch: 1,
            requestId: "first",
          }),
        );
        const owned = yield* fork(
          service.askOwned(keyed("owned"), {
            runId: "live",
            assignmentEpoch: 2,
            requestId: "second",
          }),
        );
        const ordinary = yield* fork(service.ask(keyed("ordinary")));
        yield* Fiber.interrupt(cancelled);
        expect(calls).toEqual(["async"]);
        yield* service.controlAsync({ action: "cancel", requestId: receipt.requestId });
        expect(yield* Fiber.join(owned)).toEqual(outcome);
        yield* Fiber.join(ordinary);
        expect(calls).toEqual(["async", "owned", "ordinary"]);
        expect(owners).toEqual(["cancelled", "live"]);
        expect(delivered).toBe(0);
      }).pipe(
        Effect.provide(
          AskUserService.layer(
            host,
            () =>
              Effect.sync(() => {
                delivered++;
              }),
            "test",
            {
              ...noQuestionnaireActivity,
              admitted: (_id, _request, _cancel, owner) =>
                Effect.sync(() => {
                  if (owner) owners.push(owner.runId);
                }),
            },
          ),
        ),
      );
    }),
);

it.effect("settles blocking Activity rows as the presented outcome, failure or cancellation", () =>
  Effect.gen(function* () {
    const settled: string[] = [];
    const cancels: Effect.Effect<void>[] = [];
    const interruptOpened = yield* Deferred.make<void>();
    const cancelOpened = yield* Deferred.make<void>();
    const presentations: Effect.Effect<AskUserOutcome, AskUserHostError>[] = [
      Effect.succeed({ outcome: "cancelled", answers: [] }),
      Effect.succeed(outcome),
      Effect.fail(new AskUserHostError({ operation: "render", message: "broken" })),
      Deferred.succeed(interruptOpened, undefined).pipe(Effect.andThen(Effect.never)),
      Deferred.succeed(cancelOpened, undefined).pipe(Effect.andThen(Effect.never)),
    ];
    yield* Effect.gen(function* () {
      const service = yield* AskUserService;
      expect((yield* service.ask(request)).outcome).toBe("cancelled");
      expect(yield* service.ask(request)).toEqual(outcome);
      expect(yield* Effect.flip(service.ask(request))).toMatchObject({ _tag: "AskUserHostError" });
      const interrupted = yield* Effect.forkChild(service.ask(request), {
        startImmediately: true,
      });
      yield* Deferred.await(interruptOpened);
      yield* Fiber.interrupt(interrupted);
      const cancelled = yield* Effect.forkChild(
        service.askOwned(request, { runId: "run", assignmentEpoch: 0, requestId: "activity" }),
        { startImmediately: true },
      );
      yield* Deferred.await(cancelOpened);
      yield* cancels[4]!;
      expect(yield* Fiber.join(cancelled)).toEqual({ outcome: "cancelled", answers: [] });
    }).pipe(
      Effect.provide(
        AskUserService.layer(() => presentations.shift()!, undefined, "test", {
          ...noQuestionnaireActivity,
          admitted: (_id, _request, cancel) => Effect.sync(() => cancels.push(cancel)),
          settled: (id, status) => Effect.sync(() => settled.push(`${id}:${status}`)),
        }),
      ),
    );
    expect(settled).toEqual([
      "test-blocking-1:cancelled",
      "test-blocking-2:submitted",
      "test-blocking-3:failed",
      "test-blocking-4:cancelled",
      "test-blocking-5:cancelled",
    ]);
  }),
);

it.effect("shares one bounded queue across blocking, owned and async requests", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const host: AskUserHost = () =>
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
    yield* Effect.gen(function* () {
      const service = yield* AskUserService;
      const active = yield* Effect.forkChild(service.ask(request), { startImmediately: true });
      yield* Deferred.await(entered);
      const owned = yield* Effect.forkChild(
        service.askOwned(request, { runId: "owner", assignmentEpoch: 0, requestId: "one" }),
        { startImmediately: true },
      );
      for (let i = 0; i < MAX_PENDING_QUESTIONNAIRES - 2; i++)
        yield* service.startAsync(asyncRequest);
      expect(yield* Effect.flip(service.ask(request))).toMatchObject({ reason: "busy" });
      expect(
        yield* Effect.flip(
          service.askOwned(request, { runId: "other", assignmentEpoch: 0, requestId: "two" }),
        ),
      ).toMatchObject({ reason: "busy" });
      yield* Fiber.interrupt(owned);
      // The cancelled ticket still occupies its bounded slot until the active
      // predecessor closes. Repeated cancel/admit cannot grow drain fibers.
      expect(yield* Effect.flip(service.startAsync(asyncRequest))).toMatchObject({
        reason: "busy",
      });
      yield* Fiber.interrupt(active);
    }).pipe(Effect.provide(AskUserService.layer(host, () => Effect.void)));
  }),
);

it.effect("rejects an invalid ask while a valid host dialog holds the permit", () =>
  Effect.gen(function* () {
    const firstEntered = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    let calls = 0;

    const host: AskUserHost = () =>
      Effect.gen(function* () {
        calls += 1;
        yield* Deferred.succeed(firstEntered, undefined);
        yield* Deferred.await(releaseFirst);
        return outcome;
      });
    const serviceLayer = AskUserService.layer(host);

    const program = AskUserService.use((service) =>
      Effect.gen(function* () {
        const first = yield* service
          .ask(request)
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(firstEntered);

        const invalidSettled = yield* Deferred.make<void>();
        const invalid = yield* service.ask(invalidRequest).pipe(
          Effect.flip,
          Effect.tap(() => Deferred.succeed(invalidSettled, undefined)),
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* Effect.yieldNow;

        expect(yield* Deferred.isDone(invalidSettled)).toBe(true);
        expect((yield* Fiber.join(invalid))._tag).toBe("AskUserValidationError");
        expect(calls).toBe(1);

        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Fiber.join(first);
      }),
    );
    yield* Effect.provide(program, serviceLayer, { local: true });
  }).pipe(Effect.scoped),
);
