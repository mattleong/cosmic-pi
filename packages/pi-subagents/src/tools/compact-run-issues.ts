import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { type CompactIssue } from "pi-code-previews";
import { skippedCandidateLabel } from "../profiles/model.ts";
import { runAttention, runCleanupAttention } from "../run/attention.ts";
import { reportTruncationText } from "../run/state.ts";
import { savedFileFact, workspaceFact } from "../ui/notice-facts.ts";
import type { SubagentRunCard } from "./details-schema.ts";
import { cleanupEvidenceText, proposalDiffStatLines } from "./format.ts";
import { countLabel } from "pi-cosmic-core/display";
import { failureMessage, firstLineMessage, quoteText } from "pi-cosmic-core/message-text";
import { isTextFragment } from "./text-fragments.ts";

type AddIssue = (
  severity: CompactIssue["severity"],
  code: string,
  message: string,
  detail?: string,
) => void;

export const QUOTED_TEXT_LIMIT = 120;

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
  /**
   * Questions arrive in their own notice: the heading already says the run waits for a reply, so
   * the call doesn't repeat the question.
   */
  readonly questionsNoticed?: boolean | undefined;
}

type QuestionStyle = "quoted" | "named" | "omitted";

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

/** Only the attention issues of `cards`, for runs a call reports without targeting them. */
/** Attention from runs a call didn't target; a noticed question is named, not repeated. */
export function compactAttentionIssues(
  cards: readonly SubagentRunCard[],
  options: Pick<RunIssueOptions, "questionsNoticed"> = {},
): CompactIssue[] {
  const issues: CompactIssue[] = [];
  for (const card of cards) {
    const add = cardIssueAdder(issues, card);
    attentionIssues(card, cardLabel(card), add, options.questionsNoticed ? "named" : "quoted");
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
    attentionIssues(card, label, add, options.questionsNoticed ? "omitted" : "quoted");
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

function attentionIssues(
  card: SubagentRunCard,
  label: string,
  add: AddIssue,
  questions: QuestionStyle,
): void {
  const attention = runAttention(card);
  switch (attention?.kind) {
    case undefined:
      return;
    case "paused":
      // A held state, not a problem: the heading already says the run is paused.
      if (runCleanupAttention(card) !== undefined) return;
      add("info", "paused-recovery", `${label} is paused`);
      return;
    case "question": {
      if (questions === "omitted") return;
      if (questions === "named") {
        add("attention", "parent-question", `${label} asks a question`, attention.message);
        return;
      }
      // The whole question is detail only when the message can't show all of it.
      const { line, detail } = quoteText(attention.message, { limit: QUOTED_TEXT_LIMIT });
      add(
        "attention",
        "parent-question",
        `${label} asks: ${line ?? firstLineMessage(attention.message, "a question", QUOTED_TEXT_LIMIT)}`,
        detail,
      );
      return;
    }
    case "question-unavailable":
      add(
        "attention",
        "question-unavailable",
        `${label} is waiting for a reply, but its question is unavailable`,
      );
  }
}

function cleanupIssues(card: SubagentRunCard, label: string, add: AddIssue): void {
  const attention = runCleanupAttention(card);
  if (attention === undefined) return;
  const messages = {
    quarantined: "cleanup remains unconfirmed",
    "pool-quarantined": "writer admission is blocked by cleanup quarantine",
  };
  add(
    "warning",
    `cleanup-${attention}`,
    `${label}: ${messages[attention]}`,
    cleanupEvidenceText(card),
  );
}

function evidenceIssues(
  card: SubagentRunCard,
  label: string,
  add: AddIssue,
  errorShown: boolean,
): void {
  if (card.error) {
    const { line, detail } = quoteText(card.error, { limit: QUOTED_TEXT_LIMIT, failure: true });
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
  const savedDetail = (saved: NonNullable<SubagentRunCard["reportArchive"]>): string =>
    Fn.pipe(
      [
        card.reportTruncation && reportTruncationText(card.reportTruncation),
        savedFileFact("Report file", saved),
      ],
      Arr.filter(isTextFragment),
      Arr.join(". "),
    );
  // A whole saved report is a usable recovery path, so the cut is routine information.
  if (reportCut && archive?.complete === true)
    add("info", "report-saved", `${label}: full report saved to a file`, savedDetail(archive));
  if (reportCut && archive?.complete === false)
    add("warning", "report-cut", `${label}: report too long to save in full`, savedDetail(archive));
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
