import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import * as TestClock from "effect/testing/TestClock";
import { yieldUntil } from "pi-cosmic-core/testing";
import { completionBlock } from "../../src/boundary/host-notifier.ts";
import { MAX_USER_GUIDANCE_CHARS } from "../../src/run/model.ts";
import { formatRunBlock, runViewBlock } from "../../src/tools/run-block.ts";
import {
  completeLocalRun,
  localServiceFixture,
  request,
  runView,
  withService,
} from "./fixtures/service-harness.ts";

describe("what the user told a run directly", () => {
  it.effect("reaches the run's parent with the outcome it led to, and no later one", () => {
    const { fake, notifications, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request());
      yield* service.send(run.id, "Skip the tests.");
      yield* service.send(run.id, "Check the public API too.");
      const guided = yield* runView(service, run.id);
      expect(guided.userGuidance).toEqual({ count: 2, latest: "Check the public API too." });
      expect(formatRunBlock(runViewBlock(guided, undefined))).toContain(
        "The user messaged this agent directly 2 times; latest: Check the public API too.",
      );

      yield* completeLocalRun(service, fake.controls[0]!, run.id, "First report.");
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => notifications.length === 1);
      const first = notifications[0];
      if (first?.type !== "completed") throw new Error("expected a completion notice");
      expect(formatRunBlock(completionBlock(first.runs[0]!))).toContain(
        "The user messaged this agent directly 2 times",
      );

      // The user's resume is the next assignment's own guidance; the earlier messages are spent.
      const resumed = yield* service.resume(run.id, "Now document it.");
      expect(resumed.userGuidance).toEqual({ count: 1, latest: "Now document it." });
      yield* completeLocalRun(service, fake.controls[1]!, run.id, "Second report.");
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => notifications.length === 2);
      const second = notifications[1];
      if (second?.type !== "completed") throw new Error("expected a completion notice");
      expect(formatRunBlock(completionBlock(second.runs[0]!))).toContain(
        "The user messaged this agent directly: Now document it.",
      );
    });
  });

  it.effect("counts what the user typed into the run's own session", () => {
    const { fake, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request());
      fake.controls[0]!.offerIpc({
        channel: "pi-subagents",
        type: "user_input",
        text: "Look at the tests first.",
      });
      yield* yieldUntil(() => fake.controls[0] !== undefined);
      let guided = yield* runView(service, run.id);
      for (let attempt = 0; attempt < 50 && !guided.userGuidance; attempt += 1) {
        yield* Effect.yieldNow;
        guided = yield* runView(service, run.id);
      }
      expect(guided.userGuidance).toEqual({ count: 1, latest: "Look at the tests first." });
      expect(guided.sessionEvents.at(-1)).toMatchObject({
        type: "notice",
        kind: "parent",
        text: "Guidance: Look at the tests first.",
      });
    });
  });

  it.effect("keeps only a bounded copy of the latest message", () => {
    const { layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request());
      yield* service.send(run.id, Fn.pipe("x", Str.repeat(4 * MAX_USER_GUIDANCE_CHARS)));
      const { userGuidance } = yield* runView(service, run.id);
      expect(userGuidance?.latest.length).toBeLessThanOrEqual(MAX_USER_GUIDANCE_CHARS);
    });
  });

  it.effect("stays unset for a run only agents assigned", () => {
    const { fake, notifications, layer } = localServiceFixture();
    return withService(layer, function* (service) {
      const run = yield* service.start(request());
      yield* completeLocalRun(service, fake.controls[0]!, run.id);
      yield* TestClock.adjust("100 millis");
      yield* yieldUntil(() => notifications.length === 1);
      expect(notifications[0]).toMatchObject({ type: "completed", runs: [{ id: run.id }] });
      expect((yield* runView(service, run.id)).userGuidance).toBeUndefined();
      const [notice] = notifications;
      expect(notice?.type === "completed" && notice.runs[0]?.userGuidance).toBeUndefined();
    });
  });
});
