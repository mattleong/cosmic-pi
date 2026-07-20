import { nodeHomeDirectory, nodeIsAbsolute, nodeRelative } from "../boundary/node";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { escapeControlChars } from "../shared/terminal-text";

export function formatDisplayPath(path: string, cwd: string): string {
  if (!path) return "";

  if (nodeIsAbsolute(path)) {
    const fromCwd = nodeRelative(cwd, path);
    if (fromCwd && !isParentRelativePath(fromCwd) && !nodeIsAbsolute(fromCwd)) return fromCwd;
    if (!fromCwd) return ".";

    const home = nodeHomeDirectory();
    const fromHome = nodeRelative(home, path);
    if (fromHome && !isParentRelativePath(fromHome) && !nodeIsAbsolute(fromHome))
      return `~/${fromHome}`;
    if (!fromHome) return "~";
  }

  return path;
}

function isParentRelativePath(path: string): boolean {
  return path === ".." || path.startsWith("../") || path.startsWith("..\\");
}

export function renderDisplayPath(
  path: string,
  cwd: string,
  theme: Theme,
  fallback = "...",
): string {
  const displayPath = formatDisplayPath(path, cwd) || fallback;
  return theme.fg("accent", escapeControlChars(displayPath));
}
