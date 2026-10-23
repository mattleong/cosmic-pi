import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
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

export const pathPreviewLanguage = (path: string, content?: string): string | undefined =>
  resolvePreviewLanguage({ path, content });

interface ObservedArguments {
  // Weak, so a row that is not redrawn after streaming does not keep replaced arguments alive.
  readonly first: WeakRef<object>;
  changed: boolean;
}

const observedArguments = new WeakMap<object, ObservedArguments>();

/**
 * Streaming arguments render plain so partial text is neither tokenized on every delta nor kept in
 * the shared highlight cache. Pi never marks replayed arguments complete, and a row replayed without
 * a saved result keeps every flag of a streaming row, so a row streams only once its arguments change
 * between draws; its first draw, including every replayed row's, highlights. Pi replaces the
 * arguments object on each delta and keeps it across redraws, so identity identifies a change.
 */
export function argumentsStreaming(context: {
  readonly state: unknown;
  readonly args: unknown;
  readonly argsComplete: boolean;
  readonly executionStarted: boolean;
  readonly isPartial: boolean;
}): boolean {
  const { state, args } = context;
  if (context.argsComplete || context.executionStarted || !context.isPartial) return false;
  if (!Predicate.isObjectKeyword(state) || !Predicate.isObjectKeyword(args)) return false;
  const observed = observedArguments.get(state);
  if (!observed) {
    observedArguments.set(state, { first: new WeakRef(args), changed: false });
    return false;
  }
  observed.changed ||= observed.first.deref() !== args;
  return observed.changed;
}

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
    const normalizedChunk = Arr.map(chunk, (entry) => expandPreviewTabs(entry.line));
    const highlighted = renderHighlightedText(
      Arr.join(normalizedChunk, "\n"),
      lang,
      theme,
      invalidate,
    );
    return Arr.map(chunk, (entry, index) => {
      const line =
        highlighted[index] ??
        theme.fg("toolOutput", escapeLineControlChars(normalizedChunk[index] ?? ""));
      if (firstLine === undefined) return line;
      const lineNumber = Fn.pipe(String(firstLine + entry.index), Str.padStart(width, " "));
      return `${theme.fg("dim", `${lineNumber} │ `)}${line}`;
    });
  });
  let text = rendered.lines.length
    ? Arr.join(rendered.lines, "\n")
    : theme.fg("muted", options.emptyLabel);
  if (rendered.hidden > 0) text += showingFooter(theme, rendered.shown, preview.total, "lines");
  if (skipHighlight) text += previewFooter(theme, options.skipHighlightLabel);
  return new Text(text, 0, 0);
}

export function renderSelectedOutputLines(
  rawLines: string[],
  limit: number,
  theme: Theme,
  noun: string,
  renderChunk: (chunk: string[]) => string[],
): string {
  const preview = renderChunkedPreviewEntries(selectPreviewLines(rawLines, limit), theme, (chunk) =>
    renderChunk(Arr.map(chunk, (entry) => entry.line)),
  );
  const text = Arr.join(preview.lines, "\n");
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
