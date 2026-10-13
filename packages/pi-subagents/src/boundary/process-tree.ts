import { processGroupSignalError, signalProcessGroup } from "pi-cosmic-core";
import * as Effect from "effect/Effect";
import type { NodeChildProcess } from "./node-builtins.ts";

const hasExited = (child: NodeChildProcess) => child.exitCode !== null || child.signalCode !== null;

const killLiveLeader = (child: NodeChildProcess, signal: NodeJS.Signals) => {
  if (hasExited(child)) return false;
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
};

export const terminateProcessTree = Effect.fn("ProcessTree.terminate")(function* (
  child: NodeChildProcess,
  mode: "graceful" | "force",
) {
  const pid = child.pid;
  if (!pid) return yield* Effect.void;
  const signal = mode === "force" ? "SIGKILL" : "SIGTERM";
  const result = signalProcessGroup(pid, signal);
  if (result === "present" || result === "absent" || killLiveLeader(child, signal))
    return yield* Effect.void;
  return yield* processGroupSignalError(result);
});
