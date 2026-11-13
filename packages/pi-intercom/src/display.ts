import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { authoredTextLines, expandedDetails } from "pi-code-previews";
import { sanitizeTerminalLine, stripTerminalControls } from "pi-cosmic-core/security";
import { cachedComponent } from "pi-cosmic-ui/tool";
import { displayDirectory, overlongSessionName } from "./identity.ts";

/** Words a session wrote, without terminal escape sequences that would restyle the view. */
export const sessionText = (text: string): string => stripTerminalControls(text);

/**
 * Text a session wrote, rendered as markdown the way Pi renders assistant text. Collapsed, it shows
 * about ten wrapped rows and says how many more expansion shows. `indent` sets it beneath a
 * heading, as a collapsed preview message's body sits two columns in.
 */
export const textBody = (
  text: string,
  theme: Pick<Theme, "fg" | "bold">,
  expanded: boolean,
  indent = 0,
): Component =>
  cachedComponent((width) =>
    authoredTextLines(sessionText(text), width, theme, { expanded, indent }),
  );

/** How far a collapsed preview message's body indents beneath its heading. */
export const PREVIEW_BODY_INDENT = 2;

/** A muted status line, such as how a recipient will read a message. */
export const statusLine = (text: string, theme: Pick<Theme, "fg">): Component =>
  new Text(theme.fg("muted", sanitizeTerminalLine(text)), 0, 0);

/**
 * The expanded `Details` section: a session's full id, its directory, and its name only when it is
 * too long for any heading to carry whole.
 */
export const sessionDetails = (
  theme: Pick<Theme, "fg">,
  session: {
    readonly sessionId: string;
    readonly name?: string | undefined;
    readonly cwd?: string | undefined;
  },
): Component => {
  const name = overlongSessionName(session);
  return expandedDetails(theme, [
    Arr.join(
      Arr.filter(
        [
          `Session ${sanitizeTerminalLine(session.sessionId)}`,
          name === undefined ? "" : `Name ${name}`,
          displayDirectory(session.cwd ?? ""),
        ],
        Str.isNonEmpty,
      ),
      " · ",
    ),
  ]);
};
