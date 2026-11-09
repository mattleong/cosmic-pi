import * as Arr from "effect/Array";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import { visibleWidth } from "@earendil-works/pi-tui";
import { skippedCandidateLabel } from "../profiles/model.ts";
import { runAttention } from "../run/attention.ts";
import { isTerminalRunState, type SubagentRunState } from "../run/model.ts";
import { agentTextBlockLines, factRowLines, type AgentTextBlock } from "../ui/agent-text.ts";
import { quotesWhole } from "./compact-run-issues.ts";
import { aggregateUsage } from "../ui/metrics.ts";
import { savedFileFact, workspaceNote } from "../ui/notice-facts.ts";
import { agentFactLines, runRouteFact, writerFact } from "../ui/run-facts.ts";
import { withoutStatusGlyphWords } from "pi-cosmic-ui/manager";
import {
  runRowStateLabel,
  runSnapshotGlyphMeaning,
  runStateColor,
  runStateSnapshotGlyph,
} from "../ui/run-state.ts";
import type { SubagentRunCard } from "./details-schema.ts";
import { runTiming } from "./render-run-rows.ts";
import { isTextFragment } from "./text-fragments.ts";

const REPORT_STATUS_NOTES = {
  missing: "No final report was accepted",
  claimed: "Its report was claimed by another wait",
  delivered: "Its report was delivered earlier",
  available: "Its report isn't part of this result",
} as const;

/**
 * A finished report's notes: that a cut report has no saved copy, and a writer's proposal. A saved
 * copy's issue already says how much of the report its file holds.
 */
const reportNotes = (card: SubagentRunCard): ReadonlyArray<string> =>
  Arr.filter(
    [
      card.finalTextTruncated && card.reportArchive === undefined
        ? "Only the start of this report was kept"
        : undefined,
      card.state === "completed" && !card.finalText && !card.finalTextTruncated
        ? card.reportStatus === undefined
          ? "Its report isn't part of this result"
          : REPORT_STATUS_NOTES[card.reportStatus]
        : undefined,
      card.writeIntent === "writer" && card.workspaceId !== undefined && card.state === "completed"
        ? workspaceNote(card.workspaceOutcome)
        : undefined,
    ],
    isTextFragment,
  );

/** The words a run's card holds: its report, failure, or question. */
export const cardWords = (card: SubagentRunCard): string | undefined => {
  if (card.state === "completed") return card.finalText;
  if (card.error) return card.error;
  const attention = runAttention(card);
  return attention?.kind === "question" ? attention.message : undefined;
};

/** Whether a run's block shows its failure text. */
export const cardShowsError = (card: SubagentRunCard): boolean =>
  card.error !== undefined && cardWords(card) === card.error;

/** Whether a run's block shows its pending question: expanded, when its issue quotes only part. */
export const cardShowsQuestion = (card: SubagentRunCard): boolean => {
  const attention = runAttention(card);
  return (
    attention?.kind === "question" &&
    cardWords(card) === attention.message &&
    !quotesWhole(attention.message)
  );
};

/**
 * A run's block: its state where its glyph doesn't say it, then its words or progress. Collapsed,
 * a failure's raw text stays behind the expansion; the row's issue already names its cause. A
 * question is its issue's quote, and the block adds the rest of a long one when expanded.
 */
const cardBlock = (card: SubagentRunCard, expanded: boolean): AgentTextBlock => {
  const asking = runAttention(card)?.kind === "question";
  const words =
    (!expanded && cardShowsError(card)) || (asking && !(expanded && cardShowsQuestion(card)))
      ? undefined
      : cardWords(card);
  return {
    glyph: runStateSnapshotGlyph(card.state),
    tone: runStateColor(card.state),
    name: card.name,
    status: runRowStateLabel(asking ? "waiting_for_parent" : card.state),
    ...(words !== undefined && { text: words, verbatim: words === card.error }),
    notes: [
      ...(!isTerminalRunState(card.state) && !asking && words === undefined && card.progress
        ? [card.progress]
        : []),
      ...reportNotes(card),
    ],
  };
};

export const cardBlockLines = (
  cards: ReadonlyArray<SubagentRunCard>,
  width: number,
  theme: Theme,
  expanded: boolean,
): string[] =>
  agentTextBlockLines(
    Arr.map(cards, (card) => cardBlock(card, expanded)),
    width,
    theme,
    expanded,
  );

/** One Details line per run: ID, route, writer, usage, and timing, then exceptional evidence. */
export const cardFactLines = (card: SubagentRunCard): ReadonlyArray<string> =>
  agentFactLines(
    card.name,
    [
      card.id,
      runRouteFact(card),
      writerFact(card),
      card.context === "fork" && "forked context",
      card.reportGeneration > 1 && `assignment ${card.reportGeneration}`,
      aggregateUsage([card]),
      runTiming(card),
    ],
    [
      card.reportArchive && savedFileFact("Report file", card.reportArchive),
      ...Arr.map(
        card.selection.skippedCandidates,
        (skipped) =>
          `Skipped ${skippedCandidateLabel(skipped.candidate)}: ${sanitizeTerminalLine(skipped.reason)}`,
      ),
      // Cleanup evidence is its issue's detail.
      card.selection.warning && `Launch note: ${card.selection.warning}`,
    ],
  );

const GROUP_VERBS: Readonly<Record<SubagentRunState, string>> = {
  starting: "Starting",
  running: "Still running",
  waiting_for_parent: "Waiting for reply",
  paused: "Paused",
  completed: "Already finished",
  failed: "Already failed",
  stopping: "Stopping",
  stopped: "Stopped",
};

/**
 * Runs grouped by state in one line each, such as `⊘ auth-review, schema-check`. A group's verb
 * shows only where its glyph doesn't say it: `✓ Already finished auth-review`, `• Still running`.
 */
export const stateGroupLines = (
  cards: ReadonlyArray<SubagentRunCard>,
  width: number,
  theme: Theme,
  expanded = false,
): string[] => {
  const groups = new Map<SubagentRunState, string[]>();
  for (const card of cards)
    groups.set(card.state, [...(groups.get(card.state) ?? []), sanitizeTerminalLine(card.name)]);
  // Expanded, a long list of names wraps beneath the first.
  return Arr.flatMap([...groups], ([state, names]) => {
    const glyph = runStateSnapshotGlyph(state);
    const verb = withoutStatusGlyphWords(GROUP_VERBS[state], runSnapshotGlyphMeaning(state));
    const lead = verb === undefined ? " " : ` ${verb} `;
    return factRowLines(
      [[glyph, runStateColor(state)], [lead], [Arr.join(names, ", "), "toolTitle"]],
      width,
      theme,
      expanded,
      { hang: visibleWidth(`${glyph}${lead}`) },
    );
  });
};
