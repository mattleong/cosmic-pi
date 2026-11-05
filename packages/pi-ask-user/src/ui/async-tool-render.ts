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
import type { PendingPresentation } from "../questionnaire/async-model.ts";
import {
  answersBody,
  callBody,
  cancelledLine,
  emptyBody,
  expandedResult,
  markReported,
  mutedState,
  queuedState,
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
  decodePresentation,
  contentText,
  deliveryFacts,
  isStatusList,
  requestFacts,
  isPendingState,
  questionnaireState,
  requestArguments,
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

type ResultContext = Partial<Pick<RenderContext, "args" | "isError" | "state">>;

type AsyncToolResult = Pick<AgentToolResult<unknown>, "content" | "details">;

export function renderAsyncCall(
  args: QuestionnaireArgs,
  theme: Theme,
  context: Pick<RenderContext, "expanded" | "state" | "isPartial" | "executionStarted">,
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
  options: ToolRenderResultOptions,
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
      // The call still shows the request until the final result arrives.
      ...(!options.isPartial && { args: requestArguments(context.args) }),
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
  markReported(context);
  if (options.isPartial)
    return presentationLine(decodePresentation(envelope(input)?.details), theme);
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

/**
 * A live call's line: an await says where its questionnaire stands, as its compact row does, and
 * spins only until it knows. A hidden one's issue already says so and how to resume it.
 */
function presentationLine(presentation: PendingPresentation | undefined, theme: Theme): Component {
  if (presentation === "open") return waitingState(stateWords("waiting"), theme);
  if (presentation === "hidden") return emptyBody();
  if (presentation === "queued") return queuedState(stateWords("queued"), theme);
  return new Text(toolRunningLine(theme), 0, 0);
}

function collapsedRows(
  rows: readonly ReplayedSnapshot[],
  states: readonly QuestionnaireState[],
  list: boolean,
  theme: Theme,
): Component {
  if (rows.length === 0) return mutedState(["No questionnaires", "None"], theme);
  // An open questionnaire needs the user now; a queued one only waits its turn.
  const pendingState = (alternatives: readonly string[], shown = states) =>
    shown.includes("waiting") || shown.includes("hidden")
      ? waitingState(alternatives, theme)
      : shown.includes("queued")
        ? queuedState(alternatives, theme)
        : mutedState(alternatives, theme);
  if (list) {
    // Hidden and failed questionnaires have their own issues: how to resume them, and the failure.
    const counted = Arr.filter(states, (entry) => entry !== "hidden" && entry !== "failed");
    return counted.length === 0
      ? emptyBody()
      : pendingState(stateCounts(counted, counted.length < states.length), counted);
  }
  const [state] = states;
  if (state === "cancelled") return cancelledLine(theme);
  // Its issue says it is hidden and how to resume it.
  if (state === "hidden") return emptyBody();
  const answers = submittedAnswers(rows);
  if (answers) return answersBody(answers, rowTitles(rows), theme, true);
  return state && isPendingState(state) ? pendingState(stateWords(state)) : emptyBody();
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
  // A preview body already shows the stored text that expansion would.
  if (!outcome)
    return {
      ...presentation,
      summary: { subject },
      ...(preview ? { collapsed: () => new Text(raw, 0, 0) } : { expandLabel: "message" }),
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
    // The request and delivery IDs.
    expandLabel: "details",
    ...(answers && { collapsed: () => answersBody(answers, titles, theme, true) }),
    ...(cancellation && {
      collapsed: () => cancelledLine(theme),
      expanded: () => stacked([cancelledLine(theme), expanded()]),
    }),
  };
};

export const renderAsyncMessage = withCodePreviewMessageShell(presentAsyncMessage);
