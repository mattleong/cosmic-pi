import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  managerActivityGlyph,
  managerNoticeGlyph,
  type ManagerActivityKind,
} from "pi-cosmic-ui/manager";
import type { CompactChild } from "../tools/compact-summary";

const ACTIVITY_KINDS = {
  pending: "pending",
  running: "running",
  success: "done",
  error: "failed",
  cancelled: "stopped",
} as const satisfies Record<string, ManagerActivityKind>;

export function compactStatusIcon(
  status: CompactChild["status"],
  theme: Theme,
  animationFrame = 0,
): string {
  if (status === "returned") return theme.fg("muted", "•");
  const glyph =
    status === "warning" || status === "uncertain"
      ? managerNoticeGlyph("warning")
      : managerActivityGlyph(ACTIVITY_KINDS[status], animationFrame);
  const color =
    status === "success"
      ? "success"
      : status === "error"
        ? "error"
        : status === "cancelled"
          ? "muted"
          : "warning";
  return theme.fg(color, glyph);
}
