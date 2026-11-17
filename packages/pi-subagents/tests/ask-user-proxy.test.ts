import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Fn from "effect/Function";
import * as Result from "effect/Result";
import { deferredPromise } from "pi-cosmic-core/testing";
import { describe, expect, it } from "vitest";
import {
  decodeQuestionnaireAsker,
  queryQuestionnaireAskers,
  queryQuestionnaireRelay,
  type AskUserRequest,
  type AskUserOutcome,
  type QuestionnaireCapability,
  type QuestionnaireOwner,
} from "pi-ask-user/protocol";
import {
  askSessionQuestionnaire,
  publishQuestionnaireAskers,
  publishChildQuestionnaireRelay,
} from "../src/boundary/host-ask-user.ts";
import {
  decodeQuestionnaireProxyRequest,
  decodeSubagentProxyRequest,
} from "../src/tools/proxy-protocol.ts";
import { InvalidSubagentRequestError } from "../src/run/errors.ts";
import {
  answerCapabilityQueries,
  eventBus as bus,
  pickQuestionnaire as request,
} from "./support/questionnaire.ts";
import { effectTest, step } from "./support/effect-test.ts";
import { rejection } from "./support/result.ts";
import * as Str from "effect/String";

const owner = (requestId: string): QuestionnaireOwner => ({
  runId: "run",
  assignmentEpoch: 1,
  requestId,
});
const capability = (overrides: Partial<QuestionnaireCapability> = {}): QuestionnaireCapability => ({
  version: 1,
  sessionId: "root",
  generation: "g1",
  ask: () => Promise.resolve({ outcome: "cancelled", answers: [] }),
  cancel: () => Promise.resolve(),
  ...overrides,
});

const relayToRoot = (rootCapability: QuestionnaireCapability, asker: QuestionnaireOwner) => {
  const root = bus();
  const child = bus();
  answerCapabilityQueries(root, () => rootCapability);
  const detach = publishChildQuestionnaireRelay(
    child,
    "child",
    () => true,
    (wire, signal) => {
      const decoded = decodeQuestionnaireProxyRequest(wire);
      if (Result.isFailure(decoded)) return Promise.reject(decoded.failure);
      return Effect.runPromise(askSessionQuestionnaire(root, "root", decoded.success, asker), {
        signal,
      });
    },
  );
  return { child, detach, relay: queryQuestionnaireRelay(child, "child")! };
};

describe("structured questionnaire proxy boundary", () => {
  effectTest(
    "round-trips text questions and notes through the authenticated root and rejects text with choices",
    function* () {
      const textRequest: AskUserRequest = {
        questions: [{ key: "details", title: "Details", prompt: "Describe?", mode: "text" }],
      };
      const outcome: AskUserOutcome = {
        outcome: "submitted",
        answers: [{ key: "details", kind: "text", text: "bq1234\nanswer", note: "context" }],
      };
      const authenticated = owner("authenticated-text");
      const { relay, detach } = relayToRoot(
        capability({
          cancel: (received) => {
            expect(received).toEqual(authenticated);
            return Promise.resolve();
          },
          ask: (received, receivedOwner) => {
            expect(received).toEqual(textRequest);
            expect(receivedOwner).toEqual(authenticated);
            return Promise.resolve(outcome);
          },
        }),
        authenticated,
      );
      for (const choices of [[], [{ value: "a", label: "A", description: "A" }]]) {
        expect(
          rejection(
            decodeQuestionnaireProxyRequest({
              tool: "ask_user",
              argumentsJson: JSON.stringify({
                questions: [{ ...textRequest.questions[0], choices }],
              }),
            }),
          ),
        ).toBeInstanceOf(InvalidSubagentRequestError);
      }
      yield* Effect.addFinalizer(() => Effect.sync(detach));
      const answer = yield* step(() =>
        Promise.resolve<unknown>(relay.ask(textRequest, new AbortController().signal)),
      );
      expect(answer).toEqual(outcome);
    },
  );
  it("keeps questionnaire requests separate and rejects ownership injection and excess data", () => {
    const wire = { tool: "ask_user", argumentsJson: JSON.stringify(request) };
    expect(Result.getOrUndefined(decodeQuestionnaireProxyRequest(wire))).toEqual(request);
    expect(rejection(decodeSubagentProxyRequest(wire))).toBeInstanceOf(InvalidSubagentRequestError);
    const questions = Array.from({ length: 6 }, (_, index) => ({
      ...request.questions[0],
      key: `question-${index}`,
    }));
    expect(
      Result.getOrUndefined(
        decodeQuestionnaireProxyRequest({ ...wire, argumentsJson: JSON.stringify({ questions }) }),
      ),
    ).toEqual({ questions });
    for (const argumentsJson of [
      JSON.stringify({ ...request, owner: { runId: "forged" } }),
      "{",
      Fn.pipe(" ", Str.repeat(131073)),
      JSON.stringify({ questions: [...questions, questions[0]] }),
    ])
      expect(rejection(decodeQuestionnaireProxyRequest({ ...wire, argumentsJson }))).toBeInstanceOf(
        InvalidSubagentRequestError,
      );
  });

  for (const ending of [
    "answer",
    "rejection",
    "invalid",
    "replacement",
    "cleanup-rejection",
  ] as const) {
    effectTest(`joins exact root cleanup after ${ending}`, function* () {
      const events = bus();
      const questionOwner = owner("q");
      const cleanup = deferredPromise();
      const cancelled = deferredPromise();
      let generation = "g1";
      answerCapabilityQueries(events, () => ({
        version: 1,
        sessionId: "root",
        generation,
        ask: () =>
          ending === "rejection"
            ? Promise.reject(new Error("private root error"))
            : Promise.resolve(ending === "invalid" ? {} : { outcome: "cancelled", answers: [] }),
        cancel: (received: QuestionnaireOwner) => {
          expect(received).toBe(questionOwner);
          cancelled.resolve();
          return cleanup.promise.then(() => {
            if (ending === "replacement") generation = "g2";
            if (ending === "cleanup-rejection") throw new Error("private cleanup error");
            return undefined;
          });
        },
      }));
      const asking = yield* Effect.forkChild(
        Effect.result(askSessionQuestionnaire(events, "root", request, questionOwner)),
      );
      yield* step(() => cancelled.promise);
      expect(asking.pollUnsafe()).toBeUndefined();
      cleanup.resolve();
      const outcome = yield* Fiber.join(asking);
      expect(Result.isSuccess(outcome)).toBe(ending === "answer");
      if (Result.isFailure(outcome))
        expect(outcome.failure).toBeInstanceOf(InvalidSubagentRequestError);
    });
  }

  effectTest("does not cancel a rejected capability before ask admission", function* () {
    const events = bus();
    let entered = false;
    let cancelled = false;
    answerCapabilityQueries(events, () =>
      capability({
        ask: () => {
          entered = true;
          return Promise.resolve({ outcome: "cancelled", answers: [] });
        },
        cancel: () => {
          cancelled = true;
          return Promise.resolve();
        },
      }),
    );
    const outcome = yield* Effect.result(
      askSessionQuestionnaire(events, "different-session", request, owner("q")),
    );
    expect(rejection(outcome)).toBeInstanceOf(InvalidSubagentRequestError);
    expect(entered).toBe(false);
    expect(cancelled).toBe(false);
  });

  effectTest("rejects a stale root answer after capability replacement", function* () {
    const events = bus();
    let generation = "g1";
    answerCapabilityQueries(events, () =>
      capability({
        generation,
        ask: () => {
          generation = "g2";
          return Promise.resolve({ outcome: "cancelled", answers: [] });
        },
      }),
    );
    const outcome = yield* Effect.result(
      askSessionQuestionnaire(events, "root", request, owner("q")),
    );
    expect(rejection(outcome)).toBeInstanceOf(InvalidSubagentRequestError);
  });
});

