import { assert, describe, expect, it } from "@effect/vitest";
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
  runView,
  waitForCompleted,
  withService,
} from "./fixtures/service-harness.ts";
import { InvalidSubagentRequestError, SubagentNotFoundError } from "../../src/run/errors.ts";
import { objectContaining } from "../support/matchers.ts";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";

const policy = (maxDirectChildren: number, maxDepth: number) => ({
  maxDirectChildren,
  maxDepth,
});

const withFixture = <Eff extends Effect.Effect<unknown, unknown, unknown>, A>(
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
      expect(Arr.filter(outcomes, Exit.isSuccess)).toHaveLength(1);
      expect(Arr.filter(outcomes, Exit.isFailure)).toHaveLength(1);

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
      expect(blocked).toBeInstanceOf(InvalidSubagentRequestError);
      expect(blocked).toMatchObject({ code: "nesting_depth_limit" });

      const sibling = yield* service.start(
        request({ name: "sibling", nestingPolicy: policy(12, 2) }),
      );
      expect(yield* runView(service, parent.id)).toMatchObject({
        directChildCount: 1,
        descendantCount: 1,
      });
      expect(yield* service.visibleList(parent.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: parent.id }),
          expect.objectContaining({ id: child.id }),
        ]),
      );
      const unauthorized = yield* service
        .authorizeTargets(parent.id, [sibling.id])
        .pipe(Effect.flip);
      expect(unauthorized).toBeInstanceOf(SubagentNotFoundError);
      expect(unauthorized).toMatchObject({ id: sibling.id });
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
          Arr.some(
            notifications,
            (notification) =>
              notification.type === "completed" &&
              Arr.some(notification.runs, (run) => run.id === fallback.id),
          ),
        200,
      );
      expect(child.parentRunId).toBe(parent.id);
    });
  });

  it.effect("retries a report whose ancestor acknowledgement was lost, under the same key", () => {
    const { fake, notifications, layer } = localServiceFixture({ notify: acknowledgeCompletions });
    return withService(layer, function* (service) {
      const parent = yield* service.start(request({ name: "uncertain-parent" }));
      const child = yield* service.startSessionOwnedFrom(
        parent.id,
        request({ name: "uncertain-child" }),
      );
      const notices = () =>
        Arr.flatMap(fake.controls[0]?.ipc ?? [], (message) =>
          message.type === "proxy_notification" ? [message] : [],
        );
      fake.controls[0]?.loseNextNotificationAck();
      fake.controls[1]?.settle();
      yield* waitForCompleted(service, child.id);
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => notices().length === 1);

      // The lost acknowledgement leaves the outcome uncertain, so the same notice goes again.
      yield* TestClock.adjust("10 seconds");
      yield* Effect.yieldNow;
      yield* TestClock.adjust("30 seconds");
      yield* yieldUntil(() => notices().length === 2);
      yield* TestClock.adjust("30 seconds");
      expect(Arr.map(notices(), (notice) => notice.key)).toEqual([
        `${child.id}:1`,
        `${child.id}:1`,
      ]);
      expect(notices()[0]?.requestId).not.toBe(notices()[1]?.requestId);
      expect(notifications).toEqual([]);
    });
  });

  it.effect("falls back past an ancestor that refuses a report", () => {
    const { fake, notifications, layer } = localServiceFixture({ notify: acknowledgeCompletions });
    return withService(layer, function* (service) {
      const parent = yield* service.start(request({ name: "refusing-parent" }));
      const child = yield* service.startSessionOwnedFrom(
        parent.id,
        request({ name: "refused-child" }),
      );
      fake.controls[0]?.refuseNextNotification();
      fake.controls[1]?.settle("Child report.");
      yield* waitForCompleted(service, child.id);
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => Arr.some(notifications, (notice) => notice.type === "completed"));
      expect(notifications).toEqual([
        objectContaining({ type: "completed", runs: [objectContaining({ id: child.id })] }),
      ]);
      yield* TestClock.adjust("30 seconds");
      assert(fake.controls[0] !== undefined);
      expect(
        Arr.filter(fake.controls[0].ipc, (message) => message.type === "proxy_notification"),
      ).toHaveLength(1);
    });
  });

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
      yield* yieldUntil(() =>
        Arr.last(projections).pipe(
          Option.flatMap((projection) =>
            Arr.findFirst(projection.runs, (run) => run.id === leaf.id),
          ),
          Option.exists((run) => run.state === "stopping"),
        ),
      );
      yield* Fiber.interrupt(waiter);
      expect(releaseOrder).toEqual([]);
      yield* Deferred.succeed(gate, undefined);
      yield* yieldUntil(() =>
        Option.exists(Arr.last(projections), (projection) =>
          Arr.every(projection.runs, (run) => run.state === "stopped"),
        ),
      );
      yield* service.stop(parent.id);
      expect(releaseOrder).toEqual([2, 1, 0]);
      expect(Arr.map(fake.controls, (control) => control.released())).toEqual([1, 1, 1]);
    });
  });
});
