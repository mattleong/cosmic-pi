import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Text, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { expandedArguments, expandedSection, previewIssuesSlot } from "pi-code-previews";
import { stripTerminalControls } from "pi-cosmic-core";
import { clipToWidth } from "pi-cosmic-ui/manager";
import {
  composeToolComponent,
  renderExpansionAffordance,
  renderToolHeader,
  toolStatusLine,
  type ToolHeader,
} from "pi-cosmic-ui/tool";
import type {
  AskUserAsyncControl,
  AskUserAsyncRequest,
  AskUserRequest,
} from "../questionnaire/schema.ts";
import { titleLabel } from "./layout.ts";
import type { ReplayedAnswer } from "./tool-render-projection.ts";

export type RenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];
export type QuestionnaireArgs = Partial<AskUserRequest | AskUserAsyncRequest | AskUserAsyncControl>;

export const emptyBody = (): Component => new Container();

export function stacked(parts: readonly Component[]): Component {
  const body = new Container();
  for (const part of parts) body.addChild(part);
  return body;
}

export const cancelledLine = (theme: Pick<Theme, "fg">): Component =>
  new Text(toolStatusLine(theme, "stopped", "Cancelled"), 0, 0);

const sentenceCase = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

export const mutedState = (alternatives: readonly string[], theme: Pick<Theme, "fg">): Component =>
  composeToolComponent((width) => {
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
    label: titleLabel(titles.get(answer.key) ?? answer.key),
    value: stripTerminalControls(
      answer.kind === "choices" ? answer.labels.join(", ") : answer.text,
    ),
    note: answer.note === undefined ? undefined : stripTerminalControls(answer.note),
  }));

const indentLines = (text: string, indent: string): string =>
  text.replace(/\r?\n/gu, `\n${indent}`);

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
  return composeToolComponent((width) => {
    let cut = false;
    const fit = (prefix: string, text: string, style: (line: string) => string): string => {
      const [first = "", ...rest] = text.split(/\r?\n/u);
      const line = `${prefix}${style(first)}`;
      if (rest.some((entry) => entry.trim()) || visibleWidth(line) > width) cut = true;
      return clipToWidth(line, width);
    };
    const rendered = entries.flatMap(({ label, value, note }) => {
      const answerLine = fit(`${theme.fg("muted", `${label}:`)} `, value, (line) => line);
      return note === undefined
        ? [answerLine]
        : [answerLine, fit("  ", note, (line) => theme.fg("dim", `Note: ${line}`))];
    });
    if (cut)
      rendered.push(clipToWidth(renderExpansionAffordance("Full answers", false, theme), width));
    return rendered;
  });
}

const rawResultSection = (theme: Theme, text: string, isError: boolean): Component =>
  expandedSection(
    theme,
    isError ? "Error" : "Raw result",
    new Text(theme.fg(isError ? "error" : "toolOutput", text), 0, 0),
  );

export function callBody(
  header: ToolHeader,
  args: QuestionnaireArgs,
  theme: Theme,
  context: Pick<RenderContext, "expanded" | "state">,
): Component {
  const heading = new Text(renderToolHeader(header, theme), 0, 0);
  if (!context.expanded) return heading;
  return stacked([heading, previewIssuesSlot(context), expandedArguments(theme, args)]);
}

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
