import type {
  CompactIssue,
  CompactOutcome,
  CompactSummary,
  CompactSummaryProvider,
} from "pi-code-previews";
import { countLabel, stripTerminalControls } from "pi-cosmic-core";
import {
  callTitles,
  decodeAsyncControl,
  decodeCallQuestions,
  decodeCompactAsyncRows,
  decodeCompactChoices,
  decodeOutcome,
  isStatusList,
  questionnaireState,
  stateCounts,
  stateWords,
  type QuestionnaireState,
  type ReplayedAnswer,
  type ReplayedOutcome,
  type ReplayedSnapshot,
} from "./tool-render-projection.ts";

/**
 * Who the row is about: question titles, the questionnaire a control call names, or "all" for a
 * status list, short enough that its counts still fit narrow rows.
 */
function identity<Args>(args: Args): CompactSummary {
  const control = decodeAsyncControl(args);
  if (control)
    return { action: control.action, subject: isStatusList(args) ? "all" : "Questionnaire" };
  return { subject: callTitles(args) ?? "Questionnaire" };
}

function liveSummary<Args>(args: Args): CompactSummary | undefined {
  const questions = decodeCallQuestions(args)?.questions;
  if (questions?.length)
    return { ...identity(args), counters: [countLabel(questions.length, "question")] };
  const control = decodeAsyncControl(args);
  if (!control || (control.action !== "status" && !control.requestId)) return undefined;
  return identity(args);
}

/** Choice labels verified against the call's single question, so no answer text leaks. */
function verifiedLabels<Args>(args: Args, answer: ReplayedAnswer): readonly string[] | undefined {
  const questions = decodeCompactChoices(args)?.questions;
  const question = questions?.length === 1 ? questions[0] : undefined;
  if (!question?.key || answer.key !== question.key || answer.kind !== "choices") return undefined;
  const labels = answer.labels;
  const verified =
    labels.length > 0 &&
    labels.every(
      (label) =>
        label.trim() &&
        label.length <= 40 &&
        !/[\r\n]/u.test(label) &&
        question.choices.some((choice) => choice.label === label),
    );
  return verified ? labels.map(stripTerminalControls) : undefined;
}

/**
 * What was answered, in the counter slot. One verified choice question shows its labels; one
 * custom or text answer names its kind; otherwise the count. Answer text never appears here.
 */
function answerCounters<Args>(args: Args, answers: readonly ReplayedAnswer[]): string[] {
  const count = countLabel(answers.length, "answer");
  const [answer] = answers;
  if (answers.length !== 1 || !answer) return [count];
  if (answer.kind === "custom") return ["custom answer", count];
  if (answer.kind === "text") return ["written answer", count];
  const labels = verifiedLabels(args, answer);
  return labels ? [labels.join(", "), countLabel(labels.length, "choice")] : [count];
}

function settledSummary<Args>(args: Args, outcome: ReplayedOutcome): CompactSummary | undefined {
  if (outcome.outcome === "cancelled") return { ...identity(args), outcome: "cancelled" };
  if (outcome.answers.length === 0) return undefined;
  return {
    ...identity(args),
    outcome: "success",
    counters: answerCounters(args, outcome.answers),
  };
}

/** Transcript summaries never change the separate questionnaire overlay. */
export const askUserCompactSummary: CompactSummaryProvider = ({ phase, args, result, context }) => {
  if (phase !== "settled") return context.isError ? undefined : liveSummary(args);
  const decoded = decodeOutcome(result?.details);
  if (decoded?.outcome === "cancelled") return settledSummary(args, decoded);
  // Pi's error text explains the failure; the shell turns its first line into the issue.
  if (context.isError) return { ...identity(args), outcome: "error" };
  return decoded && settledSummary(args, decoded);
};

const AWAIT_ANSWERS =
  "Continue only independent work; use ask_user_async_control await when it is exhausted.";
const QUEUED_ORDER = "Queued questionnaires open automatically in order.";
const RETRIEVE_DELIVERY =
  "Retrieve the retained result with ask_user_async_control status or await; delivery IDs identify the same result.";

/**
 * Waiting is a questionnaire's normal state, so it is one informational issue whatever the
 * count, with the await guidance as its detail. A queued one is not on screen yet. Lists count.
 */
