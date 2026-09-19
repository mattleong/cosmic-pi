import * as Schema from "effect/Schema";
import {
  withCompactIssues,
  type CompactSummary,
  type CompactSummaryProvider,
} from "pi-code-previews";
import { MAX_RETAINED_REQUESTS } from "../questionnaire/async-model.ts";
import { stripTerminalControls } from "pi-cosmic-core";
import {
  decodeCallTitles,
  decodeCompactChoices,
  outcomeProjection,
  projection,
} from "./tool-render-projection.ts";

const Outcome = outcomeProjection({ note: Schema.optional(Schema.String) });
const outcome = projection(Outcome);
const Identity = Schema.String.check(Schema.isLengthBetween(1, 256));
const Snapshot = Schema.Struct({
  requestId: Identity,
  deliveryId: Identity,
  status: Schema.Literals(["pending", "submitted", "cancelled", "failed"]),
  delivery: Schema.Literals(["pending", "sending", "sent", "failed", "waiter", "none"]),
  outcome: Schema.optional(Outcome),
  presentation: Schema.optional(
    Schema.Literals(["queued", "opening", "open", "hidden", "settled"]),
  ),
});
const snapshot = projection(Snapshot);
const requests = projection(
  Schema.Struct({
    requests: Schema.Array(Snapshot).check(Schema.isMaxLength(MAX_RETAINED_REQUESTS)),
  }),
);

function summarize(outcomes: readonly (typeof Outcome.Type)[]): CompactSummary {
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

const control = projection(
  Schema.Struct({
    action: Schema.Literals(["status", "await", "cancel"]),
    requestId: Schema.optional(Schema.String),
  }),
);

function liveSummary<Args>(args: Args): CompactSummary | undefined {
  const questions = decodeCallTitles(args)?.questions;
  if (questions?.length)
    return {
      subject: questions.map((question) => stripTerminalControls(question.title)).join(", "),
      counters: [`${questions.length} ${questions.length === 1 ? "question" : "questions"}`],
    };
  const input = control(args);
  if (!input || (input.action !== "status" && !input.requestId)) return undefined;
  return {
    action: input.action,
    subject: input.requestId ? stripTerminalControls(input.requestId) : "",
    compactSubject: "Questionnaire",
  };
}

function selectedChoice<Args>(
  args: Args,
  value: typeof Outcome.Type | undefined,
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
  const single = snapshot(result?.details);
  const rows = single ? [single] : requests(result?.details)?.requests;
  if (!rows?.length) return undefined;
  if (
    context.isError &&
    !rows.every((row) => row.status === "cancelled" && row.outcome?.outcome === "cancelled")
  )
    return undefined;
  const input = control(args);
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
        entries: rows.map((row) => ({
          operation: `questionnaire:${row.requestId}`,
          code: "answers-pending",
          severity: "warning",
          cause: "No answers yet.",
          description: "Waiting for answers.",
          recovery: [
            {
              code: "await-answers",
              text: "Continue only independent work; use ask_user_async_control await when it is exhausted.",
            },
          ],
        })),
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
          .map((row) => ({
            operation: `questionnaire:${row.requestId}:${row.deliveryId}`,
            code: "delivery-failed",
            severity: "warning",
            cause: "Automatic delivery failed.",
            description:
              row.outcome?.outcome === "submitted"
                ? "Answers were saved, but automatic delivery failed."
                : "The cancellation was saved, but automatic delivery failed.",
            recovery: [
              {
                code: "retrieve-delivery",
                text: "Retrieve the retained result with ask_user_async_control status or await; delivery IDs identify the same result.",
              },
            ],
          })),
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
