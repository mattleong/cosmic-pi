import type {
  CompactIssue,
  CompactOutcome,
  CompactSummary,
  CompactSummaryProvider,
} from "pi-code-previews";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Str from "effect/String";
import { clipText, countLabel } from "pi-cosmic-core/display";
import { stripTerminalControls } from "pi-cosmic-core/security";
import {
  callTitles,
  decodeAsyncControl,
  decodeCallQuestions,
  decodeCompactAsyncRows,
  decodeCompactChoices,
  decodeOutcome,
  isPendingState,
  isStatusList,
  storedTitlesLabel,
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

// Control calls name only a request id, so their questions' titles come from the result.
function identity(args: QuestionnaireArgs, storedTitles?: string): CompactSummary {
  const control = decodeAsyncControl(args);
  if (control)
    return {
      action: control.action,
      subject: isStatusList(args) ? "all" : (storedTitles ?? "questionnaire"),
    };
  return { subject: callTitles(args) ?? "questionnaire" };
}

function liveSummary(args: QuestionnaireArgs): CompactSummary | undefined {
  const questions = decodeCallQuestions(args)?.questions;
  if (questions?.length)
    return { ...identity(args), counters: [countLabel(questions.length, "question")] };
  const control = decodeAsyncControl(args);
  if (!control || (control.action !== "status" && !control.requestId)) return undefined;
  return identity(args);
}

type CompactQuestion = NonNullable<ReturnType<typeof decodeCompactChoices>>["questions"][number];

// Labels come from the result, so only labels that match the asked choices are shown verbatim.
function verifiedLabels(
  question: CompactQuestion | undefined,
  answer: ReplayedAnswer,
  maxWidth: number,
): readonly string[] | undefined {
  if (!question || answer.kind !== "choices") return undefined;
  const labels = answer.labels;
  const verified =
    labels.length > 0 &&
    Arr.every(
      labels,
      (label) =>
        Str.isNonEmpty(Str.trim(label)) &&
        label.length <= maxWidth &&
        !/[\r\n]/u.test(label) &&
        Arr.some(question.choices ?? [], (choice) => choice.label === label),
    );
  return verified ? Arr.map(labels, stripTerminalControls) : undefined;
}

// A written answer's first line, quoted so it reads as the user's words rather than a listed choice.
const MAX_WRITTEN_ANSWER_WIDTH = 48;
// Several answers share one row, so each stays short.
const MAX_SHARED_ANSWER_WIDTH = 32;

function writtenAnswer(text: string, maxWidth = MAX_WRITTEN_ANSWER_WIDTH): string {
  const first = Option.getOrElse(
    Arr.findFirst(
      Arr.map(Str.split(stripTerminalControls(text), /\r?\n/u), Str.trim),
      Str.isNonEmpty,
    ),
    () => "",
  );
  const more = Str.trim(stripTerminalControls(text)) !== first;
  // Plain clipping: the row escapes control text, so a styled ellipsis would show its codes.
  const clipped = clipText(first, maxWidth);
  return `“${more && clipped === first ? `${first}…` : clipped}”`;
}

/**
 * One answer among several: a lone choice by its verified name, several choices by count, and
 * written words quoted. A lone choice whose name can't be verified leaves the row to its count.
 */
function sharedAnswer(
  question: CompactQuestion | undefined,
  answer: ReplayedAnswer,
): string | undefined {
  if (answer.kind !== "choices") return writtenAnswer(answer.text, MAX_SHARED_ANSWER_WIDTH);
  if (answer.labels.length > 1) return countLabel(answer.labels.length, "choice");
  const [label, ...others] = verifiedLabels(question, answer, MAX_SHARED_ANSWER_WIDTH) ?? [];
  return others.length === 0 ? label : undefined;
}

// Alternatives, most informative first; the row shows the first that fits beside the titles.
function answerCounters(args: QuestionnaireArgs, answers: readonly ReplayedAnswer[]): string[] {
  const count = countLabel(answers.length, "answer");
  const questions = decodeCompactChoices(args)?.questions ?? [];
  const questionFor = (answer: ReplayedAnswer) =>
    Option.getOrUndefined(Arr.findFirst(questions, (question) => question.key === answer.key));
  const [answer] = answers;
  if (!answer) return [count];
  if (answers.length > 1) {
    const shared = Arr.map(answers, (entry) => sharedAnswer(questionFor(entry), entry));
    return Arr.every(shared, Predicate.isString) ? [Arr.join(shared, " · "), count] : [count];
  }
  if (answer.kind !== "choices") return [writtenAnswer(answer.text), count];
  // A lone question's labels may be longer, since they share the row with nothing else.
  const labels =
    questions.length === 1 ? verifiedLabels(questionFor(answer), answer, 40) : undefined;
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

const QUEUED_ORDER = "Queued questionnaires open automatically in order.";
const DELIVERY_RETAINED = "The saved result stays available to the agent.";

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
    ...(queued > 0 && { detail: QUEUED_ORDER }),
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
    detail: DELIVERY_RETAINED,
  };
}

type ClassifiedRow = Pick<ReplayedSnapshot, "delivery" | "outcome" | "titles"> & {
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
      : Arr.some(states, isPendingState)
        ? "attention"
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
    ...identity(args, rows.length === 1 ? storedTitlesLabel(only?.titles) : undefined),
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
