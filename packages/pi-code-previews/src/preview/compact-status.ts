import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  managerActivityColor,
  managerActivityGlyph,
  managerNoticeGlyph,
  type ManagerActivityKind,
} from "pi-cosmic-ui/manager";
import type { CompactStatus } from "../tools/compact-summary";

const ACTIVITY_KINDS = {
  pending: "pending",
  running: "running",
  success: "done",
  error: "failed",
  cancelled: "stopped",
} as const satisfies Record<string, ManagerActivityKind>;

/** ✓ ⚠ ✗ ⊘ for settled outcomes; ? when the outcome cannot be confirmed. */
export function compactStatusIcon(status: CompactStatus, theme: Theme, animationFrame = 0): string {
  if (status === "returned") return theme.fg("muted", "•");
  if (status === "uncertain") return theme.fg("warning", "?");
  const glyph =
    status === "warning"
      ? managerNoticeGlyph("warning")
      : managerActivityGlyph(ACTIVITY_KINDS[status], animationFrame);
  const color = status === "warning" ? "warning" : managerActivityColor(ACTIVITY_KINDS[status]);
  return theme.fg(color, glyph);
}
