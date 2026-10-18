import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { absurd } from "effect/Function";
import * as Predicate from "effect/Predicate";
import { sanitizeTerminalLine, stripTerminalControls } from "pi-cosmic-core";
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
  type InvalidSubagentRequestError,
  type SubagentError,
} from "../run/errors.ts";
import { SubagentService } from "../run/service.ts";
import { AGENT_TOOL_NAME } from "../run/tool-policy.ts";
import {
  encodeSubagentContract,
  MAX_CONTRACT_TASK_CHARS,
  type AgentListContract,
  type AgentReadContract,
} from "./contract-schema.ts";
import { envelope, metadata, projectName } from "./contract.ts";
import type { AgentToolDetails } from "./details-schema.ts";
import { boundToolOutput } from "./format.ts";
import type { AgentToolInput } from "./schema.ts";

const AGENT_DETAILS_VERSION = 1;

const agentName = (entry: { readonly name: string }): string => projectName(entry.name) || "agent";

const agentLabel = (entry: { readonly id: string; readonly name: string }): string =>
  entry.id === MAIN_AGENT_ID
    ? "the main agent"
    : `${sanitizeTerminalLine(entry.id)} ${JSON.stringify(agentName(entry))}`;

const missingText = (missingIds: ReadonlyArray<string>): string =>
  missingIds.length === 0
    ? ""
    : `Not in this session: ${missingIds.map(sanitizeTerminalLine).join(", ")}. Call agent_list without agentIds for current agent IDs.`;

// Lists parents before children, indented by depth.
const listLine = (entry: AgentListEntry): string => {
  if (entry.kind === "main")
    return `- ${MAIN_AGENT_ID}: ${entry.state}${entry.self ? " (you)" : ""}`;
  const role = entry.agent ?? entry.profile;
  const facts = [
    entry.state,
    [role, entry.runtime && `local/${entry.runtime}`].filter(Boolean).join(" on "),
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

const listContract = (result: AgentListResult): AgentListContract => ({
  ...envelope(AGENT_TOOL_NAME.list),
  agents: result.agents.map((entry) => {
    const profile = knownProfile(entry.profile);
    const task = metadata(entry.task, MAX_CONTRACT_TASK_CHARS);
    return {
      id: entry.id,
      name: agentName(entry),
      kind: entry.kind,
      state: entry.state,
      ...(entry.parentId !== undefined && { parentId: entry.parentId }),
      ...(entry.depth !== undefined && { depth: entry.depth }),
      ...(entry.runtime !== undefined && { runtime: entry.runtime }),
      ...(profile !== undefined && { profile }),
      ...(entry.agent !== undefined && isCustomAgentName(entry.agent) && { agent: entry.agent }),
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
  resumed: (label) =>
    `Resumed ${label} with your message as its next assignment. Its report goes to its own parent.`,
  woken: () => "The main agent was idle; your message started its turn.",
  queued: () => "The main agent is busy; it sees your message before its current turn ends.",
  held: () =>
    "The main agent holds agent messages until the user's next prompt; your message waits in its conversation.",
};

const sendText = (result: AgentSendResult): string =>
  result.wakeBudgetExhausted
    ? "Agent messages already woke the main agent as often as allowed until the user's next prompt; your message waits in its conversation."
    : SEND_TEXT[result.disposition](agentLabel({ id: result.to, name: result.name }));

const sendDetails = (result: AgentSendResult): AgentToolDetails => ({
  version: AGENT_DETAILS_VERSION,
  action: AGENT_TOOL_NAME.send,
  to: result.to,
  name: agentName(result),
  disposition: result.disposition,
  ...(result.wakeBudgetExhausted && { wakeBudgetExhausted: true as const }),
});

const readText = (text: string | undefined): string | undefined => {
  const cleaned = text === undefined ? "" : stripTerminalControls(text);
  return cleaned.trim() ? cleaned : undefined;
};

const READ_SOURCES = {
  assistant: "latest assistant message",
  report: "report",
  error: "error",
} as const;

const readSection = (readout: AgentReadout): string => {
  const text = readText(readout.text);
  const facts =
    readout.kind === "main"
      ? readout.state
      : [readout.state, readout.reportGeneration > 0 && `report ${readout.reportGeneration}`]
          .filter(Boolean)
          .join(", ");
  const heading = `${readout.kind === "main" ? MAIN_AGENT_ID : agentLabel(readout)} (${facts})`;
  if (readout.kind === "main" && readout.state === "unavailable")
    return `${heading}: the session that owned the main agent was replaced, so it can't be read.`;
  if (text === undefined) return `${heading}: no assistant message yet.`;
  const source =
    readout.kind === "main" ? READ_SOURCES.assistant : READ_SOURCES[readout.source ?? "assistant"];
  return `${heading}, ${source}${readout.truncated ? " (truncated)" : ""}:\n${text}`;
};

const readBody = (result: AgentReadResult): string =>
  [...result.agents.map(readSection), missingText(result.missingIds)].filter(Boolean).join("\n\n");

const readContract = (result: AgentReadResult): AgentReadContract => ({
  ...envelope(AGENT_TOOL_NAME.read),
  agents: result.agents.map((readout) => {
    const text = readText(readout.text);
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
          ...(readout.source !== undefined && text !== undefined && { source: readout.source }),
          reportGeneration: readout.reportGeneration,
        };
  }),
  missingIds: [...result.missingIds],
});

const readDetails = (result: AgentReadResult): AgentToolDetails => ({
  version: AGENT_DETAILS_VERSION,
  action: AGENT_TOOL_NAME.read,
  agents: result.agents.map((readout) => {
    const hasText = readText(readout.text) !== undefined;
    return {
      id: readout.id,
      name: agentName(readout),
      state: readout.state,
      textStatus: hasText ? "text" : "none",
      truncated: readout.truncated,
      ...(readout.kind === "run" &&
        hasText &&
        readout.source !== undefined && { source: readout.source }),
    };
  }),
  missingIds: [...result.missingIds],
});

const codedRefusal = (error: InvalidSubagentRequestError): InvalidSubagentRequestError =>
  error.code !== undefined && !error.message.startsWith(`[${error.code}]`)
    ? invalidRequest(error.code, `[${error.code}] ${error.message}`)
    : error;

/** Refusals carry their code in the text, the only part of a thrown tool error Pi keeps. */
const codedFailure = (error: SubagentError): SubagentError =>
  Predicate.isTagged(error, "InvalidSubagentRequestError") ? codedRefusal(error) : error;

/** Scripts can't send agent messages; each agent refuses its own scripted sends. */
export const scriptedAgentSendRefusal = (): InvalidSubagentRequestError =>
  codedRefusal(
    invalidRequest(
      "scripted_agent_send_not_supported",
      "Codemode scripts can't send agent messages. End the script and send the message with agent_send directly.",
    ),
  );

/**
 * Runs an `agent_*` tool for an authenticated caller. List and read results carry structured
 * contracts for scripts; scripts can't send.
 */
export const executeAgentActionEffect = (
  input: AgentToolInput,
  caller: AgentCaller,
  scripted = false,
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
        return {
          content: [{ type: "text", text: boundToolOutput(readBody(result)) }],
          details: readDetails(result),
          structuredContent: encodeSubagentContract(readContract(result)),
        } satisfies AgentToolResult<unknown>;
      }
    }
    return absurd<never>(input);
  }).pipe(Effect.mapError(codedFailure));
