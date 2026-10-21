import { absurd } from "effect/Function";
import * as Predicate from "effect/Predicate";
import {
  clipText,
  safeTextPrefix,
  sanitizeDiagnosticError,
  sanitizeTerminalLine,
  stripTerminalControls,
} from "pi-cosmic-core";
import { runAttention, runCleanupAttention } from "../run/attention.ts";
import { MAX_OUTCOME_FILE_PATH_CHARS, MAX_OUTCOME_PREVIEW_CHARS } from "../run/limits.ts";
import {
  failedRunNextCandidate,
  isTerminalRunState,
  type SubagentNextCandidate,
  type SubagentReportArchive,
  type SubagentReportTruncation,
  type SubagentRunView,
} from "../run/model.ts";
import { failureFileText, reportFileText, reportTruncationText } from "../run/state.ts";
import { runStateLabel } from "../ui/run-state.ts";
import { nextCandidateText, proposalGuidance, runProfileLabel } from "./format.ts";
import { steeringDeliveryEvidence } from "./outcome.ts";

/**
 * Multi-run model-facing output (await, lifecycle, and completion notices) gives each run one
 * block with a fixed number of lines, each clipped to a fixed bound, so a block never exceeds
 * `MAX_RUN_BLOCK_CHARS` and a full batch always fits. Everything else about a run, such as full
 * warnings, diff-stat files, cwd, route warnings, and cleanup evidence, is in its `agent_read`.
 */
const MAX_BLOCK_LINE_CHARS = 160;
const MAX_BLOCK_NAME_CHARS = 48;
const PREVIEW_LABELS = {
  report: "Report (no file was saved): ",
  failure: "Failure: ",
  question: "Question: ",
} as const;
/** A label and the preview of a failure, question, or unsaved report. */
const MAX_PREVIEW_LINE_CHARS =
  MAX_OUTCOME_PREVIEW_CHARS +
  Math.max(...Object.values(PREVIEW_LABELS).map(({ length }) => length));
/** A label, an archived path, and the file's size. */
const MAX_FILE_LINE_CHARS = MAX_OUTCOME_FILE_PATH_CHARS + 112;

const ACTION_KINDS = ["attention", "candidate", "steering", "workspace", "warning"] as const;

/** The one-line action items a block may carry, at most one of each kind. */
export type RunBlockActions = Partial<Record<(typeof ACTION_KINDS)[number], string | undefined>>;

/**
 * Identity, an outcome of at most a preview line and a file or pointer line, and one line per
 * action kind, each with its line break.
 */
export const MAX_RUN_BLOCK_CHARS =
  MAX_BLOCK_LINE_CHARS +
  MAX_PREVIEW_LINE_CHARS +
  MAX_FILE_LINE_CHARS +
  ACTION_KINDS.length * MAX_BLOCK_LINE_CHARS +
  2 +
  ACTION_KINDS.length;

/** Blocks are joined by a blank line. */
export const RUN_BLOCK_SEPARATOR = "\n\n";

/**
 * A bounded header and summary lines that precede the blocks: an await's progress and attention,
 * lifecycle failure sections, or a notice's heading.
 */
export const MAX_RESULT_HEADER_CHARS = 1_200;

export type RunBlockOutcome =
  /** A report's file; only without one does the block preview the retained text. */
  | {
      readonly kind: "report";
      readonly text: string | undefined;
      readonly archive?: SubagentReportArchive | undefined;
      readonly truncation?: SubagentReportTruncation | undefined;
    }
  | {
      readonly kind: "failure";
      readonly text: string;
      readonly archive?: SubagentReportArchive | undefined;
    }
  | { readonly kind: "question"; readonly text: string }
  /** A fixed status line, such as a report delivered earlier. */
  | { readonly kind: "note"; readonly text: string };

export interface RunBlock {
  readonly id: string;
  readonly name: string;
  /** Short identity facts after the name, such as the state and profile. */
  readonly facts: ReadonlyArray<string | undefined>;
  readonly outcome?: RunBlockOutcome | undefined;
  readonly actions: RunBlockActions;
}

const clipLine = (text: string, maximum: number): string =>
  clipText(sanitizeTerminalLine(text), maximum);

/** Free text from a child or backend: one redacted line. */
const freeText = (text: string, maximum: number): string =>
  sanitizeDiagnosticError(text, { maximumLength: maximum });

const preview = (text: string): { readonly line: string; readonly cut: boolean } => {
  const whole = sanitizeDiagnosticError(text, { maximumLength: Number.MAX_SAFE_INTEGER });
  return whole.length <= MAX_OUTCOME_PREVIEW_CHARS
    ? { line: whole, cut: false }
    : { line: clipText(whole, MAX_OUTCOME_PREVIEW_CHARS), cut: true };
};

/**
 * An outcome is at most one preview-sized line and one file line, each clipped to its bound: a
 * report's file, or a preview followed by where the rest is.
 */
