import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import * as TestClock from "effect/testing/TestClock";
import { yieldUntil } from "pi-cosmic-core/testing";
import type { SubagentNotification } from "../../src/boundary/host-notifier.ts";
import type { RunRecord } from "../../src/run/internal.ts";
import { notificationHandoff } from "../../src/run/notification-handoff.ts";
import { view } from "../fixtures/run-view.ts";
import { backendHandleFixture, runRecordFixture } from "./fixtures/run-context.ts";
import {
  acknowledgeCompletions,
  contactParentFrame,
  type FakeChildControl,
  localServiceFixture,
  request,
  runView,
  waitForCompleted,
  withService,
} from "./fixtures/service-harness.ts";

const deliverNotification = () => Effect.void;

const yieldTurns = Effect.gen(function* () {
  for (let turn = 0; turn < 50; turn += 1) yield* Effect.yieldNow;
});

const reportsAtRoot = (notifications: ReadonlyArray<SubagentNotification>) =>
  Arr.flatMap(notifications, (notification) =>
    notification.type === "completed" ? Arr.map(notification.runs, (run) => run.finalText) : [],
  );

const reportKeys = (control: FakeChildControl | undefined, runId: string) =>
  Arr.flatMap(control?.ipc ?? [], (message) =>
    message.type === "proxy_notification" && Str.startsWith(`${runId}:`)(message.key)
      ? [message.key]
      : [],
  );

describe("notice hand-off", () => {
  it.effect("sends every report to the root within the retirement budget", () => {
    const { fake, notifications, layer } = localServiceFixture({ notify: acknowledgeCompletions });
    return withService(layer, function* (service) {
      const parent = yield* service.start(request({ name: "parent" }));
      const child = yield* service.startSessionOwnedFrom(parent.id, request({ name: "child" }));
      const sibling = yield* service.start(request({ name: "sibling" }));
      // The parent never acknowledges, so the delivery worker waits on it.
      const never = yield* Deferred.make<void>();
      fake.controls[0]?.gateNextIpcType("proxy_notification", never);
      fake.controls[1]?.settle("Child report.");
      yield* waitForCompleted(service, child.id);
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => fake.controls[0]?.sentIpc("proxy_notification") === true);
      fake.controls[2]?.settle("Sibling report.");
      yield* waitForCompleted(service, sibling.id);

      const retiring = yield* service.retireDelivery.pipe(
        Effect.timeoutOption("2 seconds"),
        Effect.forkChild,
      );
      yield* yieldTurns;
      yield* TestClock.adjust("2 seconds");
      expect(Option.isSome(yield* Fiber.join(retiring))).toBe(true);
      expect(reportsAtRoot(notifications)).toEqual(
        expect.arrayContaining(["Child report.", "Sibling report."]),
      );
    });
  });

  it.effect("sends a report a running parent already took to the root on retirement", () => {
    const { fake, notifications, layer } = localServiceFixture({ notify: acknowledgeCompletions });
    return withService(layer, function* (service) {
      const parent = yield* service.start(request({ name: "parent" }));
      const child = yield* service.startSessionOwnedFrom(parent.id, request({ name: "child" }));
      fake.controls[1]?.settle("Child report.");
      yield* waitForCompleted(service, child.id);
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => reportKeys(fake.controls[0], child.id).length === 1);
      yield* yieldTurns;
      expect(reportsAtRoot(notifications)).toEqual([]);

      yield* service.retireDelivery;
      expect(reportsAtRoot(notifications)).toEqual(["Child report."]);
    });
  });

  for (const ending of ["fails", "is stopped", "pauses"] as const)
    it.effect(`hands on a report its parent took when the parent ${ending}`, () => {
      const { fake, notifications, layer } = localServiceFixture({
        notify: acknowledgeCompletions,
      });
      return withService(layer, function* (service) {
        const top = yield* service.start(request({ name: "top" }));
        const middle = yield* service.startSessionOwnedFrom(top.id, request({ name: "middle" }));
        const leaf = yield* service.startSessionOwnedFrom(middle.id, request({ name: "leaf" }));
        fake.controls[2]?.settle("Leaf report.");
        yield* waitForCompleted(service, leaf.id);
        yield* TestClock.adjust("100 millis");
        yield* yieldUntil(() => reportKeys(fake.controls[1], leaf.id).length === 1);
        yield* yieldTurns;

        if (ending === "fails") fake.controls[1]?.exit(1);
        else if (ending === "is stopped") yield* service.stop(middle.id);
        else expect((yield* service.interrupt(middle.id)).state).toBe("paused");
        expect((yield* runView(service, middle.id)).state).toBe(
          { fails: "failed", "is stopped": "stopped", pauses: "paused" }[ending],
        );
        yield* TestClock.adjust("100 millis");
        yield* yieldUntil(() => reportKeys(fake.controls[0], leaf.id).length === 1);
        yield* TestClock.adjust("30 seconds");
        expect(reportKeys(fake.controls[0], leaf.id)).not.toEqual(
          reportKeys(fake.controls[1], leaf.id),
        );
        expect(reportKeys(fake.controls[1], leaf.id)).toHaveLength(1);
        expect(reportsAtRoot(notifications)).not.toContain("Leaf report.");
      });
    });

  it.effect("keeps a report as delivered when the parent that took it completes", () => {
    const { fake, notifications, layer } = localServiceFixture({ notify: acknowledgeCompletions });
    return withService(layer, function* (service) {
      const top = yield* service.start(request({ name: "top" }));
      const middle = yield* service.startSessionOwnedFrom(top.id, request({ name: "middle" }));
      const leaf = yield* service.startSessionOwnedFrom(middle.id, request({ name: "leaf" }));
      fake.controls[2]?.settle("Leaf report.");
      yield* waitForCompleted(service, leaf.id);
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => reportKeys(fake.controls[1], leaf.id).length === 1);
      yield* yieldTurns;

      fake.controls[1]?.settle("Middle report.");
      yield* waitForCompleted(service, middle.id);
      expect((yield* runView(service, middle.id)).finalText).toBe("Middle report.");
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => reportKeys(fake.controls[0], middle.id).length === 1);
      yield* TestClock.adjust("30 seconds");
      expect(reportKeys(fake.controls[0], leaf.id)).toEqual([]);
      expect(reportsAtRoot(notifications)).toEqual([]);
    });
  });

  it.effect("doesn't ask the retiring root to answer a question it is about to stop", () => {
    const { fake, notifications, layer } = localServiceFixture({ notify: acknowledgeCompletions });
    return withService(layer, function* (service) {
      const parent = yield* service.start(request({ name: "parent" }));
      yield* service.startSessionOwnedFrom(parent.id, request({ name: "child" }));
      // The parent never acknowledges, so the question is in flight when the root retires.
      const never = yield* Deferred.make<void>();
      fake.controls[0]?.gateNextIpcType("proxy_notification", never);
      fake.controls[1]?.offerIpc(contactParentFrame("q-1", "question", "Which way?"));
      yield* yieldUntil(() => fake.controls[0]?.sentIpc("proxy_notification") === true);

      yield* service.retireDelivery;
      yield* yieldTurns;
      yield* TestClock.adjust("30 seconds");
      yield* yieldTurns;
      expect(Arr.filter(notifications, (notification) => notification.type === "question")).toEqual(
        [],
      );
    });
  });
});

