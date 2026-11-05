import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { renderExpansionAffordance } from "pi-cosmic-ui/tool";
import { outputLimitProjection } from "../../builtin-issues";
import { isAffordanceRow } from "../../../preview/affordance-row";
import { expandedSection } from "../../../preview/expanded-section";
import { ownField, ownObject, type HostObject } from "../../../shared/untrusted-value";
import { escapeControlChars } from "../../../shared/terminal-text";
import { numericArg } from "../../data/args";

type SplitOutput = { readonly lines: string[]; readonly notice: string | undefined };

const LISTING_NOTICE = /^\[[^\r\n]+\]$/u;
const SHELL_NOTICE = /^\[Showing .+\. Full output: .+\]$/u;

function splitTrailingNotice(lines: string[], notice: RegExp): SplitOutput {
  const last = lines.at(-1);
  if (last === undefined || lines.at(-2) !== "" || !notice.test(last))
    return { lines, notice: undefined };
  let end = lines.length - 1;
  while (end > 0 && lines[end - 1] === "") end -= 1;
  return { lines: lines.slice(0, end), notice: Fn.pipe(last, Str.slice(1, -1)) };
}

export const splitListingNotice = (lines: string[]): SplitOutput =>
  splitTrailingNotice(lines, LISTING_NOTICE);

export const splitShellNotice = (lines: string[]): SplitOutput =>
  splitTrailingNotice(lines, SHELL_NOTICE);

export function oversizedReadNotice(
  details: HostObject | undefined,
  text: string,
): string | undefined {
  if (ownField(ownObject(details, "truncation"), "firstLineExceedsLimit") !== true)
    return undefined;
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

/**
 * A listing's `Limit reached` line when its limit was reached. A preview heading that states the
 * limit (`· limit 2`) gives the number, so the line adds it only for a limit the call didn't set.
 */
export function limitReachedLine(
  tool: "grep" | "find" | "ls",
  details: HostObject | undefined,
  args: HostObject | undefined,
): string | undefined {
  const [counter] = outputLimitProjection(tool, details).counters;
  if (counter === undefined) return undefined;
  const requested = numericArg(args, "limit");
  return requested !== undefined && counter === `limit reached: ${requested}`
    ? "Limit reached"
    : `${Str.toUpperCase(Str.slice(0, 1)(counter))}${Str.slice(1)(counter)}`;
}

/**
 * A collapsed listing's rows, then, when its limit was reached, its `Limit reached` line and,
 * unless the rows already offer expansion, the agent notes expansion adds.
 */
export function withCollapsedLimit(
  text: string,
  theme: Theme,
  tool: "grep" | "find" | "ls",
  details: HostObject | undefined,
  args: HostObject | undefined,
  notice: string | undefined,
): string {
  const stated = limitReachedLine(tool, details, args);
  if (stated === undefined) return text;
  const offered = Arr.some(Str.split(text, "\n"), isAffordanceRow);
  return Arr.join(
    [
      text,
      theme.fg("muted", stated),
      ...(notice && !offered ? [renderExpansionAffordance("agent notes", false, theme)] : []),
    ],
    "\n",
  );
}
