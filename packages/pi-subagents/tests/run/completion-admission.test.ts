import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Semaphore from "effect/Semaphore";
import { makeRunCompletionObservations } from "../../src/run/completion-observations.ts";
import { view } from "../tools/fixtures/tool-harness.ts";
import { makeRunContext, partialRecord } from "./fixtures/run-context.ts";
import { useProbe } from "./fixtures/service-harness.ts";

describe("completion admission", () => {
  for (const operation of ["await", "status"] as const)
    it.effect(`cancels ${operation} after gate acquisition while the run lock is held`, () =>
      Effect.gen(function* () {
        const runLock = yield* Semaphore.make(1);
        const completionGate = yield* Semaphore.make(1);
        const enteredGate = yield* Deferred.make<void>();
        // The observation boundary reads only the completion fields and the view.
        const record = partialRecord({
          view: view({ state: "completed", reportGeneration: 1, finalText: "Report" }),
          completionGeneration: 1,
          completionGenerations: new Map([
            [1, { generation: 1, outcome: "completed" as const, finalText: "Report" }],
          ]),
          completionClaims: new Map<number, string>(),
        });
        let token = 0;
        const observations = makeRunCompletionObservations({
          ...(yield* makeRunContext({
            records: new Map([[record.view.id, record]]),
            withLock: runLock.withPermits(1),
          })),
          withCompletionGate: (effect) =>
            completionGate.withPermits(1)(
              Deferred.succeed(enteredGate, undefined).pipe(Effect.andThen(effect)),
            ),
          currentProjection: () => ({ revision: 1, runs: [record.view] }),
          waitForRevision: () => Effect.never,
          allocateClaimToken: () => `claim-${++token}`,
          delivery: {
            wakeCompletionLocked: () => undefined,
            claimQuestionsLocked: () => undefined,
            questionReceiptLocked: () => undefined,
            acknowledgeQuestionsLocked: () => undefined,
            releaseQuestionClaimsLocked: () => undefined,
          },
        });
        const probe = useProbe();
        const observe =
          operation === "await"
            ? observations.withAwaitTerminalObservations(
                [record.view.id],
                "all_finished",
                undefined,
                probe.use,
              )
            : observations.withStatusObservations([record.view.id], probe.use);
        yield* runLock.take(1);
        yield* Effect.gen(function* () {
          const waiter = yield* observe.pipe(Effect.forkScoped);
          yield* Deferred.await(enteredGate);
          yield* Effect.yieldNow;
          expect(probe.entered).toBe(false);
          expect(record.completionClaims.size).toBe(0);
          let cancelled = false;
          const cancellation = yield* Fiber.interrupt(waiter).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                cancelled = true;
              }),
            ),
            Effect.forkScoped,
          );
          for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
          expect(cancelled).toBe(true);
          expect(probe.entered).toBe(false);
          expect(record.completionClaims.size).toBe(0);
          let gateReusable = false;
          const gateProbe = yield* completionGate
            .withPermits(1)(
              Effect.sync(() => {
                gateReusable = true;
              }),
            )
            .pipe(Effect.forkScoped);
          for (let i = 0; i < 20; i++) yield* Effect.yieldNow;
          expect(gateReusable).toBe(true);
          yield* Fiber.join(gateProbe);
          yield* Fiber.join(cancellation);
        }).pipe(Effect.ensuring(runLock.release(1)));
        // The cancelled admission must not acquire a claim when the second lock opens.
        // A new caller can still own and consume the original report.
        yield* observations.withAwaitTerminalObservations(
          [record.view.id],
          "all_finished",
          undefined,
          (items) =>
            Effect.gen(function* () {
              expect(items[0]?.run.finalText).toBe("Report");
              const receipt = items[0]?.completionReceipt;
              expect(receipt).toBeDefined();
              yield* observations.consumeCompletions(receipt ? [receipt] : []);
            }),
        );
        expect(record.completionClaims.size).toBe(0);
        expect(record.completionGenerations.size).toBe(0);
        expect(probe.entered).toBe(false);
      }),
    );
});
