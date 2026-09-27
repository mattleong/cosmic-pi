import type {
  MessageRenderOptions,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import { planCompactPresentation, renderCompactIssues, renderCompactRow } from "pi-code-previews";
import * as Schema from "effect/Schema";
import { countLabel } from "pi-cosmic-core";
import { renderToolHeader, toolRunningLine } from "pi-cosmic-ui/tool";
import {
  answersBody,
  callBody,
  cancelledLine,
  emptyBody,
  expandedResult,
  mutedState,
  stacked,
  type RenderContext,
} from "./tool-body.ts";
import {
  answerOutcome,
  callTitles,
  decodeAsyncControl,
  decodeExpandedAsyncRows,
  fallbackText,
  isStatusList,
  projection,
  questionnaireState,
  stateCounts,
  stateWords,
  type ReplayedAnswer,
  type ReplayedSnapshot,
} from "./tool-render-projection.ts";

const envelope = projection(
  Schema.Struct({
    details: Schema.optional(Schema.Unknown),
    content: Schema.optional(Schema.Unknown),
  }),
);
const notification = projection(
  Schema.Struct({
    requestId: Schema.String,
    deliveryId: Schema.String,
    generation: Schema.String,
    outcome: answerOutcome,
  }),
);
/** Async replay accepts string content as well as text parts. */
const rawText = <Content>(content: Content): string => fallbackText(content, true);
/** Async snapshots carry answer keys only; their questions stay with the opening call. */
const NO_TITLES: ReadonlyMap<string, string> = new Map();

type ResultContext = Partial<Pick<RenderContext, "args" | "isError">>;

/** "Ask user" with its question titles, or "Questionnaire" with the control action. */
export function renderAsyncCall<Args>(
  args: Args,
  theme: Theme,
  context: Pick<RenderContext, "expanded" | "state">,
  isControl = false,
): Component {
  const header = isControl
    ? { title: "Questionnaire", subtitle: decodeAsyncControl(args)?.action }
    : { title: "Ask user", subtitle: callTitles(args) };
  return callBody(header, args, theme, context);
}

/** A consistent single snapshot's answers; stale or mismatched outcomes are never shown. */
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

/** The expanded body in both styles: the labeled agent-facing text. */
export function renderAsyncContent<Input>(
  input: Input,
  _options: ToolRenderResultOptions,
  theme: Theme,
  context: ResultContext = {},
): Component {
  const result = envelope(input);
  return expandedResult(
    rawText(result?.content),
    context.isError ?? false,
    submittedAnswers(decodeExpandedAsyncRows(result?.details)),
    NO_TITLES,
    theme,
  );
}

/**
 * Collapsed, a questionnaire shows its answers or its routine state; a list shows its counts.
 * Failures are the shell's issue lines; a returned cancellation is stated here, once.
 */
export function renderAsyncResult<Input>(
  input: Input,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ResultContext = {},
): Component {
  if (options.isPartial) return new Text(toolRunningLine(theme), 0, 0);
  const result = envelope(input);
  const rows = decodeExpandedAsyncRows(result?.details);
  const states = rows?.map(questionnaireState);
  const list = !rows || rows.length !== 1 || isStatusList(context.args);
  const [state] = states ?? [];
  // The shell states failures and the cancellations Pi reports; the body states the rest.
  const cancelled = !list && state === "cancelled" && !context.isError;
  if (options.expanded) {
    const content = renderAsyncContent(input, options, theme, context);
    return cancelled ? stacked([cancelledLine(theme), content]) : content;
  }
  if (context.isError) return emptyBody();
  if (!rows || !states || states.some((entry) => entry === undefined))
    return new Text(rawText(result?.content), 0, 0);
  const known = states.flatMap((entry) => (entry ? [entry] : []));
  if (rows.length === 0) return mutedState(["No questionnaires retained", "None retained"], theme);
  if (list) return mutedState(stateCounts(known), theme);
  if (cancelled) return cancelledLine(theme);
  const answers = submittedAnswers(rows);
  if (answers) return answersBody(answers, NO_TITLES, theme, true);
  return state === "waiting" || state === "queued"
    ? mutedState(stateWords(state), theme)
    : emptyBody();
}

/** Lines under the transcript's output padding. */
function padded(parts: readonly Component[], pad: number): Component {
  return {
    render(width) {
      const margin = " ".repeat(Math.max(0, pad));
      const inner = Math.max(1, width - Math.max(0, pad) * 2);
      return parts.flatMap((part) => part.render(inner)).map((line) => `${margin}${line}`);
    },
    invalidate() {
      for (const part of parts) part.invalidate();
    },
  };
}

/**
 * Automatic answer messages. Collapsed they show the answers (or only a compact row); expanded
 * they show the message the agent received. Delivery and generation IDs never appear.
 */
export function renderAsyncMessage<Input>(
  input: Input,
  options: MessageRenderOptions,
  theme: Theme,
  compact = false,
): Component {
  const message = envelope(input);
  const outcome = notification(message?.details)?.outcome;
  const raw = rawText(message?.content);
  const answers = outcome?.outcome === "submitted" ? outcome.answers : undefined;
  const expanded = expandedResult(raw, false, answers, NO_TITLES, theme);
  if (compact) {
    const subject = !outcome
      ? "Questionnaire update"
      : outcome.outcome === "cancelled"
        ? "Questionnaire cancelled"
        : "Answers submitted";
    // Malformed notifications have no outcome; the planner marks them unconfirmed.
    const { collapsedSummary } = planCompactPresentation({
      summary: outcome && {
        subject,
        outcome: outcome.outcome === "cancelled" ? "cancelled" : "success",
        counters: answers?.length ? [countLabel(answers.length, "answer")] : [],
      },
      phase: "settled",
      isError: false,
      expanded: options.expanded,
      heading: { subject },
    });
    const heading: Component = {
      render: (width) => [
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
      ],
      invalidate: () => undefined,
    };
    return padded(options.expanded ? [heading, expanded] : [heading], options.outputPad);
  }
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
