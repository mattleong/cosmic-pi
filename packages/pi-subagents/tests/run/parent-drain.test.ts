import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { yieldUntil } from "pi-cosmic-core/testing";
import type { SubagentNotification } from "../../src/boundary/host-notifier.ts";
import {
  acknowledgeCompletions,
  completeLocalRun,
  contactParentFrame,
  localServiceFixture,
  request,
  runViews,
  withService,
} from "./fixtures/service-harness.ts";

describe("session-end completion flush", () => {
  it.effect("hands a pending report to the notifier without waiting for the retry clock", () => {
    const delivered: SubagentNotification[] = [];
    const { fake, layer } = localServiceFixture({
      notify: (notification) => {
        delivered.push(notification);
        return acknowledgeCompletions(notification);
      },
    });
    return withService(layer, function* (service) {
      const run = yield* service.start(request());
      yield* completeLocalRun(service, fake.controls[0]!, run.id, "Done.");
      expect(delivered).toEqual([]);
      yield* service.deliverPendingCompletions;
      expect(delivered.map((notification) => notification.type)).toEqual(["completed"]);
    });
  });
});

describe("headless parent drain", () => {
  it.effect("yields for a direct child's question while its sibling is still running", () => {
    const { fake, layer, projections } = localServiceFixture();
    return withService(layer, function* (service) {
      const asking = yield* service.start(request({ name: "asking" }));
      const sibling = yield* service.start(request({ name: "running-sibling" }));
      const drain = yield* service.awaitParentDrain.pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      expect(drain.pollUnsafe()).toBeUndefined();

      fake.controls[0]!.offerIpc(
        contactParentFrame("question-1", "question", "Which path should I take?"),
      );
      yield* yieldUntil(
        () =>
          projections
            .at(-1)
            ?.runs.some((run) => run.id === asking.id && run.question !== undefined) === true,
      );
      yield* TestClock.adjust("1 second");

      expect(drain.pollUnsafe()).toBeDefined();
      yield* Fiber.join(drain);
      expect((yield* runViews(service)).find((run) => run.id === sibling.id)?.state).toBe(
        "running",
      );
    });
  });

  it.effect("waits for a running child and the delivery of its report", () => {
    const delivered: SubagentNotification[] = [];
    const { fake, layer } = localServiceFixture({
      notify: (notification) => {
        delivered.push(notification);
        return acknowledgeCompletions(notification);
      },
    });
    return withService(layer, function* (service) {
      const run = yield* service.start(request());
      const drain = yield* service.awaitParentDrain.pipe(Effect.forkScoped);
      yield* TestClock.adjust("2 seconds");
      expect(drain.pollUnsafe()).toBeUndefined();

      yield* completeLocalRun(service, fake.controls[0]!, run.id, "Done.");
      yield* TestClock.adjust("2 seconds");
      yield* yieldUntil(() => delivered.some((notification) => notification.type === "completed"));
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(drain);
    });
  });
});
