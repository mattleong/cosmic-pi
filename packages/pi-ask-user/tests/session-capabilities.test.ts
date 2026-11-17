import {
  acquireService,
  forkNow,
  hostile,
  keyedRequest as keyed,
  routeRequest as request,
  submitted,
} from "./support/questionnaire.ts";
import { expect } from "vitest";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { makeSessionCapabilityProtocol } from "pi-cosmic-core";
import { deferredPromise } from "pi-cosmic-core/testing";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { registerQuestionnaireCapability } from "../src/boundary/host-owned-calls.ts";
import { MAX_PENDING_QUESTIONNAIRES } from "../src/questionnaire/queue.ts";
import { askInSession } from "../src/boundary/host-askers.ts";
import { AskUserService } from "../src/questionnaire/service.ts";
import {
  decodeQuestionnaireRequest,
  decodeQuestionnaireOutcome,
  queryQuestionnaireCapability,
  QUESTIONNAIRE_ASKERS_QUERY,
  type QuestionnaireEvents,
  type QuestionnaireOwner,
  type AskUserOutcome,
  type AskUserRequest,
} from "../src/protocol.ts";
import { AskUserRuntimeClosedError } from "../src/questionnaire/errors.ts";

const answer = submitted({ key: "route", kind: "choices", values: ["a"], labels: ["A"] });
const owner = { runId: "run-1", assignmentEpoch: 0, requestId: "request-1" };
// Discovered callbacks are foreign, so their results settle as untrusted values.
const sessionCapability = (bus: QuestionnaireEvents) => {
  const capability = queryQuestionnaireCapability(bus, "root")!;
  return {
    ask: (input: AskUserRequest, askOwner: QuestionnaireOwner, signal: AbortSignal) =>
      Promise.resolve<unknown>(capability.ask(input, askOwner, signal)),
    cancel: (cancelOwner: QuestionnaireOwner) =>
      Promise.resolve<unknown>(capability.cancel(cancelOwner)),
  };
};
const askFails = (
  capability: ReturnType<typeof sessionCapability>,
  askOwner: QuestionnaireOwner,
): Effect.Effect<boolean> =>
  Effect.exit(Effect.tryPromise((signal) => capability.ask(request, askOwner, signal))).pipe(
    Effect.map(Exit.isFailure),
  );
const queries = makeSessionCapabilityProtocol({ version: 1 });
it("decodes bounded structured transport data and rejects hostile or semantically invalid requests", () => {
  expect(decodeQuestionnaireRequest(request)).toEqual(request);
  // The asker's name crosses the relay with its questions; anything but text does not.
  expect(decodeQuestionnaireRequest({ ...request, askedBy: " Pane tour " })).toEqual({
    ...request,
    askedBy: "Pane tour",
  });
  expect(
    decodeQuestionnaireRequest({ ...request, askedBy: { name: "Pane tour" } }),
  ).toBeUndefined();
  expect(decodeQuestionnaireOutcome(answer)).toEqual(answer);
  for (const input of [
    { questions: Array(10000).fill(request.questions[0]) },
    { questions: [request.questions[0], request.questions[0]] },
    hostile({}, "questions"),
  ])
    expect(decodeQuestionnaireRequest(input)).toBeUndefined();
  for (const input of [{ outcome: "cancelled", answers: answer.answers }, hostile({}, "answers")])
    expect(decodeQuestionnaireOutcome(input)).toBeUndefined();
});