interface OutcomeLines {
  readonly preview?: string | undefined;
  /** A saved file, or where the rest of a cut preview is when no file holds it. */
  readonly rest?: { readonly kind: "file" | "pointer"; readonly text: string } | undefined;
}

const OUTCOME_REST_BOUNDS = { file: MAX_FILE_LINE_CHARS, pointer: MAX_PREVIEW_LINE_CHARS } as const;

/**
 * The question stays a preview; its notice, sent once whatever awaits are running, delivers the
 * whole question, and agent_read returns it if that notice hasn't arrived.
 */
const questionOutcomeLines = (id: string, text: string): OutcomeLines => {
  const { line, cut } = preview(text);
  return {
    preview: `${PREVIEW_LABELS.question}${line}`,
    ...(cut && {
      rest: {
        kind: "pointer",
        text: `The full question arrives in its own question notice; if it hasn't, agent_read ${id} returns it.`,
      },
    }),
  };
};

const outcomeLines = (id: string, outcome: RunBlockOutcome): OutcomeLines => {
  switch (outcome.kind) {
    case "report": {
      if (outcome.archive) return { rest: { kind: "file", text: reportFileText(outcome.archive) } };
      const text = outcome.text?.trim();
      if (!text) return { preview: "Completed without a final report." };
      const { line, cut } = preview(text);
      const kept = outcome.truncation ? ` (${reportTruncationText(outcome.truncation)})` : "";
      return {
        preview: `${PREVIEW_LABELS.report}${line}`,
        ...((cut || outcome.truncation) && {
          rest: { kind: "pointer", text: `agent_read ${id} gives the retained report${kept}.` },
        }),
      };
    }
    case "failure": {
      const { line, cut } = preview(outcome.text);
      return {
        preview: `${PREVIEW_LABELS.failure}${line}`,
        ...(cut && {
          rest: outcome.archive
            ? { kind: "file", text: failureFileText(outcome.archive) }
            : {
                kind: "pointer",
                text: `No failure file was saved; agent_read ${id} gives the full failure.`,
              },
        }),
      };
    }
    case "question":
      return questionOutcomeLines(id, outcome.text);
    case "note":
      return { preview: outcome.text };
  }
  return absurd(outcome);
};

const warningLine = (id: string, warning: string): string => {
  const pointer = ` … (cut; agent_read ${id} has the full warning)`;
  const whole = freeText(warning, Number.MAX_SAFE_INTEGER);
  const room = MAX_BLOCK_LINE_CHARS - "Warning: ".length;
  return `Warning: ${whole.length <= room ? whole : `${safeTextPrefix(whole, room - pointer.length).trimEnd()}${pointer}`}`;
};

/** One run's block, within `MAX_RUN_BLOCK_CHARS` by construction. */
export const formatRunBlock = ({ id, name, facts, outcome, actions }: RunBlock): string => {
  const identity = [
    `${sanitizeTerminalLine(id)} ${freeText(name, MAX_BLOCK_NAME_CHARS)}`,
    ...facts.filter(Predicate.isNotUndefined),
  ].join(" · ");
  const lines = outcome ? outcomeLines(id, outcome) : {};
  return [
    clipLine(identity, MAX_BLOCK_LINE_CHARS),
    ...(lines.preview === undefined ? [] : [clipLine(lines.preview, MAX_PREVIEW_LINE_CHARS)]),
    ...(lines.rest === undefined
      ? []
      : [clipLine(lines.rest.text, OUTCOME_REST_BOUNDS[lines.rest.kind])]),
    ...ACTION_KINDS.flatMap((kind) => {
      const action = actions[kind];
      if (!action) return [];
      return [
        clipLine(kind === "warning" ? warningLine(id, action) : action, MAX_BLOCK_LINE_CHARS),
      ];
    }),
  ].join("\n");
};

/** Blocks after a header, both bounded, so the result fits by construction. */
export const formatRunBlocks = (
  header: ReadonlyArray<string>,
  blocks: ReadonlyArray<RunBlock>,
): string => {
  const heading = clipText(header.filter(Boolean).join("\n"), MAX_RESULT_HEADER_CHARS);
  return [heading, ...blocks.map(formatRunBlock)].filter(Boolean).join(RUN_BLOCK_SEPARATOR);
};

/** A delivered report the run retained whole, which output may repeat after its blocks. */
export interface InlineReport {
  readonly id: string;
  readonly name: string;
  readonly text: string;
}

/** A delivered report with a file whose retained copy is the whole report. */
export const wholeSavedReport = (report: {
  readonly id: string;
  readonly name: string;
  readonly finalText?: string | undefined;
  readonly finalTextTruncation?: SubagentReportTruncation | undefined;
  readonly reportArchive?: SubagentReportArchive | undefined;
}): InlineReport | undefined => {
  const text = report.finalText?.trim();
  return text && report.reportArchive && !report.finalTextTruncation
    ? { id: report.id, name: report.name, text }
    : undefined;
};

const inlineReportSection = ({ id, name, text }: InlineReport): string =>
  `Report from ${sanitizeTerminalLine(id)} ${freeText(name, MAX_BLOCK_NAME_CHARS)}, the same as its file:\n${stripTerminalControls(text)}`;

