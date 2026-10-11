import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { expandedSection } from "../../../preview/expanded-section";
import { getObjectValue } from "../../../shared/helpers";
import { escapeControlChars } from "../../../shared/terminal-text";

type SplitOutput = { readonly lines: string[]; readonly notice: string | undefined };

const LISTING_NOTICE = /^\[[^\r\n]+\]$/u;
const SHELL_NOTICE = /^\[Showing .+\. Full output: .+\]$/u;

function splitTrailingNotice(lines: string[], notice: RegExp): SplitOutput {
  const last = lines.at(-1);
  if (last === undefined || lines.at(-2) !== "" || !notice.test(last))
    return { lines, notice: undefined };
  let end = lines.length - 1;
  while (end > 0 && lines[end - 1] === "") end -= 1;
  return { lines: lines.slice(0, end), notice: last.slice(1, -1) };
}

export const splitListingNotice = (lines: string[]): SplitOutput =>
  splitTrailingNotice(lines, LISTING_NOTICE);

export const splitShellNotice = (lines: string[]): SplitOutput =>
  splitTrailingNotice(lines, SHELL_NOTICE);

export function oversizedReadNotice<Details>(details: Details, text: string): string | undefined {
  const truncation = getObjectValue(details, "truncation");
  if (getObjectValue(truncation, "firstLineExceedsLimit") !== true) return undefined;
  return /^\[([^\r\n]*)\]$/u.exec(text)?.[1] ?? text;
}

export function agentNotesSection(theme: Theme, notes: string): Component {
  return expandedSection(
    theme,
    "Agent notes",
    new Text(theme.fg("dim", escapeControlChars(notes)), 0, 0),
  );
}

export function withAgentNotes(body: Component, theme: Theme, notes: string | undefined) {
  if (!notes) return body;
  const container = new Container();
  container.addChild(body);
  container.addChild(agentNotesSection(theme, notes));
  return container;
}
