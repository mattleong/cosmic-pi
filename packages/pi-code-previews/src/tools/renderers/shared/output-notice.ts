import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { expandedSection } from "../../../preview/expanded-section";
import { getObjectValue } from "../../../shared/helpers";
import { escapeControlChars } from "../../../shared/terminal-text";

type SplitOutput = { readonly lines: string[]; readonly notice: string | undefined };

// Search and listing output never contains a blank line, so a final bracketed paragraph is Pi's.
const LISTING_NOTICE = /^\[[^\r\n]+\]$/u;
// Pi's bash notice names the retained full output; ordinary command output must not match.
const SHELL_NOTICE = /^\[Showing .+\. Full output: .+\]$/u;

/**
 * Pi appends recovery text for the agent as one bracketed paragraph, such as "[30 matches limit
 * reached. Use limit=60 for more, or refine pattern]". It is not output: collapsed bodies omit it
 * and never count it, and expanded content keeps it under "Agent notes".
 */
function splitTrailingNotice(lines: string[], notice: RegExp): SplitOutput {
  const last = lines.at(-1);
  if (last === undefined || lines.at(-2) !== "" || !notice.test(last))
    return { lines, notice: undefined };
  let end = lines.length - 1;
  while (end > 0 && lines[end - 1] === "") end -= 1;
  return { lines: lines.slice(0, end), notice: last.slice(1, -1) };
}

/** Grep, find, and ls output without Pi's trailing limit notice. */
export const splitListingNotice = (lines: string[]): SplitOutput =>
  splitTrailingNotice(lines, LISTING_NOTICE);

/** Bash output, without its closing status, and without Pi's truncation notice. */
export const splitShellNotice = (lines: string[]): SplitOutput =>
  splitTrailingNotice(lines, SHELL_NOTICE);

/**
 * A read whose first line exceeds Pi's byte limit returns only a recovery instruction for the
 * agent, never file content. The issue line reports it; the instruction is not a numbered line.
 */
export function oversizedReadNotice<Details>(details: Details, text: string): string | undefined {
  const truncation = getObjectValue(details, "truncation");
  if (getObjectValue(truncation, "firstLineExceedsLimit") !== true) return undefined;
  return /^\[([^\r\n]*)\]$/u.exec(text)?.[1] ?? text;
}

/** Recovery text written for the agent, shown only in expanded content under its own label. */
export function agentNotesSection(theme: Theme, notes: string): Component {
  return expandedSection(
    theme,
    "Agent notes",
    new Text(theme.fg("dim", escapeControlChars(notes)), 0, 0),
  );
}

/** A body followed by its agent notes when there are any. */
export function withAgentNotes(body: Component, theme: Theme, notes: string | undefined) {
  if (!notes) return body;
  const container = new Container();
  container.addChild(body);
  container.addChild(agentNotesSection(theme, notes));
  return container;
}
