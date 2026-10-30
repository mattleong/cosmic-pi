import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import { withCodePreviewMessageShell, type CodePreviewMessagePresenter } from "pi-code-previews";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { countLabel } from "pi-cosmic-core/display";
import { decodeUnknownOrUndefined } from "pi-cosmic-core/schema/decode";
import { toolRunningLine } from "pi-cosmic-ui/tool";
import {
  answersBody,
  callBody,
  cancelledLine,
  emptyBody,
  expandedResult,
  mutedState,
  waitingState,
  stacked,
  type QuestionnaireArgs,
  type RenderContext,
} from "./tool-body.ts";
import {
  answerOutcome,
  callTitles,
  decodeAsyncControl,
  decodeExpandedAsyncRows,
  contentText,
  deliveryFacts,
  isStatusList,
  requestFacts,
  isPendingState,
  questionnaireState,
  stateCounts,
  stateWords,
  storedTitlesLabel,
  titlesOf,
  type QuestionnaireState,
  type ReplayedAnswer,
  type ReplayedSnapshot,
} from "./tool-render-projection.ts";

const envelope = decodeUnknownOrUndefined(
  Schema.Struct({
    details: Schema.optional(Schema.Unknown),
    content: Schema.optional(Schema.Unknown),
  }),
);
const notification = decodeUnknownOrUndefined(
  Schema.Struct({
    requestId: Schema.String,
    deliveryId: Schema.String,
    generation: Schema.String,
    outcome: answerOutcome,
    titles: Schema.optional(Schema.Unknown),
  }),
);
const NO_TITLES: ReadonlyMap<string, string> = new Map();

type ResultContext = Partial<Pick<RenderContext, "args" | "isError">>;

type AsyncToolResult = Pick<AgentToolResult<unknown>, "content" | "details">;

export function renderAsyncCall(
  args: QuestionnaireArgs,
  theme: Theme,
  context: Pick<RenderContext, "expanded" | "state">,
  isControl = false,
): Component {
  const header = isControl
    ? { title: "Questionnaire", subtitle: decodeAsyncControl(args)?.action }
    : { title: "Ask user", subtitle: callTitles(args) };
  return callBody(header, args, theme, context);
}

/** Titles label a lone row's answers; a list shows no answers. */
const rowTitles = (rows: readonly ReplayedSnapshot[] | undefined): ReadonlyMap<string, string> => {
  const [row] = rows ?? [];
  return rows?.length === 1 && row ? titlesOf(row.titles) : NO_TITLES;
};

function submittedAnswers(
  rows: readonly ReplayedSnapshot[] | undefined,
): readonly ReplayedAnswer[] | undefined {
  const [row] = rows ?? [];
  return rows?.length === 1 &&
    row &&
    questionnaireState(row) === "answered" &&
    row.outcome?.outcome === "submitted"
    ? row.outcome.answers
    : undefined;
}

export function renderAsyncContent(
  input: AsyncToolResult,
  _options: ToolRenderResultOptions,
  theme: Theme,
  context: ResultContext = {},
): Component {
  const result = envelope(input);
  const rows = decodeExpandedAsyncRows(result?.details);
  const list = rows?.length !== 1 || isStatusList(context.args);
  return expandedResult(
    {
      raw: contentText(result?.content),
      isError: context.isError ?? false,
      decoded: rows !== undefined,
      answers: submittedAnswers(rows),
      titles: rowTitles(rows),
      facts: rows ? requestFacts(rows, list) : [],
    },
    theme,
  );
}

export function renderAsyncResult(
  input: AsyncToolResult,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ResultContext = {},
): Component {
  if (options.isPartial) return new Text(toolRunningLine(theme), 0, 0);
  const result = envelope(input);
  const decoded = decodeExpandedAsyncRows(result?.details);
  const rows = decoded ?? [];
  const states = Arr.getSomes(
    Arr.map(rows, (row) => Option.fromNullishOr(questionnaireState(row))),
  );
  const list = rows.length !== 1 || isStatusList(context.args);
  const classified = decoded !== undefined && states.length === rows.length;
  if (options.expanded) {
    const content = renderAsyncContent(input, options, theme, context);
    // A list keeps its counts and a lone cancellation its line; expanded issues state pending work.
    if (context.isError || !classified || (!list && states[0] !== "cancelled")) return content;
    return stacked([collapsedRows(rows, states, list, theme), content]);
  }
  if (context.isError) return emptyBody();
  if (!classified) return new Text(contentText(result?.content), 0, 0);
  return collapsedRows(rows, states, list, theme);
}

function collapsedRows(
  rows: readonly ReplayedSnapshot[],
  states: readonly QuestionnaireState[],
  list: boolean,
  theme: Theme,
): Component {
  if (rows.length === 0) return mutedState(["No questionnaires retained", "None retained"], theme);
  if (list)
    return Arr.some(states, isPendingState)
      ? waitingState(stateCounts(states), theme)
      : mutedState(stateCounts(states), theme);
  const [state] = states;
  if (state === "cancelled") return cancelledLine(theme);
  const answers = submittedAnswers(rows);
  if (answers) return answersBody(answers, rowTitles(rows), theme, true);
  return state && isPendingState(state) ? waitingState(stateWords(state), theme) : emptyBody();
}

/**
 * An async questionnaire's answer message: what happened as its heading, then the answers. A
 * message whose details don't decode keeps its stored text.
 */
export const presentAsyncMessage: CodePreviewMessagePresenter = (input, options, theme) => {
  const message = envelope(input);
  const delivered = notification(message?.details);
  const outcome = delivered?.outcome;
  const titles = titlesOf(delivered?.titles);
  const raw = contentText(message?.content);
  const answers = outcome?.outcome === "submitted" ? outcome.answers : undefined;
  const preview = options.collapsedStyle === "preview";
  const expanded = () =>
    expandedResult(
      {
        raw,
        isError: false,
        decoded: delivered !== undefined,
        answers,
        titles,
        facts: delivered ? deliveryFacts(delivered.requestId, delivered.deliveryId) : [],
      },
      theme,
    );
  // The icon says whether it was answered or cancelled; the heading names the questions.
  const subject = storedTitlesLabel(delivered?.titles) ?? "questionnaire";
  const presentation = { name: "ask_user_answers", label: "Answers", expanded };
  if (!outcome)
    return {
      ...presentation,
      summary: { subject },
      ...(preview && { collapsed: () => new Text(raw, 0, 0) }),
    };
  const cancelled = outcome.outcome === "cancelled";
  // The preview heading carries no glyph, so its body names the cancellation.
  const cancellation = preview && cancelled;
  return {
    ...presentation,
    summary: {
      subject,
      outcome: cancelled ? "cancelled" : "success",
      counters: answers?.length ? [countLabel(answers.length, "answer")] : [],
    },
    ...(answers && { collapsed: () => answersBody(answers, titles, theme, true) }),
    ...(cancellation && {
      collapsed: () => cancelledLine(theme),
      expanded: () => stacked([cancelledLine(theme), expanded()]),
    }),
  };
};

export const renderAsyncMessage = withCodePreviewMessageShell(presentAsyncMessage);
