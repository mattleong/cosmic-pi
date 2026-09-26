import { asyncRequest, defaultQuestion, emptyForm, formOwner } from "./support/questionnaire.ts";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { MAX_PENDING_QUESTIONNAIRES } from "../src/questionnaire/queue.ts";
import type { AskUserOutcome } from "../src/questionnaire/model.ts";
import type { AskUserRequest } from "../src/questionnaire/schema.ts";
import { AskUserService, type AskUserHost } from "../src/questionnaire/service.ts";

const provideLayer = Effect.provide;

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
  "async, owned, ordinary and form requests share FIFO; cancelled callers never mount or steer answers",
  () =>
    Effect.gen(function* () {
      const firstAnswer = yield* Deferred.make<AskUserOutcome>();
      const calls: string[] = [];
      const owners: string[] = [];
      let delivered = 0;
      const host: AskUserHost = (input, opened) =>
        Effect.gen(function* () {
          calls.push(opened ? "async" : input.questions[0]!.key);
          if (opened) yield* Deferred.succeed(opened, undefined);
          return opened ? yield* Deferred.await(firstAnswer) : outcome;
        });
      const keyed = (key: string) => ({ questions: [{ ...request.questions[0]!, key }] });
      yield* Effect.gen(function* () {
        const service = yield* AskUserService;
        const receipt = yield* service.startAsync(asyncRequest);
        const fork = <A, E>(effect: Effect.Effect<A, E>) =>
          Effect.forkChild(effect, { startImmediately: true });
        const cancelled = [
          yield* fork(
            service.askOwned(request, {
              runId: "cancelled",
              assignmentEpoch: 1,
              requestId: "first",
            }),
          ),
          yield* fork(service.askForm(emptyForm, formOwner)),
        ];
        const owned = yield* fork(
          service.askOwned(keyed("owned"), {
            runId: "live",
            assignmentEpoch: 2,
            requestId: "second",
          }),
        );
        const ordinary = yield* fork(service.ask(keyed("ordinary")));
        const form = yield* fork(service.askForm(emptyForm, { ...formOwner, requestId: "next" }));
        yield* Fiber.interruptAll(cancelled);
        expect(calls).toEqual(["async"]);
        yield* service.controlAsync({ action: "cancel", requestId: receipt.requestId });
        expect(yield* Fiber.join(owned)).toEqual(outcome);
        yield* Fiber.join(ordinary);
        expect(yield* Fiber.join(form)).toEqual({ action: "accept", content: {} });
        expect(calls).toEqual(["async", "owned", "ordinary", "form"]);
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
              admitted: (_id, _request, _cancel, owner) =>
                Effect.sync(() => {
                  if (owner && "runId" in owner) owners.push(owner.runId);
                }),
              presenting: () => Effect.void,
              settled: () => Effect.void,
              removed: () => Effect.void,
            },
            () =>
              Effect.sync(() => {
                calls.push("form");
                return { action: "accept", content: {} } as const;
              }),
          ),
        ),
      );
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
    yield* provideLayer(program, serviceLayer, { local: true });
  }).pipe(Effect.scoped),
);

it.effect("serializes host asks and removes an interrupted queued caller", () =>
  Effect.gen(function* () {
    const firstEntered = yield* Deferred.make<void>();
    const laterEntered = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    let calls = 0;

    const host: AskUserHost = () =>
      Effect.gen(function* () {
        calls += 1;
        yield* Deferred.succeed(calls === 1 ? firstEntered : laterEntered, undefined);
        if (calls === 1) yield* Deferred.await(releaseFirst);
        return outcome;
      });
    const serviceLayer = AskUserService.layer(host);

    const program = AskUserService.use((service) =>
      Effect.gen(function* () {
        const first = yield* service
          .ask(request)
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(firstEntered);

        const queued = yield* service
          .ask(request)
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(calls).toBe(1);
        yield* Fiber.interrupt(queued);

        const later = yield* service
          .ask(request)
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(laterEntered);
        yield* Fiber.join(first);
        yield* Fiber.join(later);

        expect(calls).toBe(2);
      }),
    );
    // One provided service instance must own the semaphore for all three calls.
    yield* provideLayer(program, serviceLayer, { local: true });
  }).pipe(Effect.scoped),
);
