import type { Theme } from "@earendil-works/pi-coding-agent";
import { pathIcon } from "../paths/icons";
import { renderDisplayPath } from "../paths/display";
import { escapeControlChars } from "../shared/terminal-text";
import { isToolOutputNoticeLine } from "../shared/helpers";
import type { PathIconMode } from "../config/schema";

export interface PathListRenderer {
  /** All lines in display order, with each folder's paths together when drawn as a tree. */
  readonly lines: string[];
  /** Renders consecutive display-order lines; folders already drawn are not repeated. */
  readonly renderChunk: (lines: string[]) => string[];
}

export function createPathListRenderer(
  allLines: string[],
  cwd: string,
  theme: Theme,
  options: { iconMode: PathIconMode },
): PathListRenderer {
  const { iconMode } = options;
  const shouldTree = allLines.some((line) => isPathLine(line) && line.includes("/"));
  if (!shouldTree)
    return {
      lines: allLines,
      renderChunk: (lines) => lines.map((line) => renderPathListLine(line, cwd, theme, iconMode)),
    };

  const seenDirs = new Set<string>();
  return {
    lines: groupPathsByFolder(allLines),
    renderChunk: (lines) => {
      const rendered: string[] = [];
      for (const line of lines) {
        if (!line) {
          rendered.push("");
          continue;
        }
        if (isToolOutputNoticeLine(line)) {
          rendered.push(theme.fg("warning", escapeControlChars(line)));
          continue;
        }
        renderTreePath(line, theme, iconMode, seenDirs, rendered);
      }
      return rendered;
    },
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
  rendered: string[],
): void {
  const { isDir, parts } = treePathParts(path);
  let prefix = "";
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (part === undefined) continue;
    const isLeaf = index === parts.length - 1;
    const key = prefix ? `${prefix}/${part}` : part;
    const indent = "  ".repeat(index);
    if (!isLeaf || isDir) {
      if (!seenDirs.has(key)) {
        seenDirs.add(key);
        rendered.push(renderTreeEntry(part, true, indent, theme, iconMode));
      }
    } else {
      rendered.push(renderTreeEntry(part, false, indent, theme, iconMode));
    }
    prefix = key;
  }
}

function renderTreeEntry(
  part: string,
  isDirectory: boolean,
  indent: string,
  theme: Theme,
  iconMode: PathIconMode,
): string {
  const icon = pathIcon(part, isDirectory, iconMode);
  const iconText = icon ? `${indent}${icon}` : indent;
  const gap = icon ? " " : "";
  const label = isDirectory
    ? theme.fg("accent", `${escapeControlChars(part)}/`)
    : theme.fg("toolOutput", escapeControlChars(part));
  return `${theme.fg("dim", iconText)}${gap}${label}`;
}

function renderPathListLine(
  line: string,
  cwd: string,
  theme: Theme,
  iconMode: PathIconMode,
): string {
  if (!line) return "";
  if (isToolOutputNoticeLine(line)) return theme.fg("warning", escapeControlChars(line));
  const prefix = line.match(/^\s*/)?.[0] ?? "";
  const body = line.slice(prefix.length);
  const icon = pathIcon(body, body.endsWith("/"), iconMode);
  const iconText = icon ? prefix + icon : prefix;
  const gap = icon ? " " : "";
  return `${theme.fg("dim", iconText)}${gap}${renderDisplayPath(body, cwd, theme, body)}`;
}
