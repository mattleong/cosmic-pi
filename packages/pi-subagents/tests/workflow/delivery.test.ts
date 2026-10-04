import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import type { SubagentWorkflowNotification } from "../../src/boundary/host-notifier.ts";
import {
  DELIVERY_RETRY_INITIAL_MS,
  DELIVERY_RETRY_MAX_MS,
  makeWorkflowDelivery,
} from "../../src/workflow/delivery.ts";

const notification: SubagentWorkflowNotification = {
  type: "workflow",
  runId: "wf-a-1",
  name: "review",
  outcome: "completed",
  durationMs: 1_000,
  content: "Workflow review completed.",
  agents: { total: 1, failed: 0, stopped: 0, skipped: 0, reused: 0 },
  workspaces: [],
};

interface FakeHost {
  attempts: number;
  accept: boolean;
  readonly finished: string[];
}

/** A host that refuses every notification until told to accept, and a close that is recorded. */
const fakeHost = () => {
  const host: FakeHost = { attempts: 0, accept: false, finished: [] };
  return {
    host,
    notify: () => {
      host.attempts += 1;
      return { actionAccepted: host.accept };
    },
    close: (runId: string) => Effect.sync(() => void host.finished.push(runId)),
  };
};

/** Delays between attempts: doubling from the initial delay, then held at the maximum. */
const backoff = (count: number): ReadonlyArray<number> =>
  Array.from({ length: count }, (_, index) =>
    Math.min(DELIVERY_RETRY_INITIAL_MS * 2 ** index, DELIVERY_RETRY_MAX_MS),
  );

describe("workflow completion delivery", () => {
  it.effect("retries with doubling backoff up to the maximum, then closes the run", () =>
    Effect.gen(function* () {
      const { host, notify, close } = fakeHost();
      const delivery = yield* makeWorkflowDelivery(notify);
      yield* delivery.report(notification, close("wf-a-1"));
      yield* TestClock.adjust(0);
      expect(host.attempts).toBe(1);
      const delays = backoff(12);
      // The schedule reaches the maximum and stays there.
      expect(delays.at(-1)).toBe(DELIVERY_RETRY_MAX_MS);
      for (const [index, delay] of delays.entries()) {
        yield* TestClock.adjust(delay - 1);
        expect(host.attempts).toBe(index + 1);
        yield* TestClock.adjust(1);
        expect(host.attempts).toBe(index + 2);
      }
      expect(host.finished).toEqual([]);
      host.accept = true;
      yield* TestClock.adjust(DELIVERY_RETRY_MAX_MS);
      expect(host.finished).toEqual(["wf-a-1"]);
      const accepted = host.attempts;
      yield* TestClock.adjust(10 * DELIVERY_RETRY_MAX_MS);
      expect(host.attempts).toBe(accepted);
    }).pipe(Effect.scoped),
  );

  it.effect("delivers nothing once its scope closes, even mid-retry", () =>
    Effect.gen(function* () {
      const { host, notify, close } = fakeHost();
      const scope = yield* Scope.make();
      const delivery = yield* makeWorkflowDelivery(notify).pipe(Scope.provide(scope));
      yield* delivery.report(notification, close("wf-a-1"));
      yield* TestClock.adjust(DELIVERY_RETRY_INITIAL_MS);
      expect(host.attempts).toBe(2);
      yield* Scope.close(scope, Exit.void);
      host.accept = true;
      yield* TestClock.adjust(10 * DELIVERY_RETRY_MAX_MS);
      expect(host.attempts).toBe(2);
      expect(yield* delivery.closed).toBe(true);
      // A report the teardown dropped leaves the run open for the next activation.
      expect(host.finished).toEqual([]);
    }),
  );

  it.effect("finishes closing an accepted run before a teardown completes", () =>
    Effect.gen(function* () {
      const { host, notify, close } = fakeHost();
      host.accept = true;
      const scope = yield* Scope.make();
      const delivery = yield* makeWorkflowDelivery(notify).pipe(Scope.provide(scope));
      const closing = yield* Deferred.make<void>();
      const saved = yield* Deferred.make<void>();
      // The close is still saving, like a run record write, when the teardown comes.
      yield* delivery.report(
        notification,
        Deferred.succeed(closing, undefined).pipe(
          Effect.andThen(Deferred.await(saved)),
          Effect.andThen(close("wf-a-1")),
        ),
      );
      yield* Deferred.await(closing);
      const teardown = yield* Effect.forkChild(Scope.close(scope, Exit.void));
      for (let turn = 0; turn < 10; turn++) yield* Effect.yieldNow;
      expect(teardown.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(saved, undefined);
      yield* Fiber.join(teardown);
      expect(host.finished).toEqual(["wf-a-1"]);
    }),
  );
});
