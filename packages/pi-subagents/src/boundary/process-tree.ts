import { processGroupSignalError, runBoundedProcessNode, signalProcessGroup } from "pi-cosmic-core";
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

const PROCESS_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)/;

interface ProcessRow {
  readonly pid: number;
  readonly group: number;
}

export const descendantGroupsFromTable = (
  table: string,
  groupId: number,
): ReadonlyArray<number> => {
  const children = new Map<number, ProcessRow[]>();
  const pending: number[] = [];
  for (const line of table.split("\n")) {
    const match = PROCESS_ROW.exec(line);
    if (!match || match[4]?.startsWith("Z")) continue;
    const pid = Number(match[1]);
    const parent = Number(match[2]);
    const group = Number(match[3]);
    if (group === groupId) pending.push(pid);
    const siblings = children.get(parent);
    if (siblings) siblings.push({ pid, group });
    else children.set(parent, [{ pid, group }]);
  }
  const visited = new Set(pending);
  const groups = new Set<number>();
  for (let index = 0; index < pending.length; index += 1)
    for (const child of children.get(pending[index] ?? 0) ?? []) {
      if (visited.has(child.pid)) continue;
      visited.add(child.pid);
      pending.push(child.pid);
      if (child.group !== groupId) groups.add(child.group);
    }
  return [...groups];
};

/**
 * Process groups that members of an owned group started outside it, such as the group Pi's bash
 * tool gives each command. A signal to the owned group misses them, so cleanup confirms them
 * separately. Best effort: the result is empty when `ps` is unavailable or fails.
 */
export const detachedDescendantGroups = (groupId: number): Effect.Effect<ReadonlyArray<number>> =>
  runBoundedProcessNode({
    executable: "ps",
    args: ["-A", "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "stat="],
    environment: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    stdoutLimitBytes: 8 * 1024 * 1024,
    stderrLimitBytes: 16 * 1024,
    timeoutMillis: 2_000,
  }).pipe(
    Effect.map((result) =>
      result.code === 0 && !result.overflowed && !result.timedOut
        ? descendantGroupsFromTable(result.stdout, groupId)
        : [],
    ),
    Effect.orElseSucceed(() => []),
  );
