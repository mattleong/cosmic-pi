import * as Predicate from "effect/Predicate";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { invokeHostCallback } from "pi-cosmic-core";
import { expandPreviewTabs, isToolOutputNoticeLine } from "../shared/helpers";
import { ownField, type HostObject } from "../shared/untrusted-value";
import { escapeControlChars, injectVisibleRanges } from "../shared/terminal-text";
import { renderHighlightedText } from "../syntax/render";
import { pathPreviewLanguage } from "./renderers/shared/preview-text";

type ParsedGrepOutputLine = {
  path: string;
  lineNumber: string;
  code: string;
  kind: "match" | "context";
};

export function renderGrepOutputLines(
  output: string,
  theme: Theme,
  args: HostObject | undefined,
  invalidate?: () => void,
  syntaxHighlight = true,
): string[] {
  const pattern = ownField(args, "pattern");
  const search =
    Predicate.isString(pattern) && pattern && ownField(args, "literal") === true
      ? new RegExp(
          pattern.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
          ownField(args, "ignoreCase") === true ? "giu" : "g",
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
      close: invokeHostCallback(() => theme.getBgAnsi("toolSuccessBg"), "") || "\x1b[49m",
      reopenAfterSgr: (sequence) => sequence === "\x1b[39m",
    });
  const lineNumber = theme.fg(match ? "accent" : "dim", parsed.lineNumber.padStart(4));
  const marker = match ? theme.fg("warning", "│") : theme.fg("dim", "┆");
  return `${theme.fg("dim", "  ")}${lineNumber} ${marker} ${highlighted}`;
}
