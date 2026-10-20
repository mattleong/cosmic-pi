import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { absurd } from "effect/Function";
import * as Predicate from "effect/Predicate";
import type { CompactIssue } from "pi-code-previews";
import {
  clipText,
  MESSAGE_TEXT_LIMIT,
  sanitizeTerminalLine,
  stripTerminalControls,
} from "pi-cosmic-core";
import { isCustomAgentName } from "../profiles/agents.ts";
import { PROFILE_IDS } from "../profiles/model.ts";
import {
  MAIN_AGENT_ID,
  type AgentCaller,
  type AgentListEntry,
  type AgentListResult,
  type AgentReadout,
  type AgentReadResult,
  type AgentSendResult,
} from "../run/agent-messaging.ts";
import {
  invalidRequest,
  SubagentProcessError,
  type InvalidSubagentRequestError,
  type SubagentError,
} from "../run/errors.ts";
import {
  isTerminalRunState,
  SUBAGENT_ROOT_RUN_ID,
  type SubagentRunView,
  type SubagentWorkspaceOutcome,
} from "../run/model.ts";
import { SubagentService } from "../run/service.ts";
import { reportFileText } from "../run/state.ts";
import { AGENT_TOOL_NAME } from "../run/tool-policy.ts";
import {
  encodeSubagentContract,
  MAX_CONTRACT_MODEL_CHARS,
  MAX_CONTRACT_TASK_CHARS,
  type AgentListContract,
  type AgentReadContract,
} from "./contract-schema.ts";
import { envelope, metadata, projectAttention, projectName, withheldTarget } from "./contract.ts";
import { compactRunIssues } from "./compact-run-issues.ts";
import { projectReportFile, projectSubagentRunCard } from "./details-projection.ts";
import {
  AGENT_DETAILS_VERSION,
  MAX_AGENT_READ_ISSUE_TEXT_CHARS,
  MAX_AGENT_READ_ISSUES,
  type AgentToolDetails,
} from "./details-schema.ts";
import {
  attentionRecoveryText,
  boundToolOutput,
  formatRun,
  formatRunModel,
  proposalGuidance,
  type RunFormatOptions,
} from "./format.ts";
import { pendingDeliveryEvidence } from "./outcome.ts";
import type { AgentToolInput } from "./schema.ts";

const agentName = (entry: { readonly name: string }): string => projectName(entry.name) || "agent";

const agentLabel = (entry: { readonly id: string; readonly name: string }): string =>
  entry.id === MAIN_AGENT_ID
    ? "the main agent"
    : `${sanitizeTerminalLine(entry.id)} ${JSON.stringify(agentName(entry))}`;

const missingText = (missingIds: ReadonlyArray<string>): string =>
  missingIds.length === 0
    ? ""
    : `Not in this session: ${missingIds.map(sanitizeTerminalLine).join(", ")}. Call agent_list without agentIds for current agent IDs.`;

// A worktree writer's proposal, once its assignment finished, names how to apply it.
export const agentWorktreeFact = (run: SubagentRunView | undefined): string | undefined =>
  run?.workspaceId === undefined
    ? undefined
    : isTerminalRunState(run.state) || run.workspaceOutcome !== undefined
      ? proposalGuidance(run.workspaceId, run.workspaceOutcome)
      : `worktree ${sanitizeTerminalLine(run.workspaceId)}`;

export const agentAttentionFact = (run: SubagentRunView | undefined): string | undefined => {
  const kind = run && projectAttention(run)?.kind;
  if (kind === undefined) return undefined;
  return kind === "paused" ? "paused for its parent" : "waiting for its parent's reply";
};

