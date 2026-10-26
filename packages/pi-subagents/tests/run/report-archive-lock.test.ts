import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { ReportArchiveError, type ReportArchive } from "../../src/boundary/report-archive.ts";
import { REPORT_SAVE_DEADLINE_MILLIS } from "../../src/run/limits.ts";
import type { RunNotificationDelivery } from "../../src/run/notification-delivery.ts";
import { settlementOperations } from "../../src/run/settlement.ts";
import { view } from "../fixtures/run-view.ts";
import {
  gatedReportArchive,
  makeRunContext,
  runningAssignment,
  runRecordFixture,
} from "./fixtures/run-context.ts";

const quietDelivery: RunNotificationDelivery = {
  retireDelivery: Effect.void,
  queueActionNotificationLocked: () => undefined,
  insertCompletionLocked: () => undefined,
  wakeCompletionLocked: () => undefined,
  discardQuestionLocked: () => undefined,
  handOnTakenByLocked: () => undefined,
  outboxChangedLocked: () => Deferred.makeUnsafe<void>(),
  signalOutboxChangedLocked: () => undefined,
  forgetTakenReportLocked: () => undefined,
};

const yieldTurns = Effect.gen(function* () {
  for (let turn = 0; turn < 25; turn += 1) yield* Effect.yieldNow;
});

const fixture = (
  archive: ReportArchive,
  delivery: RunNotificationDelivery = quietDelivery,
  overrides: Parameters<typeof makeRunContext>[0] = {},
) =>
  Effect.gen(function* () {
    const context = yield* makeRunContext(overrides);
    const settlement = settlementOperations({
      ...context,
      delivery,
      closeRecordScope: () => Effect.void,
      claimTurnInputDrain: (_record, drained) => Deferred.doneUnsafe(drained, Effect.void),
      archiveReport: archive,
    });
    const record = yield* runRecordFixture({
      view: view({ state: "running" }),
      assignment: runningAssignment(1),
    });
    const settle = (text: string) =>
      settlement.runSettledFromBackend(record, 1, { stopReason: "stop", text });
    return { context, record, settle, settlement };
  });

