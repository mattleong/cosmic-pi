import { defaultQuestion, routeRequest as request } from "./support/questionnaire.ts";
import { afterEach, expect, vi } from "vitest";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { registerQuestionnaireCapability } from "../src/boundary/host-proxy.ts";
import { askAtQuestionnaireBoundary } from "../src/boundary/host-relay.ts";
import { AskUserService } from "../src/questionnaire/service.ts";
import {
  decodeQuestionnaireRequest,
  decodeQuestionnaireOutcome,
  queryQuestionnaireCapability,
  QUESTIONNAIRE_RELAY_QUERY,
  type QuestionnaireEvents,
  type QuestionnaireRelay,
  type AskUserOutcome,
} from "../src/protocol.ts";

const answer: AskUserOutcome = {
  outcome: "submitted",
  answers: [{ key: "route", kind: "choices", values: ["a"], labels: ["A"] }],
};
const owner = { runId: "run-1", assignmentEpoch: 0, requestId: "request-1" };
const events = (): QuestionnaireEvents => {
  const callbacks = new Map<string, Set<Parameters<QuestionnaireEvents["on"]>[1]>>();
  return {
    on: (name, listener) => {
      const listeners = callbacks.get(name) ?? new Set();
      listeners.add(listener);
      callbacks.set(name, listeners);
      return () => {
        listeners.delete(listener);
      };
    },
    emit: (name, data) => {
      for (const callback of callbacks.get(name) ?? []) callback(data);
    },
  };
};
const attachRelay = (bus: QuestionnaireEvents, relay: QuestionnaireRelay) =>
  bus.on(QUESTIONNAIRE_RELAY_QUERY, (data) => {
    const query = Schema.decodeUnknownSync(Schema.Struct({ respond: Schema.Unknown }))(data);
    if (Predicate.isFunction(query.respond)) query.respond(relay);
  });
