import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Semaphore from "effect/Semaphore";
import { makeRunSettlement } from "../../src/run/settlement.ts";
import type { RunRecord } from "../../src/run/internal.ts";
import type { BackendHandle } from "../../src/backend/model.ts";
import type { RunNotificationDelivery } from "../../src/run/notification-delivery.ts";
import { view } from "../tools/fixtures/tool-harness.ts";
import { yieldUntil } from "pi-cosmic-core/testing";
import { emptyUsage } from "../../src/run/model.ts";
import { makeRunContext } from "./fixtures/run-context.ts";
import {
  retainedRequest,
  retainedServiceFixture,
  withService,
} from "./fixtures/service-harness.ts";

it.effect("process usage rechecks handle ownership inside the mutation lock", () =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    // SAFETY: This test compares handle identity only and never invokes a backend method.
    const original = { pid: 1 } as BackendHandle;
    // SAFETY: This test compares handle identity only and never invokes a backend method.
    const replacement = { pid: 2 } as BackendHandle;
    const fields = {
      process: original,
      stoppedByParent: false,
      view: view({ state: "reported", usage: emptyUsage() }),
    } satisfies Pick<RunRecord, "process" | "stoppedByParent" | "view">;
    // SAFETY: The owned usage merger reads only the process, stop flag, and view fields.
    const record = fields as RunRecord;
    // SAFETY: This test calls only the usage merger, which never uses notification delivery.
    const delivery = {} as RunNotificationDelivery;
    const settlement = makeRunSettlement({
      ...(yield* makeRunContext({ withLock: lock.withPermits(1) })),
      delivery,
      closeRecordScope: () => Effect.void,
    });
    const charge = { ...emptyUsage(), input: 10, totalTokens: 10 };
    yield* lock.take(1);
    const pending = yield* settlement
      .mergeProcessUsage(record, original, charge)
      .pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    record.process = replacement;
    yield* lock.release(1);
    yield* Fiber.join(pending);
    expect(record.view.usage.input).toBe(0);
    yield* settlement.mergeProcessUsage(record, undefined, charge);
    expect(record.view.usage.input).toBe(0);
    yield* settlement.mergeProcessUsage(record, replacement, charge);
    expect(record.view.usage.input).toBe(10);
  }).pipe(Effect.scoped),
);

it.effect("usage-only events preserve activity and accepted report evidence", () => {
  const { backend, projections, layer } = retainedServiceFixture();
  return withService(layer, function* (service) {
    const run = yield* service.start(retainedRequest({ model: "claude-native" }));
    const control = backend.controls[0]!;
    const epoch = control.assignmentEpochs[0]!;
    control.offer({
      type: "assistant_message",
      assignmentEpoch: epoch,
      text: "Keep this report",
      usage: emptyUsage(),
    });
    yield* yieldUntil(() => (projections.at(-1)?.runs[0]?.sessionEvents.length ?? 0) > 0, 200);
    const before = yield* service.status(run.id);
    control.offer({
      type: "usage",
      usage: { ...emptyUsage(), input: 10, totalTokens: 10 },
    });
    yield* yieldUntil(() => projections.at(-1)?.runs[0]?.usage.input === 10, 200);
    const active = yield* service.status(run.id);
    expect(active.lastActivityAt).toBe(before.lastActivityAt);
    expect(active.sessionEvents).toEqual(before.sessionEvents);
    control.report(run.id, 1, "report", "Keep this report");
    yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "reported", 200);
    const reported = projections.at(-1)!.runs[0]!;
    control.offer({
      type: "usage",
      usage: { ...emptyUsage(), input: 5, totalTokens: 5 },
    });
    yield* yieldUntil(() => projections.at(-1)?.runs[0]?.usage.input === 15, 200);
    const late = projections.at(-1)!.runs[0]!;
    expect(late.finalText).toBe(reported.finalText);
    expect(late.lastActivityAt).toBe(reported.lastActivityAt);
    expect(late.reportGeneration).toBe(reported.reportGeneration);
    expect(late.sessionEvents).toEqual(reported.sessionEvents);
    expect((yield* service.status(run.id)).finalText).toBe("Keep this report");
    const admission = yield* Deferred.make<void>();
    control.gateNextStart(admission);
    control.failNextStart("fixture_not_sent");
    const sending = yield* service.send(run.id, "rejected assignment").pipe(Effect.forkChild);
    yield* yieldUntil(() => control.assignmentEpochs.length === 2, 200);
    control.offer({
      type: "usage",
      usage: { ...emptyUsage(), input: 100, totalTokens: 100 },
    });
    yield* yieldUntil(() => projections.at(-1)?.runs[0]?.usage.input === 115, 200);
    yield* Deferred.succeed(admission, undefined);
    expect((yield* Fiber.join(sending).pipe(Effect.exit))._tag).toBe("Failure");
    expect((yield* service.status(run.id)).usage.input).toBe(115);
    yield* service.send(run.id, "next assignment");
    control.offer({
      type: "usage",
      usage: { ...emptyUsage(), input: 1, totalTokens: 1 },
    });
    yield* yieldUntil(() => projections.at(-1)?.runs[0]?.usage.input === 116, 200);
    expect((yield* service.status(run.id)).usage.input).toBe(116);
  });
});
