import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import type { DuplexProcessChild } from "./node-builtins.ts";

export type { DuplexProcessChild } from "./node-builtins.ts";

export class DuplexProcessError extends Schema.TaggedError<DuplexProcessError>()(
  "DuplexProcessError",
  {
    operation: Schema.Literals(["spawn", "start", "read", "write", "close", "cleanup"]),
    reason: Schema.Literals([
      "unsupported-platform",
      "failed",
      "timeout",
      "permission",
      "overflow",
      "closed",
    ]),
    message: Schema.String,
  },
) {}

export const duplexProcessError = (
  operation: DuplexProcessError["operation"],
  reason: DuplexProcessError["reason"],
  message: string,
): DuplexProcessError => new DuplexProcessError({ operation, reason, message });

export interface DuplexProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface DuplexProcessCloseOptions {
  readonly gracefulTimeoutMs: number;
  readonly forceTimeoutMs: number;
  readonly cleanupTimeoutMs: number;
  readonly pollIntervalMs: number;
  /** Installed synchronously at spawn, before a failed spawn can emit error/close. */
  readonly nativeClosed: Effect.Effect<void>;
}

type CleanupChild = Pick<
  DuplexProcessChild,
  "pid" | "exitCode" | "signalCode" | "stdin" | "stdout" | "stderr"
>;

type GroupResult = "absent" | "present" | "permission" | "failed";

const signalGroup = (pid: number, signal: NodeJS.Signals | 0): GroupResult => {
  try {
    process.kill(-pid, signal);
    return "present";
  } catch (error) {
    const code = Predicate.hasProperty(error, "code") ? error.code : undefined;
    return code === "ESRCH" ? "absent" : code === "EPERM" ? "permission" : "failed";
  }
};

const destroyStreams = (child: CleanupChild): void => {
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    try {
      stream.destroy();
    } catch {
      // Native close and process-group evidence, not destroy(), confirm cleanup.
    }
  }
};

const closeFailure = (
  reason: Extract<DuplexProcessError["reason"], "failed" | "permission" | "timeout">,
): DuplexProcessError =>
  duplexProcessError(
    "cleanup",
    reason,
    reason === "timeout"
      ? "Child process-group cleanup was not confirmed before its deadline."
      : "Unable to confirm child process-group cleanup.",
  );

/**
 * Confirms leader exit, detached group disappearance, and native pipe release.
 * All phases share one deadline. Deliberately escaped descendants are not covered.
 */
export const closeDuplexProcess = (
  child: CleanupChild,
  options: DuplexProcessCloseOptions,
): Effect.Effect<void, DuplexProcessError> =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      const deadline = startedAt + options.cleanupTimeoutMs;
      const pid = child.pid;
      let groupGone = pid === undefined;
      const checkedSignal = (signal: NodeJS.Signals): Effect.Effect<void, DuplexProcessError> =>
        Effect.suspend(() => {
          if (pid === undefined) return Effect.void;
          const result = signalGroup(pid, signal);
          return result === "failed" ? Effect.fail(closeFailure(result)) : Effect.void;
        });
      const awaitGone = (until: number): Effect.Effect<boolean, DuplexProcessError> =>
        Effect.gen(function* () {
          while (true) {
            const group = pid === undefined ? "absent" : signalGroup(pid, 0);
            if (group === "failed") return yield* closeFailure(group);
            groupGone = group === "absent";
            const rootExited = child.exitCode !== null || child.signalCode !== null;
            if (groupGone && rootExited) return true;
            const remaining = until - (yield* Clock.currentTimeMillis);
            // Darwin can report EPERM while an exiting group is being reaped.
            // Retry within the same deadline, but only ESRCH confirms absence.
            if (remaining <= 0) {
              if (group === "permission") return yield* closeFailure("permission");
              return false;
            }
            yield* Effect.sleep(Math.min(options.pollIntervalMs, remaining));
          }
        });

      const terminate = Effect.gen(function* () {
        if (pid !== undefined) {
          if (!Number.isSafeInteger(pid) || pid <= 0) return yield* closeFailure("failed");
          yield* Effect.try({
            try: () => {
              child.stdin.end();
            },
            catch: () =>
              duplexProcessError("close", "failed", "Unable to close child process input."),
          }).pipe(Effect.ignore);
          yield* checkedSignal("SIGTERM");
          const graceful = yield* awaitGone(
            Math.min(deadline, startedAt + options.gracefulTimeoutMs),
          );
          if (!graceful) {
            yield* checkedSignal("SIGKILL");
            const forceDeadline = Math.min(
              deadline,
              (yield* Clock.currentTimeMillis) + options.forceTimeoutMs,
            );
            if (!(yield* awaitGone(forceDeadline))) return yield* closeFailure("timeout");
          }
        }
        destroyStreams(child);
        const remaining = Math.max(0, deadline - (yield* Clock.currentTimeMillis));
        // The timeout's child wait must be interruptible even inside ordered cleanup.
        yield* options.nativeClosed.pipe(
          Effect.interruptible,
          Effect.timeoutOrElse({
            duration: remaining,
            orElse: () => Effect.fail(closeFailure("timeout")),
          }),
        );
      });
      yield* terminate.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (!groupGone && pid !== undefined && Number.isSafeInteger(pid) && pid > 0)
              signalGroup(pid, "SIGKILL");
            destroyStreams(child);
          }),
        ),
      );
    }),
  );
