import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { deferredPromise } from "pi-cosmic-core/testing";
import { describe, expect, it } from "vitest";
import {
  queryQuestionnaireRelay,
  type AskUserRequest,
  type AskUserOutcome,
  type QuestionnaireCapability,
  type QuestionnaireOwner,
} from "pi-ask-user/protocol";
import {
  askParentQuestionnaire,
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
import { rejection } from "./support/result.ts";

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
      return Effect.runPromise(askParentQuestionnaire(root, "root", decoded.success, asker), {
        signal,
      });
    },
  );
  return { child, detach, relay: queryQuestionnaireRelay(child, "child")! };
};

describe("structured questionnaire proxy boundary", () => {
  it("round-trips text questions and notes through the authenticated root and rejects text with choices", () => {
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
    return relay
      .ask(textRequest, new AbortController().signal)
      .then((answer) => {
        expect(answer).toEqual(outcome);
        return undefined;
      })
      .finally(detach);
  });
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
      " ".repeat(131073),
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
    it(`joins exact root cleanup after ${ending}`, () => {
      const events = bus();
      const questionOwner = owner("q");
      const cleanup = deferredPromise();
      const cancelled = deferredPromise();
      let finished = false;
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
      const result = Effect.runPromise(
        Effect.result(askParentQuestionnaire(events, "root", request, questionOwner)),
      ).then((value) => {
        finished = true;
        return value;
      });
      return cancelled.promise
        .then(() => {
          expect(finished).toBe(false);
          cleanup.resolve();
          return result;
        })
        .then((outcome) => {
          expect(outcome._tag).toBe(ending === "answer" ? "Success" : "Failure");
          if (Result.isFailure(outcome))
            expect(outcome.failure).toBeInstanceOf(InvalidSubagentRequestError);
          return undefined;
        });
    });
  }

  it("does not cancel a rejected capability before ask admission", () => {
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
    return expect(
      Effect.runPromise(askParentQuestionnaire(events, "different-session", request, owner("q"))),
    )
      .rejects.toBeInstanceOf(InvalidSubagentRequestError)
      .then(() => {
        expect(entered).toBe(false);
        expect(cancelled).toBe(false);
        return undefined;
      });
  });

  it("rejects a stale root answer after capability replacement", () => {
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
    const result = Effect.runPromise(askParentQuestionnaire(events, "root", request, owner("q")));
    return expect(result).rejects.toBeInstanceOf(InvalidSubagentRequestError);
  });
});
