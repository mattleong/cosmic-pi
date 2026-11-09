import {
  managerActivityColor,
  managerActivityGlyph,
  managerActivityLabel,
  managerActivityMeaning,
  SUITE_STATUS_GLYPHS,
  withoutStatusGlyphWords,
  type ManagerActivityKind,
  type ManagerStatusColor,
  type StatusGlyphMeaning,
} from "pi-cosmic-ui/manager";
import {
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
  completed: "done",
  failed: "failed",
  stopping: "stopping",
  stopped: "stopped",
} as const satisfies Readonly<Record<SubagentRunState, ManagerActivityKind>>;

export const runStateGlyph = (state: SubagentRunState, frame?: number): string =>
  managerActivityGlyph(RUN_STATE_KINDS[state], frame);

/**
 * Marks running work in a row that never redraws, where a spinner would freeze on one frame: the
 * suite's neutral glyph, as background-task snapshots of running tasks use.
 */
export const SNAPSHOT_RUNNING_GLYPH = SUITE_STATUS_GLYPHS.neutral;

/** A run's glyph in a saved snapshot: running work is marked, not drawn as a stopped spinner. */
export const runStateSnapshotGlyph = (state: SubagentRunState): string =>
  state === "running" ? SNAPSHOT_RUNNING_GLYPH : runStateGlyph(state);

export const runStateLabel = (state: SubagentRunState): string =>
  state === "waiting_for_parent"
    ? "waiting for reply"
    : managerActivityLabel(RUN_STATE_KINDS[state]);

/**
 * What a run's {@link runStateSnapshotGlyph} says in words. Running work's neutral `•` and a
 * question's shared `?` say nothing, so words beside them stay.
 */
export const runSnapshotGlyphMeaning = (state: SubagentRunState): StatusGlyphMeaning | undefined =>
  state === "running" ? undefined : managerActivityMeaning(RUN_STATE_KINDS[state]);

/**
 * A listed run's state word beside its snapshot glyph, or undefined where the glyph already says
 * it: `‖ auth-review`, not `‖ auth-review · paused`; `• auth-review · running` and
 * `? db-migration · waiting for reply` keep theirs.
 */
export const runRowStateLabel = (state: SubagentRunState): string | undefined =>
  withoutStatusGlyphWords(runStateLabel(state), runSnapshotGlyphMeaning(state));

export const runStateColor = (state: SubagentRunState): ManagerStatusColor =>
  managerActivityColor(RUN_STATE_KINDS[state]);

export type RunMessageMode = "guidance" | "reply";

export const runMessageMode = (run: SubagentRunView): RunMessageMode | undefined => {
  if (run.state === "waiting_for_parent") return "reply";
  return run.state === "running" ? "guidance" : undefined;
};

export const canInterruptRun = (run: SubagentRunView): boolean =>
  run.state === "running" || run.state === "waiting_for_parent";

export const canStopRun = (run: SubagentRunView): boolean =>
  (isActiveRunState(run.state) && run.state !== "stopping") ||
  (run.cleanup?.disposition === "quarantined" && run.cleanup.recovery === "stop");

export const canResumeRun = (run: SubagentRunView): boolean =>
  isResumableRunState(run.state) && runCleanupAttention(run) === undefined;

const UNNAMEABLE_STATES: ReadonlySet<SubagentRunState> = new Set([
  "starting",
  "stopping",
  "stopped",
  "failed",
]);

export const canRenameRun = (run: SubagentRunView): boolean => !UNNAMEABLE_STATES.has(run.state);
