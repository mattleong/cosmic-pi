import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import { deferredPromise } from "pi-cosmic-core/testing";
import { describe, expect, it } from "vitest";
import {
  decodeQuestionnaireAsker,
  queryQuestionnaireAskers,
  type AskUserOutcome,
  type QuestionnaireCapability,
  type QuestionnaireOwner,
} from "pi-ask-user/protocol";
import {
  askSessionQuestionnaire,
  publishQuestionnaireAskers,
} from "../src/boundary/host-ask-user.ts";
import { decodeSubagentProxyRequest } from "../src/tools/proxy-protocol.ts";
import { InvalidSubagentRequestError } from "../src/run/errors.ts";
import {
  answerCapabilityQueries,
  eventBus as bus,
  pickQuestionnaire as request,
} from "./support/questionnaire.ts";
import { effectTest, step } from "./support/effect-test.ts";
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

describe("a session's own questionnaire, asked on an owner's behalf", () => {
  it("is not something a child's coordinator proxy can reach", () => {
    const wire = { tool: "ask_user", argumentsJson: JSON.stringify(request) };
    expect(rejection(decodeSubagentProxyRequest(wire))).toBeInstanceOf(InvalidSubagentRequestError);
  });

  for (const ending of [
    "answer",
    "rejection",
    "invalid",
    "replacement",
    "cleanup-rejection",
  ] as const) {
    effectTest(`joins the session's exact cleanup after ${ending}`, function* () {
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

  effectTest("rejects a stale answer after the session's capability is replaced", function* () {
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
