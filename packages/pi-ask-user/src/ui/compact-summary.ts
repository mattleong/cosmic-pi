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
import { countLabel } from "pi-cosmic-core/display";
import {
  callTitles,
  decodeAsyncControl,
  decodeCallQuestions,
  decodeCompactAsyncRows,
  decodeCompactChoices,
  decodeOutcome,
  decodePresentation,
  headingAnswer,
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
import type { PendingPresentation } from "../questionnaire/async-model.ts";
import { RESUME_HINT } from "../boundary/host-ui.ts";
import type {
  AskUserAsyncControl,
  AskUserAsyncRequest,
  AskUserRequest,
} from "../questionnaire/schema.ts";

/**
 * Control calls name only a request id, so their questions' titles come from the result. Until
 * then, and for a status list, the action alone names the row, as the preview heading
 * `Questionnaire await` does, leaving the row's room to its state.
 */
function identity(args: QuestionnaireArgs, storedTitles?: string): CompactSummary {
  const control = decodeAsyncControl(args);
  if (control)
    return { action: control.action, subject: isStatusList(args) ? "" : (storedTitles ?? "") };
  return { subject: callTitles(args) ?? "questionnaire" };
}

/** What expanding a row reveals: the questions its call asked, or else `fallback`. */
const revealed = (args: QuestionnaireArgs, fallback: string): string =>
  decodeCallQuestions(args)?.questions.length ? "questions" : fallback;

const QUEUED_ORDER = "Queued questionnaires open automatically in order.";
const QUEUED_ISSUE: CompactIssue = {
  severity: "info",
  code: "questionnaire-queued",
  message: "Queued until earlier questionnaires close",
  detail: QUEUED_ORDER,
};
// The user hides a questionnaire to decide later, so its row keeps saying how to bring it back.
const HIDDEN_ISSUE: CompactIssue = {
  severity: "attention",
  code: "questionnaire-hidden",
  message: `Hidden; ${RESUME_HINT}`,
};

/**
 * Where a live call's questions stand. On screen or hidden, the call waits on the user rather than
 * spinning; queued, it waits its turn. Either way its heading says so instead of counting the
 * questions, and that word stays when the titles shorten to fit.
 */
function presentationSummary(
  presentation: PendingPresentation | undefined,
): Partial<CompactSummary> {
  if (presentation === "open") return { waiting: true, counters: stateWords("waiting") };
  if (presentation === "hidden")
    return { waiting: true, counters: stateWords("hidden"), issues: [HIDDEN_ISSUE] };
  if (presentation === "queued")
    return { queued: true, counters: stateWords("queued"), issues: [QUEUED_ISSUE] };
  return {};
}

/** A call still in progress, with where its questions stand for the user once it reports that. */
function liveSummary(
  args: QuestionnaireArgs,
  presentation?: PendingPresentation,
): CompactSummary | undefined {
  const waits = presentationSummary(presentation);
  const questions = decodeCallQuestions(args)?.questions;
  if (questions?.length)
    return {
      ...identity(args),
      counters: [countLabel(questions.length, "question")],
      ...waits,
      expandLabel: "questions",
    };
  const control = decodeAsyncControl(args);
  if (!control || (control.action !== "status" && !control.requestId)) return undefined;
  return { ...identity(args), ...waits, expandLabel: "details" };
}

type CompactQuestion = NonNullable<ReturnType<typeof decodeCompactChoices>>["questions"][number];

// Labels come from the result, so only labels that match the asked choices are shown verbatim.
function verifiedLabels(
  question: CompactQuestion | undefined,
  labels: readonly string[],
): readonly string[] | undefined {
  if (!question) return undefined;
  const verified =
    labels.length > 0 &&
    Arr.every(labels, (label) =>
      Arr.some(question.choices ?? [], (choice) => choice.label === label),
    );
  return verified ? labels : undefined;
}

type CollapsedStyle = "compact" | "preview";

/**
 * The heading's answer facts: a lone short answer itself, which says the questions were answered
 * however the glyph reads, else how many answers expansion shows (`2 answers`).
 */
function answerFacts(
  args: QuestionnaireArgs,
  answers: readonly ReplayedAnswer[],
): Pick<CompactSummary, "counters" | "subjectState"> {
  const questions = decodeCompactChoices(args)?.questions ?? [];
  const value = headingAnswer(answers, (answer) =>
    verifiedLabels(
      Option.getOrUndefined(Arr.findFirst(questions, (question) => question.key === answer.key)),
      answer.labels,
    ),
  );
  // An answer is a fact about the questions, so it stays even where it is a word the glyph says.
  return value === undefined
    ? { counters: [countLabel(answers.length, "answer")] }
    : { counters: [value], subjectState: true };
}

/**
 * What expanding an answered row reveals. A compact row hides the answers unless its heading
 * carries the lone one, leaving the questions; a preview body shows the answers, so expanding
 * reveals the questions.
 */
function answeredExpandLabel(
  args: QuestionnaireArgs,
  facts: Pick<CompactSummary, "subjectState">,
  style: CollapsedStyle,
): string {
  if (style === "compact" && facts.subjectState !== true) return "answers";
  return revealed(args, "details");
}

function settledSummary(
  args: QuestionnaireArgs,
  outcome: ReplayedOutcome,
  style: CollapsedStyle,
): CompactSummary | undefined {
  // Expansion shows the questions in both styles; a compact row also gets the full answers.
  if (outcome.outcome === "cancelled")
    return { ...identity(args), outcome: "cancelled", expandLabel: revealed(args, "details") };
  if (outcome.answers.length === 0) return undefined;
  const facts = answerFacts(args, outcome.answers);
  return {
    ...identity(args),
    outcome: "success",
    ...facts,
    expandLabel: answeredExpandLabel(args, facts, style),
  };
}

/** The blocking tool's summary for rows drawn in `style`, which decides what expansion reveals. */
export const askUserCompactSummaryFor =
  (style: CollapsedStyle): CompactSummaryProvider<AskUserRequest> =>
  ({ phase, args, result, context }) => {
    if (phase !== "settled")
      return context.isError ? undefined : liveSummary(args, decodePresentation(result?.details));
    const decoded = decodeOutcome(result?.details);
    if (decoded?.outcome === "cancelled") return settledSummary(args, decoded, style);
    if (context.isError)
      return { ...identity(args), outcome: "error", expandLabel: revealed(args, "details") };
    return decoded && settledSummary(args, decoded, style);
  };

export const askUserCompactSummary = askUserCompactSummaryFor("compact");

const DELIVERY_RETAINED = "The saved result stays available to the agent.";

/** How to bring back hidden questionnaires, shown even when collapsed. */
const hiddenIssue = (hidden: number, list: boolean): CompactIssue =>
  hidden === 1 && !list
    ? HIDDEN_ISSUE
    : { ...HIDDEN_ISSUE, message: `${countLabel(hidden, "questionnaire")} hidden; ${RESUME_HINT}` };

function answersPending(
  states: readonly QuestionnaireState[],
  list: boolean,
): readonly CompactIssue[] {
  const count = (wanted: QuestionnaireState) =>
    Arr.filter(states, (state) => state === wanted).length;
  const [waiting, hidden, queued] = [count("waiting"), count("hidden"), count("queued")];
  const pending = waiting + hidden + queued;
  if (pending === 0) return [];
  const resume = hidden > 0 ? [hiddenIssue(hidden, list)] : [];
  // The heading already counts what needs the user's input and what is queued; only why queued
  // ones wait is new.
  return [...resume, ...(queued > 0 ? [QUEUED_ISSUE] : [])];
}

/** A failure's issue; under the row's `✗`, one questionnaire's says only what it left undone. */
function questionnaireFailed(count: number, list: boolean): CompactIssue | undefined {
  if (count === 0) return undefined;
  return {
    severity: "error",
    code: "questionnaire-failed",
    message:
      count === 1 && !list
        ? "No answer was recorded"
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

/**
 * What expanding a result reveals: the questionnaires a list names, else the questions a call
 * asked, else one row's answers where a compact row hides them (a preview body lists them), else
 * the delivery details.
 */
function rowsExpandLabel(
  args: QuestionnaireArgs,
  rows: readonly ClassifiedRow[],
  list: boolean,
  facts: Pick<CompactSummary, "subjectState">,
  style: CollapsedStyle,
): string | false {
  // An empty list's heading already says everything expansion would.
  if (rows.length === 0) return false;
  if (list) return "questionnaires";
  const [only] = rows;
  return only?.outcome?.outcome === "submitted"
    ? answeredExpandLabel(args, facts, style)
    : revealed(args, "details");
}

// States a listing names even when every questionnaire shares it: they wait on the user, or failed.
const NOTABLE_STATES: readonly QuestionnaireState[] = ["waiting", "hidden", "queued", "failed"];

/**
 * A listing's counter: each state's count where the questionnaires' states differ, else the total,
 * unless their one state still needs something (`1 needs your input`, `2 failed`).
 */
function listCounters(states: readonly QuestionnaireState[]): readonly string[] {
  const [first] = states;
  const shared =
    first !== undefined &&
    !Arr.contains(NOTABLE_STATES, first) &&
    Arr.every(states, (state) => state === first);
  return shared ? [countLabel(states.length, "questionnaire")] : stateCounts(states);
}

/**
 * How a call's questionnaires stand. A status only looks, so it is neutral, with its
 * questionnaires' states as heading facts, unless one waits on the user or its turn; a failure it
 * finds is a fact, not the call's problem. Other calls show how their questionnaires ended.
 */
function rowsOutcome(states: readonly QuestionnaireState[], inspecting: boolean): CompactOutcome {
  // An open questionnaire needs the user now; a queued one only waits its turn, as Activity marks it.
  const pending =
    states.includes("waiting") || states.includes("hidden")
      ? "attention"
      : states.includes("queued")
        ? "queued"
        : undefined;
  if (inspecting) return pending ?? "returned";
  if (states.includes("failed")) return "error";
  if (states.length > 0 && Arr.every(states, (state) => state === "cancelled")) return "cancelled";
  return pending ?? "success";
}

function rowsSummary(
  args: QuestionnaireArgs,
  rows: readonly ClassifiedRow[],
  style: CollapsedStyle,
): CompactSummary {
  const states = Arr.map(rows, (row) => row.state);
  const list = isStatusList(args) || rows.length !== 1;
  const inspecting = decodeAsyncControl(args)?.action === "status";
  const issues = Arr.filter(
    [
      inspecting
        ? undefined
        : questionnaireFailed(Arr.filter(states, (state) => state === "failed").length, list),
      deliveryFailed(
        Arr.filterMap(rows, (row) =>
          row.delivery === "failed" && (row.state === "answered" || row.state === "cancelled")
            ? Result.succeed(row.state)
            : Result.failVoid,
        ),
      ),
      ...answersPending(states, list),
    ],
    Predicate.isNotUndefined,
  );
  const [only] = rows;
  const ended = only?.state === "cancelled" || only?.state === "failed";
  const facts: Pick<CompactSummary, "counters" | "subjectState"> =
    list || !only
      ? { counters: listCounters(states) }
      : only.outcome?.outcome === "submitted"
        ? answerFacts(args, only.outcome.answers)
        : // Beside a neutral status glyph, an ended questionnaire's state is the heading's fact.
          inspecting && ended
          ? { counters: stateWords(only.state), subjectState: true }
          : { counters: ended ? [] : stateWords(only.state) };
  return {
    ...identity(args, rows.length === 1 ? storedTitlesLabel(only?.titles) : undefined),
    outcome: rowsOutcome(states, inspecting),
    ...(facts.counters?.length ? facts : {}),
    ...(issues.length > 0 && { issues }),
    expandLabel: rowsExpandLabel(args, rows, list, facts, style),
  };
}

/** The async tools' summaries for rows drawn in `style`, which decides what expansion reveals. */
export const asyncAskUserCompactSummaryFor =
  (style: CollapsedStyle): CompactSummaryProvider<AskUserAsyncRequest | AskUserAsyncControl> =>
  ({ phase, args, result, context }) => {
    if (phase !== "settled")
      return context.isError ? undefined : liveSummary(args, decodePresentation(result?.details));
    const decoded = decodeCompactAsyncRows(result?.details);
    const rows =
      decoded &&
      Arr.map(decoded, (row) => Object.assign({}, row, { state: questionnaireState(row) }));
    if (rows && Arr.every(rows, classified)) {
      const cancelled = rows.length > 0 && Arr.every(rows, (row) => row.state === "cancelled");
      if (!context.isError || cancelled) return rowsSummary(args, rows, style);
    }
    if (context.isError)
      return { ...identity(args), outcome: "error", expandLabel: revealed(args, "details") };
    return undefined;
  };

export const asyncAskUserCompactSummary = asyncAskUserCompactSummaryFor("compact");
