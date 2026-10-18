import {
  managerActivityColor,
  managerActivityGlyph,
  managerActivityLabel,
  type ManagerActivityKind,
  type ManagerStatusColor,
} from "pi-cosmic-ui/manager";
import {
  hasSubagentCapability,
  hasUnresolvedSteeringDelivery,
  isActiveRunState,
  isResumableRunState,
  type SubagentRunState,
  type SubagentRunView,
} from "../run/model.ts";
import { runCleanupAttention } from "../run/attention.ts";

const RUN_STATE_KINDS = {
  starting: "pending",
  running: "running",
  waiting_for_parent: "waiting",
  paused: "paused",
  reported: "done",
  completed: "done",
  failed: "failed",
  stopping: "stopping",
  stopped: "stopped",
} as const satisfies Readonly<Record<SubagentRunState, ManagerActivityKind>>;

export const runStateGlyph = (state: SubagentRunState, frame?: number): string =>
  managerActivityGlyph(RUN_STATE_KINDS[state], frame);

export const runStateLabel = (state: SubagentRunState): string =>
  state === "waiting_for_parent"
    ? "waiting for reply"
    : managerActivityLabel(RUN_STATE_KINDS[state]);

export const runStateColor = (state: SubagentRunState): ManagerStatusColor =>
  managerActivityColor(RUN_STATE_KINDS[state]);

export type RunMessageMode = "guidance" | "reply";

export const runMessageMode = (run: SubagentRunView): RunMessageMode | undefined => {
  if (run.state === "waiting_for_parent")
    return hasSubagentCapability(run, "parent-contact") ? "reply" : undefined;
  if (hasUnresolvedSteeringDelivery(run)) return undefined;
  return run.state === "running" && hasSubagentCapability(run, "steer") ? "guidance" : undefined;
};

export const canInterruptRun = (run: SubagentRunView): boolean =>
  (run.state === "running" || run.state === "waiting_for_parent") &&
  hasSubagentCapability(run, "interrupt") &&
  !hasUnresolvedSteeringDelivery(run);

export const canStopRun = (run: SubagentRunView): boolean =>
  (isActiveRunState(run.state) && run.state !== "stopping") ||
  (run.cleanup?.disposition === "quarantined" && run.cleanup.recovery === "stop");

export const canResumeRun = (run: SubagentRunView): boolean =>
  isResumableRunState(run.state) &&
  run.supersededByRunId === undefined &&
  runCleanupAttention(run) === undefined &&
  hasSubagentCapability(run, "resume");

const UNNAMEABLE_STATES: ReadonlySet<SubagentRunState> = new Set([
  "starting",
  "stopping",
  "stopped",
  "failed",
]);

export const canRenameRun = (run: SubagentRunView): boolean => !UNNAMEABLE_STATES.has(run.state);
