// Node process-tree ownership is intentionally isolated at this boundary.
// @effect-diagnostics effect/nodeBuiltinImport:off
import { hasObjectRuntimeType } from "pi-cosmic-core";
import { spawn, type ChildProcess as NodeChildProcess } from "node:child_process";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

const isNoSuchProcess = <ErrorInput>(error: ErrorInput): boolean =>
  hasObjectRuntimeType(error) && error !== null && "code" in error && error.code === "ESRCH";

export interface ProcessTreeRuntime {
  readonly platform?: NodeJS.Platform;
  readonly taskkillTimeoutMillis?: number;
  readonly spawnTaskkill?: (pid: number, mode: "graceful" | "force") => NodeChildProcess;
}

export class ProcessTreeTerminationError extends Schema.TaggedError<ProcessTreeTerminationError>()(
  "ProcessTreeTerminationError",
  {
    operation: Schema.String,
    code: Schema.Literals([
      "taskkill_spawn_failed",
      "taskkill_exit",
      "taskkill_timeout",
      "group_signal_failed",
    ]),
    message: Schema.String,
  },
) {}

const processTreeError = (
  operation: string,
  code: ProcessTreeTerminationError["code"],
  message: string,
) => new ProcessTreeTerminationError({ operation, code, message });

const systemErrorCode = <ErrorInput>(error: ErrorInput): string | undefined => {
  if (
    error === null ||
    !hasObjectRuntimeType(error) ||
    !("code" in error) ||
    !Predicate.isString(error.code)
  )
    return undefined;
  return /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : undefined;
};

const systemMessage = <ErrorInput>(message: string, error: ErrorInput): string => {
  const code = systemErrorCode(error);
  return code === undefined ? message : `${message} (${code})`;
};

const defaultSpawnTaskkill = (pid: number, mode: "graceful" | "force"): NodeChildProcess =>
  spawn("taskkill", ["/pid", String(pid), "/T", ...(mode === "force" ? ["/F"] : [])], {
    stdio: "ignore",
    windowsHide: true,
  });

const terminateWindowsTree = (
  child: NodeChildProcess,
  pid: number,
  mode: "graceful" | "force",
  runtime: ProcessTreeRuntime,
) => {
  if (child.exitCode !== null || child.signalCode !== null) return Effect.void;
  const timeoutMillis = runtime.taskkillTimeoutMillis ?? 2_000;
  const spawnTaskkill = runtime.spawnTaskkill ?? defaultSpawnTaskkill;
  const waitForTaskkill = Effect.callback<void, ProcessTreeTerminationError>((resume) => {
    let killer: NodeChildProcess;
    try {
      killer = spawnTaskkill(pid, mode);
    } catch (error) {
      resume(
        Effect.fail(
          processTreeError(
            "spawn taskkill",
            "taskkill_spawn_failed",
            systemMessage("Unable to start the Windows process-tree terminator.", error),
          ),
        ),
      );
      return;
    }
    killer.unref?.();
    let settled = false;
    const detach = () => {
      killer.off("error", onError);
      killer.off("close", onClose);
    };
    const finish = (effect: Effect.Effect<void, ProcessTreeTerminationError>): void => {
      if (settled) return;
      settled = true;
      detach();
      resume(effect);
    };
    const onError = (error: Error) =>
      finish(
        Effect.fail(
          processTreeError(
            "run taskkill",
            "taskkill_spawn_failed",
            systemMessage("The Windows process-tree terminator failed to start.", error),
          ),
        ),
      );
    const onClose = (code: number | null) => {
      if (code === 0 || child.exitCode !== null || child.signalCode !== null) {
        finish(Effect.void);
        return;
      }
      finish(
        Effect.fail(
          processTreeError(
            "run taskkill",
            "taskkill_exit",
            `The Windows process-tree terminator exited with code ${code ?? "unknown"}.`,
          ),
        ),
      );
    };
    killer.once("error", onError);
    killer.once("close", onClose);
    return Effect.sync(() => {
      if (settled) return;
      settled = true;
      detach();
      // A cancelled helper no longer owns this operation, but a delayed spawn error must still
      // be observed after the primary listeners are removed.
      killer.on("error", () => {});
      try {
        killer.kill();
      } catch {
        // Interruption already owns completion even if the helper cannot be killed.
      }
    });
  });

  return waitForTaskkill.pipe(
    Effect.timeoutOption(timeoutMillis),
    Effect.flatMap((completed) =>
      Option.isSome(completed)
        ? Effect.void
        : Effect.fail(
            processTreeError(
              "run taskkill",
              "taskkill_timeout",
              `The Windows process-tree terminator timed out after ${timeoutMillis} ms.`,
            ),
          ),
    ),
  );
};

const terminatePosixTree = (child: NodeChildProcess, pid: number, mode: "graceful" | "force") =>
  Effect.suspend(() => {
    const signal = mode === "force" ? "SIGKILL" : "SIGTERM";
    try {
      process.kill(-pid, signal);
      return Effect.void;
    } catch (error) {
      if (isNoSuchProcess(error)) return Effect.void;
      // If the group could not be signalled while the leader is still alive, retain the
      // direct-child fallback used for unusual spawn/platform configurations.
      if (child.exitCode === null && child.signalCode === null) {
        try {
          if (child.kill(signal)) return Effect.void;
        } catch {
          // Preserve the original group-signalling failure below.
        }
      }
      return Effect.fail(
        processTreeError(
          "signal process group",
          "group_signal_failed",
          systemMessage("Unable to signal the owned process tree.", error),
        ),
      );
    }
  });

/** Signal the process tree owned by a detached child with an interruptible Windows deadline. */
export const terminateProcessTreeEffect = Effect.fn("ProcessTree.terminate")(function* (
  child: NodeChildProcess,
  mode: "graceful" | "force",
  runtime: ProcessTreeRuntime = {},
) {
  const pid = child.pid;
  if (!pid) return;
  const platform = runtime.platform ?? process.platform;
  if (platform === "win32") return yield* terminateWindowsTree(child, pid, mode, runtime);
  return yield* terminatePosixTree(child, pid, mode);
});

/** Promise compatibility door for synchronous Node callbacks and existing boundary consumers. */
export const terminateProcessTree = (
  child: NodeChildProcess,
  mode: "graceful" | "force",
  runtime: ProcessTreeRuntime = {},
): Promise<void> =>
  Effect.runPromise(Effect.exit(terminateProcessTreeEffect(child, mode, runtime))).then((exit) => {
    if (Exit.isSuccess(exit)) return;
    const failure = Cause.findErrorOption(exit.cause);
    if (Option.isSome(failure)) throw failure.value;
    throw Cause.squash(exit.cause);
  });
