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
  fakeNativeReportBackendLayer,
  nativeReportRequest,
  nativeReportServiceFixture,
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
      view: view({ state: "running", usage: emptyUsage() }),
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

it.effect("usage-only events preserve activity across paused resume and report completion", () => {
  const { backend, projections, layer } = nativeReportServiceFixture(
    fakeNativeReportBackendLayer({ capabilities: ["steer", "interrupt", "resume"] }),
  );
  return withService(layer, function* (service) {
    const run = yield* service.start(nativeReportRequest({ model: "claude-native" }));
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
    expect((yield* service.interrupt(run.id)).state).toBe("paused");
    const admission = yield* Deferred.make<void>();
    control.gateNextStart(admission);
    const resuming = yield* service
      .resume(run.id, "resume with concurrent accounting")
      .pipe(Effect.forkChild);
    yield* yieldUntil(() => control.assignmentEpochs.length === 2, 200);
    control.offer({ type: "usage", usage: { ...emptyUsage(), input: 100, totalTokens: 100 } });
    yield* yieldUntil(() => projections.at(-1)?.runs[0]?.usage.input === 110, 200);
    yield* Deferred.succeed(admission, undefined);
    expect((yield* Fiber.join(resuming)).state).toBe("running");
    expect((yield* service.status(run.id)).usage.input).toBe(110);

    control.offer({ type: "usage", usage: { ...emptyUsage(), input: 1, totalTokens: 1 } });
    yield* yieldUntil(() => projections.at(-1)?.runs[0]?.usage.input === 111, 200);
    control.report(run.id, 1, "report", "Keep this report");
    yield* yieldUntil(() => projections.at(-1)?.runs[0]?.state === "completed", 200);
    const completed = projections.at(-1)!.runs[0]!;
    expect(completed.finalText).toBe("Keep this report");
    expect(completed.usage.input).toBe(111);
    expect(completed.reportGeneration).toBe(1);
    yield* yieldUntil(() => control.released() === 1, 200);
  });
});
