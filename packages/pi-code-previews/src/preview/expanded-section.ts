import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { fallbackArguments } from "../tools/data/args";
import { type HostValue } from "../shared/untrusted-value";
import { wrapPlainText } from "../shared/text-wrap";

export function expandedSection(
  theme: Pick<Theme, "fg">,
  label: string | undefined,
  ...children: Component[]
): Component {
  const content = new Container();
  for (const child of children) content.addChild(child);
  // Children that cache their rows return the same arrays, so unchanged content is not re-indented.
  let cached:
    | { readonly width: number; readonly parts: readonly string[][]; readonly rows: string[] }
    | undefined;
  return {
    render(width) {
      if (width <= 0) return [];
      const indent = Math.min(label ? 4 : 2, Math.max(0, width - 2));
      const parts = Arr.map(content.children, (child) => child.render(width - indent));
      if (
        cached?.width === width &&
        Arr.every(parts, (part, index) => part === cached?.parts[index])
      )
        return cached.rows;
      const heading = label ? [clipToWidth(`  ${theme.fg("muted", label)}`, width, "")] : [];
      const pad = Fn.pipe(" ", Str.repeat(indent));
      const rows = heading.concat(
        Arr.flatMap(parts, (lines) =>
          Arr.map(lines, (line) => (line === "" ? "" : `${pad}${line}`)),
        ),
      );
      cached = { width, parts, rows };
      return rows;
    },
    invalidate() {
      cached = undefined;
      content.invalidate();
    },
  };
}

const ARGUMENT_HANG = 2;

type ArgumentTone = "toolOutput" | "muted";

/**
 * One argument line wrapped to `width`: it keeps its own indent, and its continuation rows hang
 * two columns past it, so a long string value never wraps back left of its key.
 */
function argumentRows(
  theme: Pick<Theme, "fg">,
  tone: ArgumentTone | undefined,
  line: string,
  width: number,
): string[] {
  const rest = Str.trimStart(line);
  const lead = Math.min(line.length - rest.length, Math.max(0, width - 1));
  const indent = Fn.pipe(" ", Str.repeat(lead));
  const styled = (row: string) => (tone === undefined ? row : theme.fg(tone, row));
  const [first = "", ...more] = wrapPlainText(rest, Math.max(1, width - lead));
  if (more.length === 0) return [`${indent}${styled(first)}`];
  const hang = Math.min(ARGUMENT_HANG, Math.max(0, width - lead - 1));
  const remainder = Str.startsWith(first)(rest)
    ? wrapPlainText(Str.trimStart(Str.slice(first.length)(rest)), Math.max(1, width - lead - hang))
    : more;
  const continuation = Fn.pipe(" ", Str.repeat(lead + hang));
  return [
    `${indent}${styled(first)}`,
    ...Arr.map(remainder, (row) => `${continuation}${styled(row)}`),
  ];
}

/**
 * Formatted argument lines, such as pretty-printed JSON, each wrapped beneath its own indent, after
 * any lead rows such as a fallback call's title.
 */
export function argumentLines(
  theme: Pick<Theme, "fg">,
  lines: readonly string[],
  tone?: ArgumentTone,
  lead: readonly string[] = [],
): Component {
  let cached: { readonly width: number; readonly rows: string[] } | undefined;
  return {
    render(width) {
      if (width <= 0) return [];
      if (cached?.width !== width)
        cached = {
          width,
          rows: [
            ...Arr.flatMap(lead, (row) => wrapTextWithAnsi(row, width)),
            ...Arr.flatMap(lines, (line) => argumentRows(theme, tone, line, width)),
          ],
        };
      return cached.rows;
    },
    invalidate() {
      cached = undefined;
    },
  };
}

export function expandedArguments(theme: Theme, args: HostValue | undefined): Component {
  const lines = fallbackArguments(args);
  if (lines.length === 0) return new Container();
  return expandedSection(theme, "Arguments", argumentLines(theme, lines, "toolOutput"));
}
