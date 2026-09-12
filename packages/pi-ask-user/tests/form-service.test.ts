import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { AskUserService, type AskUserHost } from "../src/questionnaire/service.ts";
import type { AskUserOutcome, FormOutcome } from "../src/protocol.ts";
import { defaultQuestion } from "./support/questionnaire.ts";
import { ActivitySnapshotSchema, type ActivityProviderOptions } from "pi-cosmic-ui/activity";
import * as Schema from "effect/Schema";
import { makeQuestionnaireActivity } from "../src/boundary/host-activity.ts";
import { makeAskUserDialogBridge } from "../src/boundary/host-ui.ts";

const owner = {
  extensionId: "pi-mcp",
  operationId: "operation",
  requestId: "request",
  label: "MCP",
};
const form = { kind: "form", message: "private", fields: [] } as const;
const ordinary = { questions: [defaultQuestion] };

it.effect(
  "shares FIFO across async, ordinary and extension forms without steering form answers",
  () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<AskUserOutcome>();
      const calls: string[] = [];
      let deliveries = 0;
      const host: AskUserHost = (_request, opened) =>
        Effect.gen(function* () {
          calls.push(opened ? "async" : "ordinary");
          if (opened) {
            yield* Deferred.succeed(opened, undefined);
            return yield* Deferred.await(release);
          }
          return { outcome: "cancelled", answers: [] } as const;
        });
      yield* Effect.gen(function* () {
        const service = yield* AskUserService;
        const async = yield* service.startAsync({
          ...ordinary,
          independentWork: "Inspect",
          blockedWork: "Choose",
        });
        const cancelled = yield* Effect.forkChild(service.askForm(form, owner), {
          startImmediately: true,
        });
        const regular = yield* Effect.forkChild(service.ask(ordinary), { startImmediately: true });
        const pending = yield* Effect.forkChild(
          service.askForm(form, { ...owner, requestId: "next" }),
          { startImmediately: true },
        );
        yield* Fiber.interrupt(cancelled);
        expect(calls).toEqual(["async"]);
        yield* service.controlAsync({ action: "cancel", requestId: async.requestId });
        yield* Fiber.join(regular);
        expect(yield* Fiber.join(pending)).toEqual({ action: "accept", content: {} });
        expect(calls).toEqual(["async", "ordinary", "form"]);
        expect(deliveries).toBe(0);
      }).pipe(
        Effect.provide(
          AskUserService.layer(
            host,
            () =>
              Effect.sync(() => {
                deliveries++;
              }),
            "test",
            undefined,
            () =>
              Effect.sync(() => {
                calls.push("form");
                return { action: "accept", content: {} } as const;
              }),
          ),
        ),
      );
    }),
);

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

it.effect(
  "attributes private forms to the extension operation without exposing messages or answers",
  () =>
    Effect.gen(function* () {
      let provider: ActivityProviderOptions | undefined;
      const activity = makeQuestionnaireActivity({
        bridge: makeAskUserDialogBridge(),
        isCurrent: () => true,
        run: (effect, signal) => Effect.runPromise(effect, { signal }),
        register: (_events, options) => {
          provider = options;
          return { publish: () => {}, dispose: () => {}, isAvailable: () => true };
        },
      });
      activity.activate({ emit: () => {}, on: () => () => {} }, "session");
      yield* activity.observer.admittedForm!(
        "form",
        {
          kind: "form",
          message: "private-payload",
          fields: [{ key: "x", type: "string", default: "private-answer" }],
        },
        Effect.void,
        owner,
      );
      expect(provider?.snapshot()[0]?.parent).toEqual({
        providerId: "pi-mcp",
        itemId: "operation",
      });
      const serialized = Schema.encodeSync(Schema.fromJsonString(ActivitySnapshotSchema))(
        provider?.snapshot() ?? [],
      );
      expect(serialized).not.toContain("private-payload");
      expect(serialized).not.toContain("private-answer");
      yield* activity.observer.settled("form", "submitted");
      expect(provider?.snapshot()[0]).toMatchObject({ status: "done", actions: [] });
      activity.dispose();
    }),
);
