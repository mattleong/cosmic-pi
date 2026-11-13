import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, type Component } from "@earendil-works/pi-tui";
import { outputLimitProjection } from "../../builtin-issues";
import { hiddenPreviewExpandHintForShell } from "../../../preview/bordered-tool-call";
import { expandedText } from "../../../preview/expanded-body";
import type { HostObject } from "../../../shared/untrusted-value";
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

export function agentNotesSection(theme: Theme, notes: string): Component {
  return expandedText(theme, "Agent notes", Str.split(notes, "\n"), "dim");
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
    : `${Str.toUpperCase(Fn.pipe(counter, Str.slice(0, 1)))}${Fn.pipe(counter, Str.slice(1))}`;
}

/**
 * Appends a collapsed listing's `Limit reached` line when its limit was reached. Agent notes kept
 * for expansion become the row's `agent notes` tag, unless the rows already offer expansion with
 * their own stand-in; outside a shell the `▸ agent notes` line follows instead. Build it while the
 * shell builds the result body, because that is when the tag is recorded.
 */
export function collapsedLimit(
  row: { readonly state: unknown },
  theme: Theme,
  tool: "grep" | "find" | "ls",
  input: {
    readonly details: HostObject | undefined;
    readonly args: HostObject | undefined;
    readonly notice: string | undefined;
    readonly offered: boolean;
  },
): (text: string) => string {
  const stated = limitReachedLine(tool, input.details, input.args);
  if (stated === undefined) return Fn.identity;
  const hint =
    input.notice && !input.offered
      ? hiddenPreviewExpandHintForShell(row, theme, "agent notes")
      : "";
  return (text) => Arr.join([text, theme.fg("muted", stated), ...(hint ? [hint] : [])], "\n");
}
