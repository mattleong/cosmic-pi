import type { Theme } from "@earendil-works/pi-coding-agent";
import { escapeControlChars } from "../shared/terminal-text";
import { formatDisplayPath } from "pi-cosmic-core";

export function renderDisplayPath(path: string, cwd: string, theme: Theme, fallback = "…"): string {
  const displayPath = formatDisplayPath(path, cwd) || fallback;
  return theme.fg("accent", escapeControlChars(displayPath));
}
