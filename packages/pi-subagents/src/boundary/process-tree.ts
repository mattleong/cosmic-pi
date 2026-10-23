import { processGroupSignalError, signalProcessGroup } from "pi-cosmic-core/platform/process-tree";
import { runBoundedProcessNode } from "pi-cosmic-core/platform/process";
import { type NodeChildProcess } from "pi-cosmic-core/platform/node-builtins";
import * as Effect from "effect/Effect";
import * as Str from "effect/String";
import * as Fn from "effect/Function";
import { processCauseError, processError, type SubagentProcessError } from "../run/errors.ts";

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

const PROCESS_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/;

interface ProcessRow {
  readonly pid: number;
  readonly group: number;
}

export const descendantGroupsFromTable = (
  table: string,
  groupId: number,
): ReadonlyArray<number> | undefined => {
  const children = new Map<number, ProcessRow[]>();
  const pending: number[] = [];
  for (const line of Str.split(table, "\n")) {
    if (Str.trim(line) === "") continue;
    const match = PROCESS_ROW.exec(line);
    if (!match) return undefined;
    const pid = Number(match[1]);
    const parent = Number(match[2]);
    const group = Number(match[3]);
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      !Number.isSafeInteger(parent) ||
      parent < 0 ||
      !Number.isSafeInteger(group) ||
      group < 0
    )
      return undefined;
    if (Fn.pipe(match[4] ?? "", Str.startsWith("Z"))) continue;
    if (group === groupId) pending.push(pid);
    const siblings = children.get(parent);
    if (siblings) siblings.push({ pid, group });
    else children.set(parent, [{ pid, group }]);
  }
  if (pending.length === 0) return undefined;
  const visited = new Set(pending);
  const groups = new Set<number>();
  for (let index = 0; index < pending.length; index += 1)
    for (const child of children.get(pending[index] ?? 0) ?? []) {
      if (visited.has(child.pid)) continue;
      visited.add(child.pid);
      pending.push(child.pid);
      // Kernel processes may have PGID 0, but it cannot identify an owned descendant group.
      if (child.group === 0) return undefined;
      if (child.group !== groupId) groups.add(child.group);
    }
  return [...groups];
};

/**
 * Process groups that members of an owned group started outside it, such as the group Pi's bash
 * tool gives each command. A signal to the owned group misses them, so cleanup confirms them
 * separately. Incomplete discovery is a failure, never evidence of an empty descendant set.
 */
export const detachedDescendantGroups = (
  groupId: number,
  run: typeof runBoundedProcessNode = runBoundedProcessNode,
): Effect.Effect<ReadonlyArray<number>, SubagentProcessError> =>
  run({
    executable: "ps",
    args: ["-A", "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "stat="],
    environment: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    stdoutLimitBytes: 8 * 1024 * 1024,
    stderrLimitBytes: 16 * 1024,
    timeoutMillis: 2_000,
  }).pipe(
    Effect.mapError((error) =>
      processCauseError("snapshot detached descendants", error, "descendant_snapshot_failed"),
    ),
    Effect.flatMap((result) =>
      result.code === 0 && !result.overflowed && !result.timedOut && !result.cleanupUnconfirmed
        ? Effect.suspend(() => {
            const groups = descendantGroupsFromTable(result.stdout, groupId);
            return groups
              ? Effect.succeed(groups)
              : Effect.fail(
                  processError(
                    "snapshot detached descendants",
                    "descendant_snapshot_malformed",
                    "Detached descendant snapshot contained malformed process rows.",
                  ),
                );
          })
        : Effect.fail(
            processError(
              "snapshot detached descendants",
              "descendant_snapshot_incomplete",
              result.timedOut
                ? "Detached descendant snapshot timed out."
                : result.overflowed
                  ? "Detached descendant snapshot exceeded its output limit."
                  : `Detached descendant snapshot failed (exit ${String(result.code)}). ${result.stderr}`,
            ),
          ),
    ),
  );
