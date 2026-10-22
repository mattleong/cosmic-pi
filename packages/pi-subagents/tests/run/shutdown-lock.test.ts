import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type { RunRecord } from "../../src/run/internal.ts";
import { recordCleanup } from "../../src/run/record-cleanup.ts";
import { closeRunsLeafFirst } from "../../src/run/shutdown.ts";
import { view } from "../fixtures/run-view.ts";
import { makeRunContext, runningAssignment, runRecordFixture } from "./fixtures/run-context.ts";

describe("session shutdown", () => {
  it.effect("stops each run only once it holds the run lock", () =>
    Effect.gen(function* () {
      const record = yield* runRecordFixture({
        view: view({ state: "running" }),
        assignment: runningAssignment(1),
      });
      const records = new Map<string, RunRecord>([[record.view.id, record]]);
      const context = yield* makeRunContext({ records });
      const cleanup = recordCleanup({ ...context, publish: Effect.void });
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      // Another transition is mid-flight under the lock when shutdown begins.
      const holder = yield* Effect.forkChild(
        context.withLock(
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ),
      );
      yield* Deferred.await(held);

      const shutdown = yield* Effect.forkChild(
        closeRunsLeafFirst({ records, withLock: context.withLock, cleanup }),
      );
      yield* Effect.yieldNow;
      expect(record.stoppedByParent).toBe(false);
      expect(record.cleanupDisposition).toBe("none");

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      yield* Fiber.join(shutdown);
      expect(record.stoppedByParent).toBe(true);
    }).pipe(Effect.scoped),
  );
});
