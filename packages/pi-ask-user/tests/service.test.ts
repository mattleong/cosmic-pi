import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { HostDialogs } from "../src/boundary/host-dialogs.ts";
import type { AskUserOutcome } from "../src/questionnaire/model.ts";
import type { AskUserRequest } from "../src/questionnaire/schema.ts";
import { AskUserService } from "../src/questionnaire/service.ts";

const provideLayer = Effect.provide;

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

const invalidRequest: AskUserRequest = {
  questions: [
    {
      ...request.questions[0]!,
      title: " \t ",
      choices: request.questions[0]!.choices.map((choice) => ({ ...choice })),
    },
  ],
};

const outcome: AskUserOutcome = { outcome: "submitted", answers: [] };

it.effect("rejects an invalid ask while a valid host dialog holds the permit", () =>
  Effect.gen(function* () {
    const firstEntered = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    let calls = 0;

    const hostLayer = Layer.succeed(HostDialogs, {
      ask: () =>
        Effect.gen(function* () {
          calls += 1;
          yield* Deferred.succeed(firstEntered, undefined);
          yield* Deferred.await(releaseFirst);
          return outcome;
        }),
    });
    const serviceLayer = AskUserService.layer.pipe(Layer.provide(hostLayer));

    const program = AskUserService.use((service) =>
      Effect.gen(function* () {
        const first = yield* service
          .ask(request)
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(firstEntered);

        const invalidSettled = yield* Deferred.make<void>();
        const invalid = yield* service.ask(invalidRequest).pipe(
          Effect.flip,
          Effect.tap(() => Deferred.succeed(invalidSettled, undefined)),
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* Effect.yieldNow;

        expect(yield* Deferred.isDone(invalidSettled)).toBe(true);
        expect((yield* Fiber.join(invalid))._tag).toBe("AskUserValidationError");
        expect(calls).toBe(1);

        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Fiber.join(first);
      }),
    );
    yield* provideLayer(program, serviceLayer, { local: true });
  }).pipe(Effect.scoped),
);

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
    const serviceLayer = AskUserService.layer.pipe(Layer.provide(hostLayer));

    const program = AskUserService.use((service) =>
      Effect.gen(function* () {
        const first = yield* service
          .ask(request)
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(firstEntered);

        const queued = yield* service
          .ask(request)
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(calls).toBe(1);
        yield* Fiber.interrupt(queued);

        const later = yield* service
          .ask(request)
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(laterEntered);
        yield* Fiber.join(first);
        yield* Fiber.join(later);

        expect(calls).toBe(2);
      }),
    );
    // One provided service instance must own the semaphore for all three calls.
    yield* provideLayer(program, serviceLayer, { local: true });
  }).pipe(Effect.scoped),
);
