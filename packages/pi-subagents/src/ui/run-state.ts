import { brailleSpinnerFrame, managerStateGlyph, startingSpinnerFrame } from "pi-cosmic-ui/manager";
import type { SubagentRunState } from "../run/model.ts";

type RunStateColor = "accent" | "success" | "warning" | "error" | "muted";

const RUN_STATE_PRESENTATION = {
  starting: { glyph: "◌", label: "starting…", color: "accent" },
  running: { glyph: brailleSpinnerFrame(0), label: "running", color: "success" },
  waiting_for_parent: { glyph: "?", label: "waiting for reply", color: "warning" },
  paused: { glyph: "‖", label: "paused", color: "warning" },
  reported: { glyph: managerStateGlyph("done"), label: "reported · retained", color: "success" },
  completed: { glyph: managerStateGlyph("done"), label: "finished", color: "success" },
  failed: { glyph: managerStateGlyph("failed"), label: "failed", color: "error" },
  stopping: { glyph: managerStateGlyph("stopping"), label: "stopping…", color: "warning" },
  stopped: { glyph: managerStateGlyph("stopped"), label: "stopped", color: "muted" },
} as const satisfies Readonly<
  Record<
    SubagentRunState,
    { readonly glyph: string; readonly label: string; readonly color: RunStateColor }
  >
>;

export const runStateGlyph = (state: SubagentRunState): string =>
  RUN_STATE_PRESENTATION[state].glyph;

export const animatedRunStateGlyph = (state: SubagentRunState, frame: number): string => {
  if (state === "starting") return startingSpinnerFrame(frame);
  if (state === "running") return brailleSpinnerFrame(frame);
  return runStateGlyph(state);
};

export const runStateLabel = (state: SubagentRunState): string =>
  RUN_STATE_PRESENTATION[state].label;

export const runStateColor = (state: SubagentRunState): RunStateColor =>
  RUN_STATE_PRESENTATION[state].color;