describe("taken reports", () => {
  const takenFixture = Effect.gen(function* () {
    const parent = yield* runRecordFixture({
      view: view({ id: "parent", state: "running" }),
      process: yield* backendHandleFixture().pipe(
        Effect.map((handle) => ({
          ...handle,
          controls: { ...handle.controls, deliverNotification },
        })),
      ),
    });
    const leaf = yield* runRecordFixture({
      view: view({ id: "leaf", parentRunId: "parent", state: "completed" }),
    });
    leaf.completionGenerations.set(1, {
      generation: 1,
      outcome: "completed",
      finalText: "Leaf report.",
    });
    const records = new Map<string, RunRecord>([
      ["parent", parent],
      ["leaf", leaf],
    ]);
    return { parent, leaf, handoff: notificationHandoff(records) };
  });

  it.effect("hands on a taken report after its acknowledgement removed it", () =>
    Effect.gen(function* () {
      const { parent, leaf, handoff } = yield* takenFixture;
      handoff.takeReportLocked(parent, "leaf", 1);
      leaf.completionGenerations.delete(1);
      expect(handoff.endAssignmentLocked("parent", false)).toBe(true);
      expect(leaf.completionGenerations.get(1)).toMatchObject({ handOns: 1 });
    }),
  );

  it.effect("doesn't hand on a taken report an await then consumed", () =>
    Effect.gen(function* () {
      const { parent, leaf, handoff } = yield* takenFixture;
      handoff.takeReportLocked(parent, "leaf", 1);
      leaf.completionGenerations.delete(1);
      handoff.forgetReportLocked("leaf", 1);
      expect(handoff.endAssignmentLocked("parent", false)).toBe(false);
      expect(leaf.completionGenerations.has(1)).toBe(false);
    }),
  );

  it.effect("hands on at once a report taken by a run that stopped taking notices", () =>
    Effect.gen(function* () {
      const { parent, leaf, handoff } = yield* takenFixture;
      parent.stoppedByParent = true;
      handoff.takeReportLocked(parent, "leaf", 1);
      expect(leaf.completionGenerations.get(1)).toMatchObject({ handOns: 1 });
      expect(handoff.endAssignmentLocked("parent", false)).toBe(false);
    }),
  );
});
