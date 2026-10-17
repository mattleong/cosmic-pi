import { asyncRequest, defaultQuestion } from "./support/questionnaire.ts";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { MAX_PENDING_QUESTIONNAIRES } from "../src/questionnaire/queue.ts";
import type { AskUserOutcome } from "../src/questionnaire/model.ts";
import type { AskUserRequest } from "../src/questionnaire/schema.ts";
import {
  AskUserService,
  noQuestionnaireActivity,
  type AskUserHost,
} from "../src/questionnaire/service.ts";

const request = { questions: [defaultQuestion] } satisfies AskUserRequest;

const outcome: AskUserOutcome = { outcome: "submitted", answers: [] };

const forkNow = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.forkChild(effect, { startImmediately: true });

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
        const cancelled = yield* forkNow(
          service.askOwned(request, {
            runId: "cancelled",
            assignmentEpoch: 1,
            requestId: "first",
          }),
        );
        const owned = yield* forkNow(
          service.askOwned(keyed("owned"), {
            runId: "live",
            assignmentEpoch: 2,
            requestId: "second",
          }),
        );
        const ordinary = yield* forkNow(service.ask(keyed("ordinary")));
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
      expect(yield* Effect.flip(service.startAsync(asyncRequest))).toMatchObject({
        reason: "busy",
      });
      yield* Fiber.interrupt(active);
    }).pipe(Effect.provide(AskUserService.layer(host, () => Effect.void)));
  }),
);