it.effect(
  "a session's capability is bound to it, refuses aborted or stale calls and revokes captured handles",
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
      const capability = sessionCapability(bus);
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
  "a questionnaire asked for another agent opens where that agent is on screen, or here under its name",
  () =>
    Effect.gen(function* () {
      const bus = createEventBus();
      const local: AskUserRequest[] = [];
      const elsewhere: AskUserRequest[] = [];
      const layer = AskUserService.layer((asked) =>
        Effect.sync(() => {
          local.push(asked);
          return answer;
        }),
      );
      const paneAnswer = submitted({ key: "route", kind: "choices", values: ["b"], labels: ["B"] });
      // What the agent's own session does with the questionnaire, as each case sets it.
      type Presented = Promise<AskUserOutcome | { readonly outcome: string } | undefined>;
      let present: (asked: AskUserRequest, signal: AbortSignal) => Presented = () =>
        Promise.resolve(paneAnswer);
      const off = bus.on(QUESTIONNAIRE_ASKERS_QUERY, (data) => {
        queries.normalizeQuery(data)?.respond({
          version: 1,
          sessionId: "root",
          find: (askedBy: string) =>
            askedBy === "agent-1"
              ? {
                  name: "Banner colour",
                  present: (asked: AskUserRequest, signal: AbortSignal) => {
                    elsewhere.push(asked);
                    return present(asked, signal);
                  },
                }
              : undefined,
        });
      });
      const ask = (askedBy: string) =>
        askInSession(bus, "root", { ...request, askedBy }).pipe(Effect.provide(layer));

      // On screen there: answered there, by its name, and never opened here.
      expect(yield* ask("agent-1")).toEqual(paneAnswer);
      expect(elsewhere).toEqual([{ ...request, askedBy: "Banner colour" }]);
      expect(local).toEqual([]);

      // Not on screen, a session that fails, or one that answers nonsense: it opens here.
      for (const unavailable of [
        () => Promise.resolve(undefined),
        () => Promise.reject(new Error("pane closed")),
        () => Promise.resolve({ outcome: "maybe" }),
        () => {
          throw new Error("hostile asker");
        },
      ]) {
        present = unavailable;
        local.length = 0;
        expect(yield* ask("agent-1")).toEqual(answer);
        expect(local).toEqual([{ ...request, askedBy: "Banner colour" }]);
      }

      // An agent nobody knows keeps the name it was given.
      local.length = 0;
      expect(yield* ask("somebody")).toEqual(answer);
      expect(local).toEqual([{ ...request, askedBy: "somebody" }]);

      // The caller giving up reaches the session that is showing the questionnaire.
      const showing = deferredPromise<AbortSignal>();
      present = (_asked, signal) => {
        showing.resolve(signal);
        return Effect.runPromise(Effect.never, { signal });
      };
      const pending = yield* forkNow(ask("agent-1"));
      const signal = yield* Effect.promise(() => showing.promise);
      yield* Fiber.interrupt(pending);
      expect(signal.aborted).toBe(true);
      off();
    }),
);

it.effect("cancel synchronously aborts its owner and acknowledges only after owned cleanup", () =>
  Effect.gen(function* () {
    const bus = createEventBus();
    const entered = yield* Deferred.make<void>();
    const cleanupEntered = yield* Deferred.make<void>();
    const cleanup = yield* Deferred.make<void>();
    const service = yield* acquireService(() =>
      Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(
          Deferred.succeed(cleanupEntered, undefined).pipe(Effect.andThen(Deferred.await(cleanup))),
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
        return Effect.runPromise(effect.pipe(Effect.provideService(AskUserService, service)), {
          signal: ownerSignal,
        });
      },
    });
    const capability = sessionCapability(bus);
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
  return { runs, dispose, capability: sessionCapability(bus) };
};

it.effect(
  "a session's capability bounds live owners and refuses a duplicate live owner unrun",
  () =>
    Effect.gen(function* () {
      const { runs, dispose, capability } = registerPendingRuns();
      const signal = yield* Effect.abortSignal;
      const ownerAt = (index: number) => ({ ...owner, requestId: `request-${index}` });
      const refused = (index: number) => {
        const before = runs.length;
        const asking = capability.ask(request, ownerAt(index), signal);
        expect(runs).toHaveLength(before);
        return Effect.promise(() =>
          expect(asking).rejects.toBeInstanceOf(AskUserRuntimeClosedError),
        );
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

it.effect("an owned questionnaire reports shown once it opens, not while it is queued", () =>
  Effect.gen(function* () {
    const bus = createEventBus();
    const firstOpen = yield* Deferred.make<void>();
    const firstAnswer = yield* Deferred.make<AskUserOutcome>();
    const service = yield* acquireService((input) =>
      input.questions[0]!.key === "first"
        ? Deferred.succeed(firstOpen, undefined).pipe(Effect.andThen(Deferred.await(firstAnswer)))
        : Effect.succeed(answer),
    );
    const dispose = registerQuestionnaireCapability({
      events: bus,
      sessionId: "root",
      generation: "one",
      isCurrent: () => true,
      run: (effect, signal) =>
        Effect.runPromise(effect.pipe(Effect.provideService(AskUserService, service)), { signal }),
    });
    const capability = queryQuestionnaireCapability(bus, "root")!;
    const shown: string[] = [];
    const signal = yield* Effect.abortSignal;
    const first = Promise.resolve<unknown>(
      capability.ask(keyed("first"), { ...owner, requestId: "first" }, signal, () =>
        shown.push("first"),
      ),
    );
    const second = Promise.resolve<unknown>(
      capability.ask(keyed("second"), { ...owner, requestId: "second" }, signal, () => {
        shown.push("second");
        // A throwing callback can't fail the questionnaire.
        throw new Error("hostile callback");
      }),
    );
    yield* Deferred.await(firstOpen);
    expect(shown).toEqual(["first"]);
    yield* Deferred.succeed(firstAnswer, answer);
    expect(yield* Effect.promise(() => Promise.all([first, second]))).toEqual([answer, answer]);
    expect(shown).toEqual(["first", "second"]);
    dispose();
  }),
);
