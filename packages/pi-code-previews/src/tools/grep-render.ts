import * as Predicate from "effect/Predicate";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { invokeHostCallback } from "pi-cosmic-core";
import { expandPreviewTabs, getObjectValue, isToolOutputNoticeLine } from "../shared/helpers";
import { escapeControlChars, injectVisibleRanges } from "../shared/terminal-text";
import { renderHighlightedText } from "../syntax/render";
import { pathPreviewLanguage } from "./renderers/shared/preview-text";

type ParsedGrepOutputLine = {
  path: string;
  lineNumber: string;
  code: string;
  kind: "match" | "context";
};

/** Grep output grouped under file headings; literal searches highlight their matches. */
export function renderGrepOutputLines<Args>(
  output: string,
  theme: Theme,
  args: Args,
  invalidate?: () => void,
  syntaxHighlight = true,
): string[] {
  const pattern = getObjectValue(args, "pattern");
  // Match the original text: lowercasing can change its length and shift every later offset.
  const search =
    Predicate.isString(pattern) && pattern && getObjectValue(args, "literal") === true
      ? new RegExp(
          pattern.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
          getObjectValue(args, "ignoreCase") === true ? "giu" : "g",
        )
      : undefined;
  const rendered: string[] = [];
  let currentPath = "";
  let currentLanguage: string | undefined;
  for (const rawLine of output.split("\n")) {
    if (!rawLine) {
      rendered.push("");
      continue;
    }
    // A bracketed path such as `[slug]/page.tsx` still forms a row; only other lines are notices.
    const parsed = parseGrepOutputLine(rawLine);
    if (!parsed) {
      const color = isToolOutputNoticeLine(rawLine) ? "warning" : "toolOutput";
      rendered.push(theme.fg(color, escapeControlChars(rawLine)));
      continue;
    }
    if (parsed.path !== currentPath) {
      currentPath = parsed.path;
      currentLanguage = syntaxHighlight ? pathPreviewLanguage(currentPath) : undefined;
      rendered.push(theme.fg("accent", escapeControlChars(currentPath)));
    }
    rendered.push(renderGrepParsedLine(parsed, currentLanguage, theme, search, invalidate));
  }
  return rendered;
}

/**
 * Pi writes `path:N: text` for matches and `path-N- text` for context. The earliest separator
 * wins, so separators quoted inside the line text never extend the path or change its kind.
 */
const GREP_OUTPUT_LINE = /^(.+?)(?::(\d+):|-(\d+)-)\s(.*)$/s;

export function parseGrepOutputLine(line: string): ParsedGrepOutputLine | undefined {
  const match = GREP_OUTPUT_LINE.exec(line);
  if (!match) return undefined;
  const [, path, matchLine, contextLine, code] = match;
  const lineNumber = matchLine ?? contextLine;
  if (path === undefined || lineNumber === undefined || code === undefined) return undefined;
  return { path, lineNumber, code, kind: matchLine === undefined ? "context" : "match" };
}

function renderGrepParsedLine(
  parsed: ParsedGrepOutputLine,
  lang: string | undefined,
  theme: Theme,
  search: RegExp | undefined,
  invalidate: (() => void) | undefined,
): string {
  const code = expandPreviewTabs(parsed.code);
  const match = parsed.kind === "match";
  let highlighted =
    renderHighlightedText(code, lang, theme, invalidate)[0] ?? theme.fg("toolOutput", code);
  const matchRanges =
    match && search
      ? Array.from(code.matchAll(search), (found): [number, number] => [
          found.index,
          found.index + found[0].length,
        ])
      : [];
  if (matchRanges.length > 0)
    highlighted = injectVisibleRanges(highlighted, matchRanges, {
      open: "\x1b[48;2;90;74;28m",
      // A theme without ANSI accessors closes the highlight with the default background.
      close: invokeHostCallback(() => theme.getBgAnsi("toolSuccessBg"), "") || "\x1b[49m",
      reopenAfterSgr: (sequence) => sequence === "\x1b[39m",
    });
  const lineNumber = theme.fg(match ? "accent" : "dim", parsed.lineNumber.padStart(4));
  const marker = match ? theme.fg("warning", "│") : theme.fg("dim", "┆");
  return `${theme.fg("dim", "  ")}${lineNumber} ${marker} ${highlighted}`;
}
