import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { planCompactPresentation, renderCompactIssues, renderCompactRow } from "pi-code-previews";
import * as Schema from "effect/Schema";
import { stripTerminalControls } from "pi-cosmic-core";
import { renderToolHeader, toolStatusLine } from "pi-cosmic-ui/tool";
import {
  answerLine,
  asyncOutcome,
  decodeAsyncControl,
  decodeCallTitles,
  decodeExpandedAsyncRows,
  expandedAsyncSnapshot,
  fallbackText,
  projection,
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
    outcome: asyncOutcome,
  }),
);
const fallback = <Content>(content: Content): string => fallbackText(content, true);
const rawResult = <Content>(content: Content) =>
  fallback(content) ? ["Raw result", fallback(content)] : [];
const requestLine = (row: NonNullable<ReturnType<typeof decodeExpandedAsyncRows>>[number]) =>
  `Request ${stripTerminalControls(row.requestId)} · delivery ${stripTerminalControls(row.deliveryId)} · ${row.status} · delivery status ${row.delivery}`;
const notificationLine = (details: NonNullable<ReturnType<typeof notification>>) =>
  `Request ${stripTerminalControls(details.requestId)} · delivery ${stripTerminalControls(details.deliveryId)} · generation ${stripTerminalControls(details.generation)}`;
const repeatWarning = "Do not immediately ask the same questions again.";

function outcomeLines(outcome: typeof asyncOutcome.Type | undefined, theme: Theme): string[] {
  if (outcome?.outcome !== "submitted") return [];
  return outcome.answers.flatMap((answer) => {
    const lines = [answerLine(answer, theme)];
    if (answer.note) lines.push(theme.fg("muted", `Note: ${stripTerminalControls(answer.note)}`));
    return lines;
  });
}

function summary(
  status: (typeof expandedAsyncSnapshot.Type)["status"],
  outcome: typeof asyncOutcome.Type | undefined,
  theme: Theme,
): string[] {
  const label = {
    pending: "Waiting for your answers",
    submitted: "Answers submitted",
    cancelled: "Questionnaire cancelled",
    failed: "Questionnaire failed. No answer was recorded.",
  }[status];
  return [
    toolStatusLine(
      theme,
      status === "submitted" ? "success" : status === "failed" ? "error" : "warning",
      label,
    ),
    ...outcomeLines(status === "submitted" ? outcome : undefined, theme),
  ];
}

export function renderAsyncCall<Input>(
  input: Input,
  theme: Theme,
  expanded: boolean,
  isControl = false,
): Text {
  const call = decodeAsyncControl(input);
  const questions = decodeCallTitles(input)?.questions;
  const title = isControl
    ? {
        status: "Questionnaire status",
        await: "Waiting for answers",
        cancel: "Cancel questionnaire",
      }[call?.action ?? "status"]
    : "Ask user";
  const subtitle = isControl
    ? expanded && call?.requestId
      ? stripTerminalControls(call.requestId)
      : undefined
    : questions?.map((question) => stripTerminalControls(question.title)).join(", ");
  return new Text(renderToolHeader({ title, subtitle }, theme), 0, 0);
}

export function renderAsyncResult<Input>(
  input: Input,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
): Text {
  if (options.isPartial)
    return new Text(toolStatusLine(theme, "warning", "Waiting for questionnaire update"), 0, 0);
  const result = envelope(input);
  const rows = decodeExpandedAsyncRows(result?.details);
  const lines = rows?.flatMap((row) => [
    ...summary(row.status, row.outcome, theme),
    ...(row.delivery === "failed"
      ? [
          toolStatusLine(
            theme,
            "warning",
            "Automatic delivery failed. The agent can still retrieve this answer.",
          ),
        ]
      : []),
  ]);
  if (rows?.length === 0) lines?.push("No questionnaires to show.");
  if (options.expanded && rows) {
    for (const row of rows) lines?.push(theme.fg("dim", requestLine(row)));
    lines?.push(
      fallback(result?.content),
      theme.fg(
        "dim",
        "Delivery status sent means the host call returned, not that the model acknowledged the answers.",
      ),
    );
  }
  return new Text(lines?.join("\n") ?? fallback(result?.content), 0, 0);
}

export function renderAsyncContent<Input>(
  input: Input,
  _options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
): Text {
  const result = envelope(input);
  const rows = decodeExpandedAsyncRows(result?.details);
  if (
    !rows ||
    rows.some(
      (row) => row.status === "failed" || (row.outcome && row.status !== row.outcome.outcome),
    )
  )
    return new Text(fallback(result?.content), 0, 0);
  return new Text(
    rows
      .flatMap((row) => [
        ...outcomeLines(row.outcome, theme),
        requestLine(row),
        ...(row.independentWork
          ? [`Independent work: ${stripTerminalControls(row.independentWork)}`]
          : []),
        ...(row.blockedWork
          ? [`Wait for answers before: ${stripTerminalControls(row.blockedWork)}`]
          : []),
        ...(row.presentation
          ? [`Presentation: ${row.presentation}. Queued admission is not a mount or an answer.`]
          : []),
        ...(row.outcome?.outcome === "cancelled" ? [repeatWarning] : []),
        "Treat repeated delivery IDs as the same result. Sent means the host call returned, not model acknowledgement.",
      ])
      .concat(rawResult(result?.content))
      .join("\n"),
    0,
    0,
  );
}

export function renderAsyncMessage<Input>(
  input: Input,
  options: { expanded: boolean; outputPad: number },
  theme: Theme,
  compact = false,
): Component {
  const message = envelope(input);
  const details = notification(message?.details);
  if (compact) {
    const outcome = details?.outcome;
    const answers = outcome?.outcome === "submitted" ? outcome.answers.length : 0;
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
        counters: answers ? [`${answers} ${answers === 1 ? "answer" : "answers"}`] : [],
      },
      phase: "settled",
      isError: false,
      expanded: options.expanded,
      heading: { subject },
    });
    return {
      invalidate() {},
      render(width) {
        const inner = Math.max(1, width - options.outputPad * 2);
        const lines = [
          renderCompactRow(
            {
              name: "ask_user_async",
              phase: "settled",
              summary: collapsedSummary,
              expanded: options.expanded,
            },
            theme,
            inner,
          ),
          ...renderCompactIssues(collapsedSummary.issues, theme, inner, options.expanded),
        ];
        if (options.expanded && !details) lines.push(fallback(message?.content));
        if (options.expanded && details)
          lines.push(
            ...outcomeLines(outcome, theme),
            notificationLine(details),
            ...(outcome?.outcome === "cancelled" ? [repeatWarning] : []),
            "This notification does not confirm model acknowledgement of the answers.",
            ...rawResult(message?.content),
          );
        return new Text(lines.join("\n"), options.outputPad, 0).render(width);
      },
    };
  }
  if (!details) return new Text(fallback(message?.content), options.outputPad, 0);
  const lines = summary(details.outcome.outcome, details.outcome, theme);
  if (options.expanded) {
    lines.push(
      theme.fg("dim", notificationLine(details)),
      fallback(message?.content),
      theme.fg("dim", "This notification does not confirm model acknowledgement of the answers."),
    );
  }
  return new Text(lines.join("\n"), options.outputPad, 0);
}
