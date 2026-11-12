import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { type CompactIssue } from "pi-code-previews";
import { skippedCandidateLabel } from "../profiles/model.ts";
import { runAttention, runCleanupAttention } from "../run/attention.ts";
import { reportTruncationText } from "../run/state.ts";
import { workspaceFact } from "../ui/notice-facts.ts";
import type { SubagentRunCard } from "./details-schema.ts";
import { cleanupEvidenceText, proposalDiffStatLines } from "./format.ts";
import { countLabel } from "pi-cosmic-core/display";
import {
  failureMessage,
  firstLineMessage,
  quoteText,
  restatesText,
} from "pi-cosmic-core/message-text";

type AddIssue = (
  severity: CompactIssue["severity"],
  code: string,
  message: string,
  detail?: string,
) => void;

export const QUOTED_TEXT_LIMIT = 120;

/** Whether an issue's quote of `text` holds all of it, so nothing else need repeat it. */
export const quotesWhole = (text: string): boolean =>
  quoteText(text, { limit: QUOTED_TEXT_LIMIT }).detail === undefined;

const staticSkipCodes = new Set([
  "pi_model_unknown",
  "pi_model_ambiguous",
  "pi_effort_unsupported",
  "parent_model_missing",
  "parent_model_unavailable",
  "parent_model_ambiguous",
  "fast_mode_unsupported",
  "fork_context_unavailable",
]);

const cardLabel = (card: Pick<SubagentRunCard, "id" | "name">) =>
  Fn.pipe(card.name === card.id ? "Subagent" : card.name, Str.slice(0, 60));

export const hasChangesToReview = (card: SubagentRunCard): boolean =>
  (card.workspaceOutcome === undefined || card.workspaceOutcome.status === "proposal") &&
  (Boolean(card.finalText) || card.finalTextTruncated === true) &&
  card.writeIntent === "writer" &&
  (card.writerWorkspaceMode === "worktree" || Boolean(card.workspaceId));

const cardIssueAdder =
  (issues: CompactIssue[], card: SubagentRunCard): AddIssue =>
  (severity, code, message, detail) =>
    issues.push({ severity, code: `${card.id}:${code}`, message, ...(detail && { detail }) });

interface RunIssueOptions {
  readonly quietHistory?: boolean | undefined;
  /** Whether the surface already draws the card's failure text, which its issue then omits. */
  readonly showsError?: ((card: SubagentRunCard) => boolean) | undefined;
  /** Whether the surface draws the card's whole question, which its issue then only quotes. */
  readonly showsQuestion?: ((card: SubagentRunCard) => boolean) | undefined;
}

const skippedOptionsDetail = (card: SubagentRunCard): string =>
  Fn.pipe(
    card.selection.skippedCandidates,
    Arr.map(
      (entry) =>
        `${skippedCandidateLabel(entry.candidate)}: ${failureMessage(entry.reason, "skipped", QUOTED_TEXT_LIMIT)}`,
    ),
    Arr.join("\n"),
  );

function selectionIssues(
  card: SubagentRunCard,
  label: string,
  add: AddIssue,
  quiet: boolean,
): void {
  const skipped = card.selection.skippedCandidates;
  if (!skipped.length) return;
  const detail = skippedOptionsDetail(card);
  if (Arr.every(skipped, (entry) => entry.code === "previous_run_failed")) {
    add("info", "selection-skipped", `${label} moved on to its next profile option`, detail);
    return;
  }
  add(
    quiet ? "info" : "warning",
    "selection-skipped",
    skipped.length === 1
      ? `${label}: a configured option was skipped`
      : `${label}: ${skipped.length} configured options were skipped`,
    detail,
  );
}

/** Attention from runs a call didn't target: each question quoted, whole in its detail. */
export function compactAttentionIssues(cards: readonly SubagentRunCard[]): CompactIssue[] {
  const issues: CompactIssue[] = [];
  for (const card of cards) {
    const add = cardIssueAdder(issues, card);
    attentionIssues(card, cardLabel(card), add, false);
    cleanupIssues(card, cardLabel(card), add);
  }
  return issues;
}