/**
 * Follows the blocks with the reports that fit in what `maximum` leaves, chosen smallest first and
 * shown in block order. The blocks are unchanged, and a report left out stays in its file.
 */
export const withInlineReports = (
  blocks: string,
  reports: ReadonlyArray<InlineReport | undefined>,
  maximum: number,
): string => {
  const sections = reports.flatMap((report) => (report ? [inlineReportSection(report)] : []));
  let room = maximum - blocks.length;
  const shown = new Set<string>();
  for (const section of sections.toSorted((left, right) => left.length - right.length)) {
    const cost = RUN_BLOCK_SEPARATOR.length + section.length;
    if (cost > room) break;
    room -= cost;
    shown.add(section);
  }
  return [blocks, ...sections.filter((section) => shown.has(section))]
    .filter(Boolean)
    .join(RUN_BLOCK_SEPARATOR);
};

// Action items from a run's projected view.

const callArgument = (id: string): string => JSON.stringify(id);

const attentionAction = (run: SubagentRunView): string | undefined => {
  const id = callArgument(run.id);
  switch (runCleanupAttention(run)) {
    case "pool-quarantined":
      return "Writer pool quarantined by unconfirmed cleanup: find that run with agent_list and agent_read it; don't stop healthy peers.";
    case "quarantined":
      return run.cleanup?.recovery === "stop"
        ? `Cleanup unconfirmed: verify with agent_lifecycle({ action: "stop", runIds: [${id}] }), which also stops active descendants.`
        : "Cleanup unconfirmed and needs manual inspection (agent_read has the evidence); don't retry or reuse its resources.";
    case undefined:
      break;
  }
  const attention = runAttention(run);
  switch (attention?.kind) {
    case "paused":
      return attention.canResume
        ? `Paused for a decision: review with agent_read, then resume with agent_send({ to: ${id}, message: "..." }).`
        : `Paused and can't resume: stop it with agent_lifecycle({ action: "stop", runIds: [${id}] }), then start a replacement.`;
    case "question":
      return `Reply with agent_send({ to: ${id}, message: "..." }), then call agent_await again.`;
    case "question-unavailable":
      return "Waiting for a reply, but its question is unavailable; agent_read shows its state.";
    case undefined:
      return undefined;
  }
  return absurd(attention);
};

/** A failed run's next frozen route candidate, which a new run may take as its model. */
export const nextCandidateAction = (next: SubagentNextCandidate | undefined): string | undefined =>
  next && `Next candidate: ${nextCandidateText(next)}.`;

const runViewActions = (run: SubagentRunView): RunBlockActions => ({
  attention: attentionAction(run),
  candidate: nextCandidateAction(run.state === "failed" ? failedRunNextCandidate(run) : undefined),
  steering: run.steeringDelivery
    ? `Steering: ${steeringDeliveryEvidence[run.steeringDelivery].message} (steeringDelivery=${run.steeringDelivery}); agent_read has the detail.`
    : undefined,
  workspace:
    run.workspaceId && (run.workspaceOutcome || isTerminalRunState(run.state))
      ? `Workspace: ${proposalGuidance(run.workspaceId, run.workspaceOutcome)}`
      : undefined,
  warning: run.warning ?? run.systemWarning,
});

const WITHHELD_REPORT_NOTES = {
  claimed: "Report claimed by another operation.",
  delivered: "Report delivered earlier; agent_read gives its file.",
  missing: "No accepted final report for this assignment.",
  available: "Report not delivered by this result; await this run again for it.",
} as const satisfies Record<NonNullable<SubagentRunView["reportStatus"]>, string>;

/**
 * A run's outcome as its view shows it. `delivered` holds the report this result hands over;
 * otherwise a completed run says where its report stands.
 */
export const runViewOutcome = (
  run: SubagentRunView,
  delivered: boolean,
): RunBlockOutcome | undefined => {
  if (run.state === "waiting_for_parent" && run.question)
    return { kind: "question", text: run.question.message };
  if (run.state === "failed" || (run.error && isTerminalRunState(run.state)))
    return run.error
      ? { kind: "failure", text: run.error, archive: run.errorArchive }
      : { kind: "note", text: "Failed without an error report." };
  if (run.state !== "completed") return undefined;
  if (delivered)
    return {
      kind: "report",
      text: run.finalText,
      archive: run.reportArchive,
      truncation: run.finalTextTruncation,
    };
  return {
    kind: "note",
    text:
      run.reportStatus === undefined
        ? "Report availability unknown here; agent_read gives it."
        : WITHHELD_REPORT_NOTES[run.reportStatus],
  };
};

/** A run's block from its projected view. */
export const runViewBlock = (
  run: SubagentRunView,
  outcome: RunBlockOutcome | undefined,
): RunBlock => ({
  id: run.id,
  name: run.name,
  facts: [runStateLabel(run.state), runProfileLabel(run)],
  outcome,
  actions: runViewActions(run),
});
