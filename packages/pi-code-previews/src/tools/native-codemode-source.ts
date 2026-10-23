import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { indexOfFrom } from "pi-cosmic-core";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { renderExpansionAffordance } from "pi-cosmic-ui/tool";
import { expandPreviewTabs } from "../shared/helpers";
import { escapeControlChars } from "../shared/terminal-text";
import { renderHighlightedText, shouldSkipHighlight } from "../syntax/render";

interface NativeProgramContext {
  readonly expanded: boolean;
  readonly argumentsStreaming: boolean;
  readonly invalidate: () => void;
}

const COLLAPSED_PROGRAM_ROWS = 8;

/**
 * The first collapsed rows come from the first collapsed source lines: each line wraps to at
 * least one row, and neither tokenizing nor wrapping a line depends on later lines. The head keeps
 * its last line break so a CRLF line ends exactly as it does in the full program.
 */
function programHead(source: string) {
  let end = -1;
  for (let line = 0; line < COLLAPSED_PROGRAM_ROWS; line++) {
    end = indexOfFrom(source, "\n", end + 1);
    if (end < 0) return { text: source, more: false };
  }
  return { text: Fn.pipe(source, Str.slice(0, end + 1)), more: true };
}

function programText(
  text: string,
  lang: string | undefined,
  theme: Theme,
  invalidate: () => void,
): Component {
  let highlighted: Text | undefined;
  let fallback: Text | undefined;
  let failed = false;
  return {
    render(width) {
      if (!failed) {
        try {
          highlighted ??= new Text(
            Arr.join(renderHighlightedText(text, lang, theme, invalidate), "\n"),
            0,
            0,
          );
          return highlighted.render(width);
        } catch {
          failed = true;
          highlighted = undefined;
        }
      }
      fallback ??= new Text(escapeControlChars(text), 0, 0);
      return fallback.render(width);
    },
    invalidate() {
      highlighted?.invalidate();
      fallback?.invalidate();
    },
  };
}

export function renderNativeCodemodeProgram(
  source: string,
  theme: Theme,
  { expanded, argumentsStreaming, invalidate }: NativeProgramContext,
  sourceIntentNote?: string,
): Component {
  const note = sourceIntentNote && expanded ? new Text(sourceIntentNote, 0, 0) : undefined;
  // Collapsed highlighting covers only the shown lines, so the full program decides whether
  // highlighting is skipped.
  const lang = () =>
    argumentsStreaming || shouldSkipHighlight(expandPreviewTabs(source)) ? undefined : "javascript";
  let full: Component | undefined;
  let head: { readonly text: Component; readonly more: boolean } | undefined;
  const fullProgram = () => (full ??= programText(source, lang(), theme, invalidate));
  const collapsedRows = (width: number) => {
    if (!head) {
      const { text, more } = programHead(source);
      head = { text: more ? programText(text, lang(), theme, invalidate) : fullProgram(), more };
    }
    const rows = head.text.render(width);
    if (head.more && rows.length >= COLLAPSED_PROGRAM_ROWS) return { rows, more: true };
    // A blank head draws no rows, so only the full program can measure itself.
    const all = head.more ? fullProgram().render(width) : rows;
    return { rows: all, more: all.length > COLLAPSED_PROGRAM_ROWS };
  };
  return {
    render(width) {
      if (width <= 0) return [];
      if (expanded) return [...(note?.render(width) ?? []), ...fullProgram().render(width)];
      const { rows, more } = collapsedRows(width);
      if (!more) return rows;
      let hint: string;
      try {
        hint = renderExpansionAffordance("program", false, theme);
      } catch {
        hint = "More program on expand";
      }
      return [...rows.slice(0, COLLAPSED_PROGRAM_ROWS), clipToWidth(hint, width, "")];
    },
    invalidate() {
      note?.invalidate();
      full?.invalidate();
      head?.text.invalidate();
    },
  };
}
