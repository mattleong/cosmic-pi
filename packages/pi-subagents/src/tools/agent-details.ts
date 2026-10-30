import * as Arr from "effect/Array";
import type { CompactIssue } from "pi-code-previews";
import { clipText } from "pi-cosmic-core/display";
import { MESSAGE_TEXT_LIMIT } from "pi-cosmic-core/message-text";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import {
  type AgentListEntry,
  type AgentListResult,
  type AgentReadout,
  type AgentReadResult,
  type AgentSendResult,
} from "../run/agent-messaging.ts";
import { runAttention } from "../run/attention.ts";
import {
  failedRunNextCandidate,
  isTerminalRunState,
  SUBAGENT_ROOT_RUN_ID,
  type SubagentRunView,
} from "../run/model.ts";
import { MAX_TOOL_OUTPUT_CHARS } from "../run/limits.ts";
import { AGENT_TOOL_NAME } from "../run/tool-policy.ts";
import { aggregateUsage } from "../ui/metrics.ts";
import {
  nextCandidateFact,
  savedFileFact,
  workspaceFact,
  workspaceNote,
} from "../ui/notice-facts.ts";
import { noticeText } from "../ui/notice-details.ts";
import { formatRunRouteLine, formatSessionAge } from "../ui/run-presentation.ts";
import { compactRunIssues } from "./compact-run-issues.ts";
import { projectName } from "./contract.ts";
import { projectSubagentRunCard } from "./details-projection.ts";
import {
  AGENT_DETAILS_VERSION,
  MAX_AGENT_DETAIL_FACT_CHARS,
  MAX_AGENT_DETAIL_FACTS,
  MAX_AGENT_DETAIL_NOTES,
  MAX_AGENT_DISPLAY_TEXT_CHARS,
  MAX_AGENT_LIST_ENTRIES,
  MAX_AGENT_LIST_TASK_CHARS,
  MAX_AGENT_READ_ISSUE_TEXT_CHARS,
  MAX_AGENT_READ_ISSUES,
  MAX_AGENT_STATUS_CHARS,
  type AgentToolDetails,
} from "./details-schema.ts";
import { runStallFact } from "./format.ts";
import { isTextFragment } from "./text-fragments.ts";

const agentName = (entry: { readonly name: string }): string => projectName(entry.name) || "agent";

const fact = (text: string): string =>
  clipText(sanitizeTerminalLine(text), MAX_AGENT_DETAIL_FACT_CHARS);
const facts = (lines: ReadonlyArray<string | undefined>): ReadonlyArray<string> =>
  Arr.map(Arr.filter(lines, isTextFragment).slice(0, MAX_AGENT_DETAIL_FACTS), fact);
const status = (text: string): string =>
  clipText(sanitizeTerminalLine(text), MAX_AGENT_STATUS_CHARS);

const roleLabel = (run: Pick<SubagentRunView, "agent" | "profile">): string =>
  run.agent ? `${run.agent} (${run.profile ?? "generalist"})` : (run.profile ?? "generalist");

/** The route a run took, such as `reviewer → openai/gpt-5.5:high`. */
const routeFact = (run: SubagentRunView): string =>
  `Route ${formatRunRouteLine({ ...run, profile: roleLabel(run) })}`;

/** A short human status for a run, only when it departs from its state's expected course. */
const runStatus = (run: SubagentRunView, now: number): string | undefined => {
  const attention = runAttention(run);
  if (attention?.kind === "question" || attention?.kind === "question-unavailable")
    return "asks a question";
  if (attention?.kind === "paused") return "paused";
  if (run.workspaceId !== undefined && (isTerminalRunState(run.state) || run.workspaceOutcome))
    return workspaceNote(run.workspaceOutcome);
  return runStallFact(run, now);
};

/** Parents by name where they are listed, so a fact reads `child of auth-review`. */
const parentLabel = (parentId: string, names: ReadonlyMap<string, string>): string => {
  const name = names.get(parentId);
  return name === undefined || name === parentId ? parentId : `${name} (${parentId})`;
};

const listFacts = (entry: AgentListEntry, names: ReadonlyMap<string, string>): string => {
  const run = entry.run;
  return fact(
    Arr.join(
      Arr.filter(
        [
          entry.id,
          run ? formatRunRouteLine({ ...run, profile: roleLabel(run) }) : undefined,
          run?.writeIntent === "writer"
            ? run.workspaceId === undefined
              ? "shared-checkout writer"
              : `worktree ${run.workspaceId}`
            : undefined,
          entry.parentId === undefined
            ? undefined
            : `child of ${parentLabel(entry.parentId, names)}`,
        ],
        isTextFragment,
      ),
      " · ",
    ),
  );
};

const listEntry = (entry: AgentListEntry, names: ReadonlyMap<string, string>, now: number) => {
  const task = entry.task === undefined ? "" : sanitizeTerminalLine(entry.task);
  const shownStatus = entry.run ? runStatus(entry.run, now) : undefined;
  return {
    id: entry.id,
    name: agentName(entry),
    kind: entry.kind,
    state: entry.state,
    ...(entry.depth !== undefined && { depth: entry.depth }),
    ...(task && { task: clipText(task, MAX_AGENT_LIST_TASK_CHARS) }),
    ...(shownStatus && { status: status(shownStatus) }),
    facts: listFacts(entry, names),
  };
};

