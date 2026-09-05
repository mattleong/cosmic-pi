import { EventEmitter } from "node:events";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { provideBuiltLayer } from "pi-cosmic-core";
import { yieldUntil } from "pi-cosmic-core/testing";
import {
  QUESTIONNAIRE_CAPABILITY_QUERY,
  type AskUserOutcome,
  type QuestionnaireCapability,
  type QuestionnaireOwner,
} from "pi-ask-user/protocol";
import { askParentQuestionnaire } from "../../src/boundary/host-ask-user.ts";
import { SubagentService } from "../../src/run/service.ts";
import { fakeChildLayer, request, serviceLayer } from "./fixtures/service-harness.ts";

const promiseGate = <A>() =>
  // SAFETY: Supported Node versions implement withResolvers; ES2023 libs omit it.
  (
    Promise as PromiseConstructor & {
      withResolvers<Value>(): { promise: Promise<Value>; resolve: (value: Value) => void };
    }
  ).withResolvers<A>();

const argumentsJson = JSON.stringify({
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
});

describe("assignment-owned questionnaire proxy", () => {
  it.effect("does not reopen a settled request identity within an assignment", () =>
    Effect.gen(function* () {
      const fake = fakeChildLayer();
      let presentations = 0;
      const layer = serviceLayer({
        questionnaireHandler: () =>
          Effect.sync(() => {
            presentations += 1;
            return {
              content: [{ type: "text" as const, text: "cancelled" }],
              details: { outcome: "cancelled", answers: [] },
            };
          }),
      }).pipe(Layer.provide(fake.layer));
      yield* Effect.gen(function* () {
        const service = yield* SubagentService;
        yield* service.start(request({ name: "replay" }));
        const child = fake.controls[0]!;
        const send = () =>
          child.offerIpc({
            channel: "pi-subagents",
            type: "proxy_request",
            requestId: "same",
            tool: "ask_user",
            argumentsJson,
          });
        send();
        yield* yieldUntil(() =>
          child.ipc.some((message) => message.type === "proxy_response" && message.ok),
        );
        send();
        yield* yieldUntil(() =>
          child.ipc.some((message) => message.type === "proxy_response" && !message.ok),
        );
        expect(presentations).toBe(1);
      }).pipe(Effect.scoped, provideBuiltLayer(layer));
    }),
  );
  for (const ending of ["stop", "shutdown"] as const) {
    it.effect(`joins root editor cleanup on ${ending} after proxy cancellation`, () =>
      Effect.gen(function* () {
        const fake = fakeChildLayer();
        const emitter = new EventEmitter();
        const events = {
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
        const editorCleanup = promiseGate<void>();
        let owner: QuestionnaireOwner | undefined;
        let aborted = false;
        let cancelling = false;
        let cleaned = false;
        let endingStarted = false;
        let stopped = false;
        let finished = false;
        const capability: QuestionnaireCapability = {
          version: 1,
          sessionId: "root",
          generation: "g1",
          ask: (_request, authenticatedOwner, signal) => {
            owner = authenticatedOwner;
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
              },
              { once: true },
            );
            // The user never answers. Only the explicit owned cleanup acknowledgement
            // may retain the relay after interruption, not this foreign Promise.
            return promiseGate<AskUserOutcome>().promise;
          },
          cancel: (authenticatedOwner) => {
            expect(authenticatedOwner).toBe(owner);
            cancelling = true;
            return editorCleanup.promise.then(() => {
              cleaned = true;
            });
          },
        };
        emitter.on(QUESTIONNAIRE_CAPABILITY_QUERY, (query) => query.respond(capability));
        const layer = serviceLayer({
          questionnaireHandler: (input, authenticatedOwner) =>
            askParentQuestionnaire(events, "root", input, authenticatedOwner),
        }).pipe(Layer.provide(fake.layer));
        const running = yield* Effect.gen(function* () {
          const service = yield* SubagentService;
          const run = yield* service.start(request({ name: "root-editor" }));
          const child = fake.controls[0]!;
          child.offerIpc({
            channel: "pi-subagents",
            type: "proxy_request",
            requestId: "q-editor",
            tool: "ask_user",
            argumentsJson,
          });
          yield* yieldUntil(() => owner !== undefined);
          child.offerIpc({ channel: "pi-subagents", type: "proxy_cancel", requestId: "q-editor" });
          yield* yieldUntil(() => aborted);
          endingStarted = true;
          if (ending === "stop") {
            yield* service.stop(run.id);
            stopped = true;
          }
        }).pipe(
          Effect.scoped,
          provideBuiltLayer(layer),
          Effect.andThen(
            Effect.sync(() => {
              finished = true;
            }),
          ),
          Effect.forkChild,
        );
        yield* yieldUntil(() => endingStarted && cancelling);
        expect(aborted).toBe(true);
        expect(cleaned).toBe(false);
        expect(stopped).toBe(false);
        expect(finished).toBe(false);
        expect(fake.controls[0]!.released()).toBe(0);
        editorCleanup.resolve(undefined);
        yield* Fiber.join(running);
        expect(cleaned).toBe(true);
        expect(finished).toBe(true);
        expect(stopped).toBe(ending === "stop");
        expect(
          fake.controls[0]!.ipc.some(
            (message) => message.type === "proxy_response" && message.requestId === "q-editor",
          ),
        ).toBe(false);
      }),
    );
  }

  for (const ending of ["stop", "exit", "shutdown", "interrupt"] as const) {
    it.effect(`revokes and joins questionnaire cleanup on ${ending}`, () =>
      Effect.gen(function* () {
        const fake = fakeChildLayer();
        const release = yield* Deferred.make<void>();
        let owner: QuestionnaireOwner | undefined;
        let interrupted = false;
        let cleaned = false;
        let finished = false;
        const layer = serviceLayer({
          questionnaireHandler: (_request, authenticatedOwner) => {
            owner = authenticatedOwner;
            return Effect.never.pipe(
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  interrupted = true;
                }).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(
                    Effect.sync(() => {
                      cleaned = true;
                    }),
                  ),
                ),
              ),
            );
          },
        }).pipe(Layer.provide(fake.layer));
        const running = yield* Effect.gen(function* () {
          const service = yield* SubagentService;
          const run = yield* service.start(request({ name: "question" }));
          const child = fake.controls[0]!;
          child.offerIpc({
            channel: "pi-subagents",
            type: "proxy_request",
            requestId: "q-1",
            tool: "ask_user",
            argumentsJson,
          });
          yield* yieldUntil(() => owner !== undefined);
          expect(owner).toMatchObject({ runId: run.id, requestId: "q-1" });
          expect(owner!.assignmentEpoch).toBeGreaterThan(0);
          if (ending === "stop") yield* service.stop(run.id);
          if (ending === "interrupt") {
            yield* service.interrupt(run.id);
            yield* yieldUntil(() => interrupted);
          }
          if (ending === "exit") {
            child.exit(1);
            yield* yieldUntil(() => child.released() > 0);
          }
        }).pipe(
          Effect.scoped,
          provideBuiltLayer(layer),
          Effect.andThen(
            Effect.sync(() => {
              finished = true;
            }),
          ),
          Effect.forkChild,
        );
        yield* yieldUntil(() => interrupted);
        expect(cleaned).toBe(false);
        expect(finished).toBe(false);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(running);
        expect(cleaned).toBe(true);
        expect(finished).toBe(true);
      }),
    );
  }
});
