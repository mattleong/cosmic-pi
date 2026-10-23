import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Text, visibleWidth, type Component } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
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

export const mutedState = (alternatives: readonly string[], theme: Pick<Theme, "fg">): Component =>
  composeToolComponent((width) => {
    const text = Option.getOrElse(
      Arr.findFirst(alternatives, (entry) => visibleWidth(entry) <= width),
      () => alternatives.at(-1) ?? "",
    );
    return text ? [clipToWidth(theme.fg("muted", Str.capitalize(text)), width)] : [];
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
  Arr.map(answers, (answer) => ({
    label: titleLabel(titles.get(answer.key) ?? answer.key),
    value: stripTerminalControls(
      answer.kind === "choices" ? Arr.join(answer.labels, ", ") : answer.text,
    ),
    note: answer.note === undefined ? undefined : stripTerminalControls(answer.note),
  }));

const indentLines = (text: string, indent: string): string =>
  Fn.pipe(text, Str.replace(/\r?\n/gu, `\n${indent}`));

interface FirstLine {
  readonly text: string;
  // A later nonblank line is hidden by the bounded view.
  readonly hidesMore: boolean;
}

const firstLine = (text: string): FirstLine => {
  const [first, ...rest] = Str.split(text, /\r?\n/u);
  return { text: first, hidesMore: Arr.some(rest, (entry) => Str.isNonEmpty(Str.trim(entry))) };
};

export function answersBody(
  answers: readonly ReplayedAnswer[],
  titles: ReadonlyMap<string, string>,
  theme: Pick<Theme, "fg">,
  bounded: boolean,
): Component {
  const entries = answerEntries(answers, titles);
  if (!bounded)
    return new Text(
      Arr.join(
        Arr.flatMap(entries, ({ label, value, note }) => [
          `${theme.fg("muted", `${label}:`)} ${indentLines(value, "  ")}`,
          ...(note === undefined ? [] : [theme.fg("dim", `  Note: ${indentLines(note, "    ")}`)]),
        ]),
        "\n",
      ),
      0,
      0,
    );
  // Splitting long answers is width-independent; rows are rebuilt only when the width changes.
  const firstLines = Arr.map(entries, ({ label, value, note }) => ({
    label,
    answer: firstLine(value),
    note: note === undefined ? undefined : firstLine(note),
  }));
  const hidesMore = Arr.some(
    firstLines,
    ({ answer, note }) => answer.hidesMore || note?.hidesMore === true,
  );
  let last: { readonly width: number; readonly rows: string[] } | undefined;
  return {
    render: (width) => {
      if (last?.width === width) return last.rows;
      let cut = hidesMore;
      const fit = (line: string): string => {
        if (visibleWidth(line) > width) cut = true;
        return clipToWidth(line, width);
      };
      const rows = Arr.flatMap(firstLines, ({ label, answer, note }) => {
        const answerLine = fit(`${theme.fg("muted", `${label}:`)} ${answer.text}`);
        return note === undefined
          ? [answerLine]
          : [answerLine, fit(`  ${theme.fg("dim", `Note: ${note.text}`)}`)];
      });
      if (cut)
        rows.push(clipToWidth(renderExpansionAffordance("Full answers", false, theme), width));
      last = { width, rows };
      return rows;
    },
    invalidate: () => {
      last = undefined;
    },
  };
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
