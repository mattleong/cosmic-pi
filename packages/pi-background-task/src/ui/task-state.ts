import * as Str from "effect/String";
import {
  managerActivityColor,
  managerActivityGlyph,
  managerActivityLabel,
  type ManagerActivityKind,
} from "pi-cosmic-ui/manager";
import { sanitizeTerminalLine } from "pi-cosmic-core";
import type { BackgroundTaskView } from "../task/model.ts";

export const taskDisplayName = (task: Pick<BackgroundTaskView, "name" | "command">): string => {
  const name = task.name && Str.trim(task.name);
  return sanitizeTerminalLine(name === undefined || name === "" ? task.command : name);
};

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
