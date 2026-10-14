import type { SubagentRunView } from "./model.ts";

export const STALL_IDLE_MILLIS = 2 * 60 * 1000;
export const STALL_TOOL_OPEN_MILLIS = 5 * 60 * 1000;
export const STALL_FAILED_TOOL_STREAK = 3;

export type RunStall =
  | { readonly kind: "idle"; readonly sinceMillis: number }
  | { readonly kind: "tool-open"; readonly toolName: string; readonly sinceMillis: number }
  | { readonly kind: "failing-tools"; readonly count: number };

type StallRun = Pick<SubagentRunView, "state" | "lastActivityAt" | "sessionEvents">;

/**
 * Signs that a running child may be stuck. They are presentation only: elapsed time is not a safe
 * reason to stop a run, so nothing acts on them automatically.
 */
export const runStall = (run: StallRun, now: number): RunStall | undefined => {
  if (run.state !== "running") return undefined;
  const tools = run.sessionEvents.filter((event) => event.type === "tool");
  // The oldest open tool, so a newer parallel call can't hide one that is stuck.
  const open = tools.find((event) => event.state === "running");
  if (open && now - open.startedAt >= STALL_TOOL_OPEN_MILLIS)
    return { kind: "tool-open", toolName: open.toolName, sinceMillis: now - open.startedAt };
  let failed = 0;
  for (const event of tools.toReversed()) {
    if (event.state === "running") continue;
    if (event.state !== "failed") break;
    failed += 1;
  }
  if (failed >= STALL_FAILED_TOOL_STREAK) return { kind: "failing-tools", count: failed };
  if (!open && now - run.lastActivityAt >= STALL_IDLE_MILLIS)
    return { kind: "idle", sinceMillis: now - run.lastActivityAt };
  return undefined;
};
