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
  type SubagentRunState,
  type SubagentRunView,
} from "../run/model.ts";
import type { WorkflowRunState } from "../workflow/model.ts";

/** Each run state in the shared activity vocabulary every extension draws from. */
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

/** A run state's glyph; `frame` animates the live states. */
export const runStateGlyph = (state: SubagentRunState, frame?: number): string =>
  managerActivityGlyph(RUN_STATE_KINDS[state], frame);

/** The shared word, except where a run's own word is more precise. */
export const runStateLabel = (state: SubagentRunState): string =>
  state === "waiting_for_parent"
    ? "waiting for reply"
    : managerActivityLabel(RUN_STATE_KINDS[state]);

export const runStateColor = (state: SubagentRunState): ManagerStatusColor =>
  managerActivityColor(RUN_STATE_KINDS[state]);

const WORKFLOW_STATE_KINDS = {
  running: "running",
  stopping: "stopping",
  completed: "done",
  failed: "failed",
  stopped: "stopped",
} as const satisfies Readonly<Record<WorkflowRunState, ManagerActivityKind>>;

/** A workflow run's state in the shared words, for people; a teardown interrupts a run. */
export const workflowStateLabel = (state: WorkflowRunState | "interrupted"): string =>
  state === "interrupted" ? "interrupted" : managerActivityLabel(WORKFLOW_STATE_KINDS[state]);

// What a run's state and backend let a person do, shared by `/subagents` and Activity so both
// offer the same actions; each surface adds only its own safeguards.

export type RunMessageMode = "guidance" | "reply";

/**
 * The one message a run can currently accept. Pending or unresolved native guidance rejects new
 * input and queue-cancelling interruption; parent-question replies and stop stay available.
 */
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

export const canResumeRun = (run: SubagentRunView): boolean =>
  (run.state === "paused" || run.state === "completed") && hasSubagentCapability(run, "resume");

const UNNAMEABLE_STATES: ReadonlySet<SubagentRunState> = new Set([
  "starting",
  "stopping",
  "stopped",
  "failed",
]);

export const canRenameRun = (run: SubagentRunView): boolean =>
  hasSubagentCapability(run, "rename-display") && !UNNAMEABLE_STATES.has(run.state);
