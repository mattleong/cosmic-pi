import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { AskUserService } from "../src/questionnaire/service.ts";
import type { FormOutcome } from "../src/protocol.ts";
import { defaultQuestion, emptyForm as form, formOwner as owner } from "./support/questionnaire.ts";
import { ActivitySnapshotSchema } from "pi-cosmic-ui/activity";
import * as Schema from "effect/Schema";
import { makeActivityFixture } from "./support/activity.ts";

const ordinary = { questions: [defaultQuestion] };

it.effect("keeps the shared permit until active form cleanup completes", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const cleaning = yield* Deferred.make<void>();
    const finishCleanup = yield* Deferred.make<void>();
    let ordinaryOpened = false;
    yield* Effect.gen(function* () {
      const service = yield* AskUserService;
      const first = yield* Effect.forkChild(service.askForm(form, owner), {
        startImmediately: true,
      });
      yield* Deferred.await(entered);
      const second = yield* Effect.forkChild(service.ask(ordinary), { startImmediately: true });
      const stopping = yield* Effect.forkChild(Fiber.interrupt(first), { startImmediately: true });
      yield* Deferred.await(cleaning);
      expect(ordinaryOpened).toBe(false);
      yield* Deferred.succeed(finishCleanup, undefined);
      yield* Fiber.join(stopping);
      yield* Fiber.join(second);
      expect(ordinaryOpened).toBe(true);
    }).pipe(
      Effect.provide(
        AskUserService.layer(
          () =>
            Effect.sync(() => {
              ordinaryOpened = true;
              return { outcome: "cancelled", answers: [] } as const;
            }),
          undefined,
          "test",
          undefined,
          () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Deferred.succeed(cleaning, undefined).pipe(
                  Effect.andThen(Deferred.await(finishCleanup)),
                ),
              ),
            ),
        ),
      ),
    );
  }),
);

it.effect("validates host answers and bounds forms within the existing 16 pending tickets", () =>
  Effect.gen(function* () {
    const release = yield* Deferred.make<FormOutcome>();
    yield* Effect.gen(function* () {
      const service = yield* AskUserService;
      const fibers = [];
      for (let i = 0; i < 16; i++)
        fibers.push(
          yield* Effect.forkChild(service.askForm(form, { ...owner, requestId: String(i) }), {
            startImmediately: true,
          }),
        );
      expect(yield* Effect.flip(service.ask(ordinary))).toMatchObject({ reason: "busy" });
      yield* Deferred.succeed(release, { action: "accept", content: { unexpected: true } });
      for (const fiber of fibers) expect((yield* Fiber.await(fiber))._tag).toBe("Failure");
    }).pipe(
      Effect.provide(
        AskUserService.layer(
          () => Effect.succeed({ outcome: "cancelled", answers: [] }),
          undefined,
          "test",
          undefined,
          () => Deferred.await(release),
        ),
      ),
    );
  }),
);

it.effect("settles invalid form answers as failed Activity rows with separate form ids", () =>
  Effect.gen(function* () {
    const settled: string[] = [];
    const answers: FormOutcome[] = [
      { action: "accept", content: { unexpected: true } },
      { action: "accept", content: {} },
    ];
    yield* Effect.gen(function* () {
      const service = yield* AskUserService;
      yield* service.ask(ordinary);
      expect(yield* Effect.flip(service.askForm(form, owner))).toMatchObject({
        _tag: "AskUserValidationError",
      });
      expect(yield* service.askForm(form, owner)).toEqual({ action: "accept", content: {} });
    }).pipe(
      Effect.provide(
        AskUserService.layer(
          () => Effect.succeed({ outcome: "cancelled", answers: [] }),
          undefined,
          "test",
          {
            admitted: () => Effect.void,
            presenting: () => Effect.void,
            settled: (id, outcome) => Effect.sync(() => settled.push(`${id}:${outcome}`)),
            removed: () => Effect.void,
          },
          () => Effect.sync(() => answers.shift()!),
        ),
      ),
    );
    expect(settled).toEqual([
      "test-blocking-1:cancelled",
      "test-form-1:failed",
      "test-form-2:submitted",
    ]);
  }),
);

it.effect(
  "attributes private forms to the extension operation without exposing messages or answers",
  () =>
    Effect.gen(function* () {
      const { activity, provider } = makeActivityFixture();
      yield* activity.observer.admitted(
        "form",
        {
          kind: "form",
          message: "private-payload",
          fields: [{ key: "x", type: "string", default: "private-answer" }],
        },
        Effect.void,
        owner,
      );
      expect(provider.snapshot()[0]?.parent).toEqual({
        providerId: "pi-mcp",
        itemId: "operation",
      });
      const serialized = Schema.encodeSync(Schema.fromJsonString(ActivitySnapshotSchema))(
        provider.snapshot(),
      );
      expect(serialized).not.toContain("private-payload");
      expect(serialized).not.toContain("private-answer");
      yield* activity.observer.settled("form", "submitted");
      expect(provider.snapshot()[0]).toMatchObject({ status: "done", actions: [] });
      activity.dispose();
    }),
);
