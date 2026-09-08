import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type { BackendEvent } from "./model.ts";

type ClaudeReport = Extract<BackendEvent, { readonly type: "report" }>;

// Native finalization after the report tool may require another model step.
const RESULT_REPORT_GRACE = "10 seconds";

/** Delivers already-accepted reports without owning supervisor acceptance or transport recovery. */
export const makeLocalClaudeReportDelivery = (
  offer: (event: BackendEvent) => Effect.Effect<void>,
) => {
  const bufferedReports = new Map<number, ClaudeReport>();
  const nativeResultEpochs = new Set<number>();
  const forwardingReports = new Map<number, Deferred.Deferred<boolean>>();
  const forwardedReportEpochs = new Set<number>();

  function forwardReport(report: ClaudeReport): Effect.Effect<void> {
    // Install ownership and cleanup together. The enqueue and joiner waits stay
    // interruptible; a cancelled enqueue releases its claim so a waiter can retry.
    return Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        const epoch = report.assignmentEpoch;
        if (forwardedReportEpochs.has(epoch)) return Effect.void;
        const existing = forwardingReports.get(epoch);
        if (existing)
          return restore(
            Deferred.await(existing).pipe(
              Effect.flatMap((forwarded) => (forwarded ? Effect.void : forwardReport(report))),
            ),
          );
        const completion = Deferred.makeUnsafe<boolean>();
        forwardingReports.set(epoch, completion);
        let forwarded = false;
        return restore(offer(report)).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              forwarded = true;
              forwardedReportEpochs.add(epoch);
              bufferedReports.delete(epoch);
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              forwardingReports.delete(epoch);
              Deferred.doneUnsafe(completion, Effect.succeed(forwarded));
            }),
          ),
        );
      }),
    );
  }

  const observeNativeResult = (epoch: number) =>
    Effect.suspend(() => {
      nativeResultEpochs.add(epoch);
      const report = bufferedReports.get(epoch);
      return report ? forwardReport(report) : Effect.void;
    });

  const bufferAcceptedReport = (report: ClaudeReport) =>
    Effect.suspend(() => {
      if (forwardedReportEpochs.has(report.assignmentEpoch)) return Effect.void;
      if (nativeResultEpochs.has(report.assignmentEpoch)) return forwardReport(report);
      // Final usage/cost must reach the queue before report settlement closes the
      // backend scope. The scoped bound preserves completion if no result arrives.
      bufferedReports.set(report.assignmentEpoch, report);
      return Effect.sleep(RESULT_REPORT_GRACE).pipe(
        Effect.andThen(
          Effect.suspend(() =>
            bufferedReports.get(report.assignmentEpoch) === report
              ? forwardReport(report)
              : Effect.void,
          ),
        ),
        Effect.forkScoped,
        Effect.asVoid,
      );
    });

  return { bufferAcceptedReport, observeNativeResult, forwardReport };
};
