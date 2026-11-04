import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { authoredTextLines, expandedDetails } from "pi-code-previews";
import { nodeDisplayHomeDirectory } from "pi-cosmic-core/platform/node-builtins";
import { abbreviateHomePath } from "pi-cosmic-core/platform/paths";
import { sanitizeTerminalLine, stripTerminalControls } from "pi-cosmic-core/security";

/** Words a session wrote, without terminal escape sequences that would restyle the view. */
export const sessionText = (text: string): string => stripTerminalControls(text);

/**
 * Text a session wrote, rendered as markdown the way Pi renders assistant text. Collapsed, it shows
 * about ten wrapped rows and says how many more expansion shows.
 */
export const textBody = (
  text: string,
  theme: Pick<Theme, "fg" | "bold">,
  expanded: boolean,
): Component => {
  let cached: { readonly width: number; readonly rows: string[] } | undefined;
  return {
    render(width) {
      if (!Number.isFinite(width) || width < 1) return [];
      if (cached?.width === width) return cached.rows;
      const rows = authoredTextLines(sessionText(text), width, theme, { expanded, indent: 0 });
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

/** A working directory as people read it, with the home directory shortened to `~`. */
export const displayDirectory = (cwd: string): string =>
  abbreviateHomePath(sanitizeTerminalLine(cwd), nodeDisplayHomeDirectory());

/** The expanded `Details` section: a session's full id and its directory. */
export const sessionDetails = (
  theme: Pick<Theme, "fg">,
  sessionId: string,
  cwd: string | undefined,
): Component =>
  expandedDetails(theme, [
    Arr.join(
      Arr.filter(
        [`Session ${sanitizeTerminalLine(sessionId)}`, displayDirectory(cwd ?? "")],
        Str.isNonEmpty,
      ),
      " · ",
    ),
  ]);
