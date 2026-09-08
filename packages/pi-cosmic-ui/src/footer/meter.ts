import { clampPercent } from "pi-cosmic-core";
import type { CosmicFooterTheme } from "../protocol/protocol.ts";

export type ProgressTone = "success" | "warning" | "error";

export function remainingCapacityTone(percent: number): ProgressTone {
  if (percent >= 75) return "success";
  if (percent >= 25) return "warning";
  return "error";
}

export function contextConsumptionTone(percent: number): ProgressTone {
  if (percent > 75) return "error";
  if (percent > 50) return "warning";
  return "success";
}

export function progressBar(
  percent: number,
  cells: number,
  theme: CosmicFooterTheme,
  tone: ProgressTone,
): string {
  const value = clampPercent(percent);
  if (cells <= 0) return "";
  const filled = Math.floor((value / 100) * cells);
  const empty = cells - filled;
  return [
    filled > 0 ? theme.fg(tone, "━".repeat(filled)) : "",
    empty > 0 && filled < cells ? theme.fg(tone, "╸") : "",
    empty > 0 ? theme.fg("dim", "─".repeat(Math.max(0, empty - (filled < cells ? 1 : 0)))) : "",
  ].join("");
}
