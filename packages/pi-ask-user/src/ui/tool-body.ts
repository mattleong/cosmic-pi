/**
 * Questionnaire tool bodies. The shared shell draws outcomes and issue lines; these pieces draw
 * only content: headings, answers, routine state, and labeled agent-facing text.
 */
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Text, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { expandedSection, previewIssuesSlot } from "pi-code-previews";
import { stripTerminalControls } from "pi-cosmic-core";
import { clipToWidth } from "pi-cosmic-ui/manager";
import {
  renderExpansionAffordance,
  renderToolHeader,
  toolStatusLine,
  type ToolHeader,
} from "pi-cosmic-ui/tool";
import type { ReplayedAnswer } from "./tool-render-projection.ts";

/** Pi's renderer context, without copying its runtime definition. */
export type RenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];

const lines = (render: (width: number) => string[]): Component => ({
  render,
  invalidate: () => undefined,
});

/** Nothing to add: the heading and the shell's issue lines already say it. */
export const emptyBody = (): Component => new Container();

/** Components one after another. */
export function stacked(parts: readonly Component[]): Component {
  const body = new Container();
  for (const part of parts) body.addChild(part);
  return body;
}

/**
 * The user's cancellation, worded as the shell words an aborted call. The shell states only
 * cancellations Pi reports as errors; the body states the ones the questionnaire returned.
 */
export const cancelledLine = (theme: Pick<Theme, "fg">): Component =>
  new Text(toolStatusLine(theme, "stopped", "Cancelled"), 0, 0);

const sentenceCase = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** Routine state in muted text: the first wording that fits the width. */
export const mutedState = (alternatives: readonly string[], theme: Pick<Theme, "fg">): Component =>
  lines((width) => {
    const text =
      alternatives.find((entry) => visibleWidth(entry) <= width) ?? alternatives.at(-1) ?? "";
    return text ? [clipToWidth(theme.fg("muted", sentenceCase(text)), width)] : [];
  });

interface AnswerEntry {
  readonly label: string;
  readonly value: string;
  readonly note: string | undefined;
}

const answerEntries = (
  answers: readonly ReplayedAnswer[],
  titles: ReadonlyMap<string, string>,
): AnswerEntry[] =>
  answers.map((answer) => ({
    label: stripTerminalControls(titles.get(answer.key) ?? answer.key),
    value: stripTerminalControls(
      answer.kind === "choices" ? answer.labels.join(", ") : answer.text,
    ),
    note: answer.note === undefined ? undefined : stripTerminalControls(answer.note),
  }));

const indentLines = (text: string, indent: string): string =>
  text.replace(/\r?\n/gu, `\n${indent}`);

/**
 * Each answer under its question title, with its note indented beneath it. Collapsed, each keeps
 * to one line and an expansion hint says when text was cut; expanded shows them whole.
 */
export function answersBody(
  answers: readonly ReplayedAnswer[],
  titles: ReadonlyMap<string, string>,
  theme: Pick<Theme, "fg">,
  bounded: boolean,
): Component {
  const entries = answerEntries(answers, titles);
  if (!bounded)
    return new Text(
      entries
        .flatMap(({ label, value, note }) => [
          `${theme.fg("muted", `${label}:`)} ${indentLines(value, "  ")}`,
          ...(note === undefined ? [] : [theme.fg("dim", `  Note: ${indentLines(note, "    ")}`)]),
        ])
        .join("\n"),
      0,
      0,
    );
  return lines((width) => {
    let cut = false;
    const fit = (prefix: string, text: string, style: (line: string) => string): string => {
      const [first = "", ...rest] = text.split(/\r?\n/u);
      const line = `${prefix}${style(first)}`;
      if (rest.some((entry) => entry.trim()) || visibleWidth(line) > width) cut = true;
      return clipToWidth(line, width);
    };
    const rendered = entries.flatMap(({ label, value, note }) => [
      fit(`${theme.fg("muted", `${label}:`)} `, value, (line) => line),
      ...(note === undefined ? [] : [fit("  ", note, (line) => theme.fg("dim", `Note: ${line}`))]),
    ]);
    if (cut)
      rendered.push(clipToWidth(renderExpansionAffordance("Full answers", false, theme), width));
    return rendered;
  });
}

/** Agent-facing text under its label. Request IDs and agent procedures stay in here. */
export const rawResultSection = (theme: Theme, text: string, isError: boolean): Component =>
  expandedSection(
    theme,
    isError ? "Error" : "Raw result",
    new Text(theme.fg(isError ? "error" : "toolOutput", text), 0, 0),
  );

/** The call's exact input, listed in full. */
export function argumentsSection<Args>(theme: Theme, args: Args): Component {
  let json = "";
  try {
    json = JSON.stringify(args, null, 2) ?? "";
  } catch {
    // Hostile replayed arguments leave the section empty rather than failing the row.
  }
  return expandedSection(
    theme,
    "Arguments",
    new Text(theme.fg("toolOutput", stripTerminalControls(json)), 0, 0),
  );
}

/** A call's heading; expanded, the shell's issue lines and then the full arguments follow. */
export function callBody<Args>(
  header: ToolHeader,
  args: Args,
  theme: Theme,
  context: Pick<RenderContext, "expanded" | "state">,
): Component {
  const heading = new Text(renderToolHeader(header, theme), 0, 0);
  if (!context.expanded) return heading;
  return stacked([heading, previewIssuesSlot(context), argumentsSection(theme, args)]);
}

/** Expanded results: the agent-facing text, or the answers when a replay has no text. */
export function expandedResult(
  raw: string,
  isError: boolean,
  answers: readonly ReplayedAnswer[] | undefined,
  titles: ReadonlyMap<string, string>,
  theme: Theme,
): Component {
  if (raw) return rawResultSection(theme, raw, isError);
  return answers ? answersBody(answers, titles, theme, false) : emptyBody();
}