// Lists parents before children, indented by depth.
const listLine = (entry: AgentListEntry): string => {
  if (entry.kind === "main")
    return `- ${MAIN_AGENT_ID}: ${entry.state}${entry.self ? " (you)" : ""}`;
  const role = entry.agent ?? entry.profile;
  const model = entry.run ? formatRunModel(entry.run) : entry.runtime && `local/${entry.runtime}`;
  const facts = [
    entry.state,
    [role, model].filter(Boolean).join(" on "),
    entry.run?.writeIntent === "writer" && entry.run.workspaceId === undefined && "writer",
    agentWorktreeFact(entry.run),
    agentAttentionFact(entry.run),
    entry.parentId && `child of ${sanitizeTerminalLine(entry.parentId)}`,
    entry.self && "you",
  ].filter(Boolean);
  const task = entry.task
    ? `\n${"  ".repeat(entry.depth ?? 1)}Task: ${sanitizeTerminalLine(entry.task)}`
    : "";
  return `${"  ".repeat(Math.max(0, (entry.depth ?? 1) - 1))}- ${agentLabel(entry)}: ${facts.join(", ")}${task}`;
};

const listText = (result: AgentListResult): string =>
  [
    result.agents.length === 0
      ? "No matching agents."
      : `Agents in this session (${result.agents.length}):\n${result.agents.map(listLine).join("\n")}`,
    missingText(result.missingIds),
  ]
    .filter(Boolean)
    .join("\n\n");

const knownProfile = (profile: string | undefined) => PROFILE_IDS.find((id) => id === profile);

const WORKTREE_STATUS = {
  proposal: "proposal",
  integrated: "applied",
  discarded: "discarded",
  "auto-discarded": "discarded",
} as const satisfies Record<SubagentWorkspaceOutcome["status"], string>;

const listContract = (result: AgentListResult): AgentListContract => ({
  ...envelope(AGENT_TOOL_NAME.list),
  agents: result.agents.map((entry) => {
    const profile = knownProfile(entry.profile);
    const task = metadata(entry.task, MAX_CONTRACT_TASK_CHARS);
    const { run } = entry;
    const model = run && metadata(formatRunModel(run), MAX_CONTRACT_MODEL_CHARS);
    const attention = run && projectAttention(run);
    const outcome = run?.workspaceOutcome;
    return {
      id: entry.id,
      name: agentName(entry),
      kind: entry.kind,
      state: entry.state,
      ...(entry.parentId !== undefined && { parentId: entry.parentId }),
      ...(entry.depth !== undefined && { depth: entry.depth }),
      ...(entry.runtime !== undefined && { runtime: entry.runtime }),
      ...(model !== undefined && { model }),
      ...(profile !== undefined && { profile }),
      ...(entry.agent !== undefined && isCustomAgentName(entry.agent) && { agent: entry.agent }),
      ...(run !== undefined && { writeIntent: run.writeIntent }),
      ...(run?.workspaceId !== undefined && {
        worktree: {
          workspaceId: run.workspaceId,
          status: outcome === undefined ? "open" : WORKTREE_STATUS[outcome.status],
          ...(outcome?.status === "proposal" && { changedFileCount: outcome.changedFileCount }),
        },
      }),
      ...(attention !== undefined && { attention }),
      ...(task !== undefined && { task }),
      self: entry.self,
    };
  }),
  missingIds: [...result.missingIds],
});

const listDetails = (result: AgentListResult): AgentToolDetails => {
  const counts = new Map<AgentListEntry["state"], number>();
  for (const entry of result.agents) counts.set(entry.state, (counts.get(entry.state) ?? 0) + 1);
  const [only] = result.agents;
  return {
    version: AGENT_DETAILS_VERSION,
    action: AGENT_TOOL_NAME.list,
    agentCount: result.agents.length,
    states: [...counts].map(([state, count]) => ({ state, count })),
    ...(result.agents.length === 1 && only && { only: { id: only.id, name: agentName(only) } }),
    missingIds: [...result.missingIds],
  };
};

const SEND_TEXT: Record<AgentSendResult["disposition"], (label: string) => string> = {
  answered: (label) => `Answered ${label}'s pending question with your message.`,
  guided: (label) => `Delivered your message to ${label} as guidance for its current work.`,
  pending: (label) =>
    `Sent your message to ${label} as guidance; ${pendingDeliveryEvidence.message.toLowerCase()}. ${pendingDeliveryEvidence.detail}`,
  resumed: (label) =>
    `Resumed ${label} with your message as its next assignment. Its report goes to its own parent.`,
  woken: () => "The main agent was idle; your message started its turn.",
  queued: () => "The main agent is busy; it sees your message before its current turn ends.",
  held: () =>
    "The main agent is waiting on the user, behind an open dialog or after an interrupt; your message waits in its conversation and wakes it when the dialog closes or on the user's next prompt.",
};

