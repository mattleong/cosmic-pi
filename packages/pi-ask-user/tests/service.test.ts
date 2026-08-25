import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { HostDialogs } from "../src/boundary/host-dialogs.ts";
import type { AskUserOutcome } from "../src/questionnaire/model.ts";
import type { AskUserRequest } from "../src/questionnaire/schema.ts";
import { AskUserService } from "../src/questionnaire/service.ts";

const request: AskUserRequest = {
  questions: [
    {
      key: "choice",
      title: "Choice",
      prompt: "Choose.",
      mode: "single",
      choices: [
        { value: "a", label: "A", description: "Choose A." },
        { value: "b", label: "B", description: "Choose B." },
      ],
    },
  ],
};

const outcome: AskUserOutcome = { outcome: "submitted", answers: [] };

it.effect("serializes host asks and removes an interrupted queued caller", () =>
  Effect.gen(function* () {
    const firstEntered = yield* Deferred.make<void>();
    const laterEntered = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    let calls = 0;

    const hostLayer = Layer.succeed(HostDialogs, {
      ask: () =>
        Effect.gen(function* () {
          calls += 1;
          yield* Deferred.succeed(calls === 1 ? firstEntered : laterEntered, undefined);
          if (calls === 1) yield* Deferred.await(releaseFirst);
          return outcome;
        }),
    });
    const serviceContext = yield* Layer.build(AskUserService.layer.pipe(Layer.provide(hostLayer)));
    const service = Context.get(serviceContext, AskUserService);

    const first = yield* service.ask(request).pipe(Effect.forkScoped({ startImmediately: true }));
    yield* Deferred.await(firstEntered);

    const queued = yield* service.ask(request).pipe(Effect.forkScoped({ startImmediately: true }));
    yield* Effect.yieldNow;
    expect(calls).toBe(1);
    yield* Fiber.interrupt(queued);

    const later = yield* service.ask(request).pipe(Effect.forkScoped({ startImmediately: true }));
    yield* Deferred.succeed(releaseFirst, undefined);
    yield* Deferred.await(laterEntered);
    yield* Fiber.join(first);
    yield* Fiber.join(later);

    expect(calls).toBe(2);
  }).pipe(Effect.scoped),
);
