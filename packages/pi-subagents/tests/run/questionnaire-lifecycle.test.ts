import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { yieldUntil } from "pi-cosmic-core/testing";
import { type AskUserRequest, type QuestionnaireOwner } from "pi-ask-user/protocol";
import { pickQuestionnaire } from "../support/questionnaire.ts";
import {
  fakeChildLayer,
  request,
  serviceLayer,
  withService,
  type FakeChildControl,
} from "./fixtures/service-harness.ts";

const askUser = (child: FakeChildControl, requestId: string) =>
  child.offerIpc({
    channel: "pi-subagents",
    type: "proxy_request",
    requestId,
    tool: "ask_user",
    argumentsJson: JSON.stringify(pickQuestionnaire),
  });

interface QuestionnaireProbe {
  owner?: QuestionnaireOwner;
  interrupted: boolean;
  cleaned: boolean;
}

const blockingQuestionnaire = (release: Deferred.Deferred<void>) => {
  const state: QuestionnaireProbe = { interrupted: false, cleaned: false };
  const handler = (_request: AskUserRequest, owner: QuestionnaireOwner) => {
    state.owner = owner;
    return Effect.never.pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => void (state.interrupted = true)).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(Effect.sync(() => void (state.cleaned = true))),
        ),
      ),
    );
  };
  return { state, handler };
};

describe("assignment-owned questionnaire proxy", () => {
  it.effect("drains an outstanding questionnaire before launch compensation releases", () =>
    Effect.gen(function* () {
      const promptGate = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const fake = fakeChildLayer(Effect.void, {
        initialSendGates: [{ spawnIndex: 0, type: "prompt", gate: promptGate }],
        initialFailures: [{ spawnIndex: 0, type: "prompt", error: "Prompt was rejected." }],
      });
      const questionnaire = blockingQuestionnaire(release);
      const layer = serviceLayer({ questionnaireHandler: questionnaire.handler }).pipe(
        Layer.provide(fake.layer),
      );
      yield* withService(layer, function* (service) {
        const starting = yield* service
          .start(request({ name: "compensated" }))
          .pipe(Effect.flip, Effect.forkScoped);
        yield* yieldUntil(() => fake.controls[0]?.sent("prompt") === true);
        const child = fake.controls[0]!;
        askUser(child, "q-start");
        yield* yieldUntil(() => questionnaire.state.owner !== undefined);
        yield* Deferred.succeed(promptGate, undefined);
        yield* yieldUntil(() => questionnaire.state.interrupted);
        for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
        const releasedBeforeCleanup = child.released();
        yield* Deferred.succeed(release, undefined);
        const failure = yield* Fiber.join(starting);
        expect(releasedBeforeCleanup).toBe(0);
        expect(failure.message).toContain("Prompt was rejected.");
        expect(questionnaire.state.cleaned).toBe(true);
        expect(child.released()).toBe(1);
      });
    }),
  );

  for (const ending of ["stop", "exit", "shutdown", "interrupt"] as const) {
    it.effect(`revokes and joins questionnaire cleanup on ${ending}`, () =>
      Effect.gen(function* () {
        const fake = fakeChildLayer();
        const release = yield* Deferred.make<void>();
        const { state, handler } = blockingQuestionnaire(release);
        let finished = false;
        const layer = serviceLayer({ questionnaireHandler: handler }).pipe(
          Layer.provide(fake.layer),
        );
        const running = yield* withService(layer, function* (service) {
          const run = yield* service.start(request({ name: "question" }));
          const child = fake.controls[0]!;
          askUser(child, "q-1");
          yield* yieldUntil(() => state.owner !== undefined);
          expect(state.owner).toMatchObject({ runId: run.id, requestId: "q-1" });
          expect(state.owner!.assignmentEpoch).toBeGreaterThan(0);
          if (ending === "stop") yield* service.stop(run.id);
          if (ending === "interrupt") {
            yield* service.interrupt(run.id);
            yield* yieldUntil(() => state.interrupted);
          }
          if (ending === "exit") {
            child.exit(1);
            yield* yieldUntil(() => child.released() > 0);
          }
        }).pipe(
          Effect.andThen(
            Effect.sync(() => {
              finished = true;
            }),
          ),
          Effect.forkChild,
        );
        yield* yieldUntil(() => state.interrupted);
        expect(state.cleaned).toBe(false);
        expect(finished).toBe(false);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(running);
        expect(state.cleaned).toBe(true);
        expect(finished).toBe(true);
      }),
    );
  }
});
