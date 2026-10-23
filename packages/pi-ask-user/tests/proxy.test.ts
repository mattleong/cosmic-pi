import { routeRequest as request } from "./support/questionnaire.ts";
import { afterEach, expect, vi } from "vitest";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { makeSessionCapabilityProtocol } from "pi-cosmic-core";
import { deferredPromise } from "pi-cosmic-core/testing";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { registerQuestionnaireCapability } from "../src/boundary/host-owned-calls.ts";
import { MAX_PENDING_QUESTIONNAIRES } from "../src/questionnaire/queue.ts";
import { askAtQuestionnaireBoundary } from "../src/boundary/host-relay.ts";
import { AskUserService } from "../src/questionnaire/service.ts";
import {
  decodeQuestionnaireRequest,
  decodeQuestionnaireOutcome,
  queryQuestionnaireCapability,
  QUESTIONNAIRE_RELAY_QUERY,
  type QuestionnaireEvents,
  type QuestionnaireOwner,
  type QuestionnaireRelay,
  type AskUserOutcome,
  type AskUserRequest,
} from "../src/protocol.ts";
import { AskUserHostError, AskUserRuntimeClosedError } from "../src/questionnaire/errors.ts";

const answer: AskUserOutcome = {
  outcome: "submitted",
  answers: [{ key: "route", kind: "choices", values: ["a"], labels: ["A"] }],
};
const owner = { runId: "run-1", assignmentEpoch: 0, requestId: "request-1" };
// Discovered callbacks are foreign, so their results settle as untrusted values.
const rootCapability = (bus: QuestionnaireEvents) => {
  const capability = queryQuestionnaireCapability(bus, "root")!;
  return {
    ask: (input: AskUserRequest, askOwner: QuestionnaireOwner, signal: AbortSignal) =>
      Promise.resolve<unknown>(capability.ask(input, askOwner, signal)),
    cancel: (cancelOwner: QuestionnaireOwner) =>
      Promise.resolve<unknown>(capability.cancel(cancelOwner)),
  };
};
const askFails = (
  capability: ReturnType<typeof rootCapability>,
  askOwner: QuestionnaireOwner,
): Effect.Effect<boolean> =>
  Effect.exit(Effect.tryPromise((signal) => capability.ask(request, askOwner, signal))).pipe(
    Effect.map(Exit.isFailure),
  );
const relayQueries = makeSessionCapabilityProtocol({ version: 1 });
const attachRelay = (bus: QuestionnaireEvents, relay: QuestionnaireRelay) =>
  bus.on(QUESTIONNAIRE_RELAY_QUERY, (data) => {
    relayQueries.normalizeQuery(data)?.respond(relay);
  });
afterEach(() => vi.unstubAllEnvs());
it("decodes bounded structured transport data and rejects hostile or semantically invalid requests", () => {
  expect(decodeQuestionnaireRequest(request)).toEqual(request);
  expect(decodeQuestionnaireOutcome(answer)).toEqual(answer);
  for (const input of [
    { questions: Array(10000).fill(request.questions[0]) },
    { questions: [request.questions[0], request.questions[0]] },
    {
      get questions() {
        throw new Error("private");
      },
    },
  ])
    expect(decodeQuestionnaireRequest(input)).toBeUndefined();
  for (const input of [
    { outcome: "cancelled", answers: answer.answers },
    {
      get answers() {
        throw new Error("private");
      },
    },
  ])
    expect(decodeQuestionnaireOutcome(input)).toBeUndefined();
});

