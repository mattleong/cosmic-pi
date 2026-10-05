import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  hiddenLinesMarker,
  selectPreviewLines,
  selectPreviewTextLines,
  type PreviewLineEntry,
} from "../../../preview/format";
import { renderHighlightedText } from "../../../syntax/render";
import { expandPreviewTabs } from "../../../shared/helpers";
import { escapeLineControlChars } from "../../../shared/terminal-text";

export function renderHighlightedPreviewText(
  text: string,
  limit: number,
  lang: string | undefined,
  theme: Theme,
  invalidate?: () => void,
  firstLine?: number,
) {
  const preview = selectPreviewTextLines(text, limit);
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
  return { ...rendered, total: preview.total };
}

export function renderSelectedOutputLines(
  rawLines: string[],
  limit: number,
  theme: Theme,
  renderChunk: (chunk: string[]) => string[],
): { lines: string[]; shown: number; hidden: number } {
  return renderChunkedPreviewEntries(selectPreviewLines(rawLines, limit), theme, (chunk) =>
    renderChunk(chunk.map((entry) => entry.line)),
  );
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
