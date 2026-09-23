import {
  withCompactIssues,
  type CompactSummary,
  type CompactSummaryProvider,
} from "pi-code-previews";
import { stripTerminalControls } from "pi-cosmic-core";
import {
  asyncOutcome,
  decodeAsyncControl,
  decodeCallTitles,
  decodeCompactAsyncRows,
  decodeCompactChoices,
  projection,
} from "./tool-render-projection.ts";

const outcome = projection(asyncOutcome);

function summarize(outcomes: readonly (typeof asyncOutcome.Type)[]): CompactSummary {
  const cancelled = outcomes.filter((entry) => entry.outcome === "cancelled").length;
  const answers = outcomes.reduce(
    (count, entry) => count + (entry.outcome === "submitted" ? entry.answers.length : 0),
    0,
  );
  return {
    subject: cancelled ? "Questionnaire cancelled" : "Answers submitted",
    outcome: cancelled ? "cancelled" : "success",
    counters: cancelled ? [] : [`${answers} ${answers === 1 ? "answer" : "answers"}`],
    issues: { coverage: "complete", entries: [] },
  };
}

function liveSummary<Args>(args: Args): CompactSummary | undefined {
  const questions = decodeCallTitles(args)?.questions;
  if (questions?.length)
    return {
      subject: questions.map((question) => stripTerminalControls(question.title)).join(", "),
      counters: [`${questions.length} ${questions.length === 1 ? "question" : "questions"}`],
    };
  const input = decodeAsyncControl(args);
  if (!input || (input.action !== "status" && !input.requestId)) return undefined;
  return {
    action: input.action,
    subject: input.requestId ? stripTerminalControls(input.requestId) : "",
    compactSubject: "Questionnaire",
  };
}

function selectedChoice<Args>(
  args: Args,
  value: typeof asyncOutcome.Type | undefined,
): Partial<CompactSummary> {
  if (value?.outcome !== "submitted" || value.answers.length !== 1) return {};
  const questions = decodeCompactChoices(args)?.questions;
  const question = questions?.length === 1 ? questions[0] : undefined;
  const answer = value.answers[0]!;
  if (
    !question ||
    !question.key ||
    answer.key !== question.key ||
    answer.kind !== "choices" ||
    answer.labels.length !== 1
  )
    return {};
  const label = answer.labels[0]!;
  if (
    !label.trim() ||
    label.length > 40 ||
    /[\r\n]/.test(label) ||
    !question.choices.some((choice) => choice.label === label)
  )
    return {};
  return {
    subject: `${stripTerminalControls(question.title)} → ${stripTerminalControls(label)}`,
    counters: [],
  };
}

/** Transcript summaries never change the separate questionnaire overlay. */
export const askUserCompactSummary: CompactSummaryProvider = ({ phase, args, result, context }) => {
  if (phase !== "settled") return context.isError ? undefined : liveSummary(args);
  const decoded = outcome(result?.details);
  if (context.isError && decoded?.outcome !== "cancelled") return undefined;
  if (!decoded || (decoded.outcome === "submitted" && decoded.answers.length === 0))
    return undefined;
  const summary = summarize([decoded]);
  return {
    ...summary,
    subject: liveSummary(args)?.subject || summary.subject,
    ...selectedChoice(args, decoded),
  };
};

