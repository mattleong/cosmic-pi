import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { clampPercent } from "pi-cosmic-core/display";
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
  return Arr.join(
    [
      filled > 0 ? theme.fg(tone, Fn.pipe("━", Str.repeat(filled))) : "",
      empty > 0
        ? `${theme.fg(tone, "╸")}${theme.fg("dim", Fn.pipe("─", Str.repeat(empty - 1)))}`
        : "",
    ],
    "",
  );
}
