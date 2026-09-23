import { describe, expect, it } from "@effect/vitest";
import { provideBuiltLayer } from "pi-cosmic-core";
import { yieldUntil } from "pi-cosmic-core/testing";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import type { SubagentNotification } from "../../src/boundary/host-notifier.ts";
import type { SubagentProjection } from "../../src/run/model.ts";
import { SubagentService } from "../../src/run/service.ts";
import {
  contactParentFrame,
  fakeChildLayer,
  localServiceFixture,
  request,
  serviceLayer,
} from "./fixtures/service-harness.ts";

const questions = (items: ReadonlyArray<SubagentNotification>) =>
  items.filter(
    (item): item is Extract<SubagentNotification, { type: "question" }> => item.type === "question",
  );

describe("question notification ownership", () => {
  for (const ending of ["cancel", "defect", "success"] as const)
    it.effect(`hands a question to an active await on ${ending}`, () => {
      const fake = fakeChildLayer();
      const delivered: SubagentNotification[] = [];
      const layer = serviceLayer({
        notify: (notification) => void delivered.push(notification),
      }).pipe(Layer.provide(fake.layer));
      return Effect.gen(function* () {
        const service = yield* SubagentService;
        const run = yield* service.start(request({ name: `await-${ending}` }));
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const waiter = yield* service
          .withAwaitTerminalObservations([run.id], "all_finished", undefined, (observations) =>
            Effect.gen(function* () {
              expect(observations[0]?.questionReceipt).toMatchObject({
                id: run.id,
                requestId: "question-1",
              });
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              if (ending === "defect") return yield* Effect.die(new Error("render defect"));
              return observations[0]?.run;
            }),
          )
          .pipe(Effect.forkScoped);
        fake.controls[0]?.offerIpc(contactParentFrame("question-1", "question", "Proceed?"));
        yield* Deferred.await(entered);
        expect(questions(delivered)).toHaveLength(0);
        if (ending === "cancel") yield* Fiber.interrupt(waiter);
        else {
          yield* Deferred.succeed(release, undefined);
          if (ending === "defect") expect((yield* Fiber.await(waiter))._tag).toBe("Failure");
          else expect((yield* Fiber.join(waiter))?.state).toBe("waiting_for_parent");
        }
        yield* TestClock.adjust("100 millis");
        if (ending !== "success") yield* yieldUntil(() => questions(delivered).length === 1);
        expect(questions(delivered)).toHaveLength(ending === "success" ? 0 : 1);
      }).pipe(Effect.scoped, provideBuiltLayer(layer));
    });

  it.effect("keeps an unrendered question in the outbox after a bounded await result", () => {
    const fake = fakeChildLayer();
    const delivered: SubagentNotification[] = [];
    const layer = serviceLayer({
      notify: (notification) => void delivered.push(notification),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "bounded-await" }));
      let admitted = false;
      const waiter = yield* service
        .withAwaitTerminalObservations(
          [run.id],
          "all_finished",
          () => {
            admitted = true;
          },
          () => Effect.succeed("question omitted by output bound"),
          () => new Set<string>(),
        )
        .pipe(Effect.forkScoped);
      yield* yieldUntil(() => admitted);
      fake.controls[0]?.offerIpc(
        contactParentFrame("bounded-question", "question", "Full question?"),
      );
      expect(yield* Fiber.join(waiter)).toBe("question omitted by output bound");
      yield* yieldUntil(() => questions(delivered).length === 1);
      expect(questions(delivered)[0]).toMatchObject({
        id: run.id,
        requestId: "bounded-question",
        message: "Full question?",
      });
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("cancels await admission while an ancestor owns the question send", () => {
    const { fake, layer } = localServiceFixture();
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const parent = yield* service.start(request({ name: "parent" }));
      const child = yield* service.startSessionOwnedFrom(parent.id, request({ name: "child" }));
      const releaseSend = yield* Deferred.make<void>();
      fake.controls[0]!.gateNextIpcType("proxy_notification", releaseSend);
      fake.controls[1]!.offerIpc(contactParentFrame("blocked-send", "question", "Reply?"));
      yield* yieldUntil(() =>
        fake.controls[0]!.ipc.some((message) => message.type === "proxy_notification"),
      );
      let enteredUse = false;
      const waiter = yield* service
        .withAwaitTerminalObservations([child.id], "all_finished", undefined, () =>
          Effect.sync(() => {
            enteredUse = true;
          }),
        )
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      let cancelled = false;
      const cancelling = yield* Fiber.interrupt(waiter).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            cancelled = true;
          }),
        ),
        Effect.forkScoped,
      );
      yield* Effect.gen(function* () {
        for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
        expect(cancelled).toBe(true);
        expect(enteredUse).toBe(false);
      }).pipe(Effect.ensuring(Deferred.succeed(releaseSend, undefined)));
      yield* Fiber.join(cancelling);
      expect(
        fake.controls[0]!.ipc.filter((message) => message.type === "proxy_notification"),
      ).toHaveLength(1);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("does not acknowledge a replacement question with the previous await receipt", () => {
    const fake = fakeChildLayer();
    const delivered: SubagentNotification[] = [];
    const projections: SubagentProjection[] = [];
    const layer = serviceLayer({
      notify: (notification) => void delivered.push(notification),
      publish: (projection) => void projections.push(projection),
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "replacement-question" }));
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const waiter = yield* service
        .withAwaitTerminalObservations([run.id], "all_finished", undefined, (observations) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(observations),
          ),
        )
        .pipe(Effect.forkScoped);
      fake.controls[0]?.offerIpc(contactParentFrame("old", "question", "Old question?"));
      yield* Deferred.await(entered);
      fake.controls[0]?.offerIpc({
        channel: "pi-subagents",
        type: "contact_cancel",
        requestId: "old",
      });
      yield* yieldUntil(
        () =>
          projections
            .at(-1)
            ?.runs.some((view) => view.id === run.id && view.state === "running") === true,
      );
      const beforeReplacement = projections.length;
      // Deliberately reuse the request ID: only the notification generation differs.
      fake.controls[0]?.offerIpc(contactParentFrame("old", "question", "New question?"));
      yield* yieldUntil(
        () =>
          projections.length > beforeReplacement &&
          projections
            .at(-1)
            ?.runs.some((view) => view.id === run.id && view.state === "waiting_for_parent") ===
            true,
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(waiter);
      yield* yieldUntil(() => questions(delivered).length === 1);
      expect(
        questions(delivered).map((item) => [item.requestId, item.generation, item.message]),
      ).toEqual([["old", 2, "New question?"]]);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("retries an accept-then-throw without losing the exact question", () => {
    const fake = fakeChildLayer();
    const delivered: SubagentNotification[] = [];
    let attempts = 0;
    const layer = serviceLayer({
      notify: (notification) => {
        if (notification.type !== "question") return undefined;
        attempts += 1;
        delivered.push(notification);
        if (attempts === 1) throw new Error("accepted, but acknowledgement lost");
        return { actionAccepted: true };
      },
    }).pipe(Layer.provide(fake.layer));
    return Effect.gen(function* () {
      const service = yield* SubagentService;
      const run = yield* service.start(request({ name: "uncertain-ack" }));
      fake.controls[0]?.offerIpc(contactParentFrame("retry", "question", "Try again?"));
      yield* yieldUntil(() => attempts === 1);
      yield* TestClock.adjust("200 millis");
      yield* yieldUntil(() => attempts === 2);
      expect(
        questions(delivered).map((item) => [item.id, item.generation, item.requestId]),
      ).toEqual([
        [run.id, 1, "retry"],
        [run.id, 1, "retry"],
      ]);
      yield* TestClock.adjust("30 seconds");
      expect(attempts).toBe(2);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });
});
