import {
  managerActivityColor,
  managerActivityGlyph,
  managerActivityLabel,
  type ManagerActivityKind,
  type ManagerStatusColor,
} from "pi-cosmic-ui/manager";
import type { SubagentRunState } from "../run/model.ts";

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

export const runStateGlyph = (state: SubagentRunState): string =>
  managerActivityGlyph(RUN_STATE_KINDS[state]);

export const animatedRunStateGlyph = (state: SubagentRunState, frame: number): string =>
  managerActivityGlyph(RUN_STATE_KINDS[state], frame);

/** The shared word, except where a run's own word is more precise. */
export const runStateLabel = (state: SubagentRunState): string =>
  state === "waiting_for_parent"
    ? "waiting for reply"
    : state === "reported"
      ? "reported"
      : managerActivityLabel(RUN_STATE_KINDS[state]);

export const runStateColor = (state: SubagentRunState): ManagerStatusColor =>
  managerActivityColor(RUN_STATE_KINDS[state]);