describe("who a root questionnaire is asked for", () => {
  const runs = [
    { id: "agent-1", name: "Banner colour", state: "waiting_for_parent" },
    { id: "agent-2", name: "Banner colour", state: "completed" },
    { id: "agent-3", name: "reviewer", state: "running" },
    { id: "agent-4", name: "reviewer", state: "running" },
  ];
  const published = () => {
    const events = bus();
    const presented: Array<readonly [string, unknown]> = [];
    let answer: AskUserOutcome | undefined = { outcome: "cancelled", answers: [] };
    publishQuestionnaireAskers(events, {
      sessionId: () => "root",
      runs: () => runs,
      present: (runId, asked, shown) => {
        presented.push([runId, asked]);
        shown();
        return Promise.resolve(answer);
      },
    });
    return {
      presented,
      find: (askedBy: string) => queryQuestionnaireAskers(events, "root")?.find(askedBy),
      elsewhere: queryQuestionnaireAskers(events, "another-session"),
      decline: () => {
        answer = undefined;
      },
    };
  };

  it("names a run by its ID, or by a name only one waiting run carries", () => {
    const { find, elsewhere } = published();
    expect(decodeQuestionnaireAsker(find("agent-2"))?.name).toBe("Banner colour");
    expect(decodeQuestionnaireAsker(find("agent-3"))?.name).toBe("reviewer");
    // Of two namesakes, the one waiting on its parent is the one being asked for.
    expect(decodeQuestionnaireAsker(find("Banner colour"))).toBeDefined();
    expect(find("reviewer")).toBeUndefined();
    expect(find("nobody")).toBeUndefined();
    expect(elsewhere).toBeUndefined();
  });

  effectTest("shows the questions in that run's pane, without a name above them", function* () {
    const { find, presented, decline } = published();
    const asker = decodeQuestionnaireAsker(find("Banner colour"))!;
    let shown = 0;
    const ask = () =>
      step(() =>
        Promise.resolve<unknown>(
          asker.present(
            { ...request, askedBy: "Banner colour" },
            new AbortController().signal,
            () => {
              shown += 1;
            },
          ),
        ),
      );
    expect(yield* ask()).toEqual({ outcome: "cancelled", answers: [] });
    expect(presented).toEqual([["agent-1", request]]);
    expect(shown).toBe(1);
    // A pane that can't show it sends the questionnaire back to be asked in the root.
    decline();
    expect(yield* ask()).toBeUndefined();
  });
});
