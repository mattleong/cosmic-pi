import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import {
  hiddenRowsStandIn,
  previewFooter,
  selectPreviewLines,
  selectPreviewTextLines,
  type PreviewLineEntry,
} from "../../../preview/format";
import {
  normalizePreviewLanguageAlias,
  resolvePreviewLanguage,
  type DetectedPreviewLanguage,
} from "../../../syntax/language";
import { renderHighlightedText, shouldSkipHighlight } from "../../../syntax/render";
import { expandPreviewTabs } from "../../../shared/helpers";
import { escapeLineControlChars } from "../../../shared/terminal-text";
import { hangingContinuation, WrappedCodeText, type WrappedCodeRow } from "./wrapped-code-text";

export const pathPreviewLanguage = (path: string, content?: string): string | undefined =>
  resolvePreviewLanguage({ path, content });

/**
 * The language a heading names beside its path: only one detected from the content, such as a
 * shebang in an extensionless script, since the path already says one its name or extension gave.
 */
export const headingLanguageFact = (
  detected: DetectedPreviewLanguage | undefined,
): string | undefined =>
  detected?.from === "content" ? normalizePreviewLanguageAlias(detected.language) : undefined;

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
}): Component {
  const { content, theme, invalidate, firstLine } = options;
  const skipHighlight = shouldSkipHighlight(content);
  const lang = skipHighlight ? undefined : options.lang;
  const preview = selectPreviewTextLines(content, options.limit);
  const width =
    firstLine === undefined ? 0 : String(firstLine + Math.max(0, preview.total - 1)).length;
  // Numbered rows continue under a blank gutter, so wrapped code stays in its column.
  const blankGutter = theme.fg("dim", `${Fn.pipe(" ", Str.repeat(width))} │ `);
  const rendered = renderChunkedPreviewEntries(
    preview,
    (chunk): WrappedCodeRow[] => {
      const normalizedChunk = Arr.map(chunk, (entry) => expandPreviewTabs(entry.line));
      const highlighted = renderHighlightedText(
        Arr.join(normalizedChunk, "\n"),
        lang,
        theme,
        invalidate,
      );
      return Arr.map(chunk, (entry, index) => {
        const source = normalizedChunk[index] ?? "";
        const line = highlighted[index] ?? theme.fg("toolOutput", escapeLineControlChars(source));
        if (firstLine === undefined)
          return { text: line, continuation: hangingContinuation(source) };
        const lineNumber = Fn.pipe(String(firstLine + entry.index), Str.padStart(width, " "));
        return { text: `${theme.fg("dim", `${lineNumber} │ `)}${line}`, continuation: blankGutter };
      });
    },
    (hidden): WrappedCodeRow => ({
      text: hiddenRowsStandIn(theme, hidden, "line"),
      continuation: "",
    }),
  );
  const footer = skipHighlight ? previewFooter(theme, options.skipHighlightLabel) : "";
  if (rendered.lines.length === 0)
    return new Text(theme.fg("muted", options.emptyLabel) + footer, 0, 0);
  const footerRows = Arr.map(
    Arr.filter(Str.split(footer, "\n"), Str.isNonEmpty),
    (text): WrappedCodeRow => ({ text, continuation: "" }),
  );
  return new WrappedCodeText([...rendered.lines, ...footerRows]);
}

export function renderSelectedOutputLines(
  rawLines: string[],
  limit: number,
  theme: Theme,
  noun: { readonly singular: string; readonly plural?: string },
  renderChunk: (chunk: string[]) => string[],
): string {
  const preview = renderChunkedPreviewEntries(
    selectPreviewLines(rawLines, limit),
    (chunk) => renderChunk(Arr.map(chunk, (entry) => entry.line)),
    (hidden) => hiddenRowsStandIn(theme, hidden, noun.singular, noun.plural),
  );
  return Arr.join(preview.lines, "\n");
}

/**
 * Rendered preview rows with one stand-in where rows are hidden: between the head and tail, or
 * after a head shown alone.
 */
function renderChunkedPreviewEntries<T, Row>(
  preview: { entries: Array<PreviewLineEntry<T>>; shown: number; hidden: number },
  renderChunk: (chunk: Array<{ line: T; index: number }>) => Row[],
  standIn: (hidden: number) => Row,
) {
  const lines: Row[] = [];
  let chunk: Array<{ line: T; index: number }> = [];
  let placed = false;

  function flushChunk(): void {
    if (chunk.length === 0) return;
    lines.push(...renderChunk(chunk));
    chunk = [];
  }

  for (const entry of preview.entries) {
    if (entry.kind === "hidden") {
      flushChunk();
      lines.push(standIn(entry.hidden));
      placed = true;
    } else {
      chunk.push({ line: entry.line, index: entry.index });
    }
  }
  flushChunk();
  if (!placed && preview.hidden > 0) lines.push(standIn(preview.hidden));
  return { lines, shown: preview.shown, hidden: preview.hidden };
}
