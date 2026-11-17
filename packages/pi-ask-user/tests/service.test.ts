import {
  acquireService,
  asyncRequest,
  defaultQuestion,
  forkNow,
  keyedRequest as keyed,
  submitted,
} from "./support/questionnaire.ts";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { MAX_PENDING_QUESTIONNAIRES } from "../src/questionnaire/queue.ts";
import type { AskUserOutcome } from "../src/questionnaire/model.ts";
import type { AskUserRequest } from "../src/questionnaire/schema.ts";
import { noQuestionnaireActivity, type AskUserHost } from "../src/questionnaire/service.ts";

const request = { questions: [defaultQuestion] } satisfies AskUserRequest;

const outcome = submitted();

it.effect(
  "async and blocking requests share FIFO; cancelled callers never mount or steer answers",
  () =>
    Effect.gen(function* () {
      const firstAnswer = yield* Deferred.make<AskUserOutcome>();
      const calls: string[] = [];
      const admitted: string[] = [];
      let delivered = 0;
      const host: AskUserHost = (input, presence) =>
        Effect.gen(function* () {
          calls.push(presence ? "async" : input.questions[0]!.key);
          if (presence) yield* Deferred.succeed(presence.opened, undefined);
          return presence ? yield* Deferred.await(firstAnswer) : outcome;
        });
      const service = yield* acquireService(
        host,
        () =>
          Effect.sync(() => {
            delivered++;
          }),
        "test",
        {
          ...noQuestionnaireActivity,
          admitted: (_id, asked) =>
            Effect.sync(() => {
              admitted.push(asked.questions[0]!.key);
            }),
        },
      );
      const receipt = yield* service.startAsync(asyncRequest);
      const cancelled = yield* forkNow(service.ask(keyed("cancelled")));
      const second = yield* forkNow(service.ask(keyed("second")));
      const third = yield* forkNow(service.ask(keyed("third")));
      yield* Fiber.interrupt(cancelled);
      expect(calls).toEqual(["async"]);
      yield* service.controlAsync({ action: "cancel", requestId: receipt.requestId });
      expect(yield* Fiber.join(second)).toEqual(outcome);
      yield* Fiber.join(third);
      expect(calls).toEqual(["async", "second", "third"]);
      // Activity heard of every request in the order it was admitted, the cancelled one included.
      expect(admitted).toEqual([asyncRequest.questions[0]!.key, "cancelled", "second", "third"]);
      expect(delivered).toBe(0);
    }),
);

it.effect("shares one bounded queue across blocking and async requests", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const host: AskUserHost = () =>
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
    const service = yield* acquireService(host, () => Effect.void);
    const active = yield* forkNow(service.ask(request));
    yield* Deferred.await(entered);
    const waiting = yield* forkNow(service.ask(request));
    for (let i = 0; i < MAX_PENDING_QUESTIONNAIRES - 2; i++)
      yield* service.startAsync(asyncRequest);
    expect(yield* Effect.flip(service.ask(request))).toMatchObject({ reason: "busy" });
    yield* Fiber.interrupt(waiting);
    expect(yield* Effect.flip(service.startAsync(asyncRequest))).toMatchObject({
      reason: "busy",
    });
    yield* Fiber.interrupt(active);
  }),
);

it.effect("reports a blocking questionnaire as shown only once earlier ones close", () =>
  Effect.gen(function* () {
    const firstAnswer = yield* Deferred.make<AskUserOutcome>();
    const shown: string[] = [];
    const host: AskUserHost = (input) =>
      input.questions[0]!.key === "first" ? Deferred.await(firstAnswer) : Effect.succeed(outcome);
    const report = (key: string) =>
      Effect.sync(() => {
        shown.push(key);
      });
    const service = yield* acquireService(host);
    const first = yield* forkNow(service.ask(keyed("first"), report("first")));
    const second = yield* forkNow(service.ask(keyed("second"), report("second")));
    yield* Effect.yieldNow;
    expect(shown).toEqual(["first"]);
    yield* Deferred.succeed(firstAnswer, outcome);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    expect(shown).toEqual(["first", "second"]);
  }),
);
