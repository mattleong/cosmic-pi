import type { Theme } from "@earendil-works/pi-coding-agent";
import { countLabel } from "../../../shared/helpers";
import { codePreviewPerformanceConfig } from "../../../config/env";
import { getSecretWarnings } from "../../../warnings/secrets";
import { codePreviewSettings } from "../../../config/state";

/** Notice discovery must also run when the preview body is hidden. */
export function getPreviewSecretWarnings(
  source: string,
  enabled = codePreviewSettings.secretWarnings,
  limit = codePreviewPerformanceConfig.secretScanChars,
): string[] {
  return enabled ? getSecretWarnings(secretScanSample(source, limit)) : [];
}

export function withSecretWarning(source: string, theme: Theme, preview: string): string {
  const warnings = getPreviewSecretWarnings(source);
  if (warnings.length === 0) return preview;
  return `${theme.fg("warning", `⚠ Preview ${countLabel(warnings.length, "warning")}: possible ${warnings.join(", ")}`)}\n${preview}`;
}

function secretScanSample(source: string, limit: number): string {
  if (source.length <= limit) return source;
  const half = Math.floor(limit / 2);
  // slice(-0) would scan the entire source when the configured budget is one.
  if (half === 0) return source.slice(0, limit);
  return `${source.slice(0, half)}\n${source.slice(-half)}`;
}