describe("report files saved during settlement", () => {
  it.effect("lets fibers outside the run lock progress while a file is saved", () =>
    Effect.gen(function* () {
      const gate = yield* gatedReportArchive;
      const { record, settle } = yield* fixture(gate.archive);

      const settling = yield* Effect.forkChild(settle("Final report."));
      yield* Deferred.await(gate.entered);
      const progressed = yield* Effect.forkChild(yieldTurns.pipe(Effect.as("progressed")));
      expect(yield* Fiber.join(progressed)).toBe("progressed");
      expect(record.view.state).toBe("running");
      yield* Deferred.succeed(gate.release, undefined);
      yield* Fiber.join(settling);

      expect(record.view.state).toBe("completed");
      expect(record.view.reportArchive?.path).toBe("/archive/1.md");
      expect(gate.discarded).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("holds the run lock while a file is saved, so a stop can't overtake the report", () =>
    Effect.gen(function* () {
      const gate = yield* gatedReportArchive;
      const { context, record, settle } = yield* fixture(gate.archive);

      const settling = yield* Effect.forkChild(settle("Final report."));
      yield* Deferred.await(gate.entered);
      const stopping = yield* Effect.forkChild(
        context.withLock(
          Effect.sync(() => {
            record.stoppedByParent = true;
            return record.view.state;
          }),
        ),
      );
      yield* yieldTurns;
      expect(record.stoppedByParent).toBe(false);
      yield* Deferred.succeed(gate.release, undefined);
      yield* Fiber.join(settling);

      // The stop runs after the settlement and finds the committed report.
      expect(yield* Fiber.join(stopping)).toBe("completed");
      expect(record.view.reportArchive?.path).toBe("/archive/1.md");
      expect(gate.discarded).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("saves a buffered settlement's file when its assignment activates", () =>
    Effect.gen(function* () {
      const gate = yield* gatedReportArchive;
      const { record, settle, settlement } = yield* fixture(gate.archive);
      record.assignment = { ...runningAssignment(1), phase: "issuing", outcomeUncertain: true };
      yield* settle("Buffered report.");
      expect(gate.saved).toEqual([]);

      const activating = yield* Effect.forkChild(settlement.runStartedFromBackend(record, 1));
      yield* Deferred.await(gate.entered);
      yield* Deferred.succeed(gate.release, undefined);
      yield* Fiber.join(activating);

      expect(record.view).toMatchObject({ state: "completed", finalText: "Buffered report." });
      expect(record.view.reportArchive?.path).toBe("/archive/1.md");
      expect(gate.discarded).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("commits the saved file when the settlement is interrupted during the save", () =>
    Effect.gen(function* () {
      const gate = yield* gatedReportArchive;
      const { record, settle } = yield* fixture(gate.archive);

      const settling = yield* Effect.forkChild(settle("Final report."));
      yield* Deferred.await(gate.entered);
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(settling), {
        startImmediately: true,
      });
      yield* Deferred.succeed(gate.release, undefined);
      yield* Fiber.join(interrupting);

      // The locked transition finishes, so the file it saved belongs to the committed outcome.
      expect(record.view.state).toBe("completed");
      expect(record.view.reportArchive?.path).toBe("/archive/1.md");
      expect(gate.discarded).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("settles without a file whose save misses its deadline, which then removes it", () =>
    Effect.gen(function* () {
      const gate = yield* gatedReportArchive;
      const removed = yield* Deferred.make<void>();
      const { context, record, settle } = yield* fixture({
        ...gate.archive,
        discard: (file) =>
          gate.archive.discard(file).pipe(Effect.andThen(Deferred.succeed(removed, undefined))),
      });

      const settling = yield* Effect.forkChild(settle("Final report."));
      yield* Deferred.await(gate.entered);
      yield* TestClock.adjust(REPORT_SAVE_DEADLINE_MILLIS - 1);
      expect(record.view.state).toBe("running");
      yield* TestClock.adjust(1);
      yield* Fiber.join(settling);

      // The parent gets the report inline, and the run lock is free while the save goes on.
      expect(record.view).toMatchObject({ state: "completed", finalText: "Final report." });
      expect(record.view.reportArchive).toBeUndefined();
      expect(yield* context.withLock(Effect.succeed("free"))).toBe("free");
      expect(gate.discarded).toEqual([]);

      yield* Deferred.succeed(gate.release, undefined);
      yield* Deferred.await(removed);
      expect(gate.discarded).toEqual(["/archive/1.md"]);
    }).pipe(Effect.scoped),
  );

  it.effect("finishes a save whose deadline passed while the session scope closes", () =>
    Effect.gen(function* () {
      const gate = yield* gatedReportArchive;
      const ownerScope = yield* Scope.make();
      // Removal yields as a real one does, so the scope's close can't finish it in passing.
      const archive: ReportArchive = {
        ...gate.archive,
        discard: (file) => Effect.yieldNow.pipe(Effect.andThen(gate.archive.discard(file))),
      };
      const { record, settle } = yield* fixture(archive, quietDelivery, { ownerScope });

      const settling = yield* Effect.forkChild(settle("Final report."));
      yield* Deferred.await(gate.entered);
      yield* TestClock.adjust(REPORT_SAVE_DEADLINE_MILLIS);
      yield* Fiber.join(settling);
      expect(record.view.reportArchive).toBeUndefined();

      // Finalizers run newest first, so closing releases the save before reaching the save's own
      // finalizer, which must then wait for it to remove the file nothing names.
      yield* Scope.addFinalizer(ownerScope, Deferred.succeed(gate.release, undefined));
      yield* Scope.close(ownerScope, Exit.void);
      expect(gate.discarded).toEqual(["/archive/1.md"]);
    }).pipe(Effect.scoped),
  );

  it.effect("settles at once without a file once the session scope is closing", () =>
    Effect.gen(function* () {
      const gate = yield* gatedReportArchive;
      const ownerScope = yield* Scope.make();
      const { record, settle } = yield* fixture(gate.archive, quietDelivery, { ownerScope });
      yield* Scope.close(ownerScope, Exit.void);

      // The test clock never reaches the save deadline, so only an immediate settlement returns.
      yield* settle("Final report.");

      expect(record.view).toMatchObject({ state: "completed", finalText: "Final report." });
      expect(record.view.reportArchive).toBeUndefined();
      expect(gate.saved).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("removes the saved file when the settlement fails after saving it", () =>
    Effect.gen(function* () {
      const gate = yield* gatedReportArchive;
      yield* Deferred.succeed(gate.release, undefined);
      const { settle } = yield* fixture(gate.archive, {
        ...quietDelivery,
        insertCompletionLocked: () => {
          throw new Error("completion outbox failed");
        },
      });

      const settled = yield* Effect.exit(settle("Final report."));

      expect(Exit.isFailure(settled)).toBe(true);
      expect(gate.discarded).toEqual(["/archive/1.md"]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a queued report's file when later settlement work fails", () =>
    Effect.gen(function* () {
      const gate = yield* gatedReportArchive;
      yield* Deferred.succeed(gate.release, undefined);
      const queued: Array<string | undefined> = [];
      const { record, settle } = yield* fixture(
        gate.archive,
        {
          ...quietDelivery,
          insertCompletionLocked: (_record, completion) =>
            void queued.push(completion.reportArchive?.path),
        },
        { publish: Effect.die("projection publish failed") },
      );

      const settled = yield* Effect.exit(settle("Final report."));

      // The parent is told this path, so the file must outlive the failed publication.
      expect(Exit.isFailure(settled)).toBe(true);
      expect(queued).toEqual(["/archive/1.md"]);
      expect(record.view.reportArchive?.path).toBe("/archive/1.md");
      expect(gate.discarded).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "settles without a file, logs a redacted warning, and removes nothing on failure",
    () => {
      const warnings: Array<string> = [];
      const logger = Logger.make((options) => {
        const entry = Logger.formatStructured.log(options);
        if (entry.level === "WARN") warnings.push(JSON.stringify(entry));
      });
      return Effect.gen(function* () {
        const discarded: Array<string> = [];
        const { record, settle } = yield* fixture({
          save: () =>
            Effect.fail(
              ReportArchiveError.make({ reason: "write_failed", message: "/private/report/path" }),
            ),
          discard: (file) => Effect.sync(() => void discarded.push(file.path)),
        });

        yield* settle("Final report.");

        expect(record.view).toMatchObject({ state: "completed", finalText: "Final report." });
        expect(record.view.reportArchive).toBeUndefined();
        expect(discarded).toEqual([]);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).not.toContain("/private/report/path");
      }).pipe(
        Effect.scoped,
        Effect.provide(Logger.layer([logger])),
        Effect.provideService(References.MinimumLogLevel, "All"),
      );
    },
  );
});