it.effect(
  "root capabilities are session-bound, refuse aborted or stale calls and revoke captured handles",
  () =>
    Effect.gen(function* () {
      const bus = createEventBus();
      let calls = 0;
      let stale = false;
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
        isCurrent: () => {
          if (stale) throw new Error("stale host");
          return true;
        },
        run: (effect, signal) => Effect.runPromise(effect.pipe(Effect.provide(layer)), { signal }),
      });
      expect(queryQuestionnaireCapability(bus, "other")).toBeUndefined();
      const capability = rootCapability(bus);
      expect(yield* Effect.tryPromise((signal) => capability.ask(request, owner, signal))).toEqual(
        answer,
      );
      expect(yield* askFails(capability, { ...owner, runId: "" })).toBe(true);
      yield* Effect.promise(() =>
        expect(capability.ask(request, owner, AbortSignal.abort())).rejects.toBeInstanceOf(
          AskUserRuntimeClosedError,
        ),
      );
      stale = true;
      yield* Effect.promise(() =>
        expect(capability.ask(request, owner, new AbortController().signal)).rejects.toBeInstanceOf(
          AskUserRuntimeClosedError,
        ),
      );
      expect(queryQuestionnaireCapability(bus, "root")).toBeUndefined();
      stale = false;
      dispose();
      expect(yield* askFails(capability, owner)).toBe(true);
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
      const bus = createEventBus();
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

it.effect("a relay that throws or returns an invalid outcome fails as a typed relay error", () =>
  Effect.gen(function* () {
    const bus = createEventBus();
    const ask = askAtQuestionnaireBoundary(bus, "child", request).pipe(
      Effect.provide(AskUserService.layer(() => Effect.succeed(answer))),
    );
    for (const relayAsk of [
      () => {
        throw new Error("hostile relay");
      },
      () => Promise.resolve({ outcome: "maybe" }),
      () => "submitted",
    ]) {
      const off = bus.on(QUESTIONNAIRE_RELAY_QUERY, (data) => {
        relayQueries
          .normalizeQuery(data)
          ?.respond({ version: 1, sessionId: "child", ask: relayAsk });
      });
      const failure = yield* Effect.flip(ask);
      expect(failure).toBeInstanceOf(AskUserHostError);
      expect(failure).toMatchObject({ operation: "relay" });
      off();
    }
  }),
);

it.effect(
  "root cancel synchronously aborts its owner and acknowledges only after owned cleanup",
  () =>
    Effect.gen(function* () {
      const bus = createEventBus();
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
      const capability = rootCapability(bus);
      const asking = capability.ask(request, owner, yield* Effect.abortSignal).then(
        () => undefined,
        () => undefined,
      );
      yield* Deferred.await(entered);
      let acknowledged = false;
      const cancelling = capability.cancel(owner).then(() => {
        acknowledged = true;
        return undefined;
      });
      expect(signal?.aborted).toBe(true);
      yield* Deferred.await(cleanupEntered);
      expect(acknowledged).toBe(false);
      expect(yield* askFails(capability, owner)).toBe(true);
      yield* Deferred.succeed(cleanup, undefined);
      yield* Effect.tryPromise(() => cancelling);
      yield* Effect.tryPromise(() => asking);
      expect(acknowledged).toBe(true);
      yield* Effect.tryPromise(() => capability.cancel(owner));
      dispose();
      yield* Effect.tryPromise(() => runtime.dispose());
    }),
);

const registerPendingRuns = () => {
  const bus = createEventBus();
  const runs: {
    signal: AbortSignal;
    completion: ReturnType<typeof deferredPromise<AskUserOutcome>>;
  }[] = [];
  const dispose = registerQuestionnaireCapability({
    events: bus,
    sessionId: "root",
    generation: "one",
    isCurrent: () => true,
    run: (_effect, signal) => {
      const completion = deferredPromise<AskUserOutcome>();
      runs.push({ signal, completion });
      return completion.promise;
    },
  });
  return { runs, dispose, capability: rootCapability(bus) };
};

it.effect("root capabilities bound live owners and refuse a duplicate live owner unrun", () =>
  Effect.gen(function* () {
    const { runs, dispose, capability } = registerPendingRuns();
    const signal = yield* Effect.abortSignal;
    const ownerAt = (index: number) => ({ ...owner, requestId: `request-${index}` });
    const refused = (index: number) => {
      const before = runs.length;
      const asking = capability.ask(request, ownerAt(index), signal);
      expect(runs).toHaveLength(before);
      return Effect.promise(() => expect(asking).rejects.toBeInstanceOf(AskUserRuntimeClosedError));
    };
    const pending = [capability.ask(request, ownerAt(0), signal)];
    yield* refused(0);
    for (let index = 1; index < MAX_PENDING_QUESTIONNAIRES; index++)
      pending.push(capability.ask(request, ownerAt(index), signal));
    yield* refused(MAX_PENDING_QUESTIONNAIRES);
    expect(runs).toHaveLength(MAX_PENDING_QUESTIONNAIRES);
    for (const run of runs) run.completion.resolve(answer);
    expect(yield* Effect.promise(() => Promise.all(pending))).toHaveLength(
      MAX_PENDING_QUESTIONNAIRES,
    );
    dispose();
  }),
);

it.effect("caller cancellation reaches a relayed questionnaire", () =>
  Effect.gen(function* () {
    const bus = createEventBus();
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
