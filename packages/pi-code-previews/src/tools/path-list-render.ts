import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Num from "effect/Number";
import * as Str from "effect/String";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { pathIcon } from "../paths/icons";
import { renderDisplayPath } from "../paths/display";
import { escapeControlChars } from "../shared/terminal-text";
import { isToolOutputNoticeLine } from "../shared/helpers";
import type { PathIconMode } from "../config/schema";

interface PathListRenderer {
  readonly lines: string[];
  readonly renderChunk: (lines: string[]) => string[];
}

export function createPathListRenderer(
  allLines: string[],
  cwd: string,
  theme: Theme,
  iconMode: PathIconMode,
): PathListRenderer {
  const renderLine = (line: string) => renderPathListLine(line, cwd, theme, iconMode);
  const shouldTree =
    !Arr.some(allLines, (line) => isPathLine(line) && Fn.pipe(line, Str.startsWith("/"))) &&
    Arr.some(allLines, (line) => isPathLine(line) && Fn.pipe(line, Str.includes("/")));
  if (!shouldTree) return { lines: allLines, renderChunk: (lines) => Arr.map(lines, renderLine) };

  const seenDirs = new Set<string>();
  return {
    lines: groupPathsByFolder(allLines),
    renderChunk: (lines) =>
      Arr.flatMap(lines, (line) =>
        isPathLine(line) ? renderTreePath(line, theme, iconMode, seenDirs) : [renderLine(line)],
      ),
  };
}

const isPathLine = (line: string) => line.length > 0 && !isToolOutputNoticeLine(line);

function treePathParts(path: string) {
  const clean = Fn.pipe(path, Str.replace(/^\.\//, ""));
  return {
    isDir: Fn.pipe(clean, Str.endsWith("/")),
    parts: Arr.filter(Str.split(Fn.pipe(clean, Str.replace(/\/$/, "")), "/"), Str.isNonEmpty),
  };
}

type PathEntry = { line: string; index: number; key: number[] | undefined };

function groupPathsByFolder(lines: readonly string[]): string[] {
  const firstSeen = new Map<string, number>();
  const entries = Arr.map(lines, (line, index) => {
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
  return Arr.map(
    Arr.sort(entries, (left: PathEntry, right: PathEntry) => {
      if (!left.key || !right.key)
        return left.key ? -1 : right.key ? 1 : Num.sign(left.index - right.index);
      for (let depth = 0; depth < Math.min(left.key.length, right.key.length); depth++) {
        const order = (left.key[depth] ?? 0) - (right.key[depth] ?? 0);
        if (order !== 0) return Num.sign(order);
      }
      return Num.sign(left.key.length - right.key.length || left.index - right.index);
    }),
    (entry) => entry.line,
  );
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
    if (isDirectory && seenDirs.has(key)) continue;
    if (isDirectory) seenDirs.add(key);
    const name = escapeControlChars(part);
    const label = isDirectory ? theme.fg("accent", `${name}/`) : theme.fg("toolOutput", name);
    rendered.push(
      entryPrefix(part, isDirectory, Fn.pipe("  ", Str.repeat(index)), theme, iconMode) + label,
    );
  }
  return rendered;
}

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
  const indent = Fn.pipe(
    line,
    Str.match(/^\s*/),
    Option.map((match) => match[0]),
    Option.getOrElse(() => ""),
  );
  const body = Fn.pipe(line, Str.slice(indent.length));
  const prefix = entryPrefix(body, Fn.pipe(body, Str.endsWith("/")), indent, theme, iconMode);
  return prefix + renderDisplayPath(body, cwd, theme, body);
}