export function compactRunIssues(
  cards: readonly SubagentRunCard[],
  options: RunIssueOptions = {},
): CompactIssue[] {
  const issues: CompactIssue[] = [];
  for (const card of cards) {
    const issueStart = issues.length;
    const label = cardLabel(card);
    const add = cardIssueAdder(issues, card);
    attentionIssues(card, label, add, options.showsQuestion?.(card) === true);
    cleanupIssues(card, label, add);
    evidenceIssues(card, label, add, options.showsError?.(card) === true);
    const quiet =
      options.quietHistory === true &&
      card.state === "completed" &&
      issues.length === issueStart &&
      Arr.every(card.selection.skippedCandidates, (entry) => staticSkipCodes.has(entry.code));
    selectionIssues(card, label, add, quiet);
  }
  return issues;
}

export function quoted(
  label: string,
  text: string,
  fallback: string,
): Pick<CompactIssue, "message" | "detail"> {
  const { line, detail } = quoteText(text, { limit: QUOTED_TEXT_LIMIT });
  return {
    message: line ? `${label}: ${line}` : `${label} ${fallback}`,
    ...(detail && { detail }),
  };
}

function quote(add: AddIssue, label: string, code: string, text: string, fallback: string): void {
  const { message, detail } = quoted(label, text, fallback);
  add("warning", code, message, detail);
}

/**
 * A question's quote for its `asks:` row: its first line, ending with `…` when the question goes
 * on past it, and the whole question as detail unless the quote holds all of it.
 */
export const questionQuote = (question: string) => {
  const { line, detail } = quoteText(question, { limit: QUOTED_TEXT_LIMIT });
  const shown = line ?? firstLineMessage(question, "a question", QUOTED_TEXT_LIMIT);
  const cut = detail !== undefined && !restatesText(question, shown);
  return {
    quote: cut && !Fn.pipe(shown, Str.endsWith("…")) ? `${shown}…` : shown,
    cut,
    ...(detail && { detail }),
  };
};

/** Whether an `asks:` row quotes only part of `question`, so expanding shows the rest. */
export const quotesPartOfQuestion = (question: string): boolean => questionQuote(question).cut;

/**
 * A pending question as the attention line every surface raises, `name asks: …`. Its rest is left
 * to the surface's own body, which shows the whole question only when the quote is cut.
 */
export const askingIssue = (label: string, question: string, code: string): CompactIssue => ({
  severity: "attention",
  code,
  message: `${label} asks: ${questionQuote(question).quote}`,
});

/** Whether a run's `asks:` row quotes only part of its question. */
export const asksPartOfQuestion = (card: SubagentRunCard): boolean => {
  const attention = runAttention(card);
  return attention?.kind === "question" && quotesPartOfQuestion(attention.message);
};

/**
 * A run's question reads `name asks: …` on every surface. Its whole text is the issue's detail
 * unless the surface draws it (`questionShown`), as a shown failure's is.
 */
function attentionIssues(
  card: SubagentRunCard,
  label: string,
  add: AddIssue,
  questionShown: boolean,
): void {
  const attention = runAttention(card);
  switch (attention?.kind) {
    // A paused run raises nothing: a held state, not a problem, and every surface draws the run's
    // own row with `‖`.
    case undefined:
    case "paused":
      return;
    case "question": {
      // The whole question is detail only when the message can't show all of it.
      const asked = questionQuote(attention.message);
      add(
        "attention",
        "parent-question",
        `${label} asks: ${asked.quote}`,
        questionShown ? undefined : asked.detail,
      );
      return;
    }
    case "question-unavailable":
      add(
        "attention",
        "question-unavailable",
        `${label} is waiting for reply, but its question is unavailable`,
      );
  }
}

function cleanupIssues(card: SubagentRunCard, label: string, add: AddIssue): void {
  const attention = runCleanupAttention(card);
  if (attention === undefined) return;
  const messages = {
    quarantined:
      card.cleanup?.recovery === "stop"
        ? "couldn't confirm its processes ended; stop it to check again"
        : "couldn't confirm its processes ended; check them by hand",
    "pool-quarantined": "new writers wait until an earlier writer's cleanup is confirmed",
  };
  add(
    "warning",
    `cleanup-${attention}`,
    `${label}: ${messages[attention]}`,
    cleanupEvidenceText(card),
  );
}

/**
 * A failure's quoted first line, and as detail the rest of its text, or all of it when the quote
 * rephrases or cuts that line, so expansion shows each line once.
 */
