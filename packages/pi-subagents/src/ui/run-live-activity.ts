import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { countLabel } from "pi-cosmic-core/display";
import type { SubagentRunView, SubagentSessionEvent } from "../run/model.ts";
import { SUBAGENT_TOOL_NAME } from "../run/tool-policy.ts";

const LIVE_TARGET_WIDTH = 160;
const MAX_WAITING_NAMES = 3;

export type ToolEvent = Extract<SubagentSessionEvent, { readonly type: "tool" }>;

/** A run's display name by ID, when the projection still holds it. */
export type RunNameLookup = (runId: string) => string | undefined;

export const runNameLookup = (runs: ReadonlyArray<SubagentRunView>): RunNameLookup => {
  const names = new Map(Arr.map(runs, (run) => [run.id, run.name] as const));
  return (id) => names.get(id);
};

const runningTool = (run: SubagentRunView): ToolEvent | undefined =>
  Option.getOrUndefined(
    Arr.findLast(
      run.sessionEvents,
      (event): event is ToolEvent => event.type === "tool" && event.state === "running",
    ),
  );

/** Whether a run's live phrase names other runs, so it changes when they are renamed. */
export const isWaitingOnRuns = (run: SubagentRunView): boolean =>
  run.state === "running" &&
  (runningTool(run)?.toolName ?? run.currentTool) === SUBAGENT_TOOL_NAME.await;

/** Who an `agent_await` call waits on: `waiting on Read tests`, or a count once names are gone. */
export const waitingOn = (event: ToolEvent | undefined, nameOf: RunNameLookup): string => {
  const ids = event?.awaitedRunIds ?? [];
  const known = Arr.flatMap(ids, (id) => Arr.fromNullishOr(nameOf(id)));
  if (ids.length === 0 || known.length < ids.length)
    return ids.length > 1
      ? `waiting on ${countLabel(ids.length, "subagent")}`
      : "waiting on a subagent";
  const shown = Arr.join(known.slice(0, MAX_WAITING_NAMES), ", ");
  return known.length > MAX_WAITING_NAMES
    ? `waiting on ${shown} and ${known.length - MAX_WAITING_NAMES} more`
    : `waiting on ${shown}`;
};

/**
 * What a running agent is doing now, phrased: `running bash · sleep 25`, `waiting on Read tests`
 * while it awaits its children, its last progress, or `thinking` between tool calls.
 */
export const runLiveActivity = (
  run: SubagentRunView,
  nameOf: RunNameLookup,
): string | undefined => {
  if (run.state !== "running") return undefined;
  const tool = runningTool(run);
  const toolName = tool?.toolName ?? run.currentTool;
  if (toolName === SUBAGENT_TOOL_NAME.await) return waitingOn(tool, nameOf);
  if (tool) {
    const shown = tool.target && Str.trim(Str.split(Str.trim(tool.target), "\n")[0] ?? "");
    return shown
      ? `running ${tool.toolName} · ${Fn.pipe(shown, Str.slice(0, LIVE_TARGET_WIDTH))}`
      : `running ${tool.toolName}`;
  }
  if (run.currentTool) return `running ${run.currentTool}`;
  return run.progress ?? "thinking";
};
