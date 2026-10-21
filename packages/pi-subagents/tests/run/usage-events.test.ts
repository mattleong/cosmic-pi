import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Semaphore from "effect/Semaphore";
import { view } from "../tools/fixtures/tool-harness.ts";
import { yieldUntil } from "pi-cosmic-core/testing";
import { emptyUsage } from "../../src/run/model.ts";
import {
  backendHandleFixture,
  makeTestSettlement,
  runRecordFixture,
} from "./fixtures/run-context.ts";
import {
  fakeNativeReportBackendLayer,
  nativeReportRequest,
  nativeReportServiceFixture,
  profileLayerFor,
  withService,
} from "./fixtures/service-harness.ts";

it.effect("process usage rechecks handle ownership inside the mutation lock", () =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    const original = yield* backendHandleFixture({ pid: 1 });
    const replacement = yield* backendHandleFixture({ pid: 2 });
    const record = yield* runRecordFixture({
      process: original,
      stoppedByParent: false,
      view: view({ state: "running", usage: emptyUsage() }),
    });
    const settlement = yield* makeTestSettlement({ withLock: lock.withPermits(1) });
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

it.effect("stops new starts once the session's subagents reach the spend limit", () => {
  const { backend, projections, layer } = nativeReportServiceFixture(
    fakeNativeReportBackendLayer(),
    {},
    profileLayerFor({ version: 6, sessionSpendLimit: 1 }),
  );
  return withService(layer, function* (service) {
    yield* service.start(nativeReportRequest());
    backend.controls[0]!.offer({
      type: "usage",
      usage: { ...emptyUsage(), input: 10, totalTokens: 10, cost: 1.5 },
    });
    yield* yieldUntil(() => projections.at(-1)?.sessionUsage?.cost === 1.5, 200);
    expect(yield* service.start(nativeReportRequest()).pipe(Effect.flip)).toMatchObject({
      code: "session_spend_limit",
      limit: 1,
    });
  });
});
