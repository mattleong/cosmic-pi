import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Str from "effect/String";
import type { CompactIssue } from "pi-code-previews";
import { agentMessageDeliveryText } from "pi-cosmic-core/host-agent-messages";
import { clipText } from "pi-cosmic-core/display";
import { MESSAGE_TEXT_LIMIT } from "pi-cosmic-core/message-text";
import { sanitizeTerminalLine, stripTerminalControls } from "pi-cosmic-core/security";
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
  codedFailure,
  codedRefusal,
  invalidRequest,
  type InvalidSubagentRequestError,
  type SubagentError,
} from "../run/errors.ts";
import {
  isTerminalRunState,
  SUBAGENT_ROOT_RUN_ID,
  type SubagentRunView,
  type SubagentWorkspaceOutcome,
} from "../run/model.ts";
import { MAX_TOOL_OUTPUT_CHARS } from "../run/limits.ts";
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
import { envelope, metadata, projectAttention, projectName, readStatusTarget } from "./contract.ts";
import { compactRunIssues } from "./compact-run-issues.ts";
import { projectReportFile, projectSubagentRunCard } from "./details-projection.ts";
import {
  AGENT_DETAILS_VERSION,
  MAX_AGENT_READ_ISSUE_TEXT_CHARS,
  MAX_AGENT_READ_ISSUES,
  type AgentToolDetails,
} from "./details-schema.ts";
import {
  boundToolOutput,
  formatRunCard,
  formatRunModel,
  proposalGuidance,
  type RunFormatOptions,
} from "./format.ts";
import { pendingDeliveryEvidence } from "./outcome.ts";
import type { AgentToolInput } from "./schema.ts";
import { isTextFragment } from "./text-fragments.ts";

const agentName = (entry: { readonly name: string }): string => projectName(entry.name) || "agent";

const agentLabel = (entry: { readonly id: string; readonly name: string }): string =>
  entry.id === MAIN_AGENT_ID
    ? "the main agent"
    : `${sanitizeTerminalLine(entry.id)} ${JSON.stringify(agentName(entry))}`;

const missingText = (missingIds: ReadonlyArray<string>): string =>
  missingIds.length === 0
    ? ""
    : `Not in this session: ${Fn.pipe(missingIds, Arr.map(sanitizeTerminalLine), Arr.join(", "))}. Call agent_list without agentIds for current agent IDs.`;

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
  const facts = Arr.filter(
    [
      entry.state,
      Fn.pipe([role, model], Arr.filter(isTextFragment), Arr.join(" on ")),
      entry.run?.writeIntent === "writer" && entry.run.workspaceId === undefined && "writer",
      agentWorktreeFact(entry.run),
      agentAttentionFact(entry.run),
      entry.parentId && `child of ${sanitizeTerminalLine(entry.parentId)}`,
      entry.self && "you",
    ],
    isTextFragment,
  );
  const task = entry.task
    ? `\n${Fn.pipe("  ", Str.repeat(entry.depth ?? 1))}Task: ${sanitizeTerminalLine(entry.task)}`
    : "";
  return `${Fn.pipe("  ", Str.repeat(Math.max(0, (entry.depth ?? 1) - 1)))}- ${agentLabel(entry)}: ${Arr.join(facts, ", ")}${task}`;
};

const listText = (result: AgentListResult): string =>
  Fn.pipe(
    [
      result.agents.length === 0
        ? "No matching agents."
        : `Agents in this session (${result.agents.length}):\n${Fn.pipe(result.agents, Arr.map(listLine), Arr.join("\n"))}`,
      missingText(result.missingIds),
    ],
    Arr.filter(Boolean),
    Arr.join("\n\n"),
  );

const knownProfile = (profile: string | undefined) =>
  Option.getOrUndefined(Arr.findFirst(PROFILE_IDS, (id) => id === profile));

const WORKTREE_STATUS = {
  proposal: "proposal",
  integrated: "applied",
  discarded: "discarded",
  "auto-discarded": "discarded",
} as const satisfies Record<SubagentWorkspaceOutcome["status"], string>;

