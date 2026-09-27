/** Background task states in the shared activity vocabulary every extension draws from. */
import {
  managerActivityColor,
  managerActivityGlyph,
  managerActivityLabel,
  type ManagerActivityKind,
} from "pi-cosmic-ui/manager";
import { sanitizeTerminalLine } from "pi-cosmic-core";
import type { BackgroundTaskView } from "../task/model.ts";

/** A task as users know it: its name, else its command. */
export const taskDisplayName = (task: Pick<BackgroundTaskView, "name" | "command">): string =>
  sanitizeTerminalLine(task.name?.trim() || task.command);

const STATE_KINDS = {
  starting: "pending",
  running: "running",
  stopping: "stopping",
  exited: "done",
  failed: "failed",
  stopped: "stopped",
  timed_out: "failed",
} as const satisfies Record<BackgroundTaskView["state"], ManagerActivityKind>;

export const taskStateLabel = (state: BackgroundTaskView["state"]): string =>
  state === "timed_out" ? "timed out" : managerActivityLabel(STATE_KINDS[state]);

export const taskStatePresentation = (state: BackgroundTaskView["state"], frame: number) => {
  const kind = STATE_KINDS[state];
  return {
    glyph: managerActivityGlyph(kind, frame),
    color: managerActivityColor(kind),
    label: taskStateLabel(state),
  };
};
