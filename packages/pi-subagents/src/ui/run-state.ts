import { brailleSpinnerFrame, managerStateGlyph, startingSpinnerFrame } from "pi-cosmic-ui/manager";
import type { SubagentRunState } from "../run/model.ts";

export const runStateGlyph = (state: SubagentRunState): string => {
  switch (state) {
    case "starting":
      return "◌";
    case "running":
      return brailleSpinnerFrame(0);
    case "waiting_for_parent":
      return "?";
    case "paused":
      return "‖";
    case "reported":
    case "completed":
      return managerStateGlyph("done");
    case "failed":
      return managerStateGlyph("failed");
    case "stopping":
      return managerStateGlyph("stopping");
    case "stopped":
      return managerStateGlyph("stopped");
  }
};

export const animatedRunStateGlyph = (state: SubagentRunState, frame: number): string => {
  if (state === "starting") return startingSpinnerFrame(frame);
  if (state === "running") return brailleSpinnerFrame(frame);
  return runStateGlyph(state);
};

export const runStateLabel = (state: SubagentRunState): string => {
  switch (state) {
    case "starting":
      return "starting…";
    case "running":
      return "running";
    case "waiting_for_parent":
      return "waiting for reply";
    case "paused":
      return "paused";
    case "reported":
      return "reported · retained";
    case "completed":
      return "finished";
    case "failed":
      return "failed";
    case "stopping":
      return "stopping…";
    case "stopped":
      return "stopped";
  }
};

export const runStateColor = (
  state: SubagentRunState,
): "accent" | "success" | "warning" | "error" | "muted" => {
  switch (state) {
    case "starting":
      return "accent";
    case "running":
    case "reported":
    case "completed":
      return "success";
    case "waiting_for_parent":
    case "paused":
    case "stopping":
      return "warning";
    case "failed":
      return "error";
    case "stopped":
      return "muted";
  }
};