const listContract = (result: AgentListResult): AgentListContract => ({
  ...envelope(AGENT_TOOL_NAME.list),
  agents: Arr.map(result.agents, (entry) => {
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
    states: Arr.map([...counts], ([state, count]) => ({ state, count })),
    ...(result.agents.length === 1 && only && { only: { id: only.id, name: agentName(only) } }),
    missingIds: [...result.missingIds],
  };
};

const guidedText = (result: AgentSendResult, label: string): string => {
  if (result.mainState !== undefined)
    return agentMessageDeliveryText(result.mainState, "The main agent");
  const sent = result.confirmed
    ? `Delivered your message to ${label} as guidance for its current work.`
    : `Sent your message to ${label} as guidance; ${Str.toLowerCase(pendingDeliveryEvidence.message)}. ${pendingDeliveryEvidence.detail}`;
  return result.parked
    ? `${sent} It is waiting on an answer to its own question, which only its ancestors can give, so it sees your message once one of them answers.`
    : sent;
};

const sendText = (result: AgentSendResult): string => {
  const label = agentLabel({ id: result.to, name: result.name });
  switch (result.disposition) {
    case "answered":
      return `Answered ${label}'s pending question with your message.`;
    case "guided":
      return guidedText(result, label);
    case "resumed":
      return `Resumed ${label} with your message as its next assignment. Its report goes to its own parent.`;
  }
  return Fn.absurd(result.disposition);
};

const sendDetails = (result: AgentSendResult): AgentToolDetails => ({
  version: AGENT_DETAILS_VERSION,
  action: AGENT_TOOL_NAME.send,
  to: result.to,
  name: agentName(result),
  disposition: result.disposition,
  confirmed: result.confirmed,
  ...(result.mainState !== undefined && { mainState: result.mainState }),
  ...(result.parked && { parked: true }),
});

const readText = (text: string | undefined): string | undefined => {
  const cleaned = text === undefined ? "" : stripTerminalControls(text);
  return Str.trim(cleaned) ? cleaned : undefined;
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

/** A run's status card, with its parent's next steps when the reader is that parent. */
export const agentReadCard = (
  run: SubagentRunView,
  { caller, ...options }: AgentReadOptions,
): string => formatRunCard(run, { ...options, readerIsParent: isParentOf(caller, run) });

/** The heading before a read's message, such as `Report (report 3) (truncated):`. */
const MAX_READ_HEADING_CHARS = 64;

/** A read section, and the retained copy of a saved report that may follow it. */
interface ReadSection {
  readonly text: string;
  readonly retained?: string | undefined;
}

/**
 * A run's status card, then its latest message, its report's file and retained copy, or its
 * unsaved report. The card fits whole, and so does a retained report beside it; a latest message
 * or error too long for the rest of one tool result is cut.
 */
const runReadSection = (
  readout: Extract<AgentReadout, { readonly kind: "run" }>,
  options: AgentReadOptions,
): ReadSection => {
  const card = agentReadCard(readout.run, options);
  const text = readText(readout.text);
  const source = READ_SOURCES[readout.source ?? "assistant"];
  const generation = readout.source === "report" ? ` (report ${readout.reportGeneration})` : "";
  if (readout.reportFile)
    return {
      text: `${card}\n${source}${generation}:\n${reportFileText(readout.reportFile)}`,
      ...(text !== undefined && {
        retained: `Retained copy${readout.truncated ? " (truncated; the file has the whole report)" : ""}:\n${text}`,
      }),
    };
  if (text === undefined) return { text: `${card}\nNo assistant message yet.` };
  const shown = clipText(text, MAX_TOOL_OUTPUT_CHARS - card.length - MAX_READ_HEADING_CHARS);
  const truncated = readout.truncated || shown !== text;
  return { text: `${card}\n${source}${generation}${truncated ? " (truncated)" : ""}:\n${shown}` };
};

/**
 * Every section, then the retained copies of saved reports beside their files in what the result
 * has left, smallest first; one run's always fits.
 */
const readBody = (result: AgentReadResult, options: AgentReadOptions): string => {
  const sections: ReadonlyArray<ReadSection> = Arr.filter(
    [
      ...Arr.map(result.agents, (readout) =>
        readout.kind === "main"
          ? { text: mainReadSection(readout) }
          : runReadSection(readout, options),
      ),
      { text: missingText(result.missingIds) },
    ],
    (section) => Str.isNonEmpty(section.text),
  );
  let room =
    MAX_TOOL_OUTPUT_CHARS -
    Fn.pipe(
      sections,
      Arr.map((section) => section.text),
      Arr.join("\n\n"),
    ).length;
  const shown = new Map<ReadSection, string>();
  for (const section of Arr.sortWith(
    sections,
    (candidate) => candidate.retained?.length ?? 0,
    Order.Number,
  )) {
    if (section.retained === undefined) continue;
    if (section.retained.length + 1 > room) break;
    room -= section.retained.length + 1;
    shown.set(section, section.retained);
  }
  return Fn.pipe(
    sections,
    Arr.map((section) => {
      const retained = shown.get(section);
      return retained === undefined ? section.text : `${section.text}\n${retained}`;
    }),
    Arr.join("\n\n"),
  );
};

const readContract = (result: AgentReadResult): AgentReadContract => ({
  ...envelope(AGENT_TOOL_NAME.read),
  agents: Arr.map(result.agents, (readout) => {
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
          status: readStatusTarget(readout.run),
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
  return Arr.map(compactRunIssues([card]).slice(0, MAX_AGENT_READ_ISSUES), boundedReadIssue);
};

const readDetails = (result: AgentReadResult): AgentToolDetails => ({
  version: AGENT_DETAILS_VERSION,
  action: AGENT_TOOL_NAME.read,
  agents: Arr.map(result.agents, (readout) => {
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
export const executeAgentActionEffect = Effect.fn("SubagentTools.agents")(function* (
  input: AgentToolInput,
  caller: AgentCaller,
  scripted = false,
  callerCwd?: string,
): Effect.fn.Return<AgentToolResult<unknown>, SubagentError, SubagentService> {
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
  return Fn.absurd<never>(input);
}, Effect.mapError(codedFailure));