export const listDetails = (result: AgentListResult, now: number): AgentToolDetails => {
  const counts = new Map<AgentListEntry["state"], number>();
  for (const entry of result.agents) counts.set(entry.state, (counts.get(entry.state) ?? 0) + 1);
  const [only] = result.agents;
  const names = new Map(Arr.map(result.agents, (entry) => [entry.id, agentName(entry)] as const));
  return {
    version: AGENT_DETAILS_VERSION,
    action: AGENT_TOOL_NAME.list,
    agentCount: result.agents.length,
    states: Arr.map([...counts], ([state, count]) => ({ state, count })),
    ...(result.agents.length === 1 && only && { only: { id: only.id, name: agentName(only) } }),
    entries: Arr.map(result.agents.slice(0, MAX_AGENT_LIST_ENTRIES), (entry) =>
      listEntry(entry, names, now),
    ),
    missingIds: [...result.missingIds],
  };
};

export const sendDetails = (result: AgentSendResult): AgentToolDetails => ({
  version: AGENT_DETAILS_VERSION,
  action: AGENT_TOOL_NAME.send,
  to: result.to,
  name: agentName(result),
  disposition: result.disposition,
  ...(result.mainState !== undefined && { mainState: result.mainState }),
  ...(result.parked && { parked: true }),
});

/**
 * The issues a run's status card raises, bounded for persisted details. A failed worker is the
 * reader's attention, not a failed read, so failures become warnings.
 */
const boundedReadIssue = ({ severity, code, message, detail }: CompactIssue): CompactIssue => ({
  severity: severity === "error" ? "warning" : severity,
  code: clipText(code, MAX_AGENT_READ_ISSUE_TEXT_CHARS),
  message: clipText(message, MESSAGE_TEXT_LIMIT),
  ...(detail !== undefined && { detail: clipText(detail, MAX_AGENT_READ_ISSUE_TEXT_CHARS) }),
});

/** `errorShown`: the read's text is the run's failure, which its issue then doesn't repeat. */
const readIssues = (run: SubagentRunView, errorShown: boolean): ReadonlyArray<CompactIssue> => {
  const { finalText: _finalText, ...card } = projectSubagentRunCard(run);
  return Arr.map(
    compactRunIssues([card], { showsError: () => errorShown }).slice(0, MAX_AGENT_READ_ISSUES),
    boundedReadIssue,
  );
};

const runReadFacts = (
  readout: Extract<AgentReadout, { readonly kind: "run" }>,
  now: number,
): ReadonlyArray<string> => {
  const run = readout.run;
  const usage = aggregateUsage([run]);
  const elapsed = formatSessionAge(run.endedAt ?? now, run.startedAt);
  const next = run.state === "failed" ? failedRunNextCandidate(run) : undefined;
  return facts([
    `ID ${run.id}`,
    routeFact(run),
    run.parentRunId === undefined || run.parentRunId === SUBAGENT_ROOT_RUN_ID
      ? undefined
      : `Parent ${run.parentRunId}`,
    run.depth !== undefined && run.depth > 1 ? `Depth ${run.depth}` : undefined,
    run.workspaceId === undefined
      ? undefined
      : workspaceFact(run.workspaceId, run.workspaceOutcome),
    readout.reportFile ? savedFileFact("Report file", readout.reportFile) : undefined,
    readout.reportGeneration > 1 ? `Assignment ${readout.reportGeneration}` : undefined,
    next === undefined ? undefined : nextCandidateFact(next),
    Arr.join(
      Arr.filter(
        [usage, elapsed, run.context === "fork" ? "forked context" : undefined],
        isTextFragment,
      ),
      " · ",
    ) || undefined,
  ]);
};

const runReadNotes = (run: SubagentRunView, now: number): ReadonlyArray<string> =>
  Arr.map(
    Arr.filter(
      [
        !isTerminalRunState(run.state) && run.progress ? run.progress : undefined,
        runStallFact(run, now),
      ],
      isTextFragment,
    ).slice(0, MAX_AGENT_DETAIL_NOTES),
    fact,
  );

export const readDetails = (
  result: AgentReadResult,
  displayText: (readout: AgentReadout) => string | undefined,
  now: number,
): AgentToolDetails => {
  // The agents' words share one display budget, as they share one tool result.
  const budget = Math.min(
    MAX_AGENT_DISPLAY_TEXT_CHARS,
    Math.floor(MAX_TOOL_OUTPUT_CHARS / Math.max(1, result.agents.length)),
  );
  return {
    version: AGENT_DETAILS_VERSION,
    action: AGENT_TOOL_NAME.read,
    agents: Arr.map(result.agents, (readout) => {
      const text = displayText(readout);
      const words = noticeText(text, budget);
      const hasReportFile = readout.kind === "run" && readout.reportFile !== undefined;
      const issues =
        readout.kind === "run" ? readIssues(readout.run, readout.source === "error") : [];
      const notes = readout.kind === "run" ? runReadNotes(readout.run, now) : [];
      const runFacts = readout.kind === "run" ? runReadFacts(readout, now) : [];
      return {
        id: readout.id,
        name: agentName(readout),
        state: readout.state,
        textStatus: text === undefined ? "none" : "text",
        truncated: readout.truncated,
        ...(readout.kind === "run" &&
          (text !== undefined || hasReportFile) &&
          readout.source !== undefined && { source: readout.source }),
        ...(issues.length > 0 && { issues: [...issues] }),
        ...(words && { text: words.text }),
        ...(words !== undefined && (words.cut || readout.truncated) && { textCut: true }),
        ...(notes.length > 0 && { notes: [...notes] }),
        ...(runFacts.length > 0 && { facts: [...runFacts] }),
      };
    }),
    missingIds: [...result.missingIds],
  };
};
