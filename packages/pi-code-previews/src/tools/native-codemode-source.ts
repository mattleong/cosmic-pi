import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { renderExpansionAffordance } from "pi-cosmic-ui/tool";
import { escapeControlChars } from "../shared/terminal-text";
import { renderHighlightedText } from "../syntax/render";

interface NativeProgramContext {
  readonly expanded: boolean;
  readonly invalidate: () => void;
}

const COLLAPSED_PROGRAM_ROWS = 8;

/** Cap wrapped screen rows, not logical lines; expansion and theme fallback retain all source. */
export function renderNativeCodemodeProgram(
  source: string,
  theme: Theme,
  context: NativeProgramContext,
  sourceIntentNote?: string,
): Component {
  const note = sourceIntentNote && context.expanded ? new Text(sourceIntentNote, 0, 0) : undefined;
  const fallback = new Text(escapeControlChars(source), 0, 0);
  let highlighted: Component | undefined;
  try {
    highlighted = new Text(
      renderHighlightedText(source, "javascript", theme, context.invalidate).join("\n"),
      0,
      0,
    );
  } catch {
    // The plain source follows the same collapsed row budget.
  }
  return {
    render(width) {
      if (width <= 0) return [];
      let rows: string[];
      try {
        rows = (highlighted ?? fallback).render(width);
      } catch {
        highlighted = undefined;
        rows = fallback.render(width);
      }
      if (context.expanded) return [...(note?.render(width) ?? []), ...rows];
      if (rows.length <= COLLAPSED_PROGRAM_ROWS) return rows;
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
      fallback.invalidate();
      try {
        highlighted?.invalidate();
      } catch {
        highlighted = undefined;
      }
    },
  };
}
