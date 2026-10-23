import type {
  CompactIssue,
  CompactOutcome,
  CompactSummary,
  CompactSummaryProvider,
} from "pi-code-previews";
import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Str from "effect/String";
import { countLabel } from "pi-cosmic-core/display";
import { stripTerminalControls } from "pi-cosmic-core/security";
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
import type { QuestionnaireArgs } from "./tool-body.ts";
import type {
  AskUserAsyncControl,
  AskUserAsyncRequest,
  AskUserRequest,
} from "../questionnaire/schema.ts";

function identity(args: QuestionnaireArgs): CompactSummary {
  const control = decodeAsyncControl(args);
  if (control)
    return { action: control.action, subject: isStatusList(args) ? "all" : "Questionnaire" };
  return { subject: callTitles(args) ?? "Questionnaire" };
}

function liveSummary(args: QuestionnaireArgs): CompactSummary | undefined {
  const questions = decodeCallQuestions(args)?.questions;
  if (questions?.length)
    return { ...identity(args), counters: [countLabel(questions.length, "question")] };
  const control = decodeAsyncControl(args);
  if (!control || (control.action !== "status" && !control.requestId)) return undefined;
  return identity(args);
}

function verifiedLabels(
  args: QuestionnaireArgs,
  answer: ReplayedAnswer,
): readonly string[] | undefined {
  const questions = decodeCompactChoices(args)?.questions;
  const question = questions?.length === 1 ? questions[0] : undefined;
  if (!question?.key || answer.key !== question.key || answer.kind !== "choices") return undefined;
  const labels = answer.labels;
  const verified =
    labels.length > 0 &&
    Arr.every(
      labels,
      (label) =>
        Str.isNonEmpty(Str.trim(label)) &&
        label.length <= 40 &&
        !/[\r\n]/u.test(label) &&
        Arr.some(question.choices, (choice) => choice.label === label),
    );
  return verified ? Arr.map(labels, stripTerminalControls) : undefined;
}

function answerCounters(args: QuestionnaireArgs, answers: readonly ReplayedAnswer[]): string[] {
  const count = countLabel(answers.length, "answer");
  const [answer] = answers;
  if (answers.length !== 1 || !answer) return [count];
  if (answer.kind === "custom") return ["custom answer", count];
  if (answer.kind === "text") return ["written answer", count];
  const labels = verifiedLabels(args, answer);
  return labels ? [Arr.join(labels, ", "), countLabel(labels.length, "choice")] : [count];
}

function settledSummary(
  args: QuestionnaireArgs,
  outcome: ReplayedOutcome,
): CompactSummary | undefined {
  if (outcome.outcome === "cancelled") return { ...identity(args), outcome: "cancelled" };
  if (outcome.answers.length === 0) return undefined;
  return {
    ...identity(args),
    outcome: "success",
    counters: answerCounters(args, outcome.answers),
  };
}

export const askUserCompactSummary: CompactSummaryProvider<AskUserRequest> = ({
  phase,
  args,
  result,
  context,
}) => {
  if (phase !== "settled") return context.isError ? undefined : liveSummary(args);
  const decoded = decodeOutcome(result?.details);
  if (decoded?.outcome === "cancelled") return settledSummary(args, decoded);
  if (context.isError) return { ...identity(args), outcome: "error" };
  return decoded && settledSummary(args, decoded);
};

const AWAIT_ANSWERS =
  "Continue only independent work; use ask_user_async_control await when it is exhausted.";
const QUEUED_ORDER = "Queued questionnaires open automatically in order.";
const RETRIEVE_DELIVERY =
  "Retrieve the retained result with ask_user_async_control status or await; delivery IDs identify the same result.";

function answersPending(
  states: readonly QuestionnaireState[],
  list: boolean,
): CompactIssue | undefined {
  const queued = Arr.filter(states, (state) => state === "queued").length;
  const pending = queued + Arr.filter(states, (state) => state === "waiting").length;
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

type ClassifiedRow = Pick<ReplayedSnapshot, "delivery" | "outcome"> & {
  readonly state: QuestionnaireState;
};

const classified = <Row extends { readonly state: QuestionnaireState | undefined }>(
  row: Row,
): row is Row & { readonly state: QuestionnaireState } => row.state !== undefined;

function rowsSummary(args: QuestionnaireArgs, rows: readonly ClassifiedRow[]): CompactSummary {
  const states = Arr.map(rows, (row) => row.state);
  const list = isStatusList(args) || rows.length !== 1;
  const issues = Arr.filter(
    [
      questionnaireFailed(Arr.filter(states, (state) => state === "failed").length, list),
      deliveryFailed(
        Arr.filterMap(rows, (row) =>
          row.delivery === "failed" && (row.state === "answered" || row.state === "cancelled")
            ? Result.succeed(row.state)
            : Result.failVoid,
        ),
      ),
      answersPending(states, list),
    ],
    Predicate.isNotUndefined,
  );
  const outcome: CompactOutcome = states.includes("failed")
    ? "error"
    : states.length > 0 && Arr.every(states, (state) => state === "cancelled")
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

export const asyncAskUserCompactSummary: CompactSummaryProvider<
  AskUserAsyncRequest | AskUserAsyncControl
> = ({ phase, args, result, context }) => {
  if (phase !== "settled") return context.isError ? undefined : liveSummary(args);
  const decoded = decodeCompactAsyncRows(result?.details);
  const rows =
    decoded &&
    Arr.map(decoded, (row) => Object.assign({}, row, { state: questionnaireState(row) }));
  if (rows && Arr.every(rows, classified)) {
    const cancelled = rows.length > 0 && Arr.every(rows, (row) => row.state === "cancelled");
    if (!context.isError || cancelled) return rowsSummary(args, rows);
  }
  if (context.isError) return { ...identity(args), outcome: "error" };
  return undefined;
};
