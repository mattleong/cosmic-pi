import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

type ProcessSignalResult = "present" | "absent" | "permission" | "failed";

const send = (target: number, signal: NodeJS.Signals | 0): ProcessSignalResult => {
  try {
    process.kill(target, signal);
    return "present";
  } catch (cause) {
    const code = Predicate.hasProperty(cause, "code") ? cause.code : undefined;
    return Match.value(code).pipe(
      Match.when("ESRCH", (): ProcessSignalResult => "absent"),
      Match.when("EPERM", (): ProcessSignalResult => "permission"),
      Match.orElse((): ProcessSignalResult => "failed"),
    );
  }
};
const signalable = Schema.is(Schema.Int.check(Schema.isGreaterThan(0)));

export const signalProcessGroup = (pid: number | undefined, signal: NodeJS.Signals | 0) =>
  signalable(pid) ? send(-pid, signal) : "failed";

export const signalProcess = (pid: number | undefined, signal: NodeJS.Signals | 0) =>
  signalable(pid) ? send(pid, signal) : "failed";

/**
 * Waits, without a deadline, until the process group is gone (true) or can no longer be inspected
 * (false). Interruptible, so callers can race it with their own stop condition.
 */
export const awaitProcessGroupExit = Effect.fnUntraced(function* (
  pid: number | undefined,
): Effect.fn.Return<boolean> {
  while (true) {
    const observed = signalProcessGroup(pid, 0);
    if (observed === "absent") return true;
    if (observed === "failed") return false;
    // macOS may report EPERM briefly while a terminated group is being reaped.
    yield* Effect.sleep(10);
  }
}, Effect.interruptible);

export const confirmProcessGroupExit = (
  pid: number | undefined,
  timeoutMillis: number,
): Effect.Effect<boolean> =>
  awaitProcessGroupExit(pid).pipe(
    Effect.timeoutOption(Math.max(1, timeoutMillis)),
    Effect.map((result) => Option.isSome(result) && result.value),
  );

export class ProcessTreeError extends Schema.TaggedError<
  ProcessTreeError,
  { readonly brand: unique symbol }
>()("ProcessTreeError", {
  operation: Schema.String,
  code: Schema.Literal("group_signal_failed"),
  message: Schema.String,
}) {}

export const processGroupSignalError = (result: "permission" | "failed") =>
  new ProcessTreeError({
    operation: "signal process group",
    code: "group_signal_failed",
    message: `Unable to signal the owned process tree.${result === "permission" ? " (EPERM)" : ""}`,
  });
