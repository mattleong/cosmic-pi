// Child-based process-tree policy over pi-cosmic-core's signalling and Windows terminator.
import {
  processGroupSignalError,
  signalProcessGroup,
  terminateWindowsProcessTree,
  type WindowsProcessTreeTermination,
} from "pi-cosmic-core";
import * as Effect from "effect/Effect";
import type { NodeChildProcess } from "./node-builtins.ts";

export interface ProcessTreeRuntime extends Pick<
  WindowsProcessTreeTermination,
  "spawnTaskkill" | "taskkillTimeoutMillis"
> {
  readonly platform?: NodeJS.Platform | undefined;
}

const hasExited = (child: NodeChildProcess) => child.exitCode !== null || child.signalCode !== null;

/** The direct-leader fallback for unusual spawn configurations, only while the leader lives. */
const killLiveLeader = (child: NodeChildProcess, signal: NodeJS.Signals) => {
  if (hasExited(child)) return false;
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
};

/** Signal the process tree owned by a detached child with an interruptible Windows deadline. */
export const terminateProcessTree = Effect.fn("ProcessTree.terminate")(function* (
  child: NodeChildProcess,
  mode: "graceful" | "force",
  { platform = process.platform, ...windows }: ProcessTreeRuntime = {},
) {
  const pid = child.pid;
  if (!pid) return;
  // An exited leader skips taskkill, so a reused Windows PID is never targeted.
  if (platform === "win32")
    return yield* terminateWindowsProcessTree({
      ...windows,
      pid,
      mode,
      targetExited: () => hasExited(child),
    });
  const signal = mode === "force" ? "SIGKILL" : "SIGTERM";
  const result = signalProcessGroup(pid, signal);
  if (result === "present" || result === "absent" || killLiveLeader(child, signal)) return;
  return yield* processGroupSignalError(result);
});
