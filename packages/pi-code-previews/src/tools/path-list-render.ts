import type { Theme } from "@earendil-works/pi-coding-agent";
import { pathIcon } from "../paths/icons";
import { renderDisplayPath } from "../paths/display";
import { escapeControlChars } from "../shared/terminal-text";
import { isToolOutputNoticeLine } from "../shared/helpers";
import type { PathIconMode } from "../config/schema";

interface PathListRenderer {
  /** All lines in display order, with each folder's paths together when drawn as a tree. */
  readonly lines: string[];
  /** Renders consecutive display-order lines; folders already drawn are not repeated. */
  readonly renderChunk: (lines: string[]) => string[];
}

export function createPathListRenderer(
  allLines: string[],
  cwd: string,
  theme: Theme,
  iconMode: PathIconMode,
): PathListRenderer {
  const renderLine = (line: string) => renderPathListLine(line, cwd, theme, iconMode);
  const shouldTree = allLines.some((line) => isPathLine(line) && line.includes("/"));
  if (!shouldTree) return { lines: allLines, renderChunk: (lines) => lines.map(renderLine) };

  const seenDirs = new Set<string>();
  return {
    lines: groupPathsByFolder(allLines),
    renderChunk: (lines) =>
      lines.flatMap((line) =>
        isPathLine(line) ? renderTreePath(line, theme, iconMode, seenDirs) : [renderLine(line)],
      ),
  };
}

const isPathLine = (line: string) => line.length > 0 && !isToolOutputNoticeLine(line);

function treePathParts(path: string) {
  const clean = path.replace(/^\.\//, "");
  return {
    isDir: clean.endsWith("/"),
    parts: clean.replace(/\/$/, "").split("/").filter(Boolean),
  };
}

/**
 * A tree draws each path under the folder drawn last, so paths are grouped under their folders
 * at every depth. Folders and files keep the order they were first seen; grouped input such as
 * sorted output keeps its order. Other lines follow the paths.
 */
function groupPathsByFolder(lines: readonly string[]): string[] {
  const firstSeen = new Map<string, number>();
  const entries = lines.map((line, index) => {
    if (!isPathLine(line)) return { line, index, key: undefined };
    const { isDir, parts } = treePathParts(line);
    const key: number[] = [];
    let folder = "";
    for (const part of isDir ? parts : parts.slice(0, -1)) {
      folder = folder ? `${folder}/${part}` : part;
      if (!firstSeen.has(folder)) firstSeen.set(folder, index);
      key.push(firstSeen.get(folder) ?? index);
    }
    if (!isDir) key.push(index);
    return { line, index, key };
  });
  return entries
    .toSorted((left, right) => {
      if (!left.key || !right.key) return left.key ? -1 : right.key ? 1 : left.index - right.index;
      for (let depth = 0; depth < Math.min(left.key.length, right.key.length); depth++) {
        const order = (left.key[depth] ?? 0) - (right.key[depth] ?? 0);
        if (order !== 0) return order;
      }
      // A folder's own line precedes its contents.
      return left.key.length - right.key.length || left.index - right.index;
    })
    .map((entry) => entry.line);
}

function renderTreePath(
  path: string,
  theme: Theme,
  iconMode: PathIconMode,
  seenDirs: Set<string>,
): string[] {
  const { isDir, parts } = treePathParts(path);
  const rendered: string[] = [];
  let key = "";
  for (const [index, part] of parts.entries()) {
    key = key ? `${key}/${part}` : part;
    const isDirectory = isDir || index < parts.length - 1;
    // A folder is drawn once, above the first of its paths.
    if (isDirectory && seenDirs.has(key)) continue;
    if (isDirectory) seenDirs.add(key);
    const name = escapeControlChars(part);
    const label = isDirectory ? theme.fg("accent", `${name}/`) : theme.fg("toolOutput", name);
    rendered.push(entryPrefix(part, isDirectory, "  ".repeat(index), theme, iconMode) + label);
  }
  return rendered;
}

/** The dimmed indentation and, when icons are on, the entry's icon before its label. */
function entryPrefix(
  name: string,
  isDirectory: boolean,
  indent: string,
  theme: Theme,
  iconMode: PathIconMode,
): string {
  const icon = pathIcon(name, isDirectory, iconMode);
  return icon ? `${theme.fg("dim", indent + icon)} ` : theme.fg("dim", indent);
}

function renderPathListLine(
  line: string,
  cwd: string,
  theme: Theme,
  iconMode: PathIconMode,
): string {
  if (!line) return "";
  if (isToolOutputNoticeLine(line)) return theme.fg("warning", escapeControlChars(line));
  const indent = line.match(/^\s*/)?.[0] ?? "";
  const body = line.slice(indent.length);
  const prefix = entryPrefix(body, body.endsWith("/"), indent, theme, iconMode);
  return prefix + renderDisplayPath(body, cwd, theme, body);
}