const sendText = (result: AgentSendResult): string =>
  SEND_TEXT[result.disposition](agentLabel({ id: result.to, name: result.name }));

const sendDetails = (result: AgentSendResult): AgentToolDetails => ({
  version: AGENT_DETAILS_VERSION,
  action: AGENT_TOOL_NAME.send,
  to: result.to,
  name: agentName(result),
  disposition: result.disposition,
});

const readText = (text: string | undefined): string | undefined => {
  const cleaned = text === undefined ? "" : stripTerminalControls(text);
  return cleaned.trim() ? cleaned : undefined;
};

const READ_SOURCES = {
  assistant: "Latest assistant message",
  report: "Report",
  error: "Error",
} as const;

const mainReadSection = (readout: Extract<AgentReadout, { readonly kind: "main" }>): string => {
  const text = readText(readout.text);
  const heading = `${MAIN_AGENT_ID} (${readout.state})`;
  if (readout.state === "unavailable")
    return `${heading}: the session that owned the main agent was replaced, so it can't be read.`;
  if (text === undefined) return `${heading}: no assistant message yet.`;
  return `${heading}, latest assistant message${readout.truncated ? " (truncated)" : ""}:\n${text}`;
};

export interface AgentReadOptions extends RunFormatOptions {
  readonly caller: AgentCaller;
}

const isParentOf = (caller: AgentCaller, run: SubagentRunView): boolean =>
  (run.parentRunId ?? SUBAGENT_ROOT_RUN_ID) ===
  (caller.kind === "main" ? SUBAGENT_ROOT_RUN_ID : caller.runId);

/** A run's status card, then its parent's next steps when the reader is that parent. */
export const agentReadCard = (
  run: SubagentRunView,
  { caller, ...options }: AgentReadOptions,
): string =>
  [
    formatRun(run, true, { ...options, report: false }),
    isParentOf(caller, run) ? attentionRecoveryText([run]) : "",
  ]
    .filter(Boolean)
    .join("\n");

// A run's status card, then its latest message, its report's file, or its retained report.
const runReadSection = (
  readout: Extract<AgentReadout, { readonly kind: "run" }>,
  options: AgentReadOptions,
): string => {
  const text = readText(readout.text);
  const source = READ_SOURCES[readout.source ?? "assistant"];
  const generation = readout.source === "report" ? ` (report ${readout.reportGeneration})` : "";
  const message = readout.reportFile
    ? `${source}${generation}:\n${reportFileText(readout.reportFile)}`
    : text === undefined
      ? "No assistant message yet."
      : `${source}${generation}${readout.truncated ? " (truncated)" : ""}:\n${text}`;
  return `${agentReadCard(readout.run, options)}\n${message}`;
};

const readBody = (result: AgentReadResult, options: AgentReadOptions): string =>
  [
    ...result.agents.map((readout) =>
      readout.kind === "main" ? mainReadSection(readout) : runReadSection(readout, options),
    ),
    missingText(result.missingIds),
  ]
    .filter(Boolean)
    .join("\n\n");

