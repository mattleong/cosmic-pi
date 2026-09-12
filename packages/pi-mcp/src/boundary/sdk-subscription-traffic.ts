import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { boundaryError } from "../client/errors.ts";

/** Native writes are separate from SDK logical close; a write is not a remote acknowledgement. */
export class SdkSubscriptionTrafficLedger {
  private pending = 0;
  private idle = Deferred.makeUnsafe<void>();
  private failed = false;
  private cancellationWritten = false;
  private remotelyTerminated = false;
  private sealed = false;

  reserve(cancellation: boolean): ((succeeded: boolean) => void) | undefined {
    if (this.sealed) return undefined;
    if (this.pending++ === 0) this.idle = Deferred.makeUnsafe<void>();
    let settled = false;
    return (succeeded) => {
      if (settled) return;
      settled = true;
      this.failed ||= !succeeded;
      if (succeeded && cancellation) this.cancellationWritten = true;
      if (--this.pending === 0) Deferred.doneUnsafe(this.idle, Effect.void);
    };
  }

  remoteTerminated(): void {
    this.remotelyTerminated = true;
  }

  join(cleanupTimeoutMs: number, requireCancellationWrite: boolean) {
    return Effect.gen({ self: this }, function* () {
      this.sealed = true;
      const waited = yield* (this.pending === 0 ? Effect.void : Deferred.await(this.idle)).pipe(
        Effect.interruptible,
        Effect.timeoutOption(cleanupTimeoutMs),
      );
      if (
        Option.isNone(waited) ||
        this.failed ||
        (requireCancellationWrite && !this.cancellationWritten && !this.remotelyTerminated)
      )
        return yield* boundaryError(
          "cleanup",
          "unknown",
          "MCP subscription native write cleanup is unconfirmed.",
        );
    });
  }
}
