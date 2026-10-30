import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { sanitizeDiagnosticContent, sanitizeTerminalLine } from "pi-cosmic-core/security";
import type { SubagentCompletionNotification } from "../boundary/host-notifier.ts";
import type {
  SubagentNextCandidate,
  SubagentReportArchive,
  SubagentWorkspaceOutcome,
} from "../run/model.ts";
import { workspaceOutcomeLabel } from "../tools/format.ts";
import { isTextFragment } from "../tools/text-fragments.ts";
import {
  MAX_NOTICE_FACT_CHARS,
  MAX_NOTICE_FACTS,
  MAX_NOTICE_RUNS,
  MAX_NOTICE_TOTAL_TEXT_CHARS,
  noticeFact,
  noticeName,
  noticeText,
  type NoticeRun,
} from "./notice-details.ts";

/** A saved report or failure file as a display fact, such as `Report file: <path> · 98 characters, 5 lines`. */
export const savedFileFact = (label: string, archive: SubagentReportArchive): string =>
  `${label}: ${sanitizeTerminalLine(archive.path)} · ${archive.chars.toLocaleString("en-US")} characters, ${archive.lines.toLocaleString("en-US")} lines${archive.complete ? "" : " (cut at the archive limit)"}`;

/** A worktree writer's workspace and its outcome, such as `Worktree ws-1 · proposal: 3 files`. */
export const workspaceFact = (
  workspaceId: string,
  outcome: SubagentWorkspaceOutcome | undefined,
): string =>
  `Worktree ${sanitizeTerminalLine(workspaceId)}${outcome ? ` · ${workspaceOutcomeLabel(outcome)}` : ""}`;

/** A short human note on a finished writer's workspace, such as `proposal: 3 files, +12 −4`. */
export const workspaceNote = (outcome: SubagentWorkspaceOutcome | undefined): string =>
  outcome === undefined ? "changes ready for review" : workspaceOutcomeLabel(outcome);

/** A failed run's next route candidate as a display fact. */
export const nextCandidateFact = (next: SubagentNextCandidate): string =>
  next === "none"
    ? "Route has no further model candidates"
    : `Next route candidate: ${sanitizeTerminalLine(next.model)}${next.effort === "default" ? "" : `:${sanitizeTerminalLine(next.effort)}`}`;

const completionFacts = (run: SubagentCompletionNotification): ReadonlyArray<string> =>
  Arr.filter(
    [
      `ID ${sanitizeTerminalLine(run.id)}`,
      run.profile ? `Profile ${sanitizeTerminalLine(run.profile)}` : undefined,
      run.generation > 1 ? `Assignment ${run.generation}` : undefined,
      run.reportArchive ? savedFileFact("Report file", run.reportArchive) : undefined,
      run.errorArchive ? savedFileFact("Failure file", run.errorArchive) : undefined,
      run.workspaceId ? workspaceFact(run.workspaceId, run.workspaceOutcome) : undefined,
      run.nextCandidate ? nextCandidateFact(run.nextCandidate) : undefined,
    ],
    isTextFragment,
  );

/** The notice's content is redacted, so its display copies are too. */
const redacted = (text: string | undefined, limit: number): string | undefined =>
  text === undefined ? undefined : sanitizeDiagnosticContent(text, { maximumLength: limit + 2 });

/** A run's failure and warning as the user reads them, without agent procedures. */
const userError = (run: SubagentCompletionNotification): string | undefined =>
  run.userError ?? run.error;
const userWarning = (run: SubagentCompletionNotification): string | undefined =>
  run.userWarning ?? run.warning;

const completionNotes = (run: SubagentCompletionNotification): ReadonlyArray<string> => {
  const warning = Str.trim(redacted(userWarning(run), MAX_NOTICE_FACT_CHARS) ?? "");
  return Arr.filter(
    [
      warning && Str.trim(userWarning(run) ?? "") !== Str.trim(userError(run) ?? "")
        ? `Warning: ${warning}`
        : undefined,
      run.workspaceId && run.outcome === "completed"
        ? workspaceNote(run.workspaceOutcome)
        : undefined,
    ],
    isTextFragment,
  );
};

/**
 * Each finished run as a completion notice shows it to the user. The runs' words share one display
 * budget, so the details stay bounded however many runs the notice batches.
 */
export const completionNoticeRuns = (
  runs: ReadonlyArray<SubagentCompletionNotification>,
): ReadonlyArray<NoticeRun> => {
  const shown = runs.slice(0, MAX_NOTICE_RUNS);
  const budget = Math.floor(MAX_NOTICE_TOTAL_TEXT_CHARS / Math.max(1, shown.length));
  return Arr.map(shown, (run) => {
    const words = noticeText(
      redacted(run.outcome === "failed" ? userError(run) : run.finalText, budget),
      budget,
    );
    const notes = completionNotes(run);
    const facts = completionFacts(run);
    return {
      id: run.id,
      name: noticeName(run.name),
      outcome: run.outcome,
      ...(words && { text: words.text }),
      ...((words?.cut === true ||
        (run.outcome === "completed" && run.finalTextTruncation !== undefined)) && {
        textCut: true,
      }),
      ...(notes.length > 0 && {
        notes: Arr.map(notes.slice(0, MAX_NOTICE_FACTS), noticeFact),
      }),
      ...(facts.length > 0 && {
        facts: Arr.map(facts.slice(0, MAX_NOTICE_FACTS), noticeFact),
      }),
    };
  });
};
