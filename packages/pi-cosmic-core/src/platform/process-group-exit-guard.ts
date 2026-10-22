import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { signalProcessGroup } from "./process-tree.ts";

export interface ProcessGroupExitGuard {
  /** Stops covering the group once its owner confirmed that it settled. Idempotent. */
  readonly release: Effect.Effect<void>;
}

// One registration per guard, so a reused leader PID never cancels another owner's guard.
const guardedGroups = new Set<{ readonly pid: number }>();

// Host exit runs listeners synchronously and never resumes asynchronous cleanup.
const killGuardedGroups = () => {
  for (const { pid } of guardedGroups) signalProcessGroup(pid, "SIGKILL");
};

const guardGroup = (pid: number) => {
  const registration = { pid };
  if (guardedGroups.size === 0) process.on("exit", killGuardedGroups);
  guardedGroups.add(registration);
  return () => {
    if (!guardedGroups.delete(registration)) return;
    if (guardedGroups.size === 0) process.off("exit", killGuardedGroups);
  };
};

/**
 * Kills a detached process group with `SIGKILL` if the host process exits while the guard is
 * held, including `process.exit()` paths that skip scope cleanup. Release it once the group is
 * confirmed settled; closing the scope releases it as well. Host `SIGKILL` cannot be covered,
 * and processes that leave the group are not reached.
 */
export const guardProcessGroupAtHostExit = (
  pid: number,
): Effect.Effect<ProcessGroupExitGuard, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const release = guardGroup(pid);
      return { release: Effect.sync(release) } satisfies ProcessGroupExitGuard;
    }),
    (guard) => guard.release,
  );