const readContract = (result: AgentReadResult): AgentReadContract => ({
  ...envelope(AGENT_TOOL_NAME.read),
  agents: result.agents.map((readout) => {
    const text = readText(readout.text);
    const reportFile = readout.kind === "run" ? projectReportFile(readout.reportFile) : undefined;
    const fields = {
      id: readout.id,
      name: agentName(readout),
      textStatus: text === undefined ? ("none" as const) : ("text" as const),
      truncated: readout.truncated,
      ...(text !== undefined && { text }),
    };
    return readout.kind === "main"
      ? { kind: "main", state: readout.state, ...fields }
      : {
          kind: "run",
          state: readout.state,
          ...fields,
          ...(readout.source !== undefined &&
            (text !== undefined || reportFile !== undefined) && { source: readout.source }),
          ...(reportFile !== undefined && { reportFile }),
          reportGeneration: readout.reportGeneration,
          status: withheldTarget(readout.run),
        };
  }),
  missingIds: [...result.missingIds],
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

const readIssues = (run: SubagentRunView): ReadonlyArray<CompactIssue> => {
  const { finalText: _finalText, ...card } = projectSubagentRunCard(run);
  return compactRunIssues([card]).slice(0, MAX_AGENT_READ_ISSUES).map(boundedReadIssue);
};

const readDetails = (result: AgentReadResult): AgentToolDetails => ({
  version: AGENT_DETAILS_VERSION,
  action: AGENT_TOOL_NAME.read,
  agents: result.agents.map((readout) => {
    const hasText = readText(readout.text) !== undefined;
    const hasReportFile = readout.kind === "run" && readout.reportFile !== undefined;
    const issues = readout.kind === "run" ? readIssues(readout.run) : [];
    return {
      id: readout.id,
      name: agentName(readout),
      state: readout.state,
      textStatus: hasText ? "text" : "none",
      truncated: readout.truncated,
      ...(readout.kind === "run" &&
        (hasText || hasReportFile) &&
        readout.source !== undefined && { source: readout.source }),
      ...(issues.length > 0 && { issues: [...issues] }),
    };
  }),
  missingIds: [...result.missingIds],
});

const codedRefusal = (error: InvalidSubagentRequestError): InvalidSubagentRequestError =>
  error.code !== undefined && !error.message.startsWith(`[${error.code}]`)
    ? invalidRequest(error.code, `[${error.code}] ${error.message}`)
    : error;

/** Failures carry their code in the text, the only part of a thrown tool error Pi keeps. */
const codedFailure = (error: SubagentError): SubagentError => {
  if (Predicate.isTagged(error, "InvalidSubagentRequestError")) return codedRefusal(error);
  if (
    Predicate.isTagged(error, "SubagentProcessError") &&
    error.code !== undefined &&
    !error.message.startsWith(`[${error.code}]`)
  )
    return new SubagentProcessError({
      operation: error.operation,
      code: error.code,
      message: `[${error.code}] ${error.message}`,
      ...(error.pendingDelivery !== undefined && { pendingDelivery: error.pendingDelivery }),
    });
  return error;
};

/** Scripts can't send agent messages; each agent refuses its own scripted sends. */
export const scriptedAgentSendRefusal = (): InvalidSubagentRequestError =>
  codedRefusal(
    invalidRequest(
      "scripted_agent_send_not_supported",
      "Codemode scripts can't send agent messages. End the script and send the message with agent_send directly.",
    ),
  );

/**
 * Runs `agent_list`, `agent_read`, or `agent_send` for an authenticated caller, whose cwd decides
 * when a status card names a run's own cwd. List and read results carry structured contracts for
 * scripts; scripts can't send.
 */
export const executeAgentActionEffect = (
  input: AgentToolInput,
  caller: AgentCaller,
  scripted = false,
  callerCwd?: string,
): Effect.Effect<AgentToolResult<unknown>, SubagentError, SubagentService> =>
  Effect.gen(function* () {
    const service = yield* SubagentService;
    switch (input.tool) {
      case AGENT_TOOL_NAME.list: {
        const result = yield* service.agentList(caller, input.args.agentIds);
        return {
          content: [{ type: "text", text: boundToolOutput(listText(result)) }],
          details: listDetails(result),
          structuredContent: encodeSubagentContract(listContract(result)),
        } satisfies AgentToolResult<unknown>;
      }
      case AGENT_TOOL_NAME.send: {
        if (scripted) return yield* scriptedAgentSendRefusal();
        const result = yield* service.agentSend(caller, input.args.to, input.args.message);
        return {
          content: [{ type: "text", text: sendText(result) }],
          details: sendDetails(result),
        } satisfies AgentToolResult<unknown>;
      }
      case AGENT_TOOL_NAME.read: {
        const result = yield* service.agentRead(caller, input.args.agentIds);
        const options = { caller, parentCwd: callerCwd, verbose: input.args.verbose === true };
        return {
          content: [{ type: "text", text: boundToolOutput(readBody(result, options)) }],
          details: readDetails(result),
          structuredContent: encodeSubagentContract(readContract(result)),
        } satisfies AgentToolResult<unknown>;
      }
    }
    return absurd<never>(input);
  }).pipe(Effect.mapError(codedFailure));