export const failureQuote = (text: string): ReturnType<typeof quoteText> => {
  const quotedFailure = quoteText(text, { limit: QUOTED_TEXT_LIMIT, failure: true });
  if (quotedFailure.line === undefined || quotedFailure.detail === undefined) return quotedFailure;
  const [first, ...rest] = Str.split(Str.trim(text), "\n");
  if (first === undefined || !restatesText(first, quotedFailure.line)) return quotedFailure;
  const remaining = Str.trim(Arr.join(rest, "\n"));
  return remaining === ""
    ? { line: quotedFailure.line }
    : { line: quotedFailure.line, detail: remaining };
};

function evidenceIssues(
  card: SubagentRunCard,
  label: string,
  add: AddIssue,
  errorShown: boolean,
): void {
  if (card.error) {
    const { line, detail } = failureQuote(card.error);
    // The run's own block shows the whole failure, so the issue only names it.
    add(
      "error",
      "error",
      line ? `${label}: ${line}` : `${label} reported an error`,
      errorShown ? undefined : detail,
    );
  } else if (card.state === "failed") add("error", "run-failed", `${label} failed`);
  const systemSourced = card.warningSource === "system";
  const fallback = systemSourced ? "reported a system warning" : "reported a warning";
  if (card.warning) quote(add, label, "warning", card.warning, fallback);
  if (card.systemWarning && !(systemSourced && card.systemWarning === card.warning))
    quote(add, label, "system-warning", card.systemWarning, "reported a system warning");
  if (card.selection.warning)
    quote(add, label, "selection-warning", card.selection.warning, "has a launch option warning");
  reportEvidenceIssues(card, label, add);
}

const RESOLVED_WORKSPACE_ISSUES = {
  "auto-discarded": {
    message: "no changes; workspace discarded",
    detail: "The writer changed no files, so its workspace was discarded. Nothing needs review.",
  },
  integrated: {
    message: "workspace applied",
    detail: "The proposal was applied to the parent's files. Nothing is left to review.",
  },
  discarded: {
    message: "workspace discarded",
    detail: "The proposal was discarded without being applied.",
  },
} as const;

function workspaceOutcomeIssue(card: SubagentRunCard, label: string, add: AddIssue): void {
  const outcome = card.workspaceOutcome;
  if (outcome !== undefined && outcome.status !== "proposal") {
    const { message, detail } = RESOLVED_WORKSPACE_ISSUES[outcome.status];
    add("info", "workspace-outcome", `${label}: ${message}`, detail);
    return;
  }
  if (outcome === undefined && !hasChangesToReview(card)) return;
  add(
    "info",
    "workspace-outcome",
    outcome
      ? `${label}: ready to apply (${countLabel(outcome.changedFileCount, "file")})`
      : `${label}: ready to apply`,
    Arr.join(
      [
        ...(outcome ? proposalDiffStatLines(outcome) : []),
        ...(card.workspaceId ? [workspaceFact(card.workspaceId, outcome)] : []),
        ...(outcome?.uncapturedFileCount
          ? [
              "Credential files the writer created, such as .env, are not part of the proposal and stay in the worker tree.",
            ]
          : []),
      ],
      "\n",
    ),
  );
}

function reportEvidenceIssues(card: SubagentRunCard, label: string, add: AddIssue): void {
  workspaceOutcomeIssue(card, label, add);
  const reportCut = card.finalTextTruncated === true && card.finalText !== undefined;
  const archive = card.reportArchive;
  // Details name the file and its size, so the detail only says what the file holds.
  const savedDetail = (holds: string): string =>
    card.reportTruncation
      ? `${reportTruncationText(card.reportTruncation)}; ${holds}.`
      : `${Str.capitalize(holds)}.`;
  // A whole saved report is a usable recovery path, so the cut is routine information.
  if (reportCut && archive?.complete === true)
    add(
      "info",
      "report-saved",
      `${label}: full report saved to a file`,
      savedDetail("the full report is in its file"),
    );
  if (reportCut && archive?.complete === false)
    add(
      "warning",
      "report-cut",
      `${label}: report too long to save in full`,
      savedDetail("its saved file holds more, but not all, of the report"),
    );
  const clipped =
    (reportCut && archive === undefined) ||
    (card.errorTruncated === true && card.error !== undefined);
  if (clipped)
    add(
      "warning",
      "evidence-omitted",
      `${label}: some details are unavailable in this view`,
      "Details are bounded in this view.",
    );
}