const projectAsyncSummary: CompactSummaryProvider = ({ phase, args, result, context }) => {
  if (phase !== "settled") return context.isError ? undefined : liveSummary(args);
  const rows = decodeCompactAsyncRows(result?.details);
  if (!rows?.length) return undefined;
  if (
    context.isError &&
    !rows.every((row) => row.status === "cancelled" && row.outcome?.outcome === "cancelled")
  )
    return undefined;
  const input = decodeAsyncControl(args);
  const identity: Partial<CompactSummary> = {};
  if (input) {
    identity.action = input.action;
    identity.compactSubject = "Questionnaire";
  }
  if (rows.length === 1)
    identity.subject = liveSummary(args)?.subject || stripTerminalControls(rows[0]!.requestId);
  if (
    rows.every(
      (row) =>
        row.status === "pending" &&
        !row.outcome &&
        row.delivery === "pending" &&
        row.presentation !== "settled",
    )
  ) {
    const queued = rows.filter((row) => row.presentation === "queued").length;
    const waiting = rows.length - queued;
    const statuses = [
      queued ? `${rows.length === 1 ? "" : `${queued} `}queued` : "",
      waiting ? `${rows.length === 1 ? "" : `${waiting} `}awaiting answers` : "",
    ].filter(Boolean);
    return {
      subject: rows.every((row) => row.presentation === "queued")
        ? "Questionnaire queued"
        : "Awaiting answers",
      ...identity,
      outcome: "warning",
      counters: [statuses.join(", ")],
      issues: {
        coverage: "complete",
        entries: rows.map((row, index) => {
          const request = stripTerminalControls(row.requestId);
          return {
            operation: `questionnaire:${row.requestId}`,
            code: "answers-pending",
            severity: "warning" as const,
            cause: rows.length === 1 ? "No answers yet." : `Request ${request}: no answers yet.`,
            description:
              index === 0
                ? rows.length === 1
                  ? "Waiting for answers."
                  : `${rows.length} questionnaires are waiting for answers.`
                : "",
            recovery: [
              {
                code: "await-answers",
                text:
                  rows.length === 1
                    ? "Continue only independent work; use ask_user_async_control await when it is exhausted."
                    : `Request ${request}: continue only independent work; use ask_user_async_control await when it is exhausted.`,
              },
            ],
          };
        }),
      },
      notices: [
        {
          code: "answers-pending",
          kind: "warning",
          text: "No answers yet.",
          description: "Waiting for answers.",
        },
        {
          code: "await-answers",
          kind: "recovery",
          text: "Continue only independent work; use ask_user_async_control await when it is exhausted.",
        },
      ],
    };
  }
  // Opening failures, metadata-only terminal lists, and inconsistent replay need full context.
  if (
    rows.some(
      (row) =>
        !row.outcome ||
        row.status !== row.outcome.outcome ||
        (row.outcome.outcome === "submitted" && row.outcome.answers.length === 0),
    )
  )
    return undefined;
  const summary = summarize(rows.flatMap((row) => (row.outcome ? [row.outcome] : [])));
  Object.assign(summary, identity);
  if (rows.length === 1) Object.assign(summary, selectedChoice(args, rows[0]!.outcome));
  if (rows.length > 1)
    summary.counters = [[`${rows.length} requests`, ...(summary.counters ?? [])].join(", ")];
  if (rows.some((row) => row.delivery === "failed")) {
    return {
      ...summary,
      outcome: summary.outcome === "cancelled" ? "cancelled" : "warning",
      issues: {
        coverage: "complete",
        entries: rows
          .filter((row) => row.delivery === "failed")
          .map((row, index, failed) => {
            const request = stripTerminalControls(row.requestId);
            const delivery = stripTerminalControls(row.deliveryId);
            return {
              operation: `questionnaire:${row.requestId}:${row.deliveryId}`,
              code: "delivery-failed",
              severity: "warning" as const,
              cause:
                failed.length === 1
                  ? "Automatic delivery failed."
                  : `Request ${request} (delivery ${delivery}): automatic delivery failed.`,
              description:
                index === 0
                  ? failed.length > 1
                    ? `Automatic delivery failed for ${failed.length} saved questionnaire results.`
                    : row.outcome?.outcome === "submitted"
                      ? "Answers were saved, but automatic delivery failed."
                      : "The cancellation was saved, but automatic delivery failed."
                  : "",
              recovery: [
                {
                  code: "retrieve-delivery",
                  text:
                    failed.length === 1
                      ? "Retrieve the retained result with ask_user_async_control status or await; delivery IDs identify the same result."
                      : `Request ${request} (delivery ${delivery}): retrieve the retained result with ask_user_async_control status or await; delivery IDs identify the same result.`,
                },
              ],
            };
          }),
      },
      notices: [
        {
          code: "retrieve-delivery",
          description: "The response was saved, but automatic delivery failed.",
          kind: "recovery",
          text: "Automatic delivery failed. Retrieve the retained result with ask_user_async_control status or await; delivery IDs identify the same result.",
        },
      ],
    };
  }
  return summary;
};

export const asyncAskUserCompactSummary: CompactSummaryProvider = (input) => {
  const summary = projectAsyncSummary(input);
  return summary?.issues
    ? summary
    : summary
      ? withCompactIssues(summary, "ask-user-async")
      : undefined;
};
