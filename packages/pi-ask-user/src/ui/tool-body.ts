import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Text, visibleWidth, type Component } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { expandedArguments, expandedSection, previewIssuesSlot } from "pi-code-previews";
import { stripTerminalControls } from "pi-cosmic-core/security";
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
import { appendWrapped, titleLabel } from "./layout.ts";
import {
  requestArguments,
  type ReplayedAnswer,
  type RequestArguments,
  type RequestView,
} from "./tool-render-projection.ts";

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

const stateLine = (
  alternatives: readonly string[],
  draw: (text: string) => string,
  inset: number,
): Component =>
  composeToolComponent((width) => {
    const text = Option.getOrElse(
      Arr.findFirst(alternatives, (entry) => visibleWidth(entry) <= width - inset),
      () => alternatives.at(-1) ?? "",
    );
    return text ? [clipToWidth(draw(Str.capitalize(text)), width)] : [];
  });

export const mutedState = (alternatives: readonly string[], theme: Pick<Theme, "fg">): Component =>
  stateLine(alternatives, (text) => theme.fg("muted", text), 0);

/** Questionnaires still waiting on the user's answers. */
export const waitingState = (
  alternatives: readonly string[],
  theme: Pick<Theme, "fg">,
): Component => stateLine(alternatives, (text) => toolStatusLine(theme, "waiting", text), 2);

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

const detailsSection = (theme: Theme, facts: readonly string[]): Component =>
  expandedSection(
    theme,
    "Details",
    new Text(theme.fg("dim", Arr.join(Arr.map(facts, stripTerminalControls), "\n")), 0, 0),
  );

const MODE_NOTES = {
  single: undefined,
  multiple: "any number",
  text: "written answer",
} as const;

function requestRows(request: RequestView, theme: Theme, width: number): string[] {
  const lines: string[] = [];
  const append = (prefix: string, text: string) => appendWrapped(lines, prefix, text, width);
  for (const question of request.questions) {
    const note = MODE_NOTES[question.mode ?? "single"];
    append(
      "",
      `${theme.fg("muted", `${titleLabel(question.title)}:`)} ${theme.fg("text", stripTerminalControls(question.prompt))}${note ? theme.fg("dim", ` · ${note}`) : ""}`,
    );
    Arr.forEach(question.choices ?? [], (choice, index) => {
      const description = choice.description
        ? ` — ${stripTerminalControls(choice.description)}`
        : "";
      append(
        "  ",
        `${theme.fg("text", `${index + 1}. ${stripTerminalControls(choice.label)}`)}${theme.fg("muted", description)}`,
      );
      if (choice.preview)
        for (const line of Str.split(stripTerminalControls(choice.preview), /\r?\n/u))
          append("       ", theme.fg("dim", line));
    });
  }
  if (request.independentWork)
    append("", theme.fg("muted", `Meanwhile: ${stripTerminalControls(request.independentWork)}`));
  if (request.blockedWork)
    append(
      "",
      theme.fg("muted", `Blocked until answered: ${stripTerminalControls(request.blockedWork)}`),
    );
  return lines;
}

/**
 * The questions a call asked, written out readably with every prompt, choice, description, and
 * preview. Calls whose arguments don't read as a questionnaire keep their raw arguments, and a
 * control call's arguments are dropped only once its decoded result names the request.
 */
export function requestSection(
  theme: Theme,
  args: RequestArguments | undefined,
  identified = false,
): Component {
  // Tool arguments are always objects; anything else has no fields to show.
  if (!args) return emptyBody();
  const { control, request } = args;
  if (control)
    return identified
      ? emptyBody()
      : detailsSection(theme, [control.requestId ?? "All retained questionnaires"]);
  if (!request) return expandedArguments(theme, args.fields);
  let last: { readonly width: number; readonly rows: string[] } | undefined;
  return expandedSection(theme, "Questions", {
    render: (width) => {
      if (last?.width !== width) last = { width, rows: requestRows(request, theme, width) };
      return last.rows;
    },
    invalidate: () => {
      last = undefined;
    },
  });
}

/**
 * Before a result arrives the call shows what it asked; afterward the result leads with the
 * answers and repeats the request beneath them.
 */
export const pendingRequest = (
  theme: Theme,
  args: RequestArguments | undefined,
  context: Pick<RenderContext, "isPartial">,
): Component => (context.isPartial ? requestSection(theme, args) : emptyBody());

export function callBody(
  header: ToolHeader,
  args: QuestionnaireArgs,
  theme: Theme,
  context: Pick<RenderContext, "expanded" | "state" | "isPartial">,
): Component {
  const heading = new Text(renderToolHeader(header, theme), 0, 0);
  if (!context.expanded) return heading;
  return stacked([
    heading,
    previewIssuesSlot(context),
    pendingRequest(theme, requestArguments(args), context),
  ]);
}

export interface ExpandedResultInput {
  /** The model-facing text, shown only when the details don't decode. */
  readonly raw: string;
  readonly isError: boolean;
  readonly decoded: boolean;
  readonly answers?: readonly ReplayedAnswer[] | undefined;
  readonly titles?: ReadonlyMap<string, string>;
  /** Technical facts, such as request and delivery IDs, for the dim details section. */
  readonly facts?: readonly string[];
  /** The call's arguments, written out after the answers once the result arrived. */
  readonly args?: RequestArguments | undefined;
}

export function expandedResult(input: ExpandedResultInput, theme: Theme): Component {
  const request =
    input.args === undefined ? [] : [requestSection(theme, input.args, input.decoded)];
  if (!input.decoded)
    return stacked([
      ...(input.raw ? [rawResultSection(theme, input.raw, input.isError)] : []),
      ...request,
    ]);
  const facts = input.facts ?? [];
  return stacked([
    ...(input.answers
      ? [
          expandedSection(
            theme,
            "Answers",
            answersBody(input.answers, input.titles ?? new Map(), theme, false),
          ),
        ]
      : []),
    ...request,
    ...(facts.length > 0 ? [detailsSection(theme, facts)] : []),
  ]);
}
