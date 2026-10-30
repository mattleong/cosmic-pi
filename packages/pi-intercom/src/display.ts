import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { countLabel } from "pi-cosmic-core/display";
import { sanitizeTerminalLine, stripTerminalControls } from "pi-cosmic-core/security";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { renderExpansionAffordance } from "pi-cosmic-ui/tool";

/** Wrapped rows a collapsed message or reply shows before its expansion affordance. */
export const COLLAPSED_BODY_ROWS = 10;

const bodyLines = (text: string): ReadonlyArray<string> =>
  Fn.pipe(
    stripTerminalControls(text),
    Str.replace(/\t/gu, "  "),
    Str.replace(/^\n+/u, ""),
    Str.trimEnd,
    Str.split("\n"),
  );

/**
 * Text an agent wrote, with its line breaks. Collapsed, it shows at most
 * {@link COLLAPSED_BODY_ROWS} wrapped rows and says how many more expansion shows.
 */
export const textBody = (
  text: string,
  theme: Pick<Theme, "fg">,
  expanded: boolean,
  color: "toolOutput" | "text" = "toolOutput",
): Component => {
  const lines = bodyLines(text);
  let cached: { readonly width: number; readonly rows: string[] } | undefined;
  return {
    render(width) {
      if (!Number.isFinite(width) || width < 1) return [];
      if (cached?.width === width) return cached.rows;
      const wrapped = Arr.flatMap(lines, (line) =>
        line === "" ? [""] : wrapTextWithAnsi(line, width),
      );
      const shown = expanded ? wrapped : wrapped.slice(0, COLLAPSED_BODY_ROWS);
      const rows = Arr.map(shown, (row) => theme.fg(color, row));
      const hidden = wrapped.length - shown.length;
      if (hidden > 0)
        rows.push(
          clipToWidth(
            renderExpansionAffordance(countLabel(hidden, "more line"), false, theme),
            width,
            "",
          ),
        );
      cached = { width, rows };
      return rows;
    },
    invalidate() {
      cached = undefined;
    },
  };
};

/** A muted status line, such as how a recipient will read a message. */
export const statusLine = (text: string, theme: Pick<Theme, "fg">): Component =>
  new Text(theme.fg("muted", sanitizeTerminalLine(text)), 0, 0);

/** The technical facts expansion adds below a row, such as a session's id and directory. */
export const detailsLine = (parts: ReadonlyArray<string>, theme: Pick<Theme, "fg">): Component =>
  new Text(
    theme.fg(
      "dim",
      Arr.join(Arr.filter(Arr.map(parts, sanitizeTerminalLine), Str.isNonEmpty), " · "),
    ),
    0,
    0,
  );
