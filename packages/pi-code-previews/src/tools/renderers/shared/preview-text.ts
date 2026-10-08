import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  hiddenLinesMarker,
  previewFooter,
  selectPreviewLines,
  selectPreviewTextLines,
  showingFooter,
  type PreviewLineEntry,
} from "../../../preview/format";
import { resolvePreviewLanguage } from "../../../syntax/language";
import { renderHighlightedText, shouldSkipHighlight } from "../../../syntax/render";
import { expandPreviewTabs } from "../../../shared/helpers";
import { escapeLineControlChars } from "../../../shared/terminal-text";

/** The highlighting language for a file, from its path and, when given, its content. */
export const pathPreviewLanguage = (path: string, content?: string): string | undefined =>
  resolvePreviewLanguage({ path, content });

/** File content, numbered from `firstLine` when given; a zero `limit` shows every line. */
export function renderContentPreview(options: {
  content: string;
  limit: number;
  lang: string | undefined;
  theme: Theme;
  emptyLabel: string;
  skipHighlightLabel: string;
  invalidate?: (() => void) | undefined;
  firstLine?: number | undefined;
}): Text {
  const { content, theme, invalidate, firstLine } = options;
  const skipHighlight = shouldSkipHighlight(content);
  const lang = skipHighlight ? undefined : options.lang;
  const preview = selectPreviewTextLines(content, options.limit);
  const width =
    firstLine === undefined ? 0 : String(firstLine + Math.max(0, preview.total - 1)).length;
  const rendered = renderChunkedPreviewEntries(preview, theme, (chunk) => {
    const normalizedChunk = chunk.map((entry) => expandPreviewTabs(entry.line));
    const highlighted = renderHighlightedText(normalizedChunk.join("\n"), lang, theme, invalidate);
    return chunk.map((entry, index) => {
      const line =
        highlighted[index] ??
        theme.fg("toolOutput", escapeLineControlChars(normalizedChunk[index] ?? ""));
      if (firstLine === undefined) return line;
      const lineNumber = String(firstLine + entry.index).padStart(width, " ");
      return `${theme.fg("dim", `${lineNumber} │ `)}${line}`;
    });
  });
  let text = rendered.lines.length
    ? rendered.lines.join("\n")
    : theme.fg("muted", options.emptyLabel);
  if (rendered.hidden > 0) text += showingFooter(theme, rendered.shown, preview.total, "lines");
  if (skipHighlight) text += previewFooter(theme, options.skipHighlightLabel);
  return new Text(text, 0, 0);
}

/** Output lines within `limit`, and a footer counting `noun` when some are hidden. */
export function renderSelectedOutputLines(
  rawLines: string[],
  limit: number,
  theme: Theme,
  noun: string,
  renderChunk: (chunk: string[]) => string[],
): string {
  const preview = renderChunkedPreviewEntries(selectPreviewLines(rawLines, limit), theme, (chunk) =>
    renderChunk(chunk.map((entry) => entry.line)),
  );
  const text = preview.lines.join("\n");
  if (preview.hidden === 0) return text;
  return text + showingFooter(theme, preview.shown, rawLines.length, noun);
}

function renderChunkedPreviewEntries<T>(
  preview: { entries: Array<PreviewLineEntry<T>>; shown: number; hidden: number },
  theme: Theme,
  renderChunk: (chunk: Array<{ line: T; index: number }>) => string[],
) {
  const lines: string[] = [];
  let chunk: Array<{ line: T; index: number }> = [];

  function flushChunk(): void {
    if (chunk.length === 0) return;
    lines.push(...renderChunk(chunk));
    chunk = [];
  }

  for (const entry of preview.entries) {
    if (entry.kind === "hidden") {
      flushChunk();
      lines.push(hiddenLinesMarker(theme, entry.hidden));
    } else {
      chunk.push({ line: entry.line, index: entry.index });
    }
  }
  flushChunk();
  return { lines, shown: preview.shown, hidden: preview.hidden };
}
