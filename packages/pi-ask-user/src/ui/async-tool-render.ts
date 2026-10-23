import type {
  AgentToolResult,
  MessageRenderer,
  MessageRenderOptions,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import { planCompactPresentation, renderCompactIssues, renderCompactRow } from "pi-code-previews";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { countLabel, decodeUnknownOrUndefined } from "pi-cosmic-core";
import { composeToolComponent, renderToolHeader, toolRunningLine } from "pi-cosmic-ui/tool";
import {
  answersBody,
  callBody,
  cancelledLine,
  emptyBody,
  expandedResult,
  mutedState,
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
  isStatusList,
  questionnaireState,
  stateCounts,
  stateWords,
  type QuestionnaireState,
  type ReplayedAnswer,
  type ReplayedOutcome,
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
  }),
);
const NO_TITLES: ReadonlyMap<string, string> = new Map();

type ResultContext = Partial<Pick<RenderContext, "args" | "isError">>;

type AsyncToolResult = Pick<AgentToolResult<unknown>, "content" | "details">;
type AsyncMessage = Parameters<MessageRenderer>[0];

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
  return expandedResult(
    contentText(result?.content),
    context.isError ?? false,
    submittedAnswers(decodeExpandedAsyncRows(result?.details)),
    NO_TITLES,
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
  if (options.expanded) {
    const content = renderAsyncContent(input, options, theme, context);
    const cancelled = !list && states[0] === "cancelled" && !context.isError;
    return cancelled ? stacked([cancelledLine(theme), content]) : content;
  }
  if (context.isError) return emptyBody();
  if (!decoded || states.length !== rows.length)
    return new Text(contentText(result?.content), 0, 0);
  return collapsedRows(rows, states, list, theme);
}

function collapsedRows(
  rows: readonly ReplayedSnapshot[],
  states: readonly QuestionnaireState[],
  list: boolean,
  theme: Theme,
): Component {
  if (rows.length === 0) return mutedState(["No questionnaires retained", "None retained"], theme);
  if (list) return mutedState(stateCounts(states), theme);
  const [state] = states;
  if (state === "cancelled") return cancelledLine(theme);
  const answers = submittedAnswers(rows);
  if (answers) return answersBody(answers, NO_TITLES, theme, true);
  return state === "waiting" || state === "queued"
    ? mutedState(stateWords(state), theme)
    : emptyBody();
}

function padded(parts: readonly Component[], pad: number): Component {
  return {
    render(width) {
      const margin = Fn.pipe(" ", Str.repeat(Math.max(0, pad)));
      const inner = Math.max(1, width - Math.max(0, pad) * 2);
      return Arr.map(
        Arr.flatMap(parts, (part) => part.render(inner)),
        (line) => `${margin}${line}`,
      );
    },
    invalidate() {
      for (const part of parts) part.invalidate();
    },
  };
}

function messageSubject(outcome: ReplayedOutcome | undefined): string {
  if (!outcome) return "Questionnaire update";
  return outcome.outcome === "cancelled" ? "Questionnaire cancelled" : "Answers submitted";
}

function compactAsyncMessage(
  outcome: ReplayedOutcome | undefined,
  expanded: Component,
  options: MessageRenderOptions,
  theme: Theme,
): Component {
  const subject = messageSubject(outcome);
  const answers = outcome?.outcome === "submitted" ? outcome.answers : [];
  const { collapsedSummary } = planCompactPresentation({
    summary: outcome && {
      subject,
      outcome: outcome.outcome === "cancelled" ? "cancelled" : "success",
      counters: answers.length ? [countLabel(answers.length, "answer")] : [],
    },
    phase: "settled",
    isError: false,
    expanded: options.expanded,
    heading: { subject },
  });
  const heading = composeToolComponent((width) => [
    renderCompactRow(
      {
        name: "ask_user_async",
        phase: "settled",
        summary: collapsedSummary,
        expanded: options.expanded,
      },
      theme,
      width,
    ),
    ...renderCompactIssues(collapsedSummary.issues, theme, width, options.expanded),
  ]);
  return padded(options.expanded ? [heading, expanded] : [heading], options.outputPad);
}

export function renderAsyncMessage(
  input: AsyncMessage,
  options: MessageRenderOptions,
  theme: Theme,
  compact = false,
): Component {
  const message = envelope(input);
  const outcome = notification(message?.details)?.outcome;
  const raw = contentText(message?.content);
  const answers = outcome?.outcome === "submitted" ? outcome.answers : undefined;
  const expanded = expandedResult(raw, false, answers, NO_TITLES, theme);
  if (compact) return compactAsyncMessage(outcome, expanded, options, theme);
  if (!outcome) return new Text(raw, options.outputPad, 0);
  const cancelled = outcome.outcome === "cancelled";
  const parts: Component[] = [
    new Text(
      renderToolHeader(
        { title: "Ask user", subtitle: cancelled ? "Questionnaire" : "Answers submitted" },
        theme,
      ),
      0,
      0,
    ),
  ];
  if (cancelled) parts.push(cancelledLine(theme));
  if (options.expanded) parts.push(expanded);
  else if (answers) parts.push(answersBody(answers, NO_TITLES, theme, true));
  return padded(parts, options.outputPad);
}
