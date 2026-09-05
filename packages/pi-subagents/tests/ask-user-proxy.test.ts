import { EventEmitter } from "node:events";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
  QUESTIONNAIRE_CAPABILITY_QUERY,
  queryQuestionnaireRelay,
  type AskUserRequest,
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
const promiseGate = <A>() =>
  // SAFETY: Supported Node versions implement withResolvers; ES2023 libs omit it.
  (
    Promise as PromiseConstructor & {
      withResolvers<Value>(): { promise: Promise<Value>; resolve: (value: Value) => void };
    }
  ).withResolvers<A>();

const request: AskUserRequest = {
  questions: [
    {
      key: "pick",
      title: "Pick",
      prompt: "Which?",
      mode: "single",
      choices: [
        { value: "a", label: "A", description: "First" },
        { value: "b", label: "B", description: "Second" },
      ],
    },
  ],
};
const bus = () => {
  const emitter = new EventEmitter();
  return {
    on: (name: string, handler: (event: any) => void) => {
      emitter.on(name, handler);
      return () => {
        emitter.off(name, handler);
      };
    },
    emit: (name: string, event: any) => {
      emitter.emit(name, event);
    },
  };
};

describe("structured questionnaire proxy boundary", () => {
  it("keeps questionnaire requests separate and rejects ownership injection and excess data", () => {
    const wire = { tool: "ask_user", argumentsJson: JSON.stringify(request) };
    expect(decodeQuestionnaireProxyRequest(wire)).toEqual(request);
    expect(decodeSubagentProxyRequest(wire)).toBeInstanceOf(InvalidSubagentRequestError);
    for (const argumentsJson of [
      JSON.stringify({ ...request, owner: { runId: "forged" } }),
      "{",
      " ".repeat(131073),
      JSON.stringify({ questions: Array(5).fill(request.questions[0]) }),
    ])
      expect(decodeQuestionnaireProxyRequest({ ...wire, argumentsJson })).toBeInstanceOf(
        InvalidSubagentRequestError,
      );
  });

  it("preserves deliberate cancellation through root capability and child relay", () => {
    const root = bus();
    const child = bus();
    const owner = {
      runId: "authenticated-run",
      assignmentEpoch: 3,
      requestId: "authenticated-request",
    };
    let receivedOwner: QuestionnaireOwner | undefined;
    const capability: QuestionnaireCapability = {
      version: 1,
      sessionId: "root",
      generation: "g1",
      cancel: () => Promise.resolve(),
      ask: (_request, authenticatedOwner) => {
        receivedOwner = authenticatedOwner;
        return Promise.resolve({ outcome: "cancelled", answers: [] });
      },
    };
    root.on(QUESTIONNAIRE_CAPABILITY_QUERY, (query) => query.respond(capability));
    const detach = publishChildQuestionnaireRelay(
      child,
      "child",
      () => true,
      (_wire, signal) =>
        Effect.runPromise(askParentQuestionnaire(root, "root", request, owner), { signal }),
    );
    const relay = queryQuestionnaireRelay(child, "child")!;
    return relay.ask(request, new AbortController().signal).then((outcome) => {
      expect(outcome).toEqual({ outcome: "cancelled", answers: [] });
      expect(receivedOwner).toEqual(owner);
      detach();
      expect(queryQuestionnaireRelay(child, "child")).toBeUndefined();
    });
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
      const owner = { runId: "run", assignmentEpoch: 1, requestId: "q" };
      const cleanup = promiseGate<void>();
      const cancelled = promiseGate<void>();
      let finished = false;
      let generation = "g1";
      events.on(QUESTIONNAIRE_CAPABILITY_QUERY, (query) =>
        query.respond({
          version: 1,
          sessionId: "root",
          generation,
          ask: () =>
            ending === "rejection"
              ? Promise.reject(new Error("private root error"))
              : Promise.resolve(ending === "invalid" ? {} : { outcome: "cancelled", answers: [] }),
          cancel: (received: QuestionnaireOwner) => {
            expect(received).toBe(owner);
            cancelled.resolve(undefined);
            return cleanup.promise.then(() => {
              if (ending === "replacement") generation = "g2";
              if (ending === "cleanup-rejection") throw new Error("private cleanup error");
            });
          },
        }),
      );
      const result = Effect.runPromise(
        Effect.result(askParentQuestionnaire(events, "root", request, owner)),
      ).then((value) => {
        finished = true;
        return value;
      });
      return cancelled.promise
        .then(() => {
          expect(finished).toBe(false);
          cleanup.resolve(undefined);
          return result;
        })
        .then((outcome) => {
          expect(outcome._tag).toBe(ending === "answer" ? "Success" : "Failure");
          if (outcome._tag === "Failure")
            expect(outcome.failure).toBeInstanceOf(InvalidSubagentRequestError);
        });
    });
  }

  it("does not cancel a rejected capability before ask admission", () => {
    const events = bus();
    let entered = false;
    let cancelled = false;
    events.on(QUESTIONNAIRE_CAPABILITY_QUERY, (query) =>
      query.respond({
        version: 1,
        sessionId: "root",
        generation: "g1",
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
      Effect.runPromise(
        askParentQuestionnaire(events, "different-session", request, {
          runId: "run",
          assignmentEpoch: 1,
          requestId: "q",
        }),
      ),
    )
      .rejects.toBeInstanceOf(InvalidSubagentRequestError)
      .then(() => {
        expect(entered).toBe(false);
        expect(cancelled).toBe(false);
      });
  });

  it("rejects a stale root answer after capability replacement", () => {
    const events = bus();
    let generation = "g1";
    events.on(QUESTIONNAIRE_CAPABILITY_QUERY, (query) =>
      query.respond({
        version: 1,
        sessionId: "root",
        generation,
        cancel: () => Promise.resolve(),
        ask: () => {
          generation = "g2";
          return Promise.resolve({ outcome: "cancelled", answers: [] });
        },
      }),
    );
    const result = Effect.runPromise(
      askParentQuestionnaire(events, "root", request, {
        runId: "run",
        assignmentEpoch: 1,
        requestId: "q",
      }),
    );
    return expect(result).rejects.toBeInstanceOf(InvalidSubagentRequestError);
  });
});
