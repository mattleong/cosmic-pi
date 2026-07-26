import type { SubagentRunState } from "../run/model.ts";

export const runStateGlyph = (state: SubagentRunState): string => {
  switch (state) {
    case "starting":
      return "◌";
    case "running":
      return "●";
    case "waiting_for_parent":
      return "?";
    case "paused":
      return "Ⅱ";
    case "completed":
      return "✓";
    case "failed":
      return "×";
    case "stopping":
      return "◐";
    case "stopped":
      return "■";
  }
};

export const runStateColor = (
  state: SubagentRunState,
): "accent" | "success" | "warning" | "error" | "muted" => {
  switch (state) {
    case "starting":
      return "accent";
    case "running":
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
