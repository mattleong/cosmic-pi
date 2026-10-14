import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { yieldUntil } from "pi-cosmic-core/testing";
import type { SubagentNotification } from "../../src/boundary/host-notifier.ts";
import {
  acknowledgeCompletions,
  completeLocalRun,
  localServiceFixture,
  request,
  withService,
} from "./fixtures/service-harness.ts";

describe("headless parent drain", () => {
  it.effect("returns at once when nothing is running", () => {
    const { layer } = localServiceFixture();
    return withService(layer, function* (service) {
      yield* service.awaitParentDrain;
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
