import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { yieldUntil } from "pi-cosmic-core/testing";
import type { SubagentServiceContract } from "../../src/run/service.ts";
import {
  acknowledgeCompletions,
  fakeChildLayer,
  localServiceFixture,
  request,
  waitForCompleted,
  withService,
} from "./fixtures/service-harness.ts";

const policy = (maxDirectChildren: number, maxDepth: number) => ({
  maxDirectChildren,
  maxDepth,
});

const withFixture = <Eff extends Effect.Effect<any, any, any>, A>(
  body: (
    service: SubagentServiceContract,
    fake: ReturnType<typeof fakeChildLayer>,
  ) => Generator<Eff, A, never>,
) => {
  const { fake, layer } = localServiceFixture();
  return withService(layer, (service) => body(service, fake));
};

describe("root-owned subagent run tree", () => {
  it.effect("enforces direct-child capacity per parent with atomic race reservations", () =>
    withFixture(function* (service) {
      const parentA = yield* service.start(
        request({ name: "parent-a", nestingPolicy: policy(12, 3) }),
      );
      const parentB = yield* service.start(
        request({ name: "parent-b", nestingPolicy: policy(12, 3) }),
      );
      const outcomes = yield* Effect.forEach(
        ["race-a", "race-b"],
        (name) =>
          service
            .startSessionOwnedFrom(parentA.id, request({ name, nestingPolicy: policy(1, 3) }))
            .pipe(Effect.exit),
        { concurrency: 2 },
      );
      expect(outcomes.filter(Exit.isSuccess)).toHaveLength(1);
      expect(outcomes.filter(Exit.isFailure)).toHaveLength(1);

      const sibling = yield* service.startSessionOwnedFrom(
        parentB.id,
        request({ name: "sibling-capacity", nestingPolicy: policy(1, 3) }),
      );
      expect(sibling.parentRunId).toBe(parentB.id);
      expect(sibling.depth).toBe(2);
    }),
  );

  it.effect("enforces depth and subtree authorization without exposing siblings", () =>
    withFixture(function* (service) {
      const parent = yield* service.start(
        request({ name: "parent", nestingPolicy: policy(12, 2) }),
      );
      const child = yield* service.startSessionOwnedFrom(
        parent.id,
        request({ name: "child", nestingPolicy: policy(12, 2) }),
      );
      const blocked = yield* service
        .startSessionOwnedFrom(
          child.id,
          request({ name: "too-deep", nestingPolicy: policy(12, 2) }),
        )
        .pipe(Effect.flip);
      expect(blocked).toMatchObject({
        _tag: "InvalidSubagentRequestError",
        code: "nesting_depth_limit",
      });

      const sibling = yield* service.start(
        request({ name: "sibling", nestingPolicy: policy(12, 2) }),
      );
      expect(yield* service.status(parent.id)).toMatchObject({
        directChildCount: 1,
        descendantCount: 1,
      });
      expect(yield* service.visibleList(parent.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: parent.id }),
          expect.objectContaining({ id: child.id }),
        ]),
      );
      expect(
        yield* service.authorizeTargets(parent.id, [sibling.id]).pipe(Effect.flip),
      ).toMatchObject({ _tag: "SubagentNotFoundError", id: sibling.id });
    }),
  );

  it.effect("keeps descendants running after natural parent completion", () =>
    withFixture(function* (service, fake) {
      const parent = yield* service.start(request({ name: "parent" }));
      const child = yield* service.startSessionOwnedFrom(parent.id, request({ name: "child" }));
      fake.controls[0]?.offer({ type: "agent_end", willRetry: false });
      fake.controls[0]?.settle();
      yield* yieldUntil(() => fake.controls[0]?.released() === 1, 200);
      expect(yield* service.status(parent.id)).toMatchObject({
        state: "completed",
        directChildCount: 1,
        descendantCount: 1,
      });
      expect(yield* service.status(child.id)).toMatchObject({ state: "running" });
    }),
  );

  it.effect("delivers outcomes to the nearest connected Pi ancestor before root fallback", () => {
    const { fake, notifications, layer } = localServiceFixture({ notify: acknowledgeCompletions });
    return withService(layer, function* (service) {
      const parent = yield* service.start(request({ name: "parent" }));
      const child = yield* service.startSessionOwnedFrom(parent.id, request({ name: "child" }));
      fake.controls[1]?.offer({ type: "agent_end", willRetry: false });
      fake.controls[1]?.settle();
      yield* waitForCompleted(service, child.id);
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => fake.controls[0]?.sentIpc("proxy_notification") === true, 200);
      expect(notifications).toEqual([]);

      const fallback = yield* service.startSessionOwnedFrom(
        parent.id,
        request({ name: "fallback-child" }),
      );
      fake.controls[0]?.offer({ type: "agent_end", willRetry: false });
      fake.controls[0]?.settle();
      yield* yieldUntil(() => fake.controls[0]?.released() === 1, 200);
      fake.controls[2]?.offer({ type: "agent_end", willRetry: false });
      fake.controls[2]?.settle();
      yield* waitForCompleted(service, fallback.id);
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(
        () =>
          notifications.some(
            (notification) =>
              notification.type === "completed" &&
              notification.runs.some((run) => run.id === fallback.id),
          ),
        200,
      );
      expect(child.parentRunId).toBe(parent.id);
    });
  });

  it.effect("does not duplicate an outcome after notification acknowledgment uncertainty", () => {
    const { fake, notifications, layer } = localServiceFixture({ notify: acknowledgeCompletions });
    return withService(layer, function* (service) {
      const parent = yield* service.start(request({ name: "uncertain-parent" }));
      const child = yield* service.startSessionOwnedFrom(
        parent.id,
        request({ name: "uncertain-child" }),
      );
      const deliveryGate = yield* Deferred.make<void>();
      fake.controls[0]?.gateNextIpcType("proxy_notification", deliveryGate);
      fake.controls[1]?.settle();
      yield* waitForCompleted(service, child.id);
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(
        () =>
          fake.controls[0]?.sentIpc("proxy_notification", (notice) =>
            notice.message.includes(child.id),
          ) === true,
      );

      yield* TestClock.adjust("10 seconds");
      yield* Effect.yieldNow;
      yield* TestClock.adjust("30 seconds");
      expect(notifications).toEqual([]);
      expect(
        fake.controls[0]?.ipc.filter((message) => message.type === "proxy_notification"),
      ).toHaveLength(1);
    });
  });

  it.effect(
    "drains admitted descendant notifications before pausing and skips paused ancestors",
    () => {
      const { fake, notifications, layer } = localServiceFixture({
        notify: acknowledgeCompletions,
      });
      return withService(layer, function* (service) {
        const parent = yield* service.start(request({ name: "pausing-parent" }));
        const first = yield* service.startSessionOwnedFrom(
          parent.id,
          request({ name: "first-child" }),
        );
        const second = yield* service.startSessionOwnedFrom(
          parent.id,
          request({ name: "second-child" }),
        );
        const deliveryGate = yield* Deferred.make<void>();
        fake.controls[0]?.gateNextIpcType("proxy_notification", deliveryGate);
        fake.controls[1]?.settle();
        yield* waitForCompleted(service, first.id);
        yield* TestClock.adjust("100 millis");
        yield* yieldUntil(
          () =>
            fake.controls[0]?.sentIpc("proxy_notification", (notice) =>
              notice.message.includes(first.id),
            ) === true,
        );

        const interrupting = yield* service
          .interrupt(parent.id)
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(fake.controls[0]?.sent("clear_queue")).toBe(false);

        yield* Deferred.succeed(deliveryGate, undefined);
        expect((yield* Fiber.join(interrupting)).state).toBe("paused");
        expect(fake.controls[0]?.sent("clear_queue")).toBe(true);

        fake.controls[2]?.settle();
        yield* waitForCompleted(service, second.id);
        yield* TestClock.adjust("100 millis");
        yield* yieldUntil(() =>
          notifications.some(
            (notification) =>
              notification.type === "completed" &&
              notification.runs.some((run) => run.id === second.id),
          ),
        );
        expect(
          fake.controls[0]?.ipc.filter((message) => message.type === "proxy_notification"),
        ).toHaveLength(1);
      });
    },
  );

  it.effect("finishes the complete leaf-first stop after its waiter is cancelled", () => {
    const releaseOrder: number[] = [];
    const { fake, projections, layer } = localServiceFixture(
      {},
      fakeChildLayer(Effect.void, { onRelease: (index) => releaseOrder.push(index) }),
    );
    return withService(layer, function* (service) {
      const parent = yield* service.start(request({ name: "parent" }));
      const child = yield* service.startSessionOwnedFrom(parent.id, request({ name: "child" }));
      const leaf = yield* service.startSessionOwnedFrom(child.id, request({ name: "leaf" }));
      const gate = yield* Deferred.make<void>();
      fake.controls[2]?.gateRelease(gate);
      const waiter = yield* service.stop(parent.id).pipe(Effect.forkScoped);
      yield* yieldUntil(
        () => projections.at(-1)?.runs.find((run) => run.id === leaf.id)?.state === "stopping",
      );
      yield* Fiber.interrupt(waiter);
      expect(releaseOrder).toEqual([]);
      yield* Deferred.succeed(gate, undefined);
      yield* yieldUntil(
        () => projections.at(-1)?.runs.every((run) => run.state === "stopped") === true,
      );
      yield* service.stop(parent.id);
      expect(releaseOrder).toEqual([2, 1, 0]);
      expect(fake.controls.map((control) => control.released())).toEqual([1, 1, 1]);
    });
  });

  it.effect("stops an explicit subtree leaf-first", () => {
    const releaseOrder: number[] = [];
    const { layer } = localServiceFixture(
      {},
      fakeChildLayer(Effect.void, {
        onRelease: (index) => releaseOrder.push(index),
      }),
    );
    return withService(layer, function* (service) {
      const parent = yield* service.start(request({ name: "parent" }));
      const child = yield* service.startSessionOwnedFrom(parent.id, request({ name: "child" }));
      yield* service.startSessionOwnedFrom(child.id, request({ name: "grandchild" }));
      yield* service.stop(parent.id);
      expect(releaseOrder).toEqual([2, 1, 0]);
      expect((yield* service.list).filter((run) => run.state === "stopped")).toHaveLength(3);
    });
  });
});
