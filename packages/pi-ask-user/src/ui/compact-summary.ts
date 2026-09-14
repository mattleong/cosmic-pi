import * as Schema from "effect/Schema";
import type { CompactSummary, CompactSummaryProvider } from "pi-code-previews";
import { MAX_RETAINED_REQUESTS } from "../questionnaire/async-model.ts";
import { stripTerminalControls } from "pi-cosmic-core";
import { decodeCallTitles, outcomeProjection, projection } from "./tool-render-projection.ts";

const Outcome = outcomeProjection({ note: Schema.optional(Schema.String) });
const outcome = projection(Outcome);
const Snapshot = Schema.Struct({
  requestId: Schema.String,
  deliveryId: Schema.String,
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
    counters: cancelled ? [] : [`${answers} answers`],
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
      counters: [`${questions.length} questions`],
    };
  const input = control(args);
  if (!input || (input.action !== "status" && !input.requestId)) return undefined;
  return {
    action: input.action,
    subject: input.requestId ? stripTerminalControls(input.requestId) : "",
  };
}

/** Transcript summaries never change the separate questionnaire overlay. */
export const askUserCompactSummary: CompactSummaryProvider = ({ phase, args, result, context }) => {
  if (context.isError) return undefined;
  if (phase !== "settled") return liveSummary(args);
  const decoded = outcome(result?.details);
  if (!decoded || (decoded.outcome === "submitted" && decoded.answers.length === 0))
    return undefined;
  return summarize([decoded]);
};

export const asyncAskUserCompactSummary: CompactSummaryProvider = ({
  phase,
  args,
  result,
  context,
}) => {
  if (context.isError) return undefined;
  if (phase !== "settled") return liveSummary(args);
  const single = snapshot(result?.details);
  const rows = single ? [single] : requests(result?.details)?.requests;
  if (!rows?.length) return undefined;
  const input = control(args);
  const identity: Partial<CompactSummary> = {};
  if (input) identity.action = input.action;
  if (rows.length === 1) identity.subject = stripTerminalControls(rows[0]!.requestId);
  if (
    rows.every(
      (row) =>
        row.status === "pending" &&
        !row.outcome &&
        row.delivery === "pending" &&
        row.presentation !== "settled",
    )
  ) {
    return {
      subject: rows.every((row) => row.presentation === "queued")
        ? "Questionnaire queued"
        : "Awaiting answers",
      ...identity,
      outcome: "warning",
      counters: [`${rows.length} requests`],
      metadata: rows.length > 1 ? rows.map((row) => stripTerminalControls(row.requestId)) : [],
      notices: [
        {
          kind: "warning",
          text: "No answers yet. Continue only independent work; use ask_user_async_control await when it is exhausted.",
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
  if (rows.length > 1) summary.counters = [`${rows.length} requests`, ...(summary.counters ?? [])];
  if (rows.some((row) => row.delivery === "failed")) {
    return {
      ...summary,
      outcome: summary.outcome === "cancelled" ? "cancelled" : "warning",
      notices: [
        {
          kind: "recovery",
          text: "Automatic delivery failed. Retrieve the retained result with ask_user_async_control status or await; delivery IDs identify the same result.",
        },
      ],
    };
  }
  return summary;
};