function answersPending(
  states: readonly QuestionnaireState[],
  list: boolean,
): CompactIssue | undefined {
  const queued = states.filter((state) => state === "queued").length;
  const pending = queued + states.filter((state) => state === "waiting").length;
  if (pending === 0) return undefined;
  const one = pending === 1;
  const message =
    one && !list
      ? queued
        ? "Queued until earlier questionnaires close"
        : "Waiting for your answers"
      : queued === pending
        ? `${countLabel(pending, "questionnaire")} ${one ? "is" : "are"} queued`
        : `${countLabel(pending, "questionnaire")} still ${one ? "needs" : "need"} your answers`;
  return {
    severity: "info",
    code: queued === pending ? "questionnaire-queued" : "answers-pending",
    message,
    detail: queued ? `${QUEUED_ORDER} ${AWAIT_ANSWERS}` : AWAIT_ANSWERS,
  };
}

/** A presenter failure settles the request without an answer. */
function questionnaireFailed(count: number, list: boolean): CompactIssue | undefined {
  if (count === 0) return undefined;
  return {
    severity: "error",
    code: "questionnaire-failed",
    message:
      count === 1 && !list
        ? "The questionnaire failed, so no answer was recorded"
        : `${countLabel(count, "questionnaire")} failed without an answer`,
  };
}

/** Saved results stay retrievable after automatic delivery fails. */
function deliveryFailed(failed: readonly QuestionnaireState[]): CompactIssue | undefined {
  if (failed.length === 0) return undefined;
  return {
    severity: "warning",
    code: "delivery-failed",
    message:
      failed.length > 1
        ? `Automatic delivery failed for ${failed.length} saved questionnaire results`
        : failed[0] === "answered"
          ? "Answers were saved, but automatic delivery failed"
          : "The cancellation was saved, but automatic delivery failed",
    detail: RETRIEVE_DELIVERY,
  };
}

interface ClassifiedRow {
  readonly state: QuestionnaireState;
  readonly delivery: ReplayedSnapshot["delivery"];
  readonly outcome?: ReplayedOutcome | undefined;
}

const classified = <Row extends { readonly state: QuestionnaireState | undefined }>(
  row: Row,
): row is Row & { readonly state: QuestionnaireState } => row.state !== undefined;

function rowsSummary<Args>(args: Args, rows: readonly ClassifiedRow[]): CompactSummary {
  const states = rows.map((row) => row.state);
  const list = isStatusList(args) || rows.length !== 1;
  const issues = [
    questionnaireFailed(states.filter((state) => state === "failed").length, list),
    deliveryFailed(
      rows.flatMap((row) =>
        row.delivery === "failed" && (row.state === "answered" || row.state === "cancelled")
          ? [row.state]
          : [],
      ),
    ),
    answersPending(states, list),
  ].filter((issue): issue is CompactIssue => issue !== undefined);
  const outcome: CompactOutcome = states.includes("failed")
    ? "error"
    : states.length > 0 && states.every((state) => state === "cancelled")
      ? "cancelled"
      : "success";
  const [only] = rows;
  const counters =
    list || !only
      ? stateCounts(states)
      : only.outcome?.outcome === "submitted"
        ? answerCounters(args, only.outcome.answers)
        : only.state === "cancelled" || only.state === "failed"
          ? []
          : stateWords(only.state);
  return {
    ...identity(args),
    outcome,
    ...(counters.length > 0 && { counters }),
    ...(issues.length > 0 && { issues }),
  };
}

export const asyncAskUserCompactSummary: CompactSummaryProvider = ({
  phase,
  args,
  result,
  context,
}) => {
  if (phase !== "settled") return context.isError ? undefined : liveSummary(args);
  const rows = decodeCompactAsyncRows(result?.details)?.map((row) => ({
    ...row,
    state: questionnaireState(row),
  }));
  if (rows?.every(classified)) {
    const cancelled = rows.length > 0 && rows.every((row) => row.state === "cancelled");
    // Decoded cancellation wins over Pi's error flag.
    if (!context.isError || cancelled) return rowsSummary(args, rows);
  }
  // Pi's error text explains the failure; the shell turns its first line into the issue.
  if (context.isError) return { ...identity(args), outcome: "error" };
  // Inconsistent or malformed replay keeps its raw evidence behind the generic row.
  return undefined;
};
