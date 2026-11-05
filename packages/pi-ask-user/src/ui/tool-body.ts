import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Text, visibleWidth, type Component } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
import {
  endElide,
  expandedArguments,
  expandedDetails,
  expandedSection,
  previewIssuesSlot,
} from "pi-code-previews";
import { failureMessage, restatesText } from "pi-cosmic-core/message-text";
import { stripTerminalControls } from "pi-cosmic-core/security";
import { clipToWidth, INLINE_SEPARATOR, SUITE_STATUS_GLYPHS } from "pi-cosmic-ui/manager";
import {
  composeToolComponent,
  renderExpansionAffordance,
  renderToolHeader,
  toolRunningLine,
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

/** Questionnaires waiting their turn behind earlier ones, marked as Activity marks them. */
export const queuedState = (alternatives: readonly string[], theme: Pick<Theme, "fg">): Component =>
  stateLine(alternatives, (text) => theme.fg("muted", `${SUITE_STATUS_GLYPHS.queued} ${text}`), 2);

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

/** Rows that depend only on the width, rebuilt when it changes. */
const widthRows = (rows: (width: number) => string[]): Component => {
  let last: { readonly width: number; readonly rows: string[] } | undefined;
  return {
    render: (width) => {
      if (last?.width !== width) last = { width, rows: rows(width) };
      return last.rows;
    },
    invalidate: () => {
      last = undefined;
    },
  };
};

/**
 * How far a wrapped or later line hangs beneath its first row: two columns past a nested row, such
 * as a choice or an answer's note, so a continuation never reads as one.
 */
const CONTINUATION_HANG = 4;
const CONTINUATION_PREFIX = Fn.pipe(" ", Str.repeat(CONTINUATION_HANG));

// Each written line wraps on its own; every row after the first hangs past the nested rows.
function appendAnswerLines(
  lines: string[],
  lead: string,
  text: string,
  style: (value: string) => string,
  indent: string,
  width: number,
): void {
  const [first, ...rest] = Str.split(text, /\r?\n/u);
  appendWrapped(lines, indent, `${lead}${style(first)}`, width, CONTINUATION_HANG);
  for (const line of rest)
    appendWrapped(lines, `${indent}${CONTINUATION_PREFIX}`, style(line), width);
}

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
    return widthRows((width) => {
      const lines: string[] = [];
      for (const { label, value, note } of entries) {
        appendAnswerLines(lines, theme.fg("muted", `${label}: `), value, Fn.identity, "", width);
        if (note !== undefined)
          appendAnswerLines(
            lines,
            theme.fg("dim", "Note: "),
            note,
            (text) => theme.fg("dim", text),
            "  ",
            width,
          );
      }
      return lines;
    });
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
      // A long answer or note is cut at a word boundary, so every word left on the row is whole.
      const fit = (lead: string, text: string, style: (value: string) => string): string => {
        const room = width - visibleWidth(lead);
        if (visibleWidth(text) <= room) return `${lead}${style(text)}`;
        cut = true;
        return clipToWidth(`${lead}${style(endElide(text, room))}`, width);
      };
      const rows = Arr.flatMap(firstLines, ({ label, answer, note }) => {
        const answerLine = fit(`${theme.fg("muted", `${label}:`)} `, answer.text, Fn.identity);
        return note === undefined
          ? [answerLine]
          : [
              answerLine,
              fit(`  ${theme.fg("dim", "Note: ")}`, note.text, (text) => theme.fg("dim", text)),
            ];
      });
      if (cut) rows.push(clipToWidth(renderExpansionAffordance("answers", false, theme), width));
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

// The shell's error issue already shows a one-sentence error; repeating it as detail adds nothing.
const restatesIssue = (raw: string, isError: boolean): boolean =>
  isError && restatesText(raw, failureMessage(raw, ""));

const detailsSection = (theme: Theme, facts: readonly string[]): Component =>
  expandedDetails(theme, Arr.map(facts, stripTerminalControls));

const MODE_NOTES = {
  single: undefined,
  multiple: "any number",
  text: "written answer",
} as const;

function requestRows(request: RequestView, theme: Theme, width: number): string[] {
  const lines: string[] = [];
  const append = (prefix: string, text: string, hang = 0) =>
    appendWrapped(lines, prefix, text, width, hang);
  for (const question of request.questions) {
    const note = MODE_NOTES[question.mode ?? "single"];
    append(
      "",
      `${theme.fg("muted", `${titleLabel(question.title)}:`)} ${theme.fg("text", stripTerminalControls(question.prompt))}`,
      CONTINUATION_HANG,
    );
    // The mode note is a fact of its own: it follows the prompt whole, or leads a continuation row
    // with its separator, so no line ends with one.
    if (note) {
      const last = lines.length - 1;
      const joined = `${lines[last] ?? ""}${theme.fg("dim", `${INLINE_SEPARATOR}${note}`)}`;
      if (visibleWidth(joined) <= width) lines[last] = joined;
      else
        append(CONTINUATION_PREFIX, theme.fg("dim", `${Str.trimStart(INLINE_SEPARATOR)}${note}`));
    }
    Arr.forEach(question.choices ?? [], (choice, index) => {
      const description = choice.description
        ? ` — ${stripTerminalControls(choice.description)}`
        : "";
      const number = `${index + 1}. `;
      append(
        "  ",
        `${theme.fg("text", `${number}${stripTerminalControls(choice.label)}`)}${theme.fg("muted", description)}`,
        number.length,
      );
      if (choice.preview)
        for (const line of Str.split(stripTerminalControls(choice.preview), /\r?\n/u))
          append("       ", theme.fg("dim", line));
    });
  }
  if (request.independentWork)
    append(
      "",
      theme.fg("muted", `Meanwhile: ${stripTerminalControls(request.independentWork)}`),
      CONTINUATION_HANG,
    );
  if (request.blockedWork)
    append(
      "",
      theme.fg("muted", `Blocked until answered: ${stripTerminalControls(request.blockedWork)}`),
      CONTINUATION_HANG,
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
  return expandedSection(
    theme,
    "Questions",
    widthRows((width) => requestRows(request, theme, width)),
  );
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

// Rows whose call has reported progress or a result, keyed by the row's shared renderer state.
const reportedRows = new WeakSet<object>();

/** Records that a row's result renderer drew, so its call no longer spins in its place. */
export const markReported = (context: Partial<Pick<RenderContext, "state">>): void => {
  const state: unknown = context.state;
  if (Predicate.isObject(state)) reportedRows.add(state);
};

export function callBody(
  header: ToolHeader,
  args: QuestionnaireArgs,
  theme: Theme,
  context: Pick<RenderContext, "expanded" | "state" | "isPartial" | "executionStarted">,
): Component {
  const heading = new Text(renderToolHeader(header, theme), 0, 0);
  // A started call spins until it reports where its questions stand, as its expanded row does.
  if (!context.expanded) {
    const state: unknown = context.state;
    const row = Predicate.isObject(state) ? state : undefined;
    const running = context.executionStarted && context.isPartial;
    return stacked([
      heading,
      previewIssuesSlot(context),
      composeToolComponent((width) =>
        width >= 1 && running && !(row !== undefined && reportedRows.has(row))
          ? [clipToWidth(toolRunningLine(theme), width)]
          : [],
      ),
    ]);
  }
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
      ...(input.raw && !restatesIssue(input.raw, input.isError)
        ? [rawResultSection(theme, input.raw, input.isError)]
        : []),
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
