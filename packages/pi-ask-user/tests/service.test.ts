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
      const service = yield* acquireService(
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
      );
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
    }),
);

it.effect("shares one bounded queue across blocking, owned and async requests", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const host: AskUserHost = () =>
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
    const service = yield* acquireService(host, () => Effect.void);
    const active = yield* forkNow(service.ask(request));
    yield* Deferred.await(entered);
    const owned = yield* forkNow(
      service.askOwned(request, { runId: "owner", assignmentEpoch: 0, requestId: "one" }),
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