afterEach(() => vi.unstubAllEnvs());
it("decodes bounded structured transport data and rejects hostile or semantically invalid requests", () => {
  expect(decodeQuestionnaireRequest(request)).toEqual(request);
  expect(decodeQuestionnaireOutcome(answer)).toEqual(answer);
  expect(
    decodeQuestionnaireRequest({ questions: Array(10000).fill(request.questions[0]) }),
  ).toBeUndefined();
  expect(
    decodeQuestionnaireRequest({ questions: [request.questions[0], request.questions[0]] }),
  ).toBeUndefined();
  expect(
    decodeQuestionnaireRequest({
      get questions() {
        throw new Error("private");
      },
    }),
  ).toBeUndefined();
  expect(
    decodeQuestionnaireOutcome({ outcome: "cancelled", answers: answer.answers }),
  ).toBeUndefined();
  expect(
    decodeQuestionnaireOutcome({
      get answers() {
        throw new Error("private");
      },
    }),
  ).toBeUndefined();
});
it("round-trips six questions and answers without relaxing the four-choice bound", () => {
  const choices = Array.from({ length: 4 }, (_, index) => ({
    ...defaultQuestion.choices[0]!,
    value: `choice-${index}`,
    label: `Choice ${index}`,
  }));
  const questions = Array.from({ length: 6 }, (_, index) => ({
    ...defaultQuestion,
    key: `question-${index}`,
    title: `Question ${index}`,
    choices,
  }));
  const answers = questions.map((question) => ({
    key: question.key,
    kind: "choices" as const,
    values: choices.map((choice) => choice.value),
    labels: choices.map((choice) => choice.label),
  }));
  expect(decodeQuestionnaireRequest({ questions })).toEqual({ questions });
  expect(decodeQuestionnaireOutcome({ outcome: "submitted", answers })).toEqual({
    outcome: "submitted",
    answers,
  });
  expect(decodeQuestionnaireRequest({ questions: [...questions, questions[0]] })).toBeUndefined();
  expect(
    decodeQuestionnaireOutcome({ outcome: "submitted", answers: [...answers, answers[0]] }),
  ).toBeUndefined();
  expect(
    decodeQuestionnaireRequest({
      questions: [{ ...defaultQuestion, choices: [...choices, choices[0]] }],
    }),
  ).toBeUndefined();
  expect(
    decodeQuestionnaireOutcome({
      outcome: "submitted",
      answers: [{ ...answers[0], values: [...answers[0]!.values, "choice-4"] }],
    }),
  ).toBeUndefined();
});
it("decodes detached text requests and rejects incompatible choices and malformed text results", () => {
  const question = { key: "text", title: "Text", prompt: "Explain?", mode: "text" };
  const input = { questions: [question] };
  const decoded = decodeQuestionnaireRequest(input);
  expect(decoded).toEqual(input);
  question.prompt = "changed";
  expect(decoded?.questions[0]?.prompt).toBe("Explain?");
  for (const choices of [[], undefined, [{ value: "a", label: "A", description: "A" }]]) {
    expect(decodeQuestionnaireRequest({ questions: [{ ...question, choices }] })).toBeUndefined();
  }
  expect(
    decodeQuestionnaireRequest({
      questions: [
        {
          ...question,
          get choices() {
            throw new Error("hostile");
          },
        },
      ],
    }),
  ).toBeUndefined();
  let reads = 0;
  expect(
    decodeQuestionnaireRequest({
      questions: [
        {
          ...question,
          get mode() {
            return ++reads === 1 ? "text" : "multiple";
          },
        },
      ],
    })?.questions[0]?.mode,
  ).toBe("text");
  for (const text of ["", " \n ", "x".repeat(4001), 42]) {
    expect(
      decodeQuestionnaireOutcome({
        outcome: "submitted",
        answers: [{ key: "text", kind: "text", text }],
      }),
    ).toBeUndefined();
  }
  expect(
    decodeQuestionnaireOutcome({
      outcome: "submitted",
      answers: [{ key: "text", kind: "text", text: " bq12\nanswer ", note: "context" }],
    }),
  ).toEqual({
    outcome: "submitted",
    answers: [{ key: "text", kind: "text", text: "bq12\nanswer", note: "context" }],
  });
  expect(
    decodeQuestionnaireOutcome({
      outcome: "submitted",
      answers: [
        {
          key: "text",
          kind: "text",
          get text() {
            throw new Error("hostile");
          },
        },
      ],
    }),
  ).toBeUndefined();
});
it.effect(
  "root capabilities are session-bound, validate owner input and revoke captured handles",
  () =>
    Effect.gen(function* () {
      const bus = events();
      let calls = 0;
      const layer = AskUserService.layer(() =>
        Effect.sync(() => {
          calls++;
          return answer;
        }),
      );
      const dispose = registerQuestionnaireCapability({
        events: bus,
        sessionId: "root",
        generation: "generation",
        isCurrent: () => true,
        run: (effect, signal) => Effect.runPromise(effect.pipe(Effect.provide(layer)), { signal }),
      });
      expect(queryQuestionnaireCapability(bus, "other")).toBeUndefined();
      const capability = queryQuestionnaireCapability(bus, "root")!;
      expect(yield* Effect.tryPromise((signal) => capability.ask(request, owner, signal))).toEqual(
        answer,
      );
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            Effect.tryPromise((signal) => capability.ask(request, { ...owner, runId: "" }, signal)),
          ),
        ),
      ).toBe(true);
      dispose();
      expect(
        Exit.isFailure(
          yield* Effect.exit(Effect.tryPromise((signal) => capability.ask(request, owner, signal))),
        ),
      ).toBe(true);
      expect(queryQuestionnaireCapability(bus, "root")).toBeUndefined();
      expect(calls).toBe(1);
    }),
);
it.effect(
  "marked Pi children fail closed without a relay and route answers without opening child dialogs",
  () =>
    Effect.gen(function* () {
      vi.stubEnv("PI_SUBAGENT_CHILD", "1");
      vi.stubEnv("PI_SUBAGENT_RUN_ID", "not-authentication");
      const bus = events();
      let local = 0;
      let forwarded = 0;
      const layer = AskUserService.layer(() =>
        Effect.sync(() => {
          local++;
          return answer;
        }),
      );
      const ask = askAtQuestionnaireBoundary(bus, "child", request).pipe(Effect.provide(layer));
      expect(Exit.isFailure(yield* Effect.exit(ask))).toBe(true);
      const off = attachRelay(bus, {
        version: 1,
        sessionId: "child",
        ask: (input, signal) => {
          expect(input).toEqual(request);
          expect(signal.aborted).toBe(false);
          forwarded++;
          return Promise.resolve(answer);
        },
      });
      expect(yield* ask).toEqual(answer);
      off();
      expect(Exit.isFailure(yield* Effect.exit(ask))).toBe(true);
      expect(local).toBe(0);
      expect(forwarded).toBe(1);
    }),
);
it.effect(
  "root cancel synchronously aborts its owner and acknowledges only after owned cleanup",
  () =>
    Effect.gen(function* () {
      const bus = events();
      const entered = yield* Deferred.make<void>();
      const cleanupEntered = yield* Deferred.make<void>();
      const cleanup = yield* Deferred.make<void>();
      const runtime = ManagedRuntime.make(
        AskUserService.layer(() =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Deferred.succeed(cleanupEntered, undefined).pipe(
                Effect.andThen(Deferred.await(cleanup)),
              ),
            ),
          ),
        ),
      );
      let signal: AbortSignal | undefined;
      const dispose = registerQuestionnaireCapability({
        events: bus,
        sessionId: "root",
        generation: "one",
        isCurrent: () => true,
        run: (effect, ownerSignal) => {
          signal = ownerSignal;
          return runtime.runPromise(effect, { signal: ownerSignal });
        },
      });
      const capability = queryQuestionnaireCapability(bus, "root")!;
      const asking = capability.ask(request, owner, yield* Effect.abortSignal).then(
        () => undefined,
        () => undefined,
      );
      yield* Deferred.await(entered);
      let acknowledged = false;
      const cancelling = capability.cancel(owner).then(() => {
        acknowledged = true;
      });
      expect(signal?.aborted).toBe(true);
      yield* Deferred.await(cleanupEntered);
      expect(acknowledged).toBe(false);
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            Effect.tryPromise((callerSignal) => capability.ask(request, owner, callerSignal)),
          ),
        ),
      ).toBe(true);
      yield* Deferred.succeed(cleanup, undefined);
      yield* Effect.tryPromise(() => cancelling);
      yield* Effect.tryPromise(() => asking);
      expect(acknowledged).toBe(true);
      yield* Effect.tryPromise(() => capability.cancel(owner));
      dispose();
      yield* Effect.tryPromise(() => runtime.dispose());
    }),
);

it.effect("caller cancellation reaches a relayed questionnaire", () =>
  Effect.gen(function* () {
    const bus = events();
    const ready = yield* Deferred.make<void>();
    const cancelled = yield* Deferred.make<void>();
    const off = attachRelay(bus, {
      version: 1,
      sessionId: "child",
      ask: (_input, signal) =>
        Effect.runPromise(
          Deferred.succeed(ready, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(cancelled, undefined)),
          ),
          { signal },
        ),
    });
    const pending = yield* Effect.forkChild(
      askAtQuestionnaireBoundary(bus, "child", request).pipe(
        Effect.provide(AskUserService.layer(() => Effect.succeed(answer))),
      ),
    );
    yield* Deferred.await(ready);
    yield* Fiber.interrupt(pending);
    yield* Deferred.await(cancelled);
    off();
  }),
);
