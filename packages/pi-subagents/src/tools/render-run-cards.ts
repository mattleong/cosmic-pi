import * as Arr from "effect/Array";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { skippedCandidateLabel } from "../profiles/model.ts";
import { runAttention } from "../run/attention.ts";
import { isTerminalRunState, type SubagentRunState } from "../run/model.ts";
import { agentTextBlockLines, type AgentTextBlock } from "../ui/agent-text.ts";
import { aggregateUsage } from "../ui/metrics.ts";
import { savedFileFact, workspaceNote } from "../ui/notice-facts.ts";
import { agentFactLines, runRouteFact, writerFact } from "../ui/run-facts.ts";
import { runStateColor, runStateLabel, runStateSnapshotGlyph } from "../ui/run-state.ts";
import type { SubagentRunCard } from "./details-schema.ts";
import { runTiming } from "./render-run-rows.ts";
import { isTextFragment } from "./text-fragments.ts";

const REPORT_STATUS_NOTES = {
  missing: "No final report was accepted",
  claimed: "Its report was claimed by another wait",
  delivered: "Its report was delivered earlier",
  available: "Its report isn't part of this result",
} as const;

/** A finished report's notes: where the rest of a cut report is, and a writer's proposal. */
const reportNotes = (card: SubagentRunCard): ReadonlyArray<string> =>
  Arr.filter(
    [
      card.finalTextTruncated
        ? card.reportArchive
          ? "The rest of this report is in its saved file"
          : "Only the start of this report was kept"
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

/**
 * A run's block: its state when that isn't a plain finish, then its words or progress. Collapsed,
 * a failure's raw text stays behind the expansion; the row's issue already names its cause.
 */
const cardBlock = (card: SubagentRunCard, expanded: boolean): AgentTextBlock => {
  const words = !expanded && cardShowsError(card) ? undefined : cardWords(card);
  const asking = runAttention(card)?.kind === "question";
  return {
    glyph: runStateSnapshotGlyph(card.state),
    tone: runStateColor(card.state),
    name: card.name,
    ...(card.state !== "completed" && {
      status: runStateLabel(asking ? "waiting_for_parent" : card.state),
    }),
    ...(words !== undefined && { text: words, verbatim: words === card.error }),
    notes: [
      ...(!isTerminalRunState(card.state) && words === undefined && card.progress
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

/** Runs grouped by state in one line each, such as `⊘ Stopped auth-review, schema-check`. */
export const stateGroupLines = (
  cards: ReadonlyArray<SubagentRunCard>,
  width: number,
  theme: Theme,
): string[] => {
  const groups = new Map<SubagentRunState, string[]>();
  for (const card of cards)
    groups.set(card.state, [...(groups.get(card.state) ?? []), sanitizeTerminalLine(card.name)]);
  return Arr.map([...groups], ([state, names]) =>
    clipToWidth(
      `${theme.fg(runStateColor(state), runStateSnapshotGlyph(state))} ${GROUP_VERBS[state]} ${theme.fg("toolTitle", Arr.join(names, ", "))}`,
      width,
    ),
  );
};
