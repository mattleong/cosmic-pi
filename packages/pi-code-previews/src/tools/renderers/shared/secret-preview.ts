import type { Theme } from "@earendil-works/pi-coding-agent";
import { countLabel } from "../../../shared/helpers";
import { codePreviewPerformanceConfig } from "../../../config/env";
import { getSecretWarnings } from "../../../warnings/secrets";
import { codePreviewSettings } from "../../../config/state";

export function withSecretWarning(source: string, theme: Theme, preview: string): string {
  if (!codePreviewSettings.secretWarnings) return preview;
  const warnings = getSecretWarnings(secretScanSample(source));
  if (warnings.length === 0) return preview;
  return `${theme.fg("warning", `⚠ Preview ${countLabel(warnings.length, "warning")}: possible ${warnings.join(", ")}`)}\n${preview}`;
}

function secretScanSample(source: string): string {
  const limit = codePreviewPerformanceConfig.secretScanChars;
  if (source.length <= limit) return source;
  const half = Math.floor(limit / 2);
  return `${source.slice(0, half)}\n${source.slice(-half)}`;
}
