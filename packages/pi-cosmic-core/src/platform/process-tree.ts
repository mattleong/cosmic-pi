import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { nodeSpawn } from "./node-builtins.ts";

/** `present` means the signal was delivered; only ESRCH proves absence. */
export type ProcessSignalResult = "present" | "absent" | "permission" | "failed";

const send = (target: number, signal: NodeJS.Signals | 0): ProcessSignalResult => {
  try {
    process.kill(target, signal);
    return "present";
  } catch (cause) {
    const code = Predicate.hasProperty(cause, "code") ? cause.code : undefined;
    return code === "ESRCH" ? "absent" : code === "EPERM" ? "permission" : "failed";
  }
};
const signalable = (pid: number | undefined): pid is number =>
  pid !== undefined && Number.isSafeInteger(pid) && pid > 0;

/** Never signals a pid that is not a positive safe integer, so `-0` cannot reach Pi's group. */
export const signalProcessGroup = (pid: number | undefined, signal: NodeJS.Signals | 0) =>
  signalable(pid) ? send(-pid, signal) : "failed";

/** Single-process signal or liveness probe with the same pid validation. */
export const signalProcess = (pid: number | undefined, signal: NodeJS.Signals | 0) =>
  signalable(pid) ? send(pid, signal) : "failed";

export class ProcessTreeError extends Schema.TaggedError<ProcessTreeError>()("ProcessTreeError", {
  operation: Schema.String,
  code: Schema.Literals([
    "taskkill_spawn_failed",
    "taskkill_exit",
    "taskkill_timeout",
    "taskkill_detach_failed",
    "group_signal_failed",
  ]),
  message: Schema.String,
}) {}

const treeError = (operation: string, code: ProcessTreeError["code"], message: string) =>
  new ProcessTreeError({ operation, code, message });

/** Appends only a bounded uppercase errno code, never native error text. */
const withErrno = (message: string, cause: unknown) =>
  Predicate.hasProperty(cause, "code") &&
  Predicate.isString(cause.code) &&
  /^[A-Z0-9_]{1,32}$/.test(cause.code)
    ? `${message} (${cause.code})`
    : message;

/** POSIX group-signal failure after any caller fallback; EPERM is the only errno kept. */
export const processGroupSignalError = (result: "permission" | "failed") =>
  treeError(
    "signal process group",
    "group_signal_failed",
    `Unable to signal the owned process tree.${result === "permission" ? " (EPERM)" : ""}`,
  );

type TerminatorListener = (result: Error | number | null) => void;

export interface ProcessTreeTerminatorChild {
  on(event: "exit" | "error", listener: TerminatorListener): void;
  removeListener(event: "exit" | "error", listener: TerminatorListener): void;
  kill(signal: NodeJS.Signals): void;
  unref(): void;
}

export type ProcessTreeTerminatorSpawn = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly stdio: "ignore"; readonly windowsHide: true },
) => ProcessTreeTerminatorChild;

export interface WindowsProcessTreeTermination {
  readonly pid: number;
  readonly mode: "graceful" | "force";
  readonly spawnTaskkill?: ProcessTreeTerminatorSpawn | undefined;
  /** Defaults to 2000. */
  readonly taskkillTimeoutMillis?: number | undefined;
  /** When given, an exited target skips taskkill (PID-reuse guard), and a nonzero taskkill
   * exit after the target exited counts as success. Error events always fail. */
  readonly targetExited?: (() => boolean) | undefined;
}

const defaultSpawnTaskkill: ProcessTreeTerminatorSpawn = nodeSpawn;

/**
 * Windows lacks POSIX process groups, so `taskkill /pid PID /T [/F]` terminates the tree.
 * Interruption and the timeout clean up synchronously and never await taskkill's own exit:
 * remove the settle listeners, add a harmless late-error listener, SIGKILL, then unref.
 */
export const terminateWindowsProcessTree = (
  termination: WindowsProcessTreeTermination,
): Effect.Effect<void, ProcessTreeError> => {
  const { pid, mode, targetExited } = termination;
  const spawnTaskkill = termination.spawnTaskkill ?? defaultSpawnTaskkill;
  const timeoutMillis = termination.taskkillTimeoutMillis ?? 2_000;
  return Effect.callback<void, ProcessTreeError>((resume) => {
    // Checked when the Effect runs, not when it is built, so a reused Effect never goes stale.
    if (targetExited?.()) return resume(Effect.void);
    let killer: ProcessTreeTerminatorChild;
    try {
      killer = spawnTaskkill(
        "taskkill",
        ["/pid", String(pid), "/T", ...(mode === "force" ? ["/F"] : [])],
        { stdio: "ignore", windowsHide: true },
      );
    } catch (cause) {
      const message = "Unable to start the Windows process-tree terminator.";
      resume(
        Effect.fail(
          treeError("spawn taskkill", "taskkill_spawn_failed", withErrno(message, cause)),
        ),
      );
      return;
    }
    // A throwing cleanup method must not suppress the remaining cleanup attempts.
    const attempt = (operation: () => void): boolean => {
      try {
        operation();
        return true;
      } catch {
        return false;
      }
    };
    let settled = false;
    let cleaned = false;
    const startFailure = (cause: unknown) =>
      treeError(
        "run taskkill",
        "taskkill_spawn_failed",
        withErrno("The Windows process-tree terminator failed to start.", cause),
      );
    const removeListeners = () => {
      const exitRemoved = attempt(() => killer.removeListener("exit", onExit));
      const errorRemoved = attempt(() => killer.removeListener("error", onError));
      return exitRemoved && errorRemoved;
    };
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      settled = true;
      removeListeners();
      attempt(() => killer.on("error", () => {}));
      attempt(() => killer.kill("SIGKILL"));
      attempt(() => killer.unref());
    };
    const settle = (failure: ProcessTreeError | undefined) => {
      if (settled) return;
      settled = true;
      const detached = removeListeners();
      if (!detached) cleanup();
      if (failure) resume(Effect.fail(failure));
      else if (detached) resume(Effect.void);
      else {
        const message = "The Windows process-tree terminator could not be detached.";
        resume(Effect.fail(treeError("run taskkill", "taskkill_detach_failed", message)));
      }
    };
    const onError: TerminatorListener = (cause) => settle(startFailure(cause));
    const onExit: TerminatorListener = (code) =>
      settle(
        code === 0 || targetExited?.()
          ? undefined
          : treeError(
              "run taskkill",
              "taskkill_exit",
              `The Windows process-tree terminator exited with code ${Predicate.isNumber(code) ? code : "unknown"}.`,
            ),
      );
    try {
      killer.on("exit", onExit);
      killer.on("error", onError);
    } catch (cause) {
      cleanup();
      resume(Effect.fail(startFailure(cause)));
      return;
    }
    return Effect.sync(cleanup);
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeoutMillis,
      orElse: () =>
        Effect.fail(
          treeError(
            "run taskkill",
            "taskkill_timeout",
            `The Windows process-tree terminator timed out after ${timeoutMillis} ms.`,
          ),
        ),
    }),
  );
};
