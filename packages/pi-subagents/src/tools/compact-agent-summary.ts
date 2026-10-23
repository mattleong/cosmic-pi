import * as Fn from "effect/Function";
import {
  getTextContent,
  type CompactIssue,
  type CompactSummary,
  type CompactSummaryProvider,
} from "pi-code-previews";
import * as Schema from "effect/Schema";
import {
  clipText,
  countLabel,
  decodeUnknownOrUndefined,
  sanitizeTerminalLine,
} from "pi-cosmic-core";
import { MAIN_AGENT_ID } from "../run/agent-messaging.ts";
import { SUBAGENT_RUN_STATES } from "../run/model.ts";
import { AGENT_TOOL_NAME, type AgentToolName } from "../run/tool-policy.ts";
import { runStateLabel } from "../ui/run-state.ts";
import { agentFailureIssues } from "./compact-action-failures.ts";
import { pendingDeliveryEvidence } from "./outcome.ts";
import { AgentToolDetailsSchema, type AgentToolDetails } from "./details-schema.ts";

export const decodeAgentToolDetails = decodeUnknownOrUndefined(AgentToolDetailsSchema, {
  onExcessProperty: "error",
});

// What a call's arguments show before the tool validated them, for headings and failures.
const AgentCallSchema = Schema.Struct({
  to: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  agentIds: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type AgentCallEvidence = typeof AgentCallSchema.Type;
export const decodeAgentCall = decodeUnknownOrUndefined(AgentCallSchema);

const displayName = (name: string): string => clipText(sanitizeTerminalLine(name), 60);

const stateLabel = (state: string): string => {
  const runState = SUBAGENT_RUN_STATES.find((known) => known === state);
  return runState === undefined ? state : runStateLabel(runState);
};

// Before a result names a run, only the main agent has a readable subject.
const isMain = (id: string | undefined): boolean => id?.trim() === MAIN_AGENT_ID;

const requestedIds = (args: AgentCallEvidence): ReadonlyArray<string> =>
  (args.agentIds ?? []).map((id) => id.trim()).filter(Boolean);

const missingIssue = (missingIds: ReadonlyArray<string>): CompactIssue[] =>
  missingIds.length === 0
    ? []
    : [
        {
          severity: "warning",
          code: "agents-missing",
          message:
            missingIds.length === 1
              ? "A requested agent isn't in this session"
              : `${missingIds.length} requested agents aren't in this session`,
          detail: `Not found: ${missingIds.join(", ")}. Refresh agent IDs with agent_list.`,
        },
      ];

const settled = (summary: CompactSummary, issues: CompactIssue[]): CompactSummary => ({
  ...summary,
  outcome: issues.some((issue) => issue.severity === "warning") ? "warning" : "success",
  issues,
});

const summarizeList = (
  details: Extract<AgentToolDetails, { readonly action: "agent_list" }>,
): CompactSummary => {
  const states = details.states.map(({ state, count }) =>
    details.agentCount === 1 ? stateLabel(state) : `${count} ${stateLabel(state)}`,
  );
  return settled(
    {
      subject: details.only ? displayName(details.only.name) : "",
      counters: details.only ? states : [countLabel(details.agentCount, "agent")],
      metadata: details.only ? [] : [states.join(", ")].filter(Boolean),
    },
    missingIssue(details.missingIds),
  );
};

type SendDetails = Extract<AgentToolDetails, { readonly action: "agent_send" }>;

const MAIN_DELIVERIES: Record<NonNullable<SendDetails["mainState"]>, string> = {
  idle: "woke the main agent",
  busy: "queued for the main agent",
  held: "held for the user",
};

const sendCounter = (details: SendDetails): string => {
  switch (details.disposition) {
    case "answered":
      return "answered";
    case "resumed":
      return "resumed";
    case "guided":
      if (details.mainState !== undefined) return MAIN_DELIVERIES[details.mainState];
      if (!details.confirmed) return "awaiting delivery confirmation";
      return details.parked ? "waiting behind its question" : "delivered as guidance";
  }
  return Fn.absurd(details.disposition);
};

const sendIssues = (details: SendDetails): CompactIssue[] => [
  ...(details.confirmed
    ? []
    : [
        {
          severity: "warning" as const,
          code: "agent-message-pending",
          message: pendingDeliveryEvidence.message,
          detail: pendingDeliveryEvidence.detail,
        },
      ]),
  ...(details.mainState === "held"
    ? [
        {
          severity: "info" as const,
          code: "agent-message-held",
          message: "The main agent is waiting on the user",
          detail:
            "The message is in the main agent's conversation. It reaches the model when an open dialog closes, or after an interrupt, on the user's next prompt.",
        },
      ]
    : []),
];

const summarizeSend = (details: SendDetails): CompactSummary =>
  settled(
    {
      subject: details.to === MAIN_AGENT_ID ? "main" : displayName(details.name),
      counters: [sendCounter(details)],
    },
    sendIssues(details),
  );

const summarizeRead = (
  details: Extract<AgentToolDetails, { readonly action: "agent_read" }>,
): CompactSummary => {
  const [only] = details.agents;
  const single = details.agents.length === 1 && only !== undefined;
  // A saved report's readout carries its file, not text.
  const empty = details.agents.filter(
    (agent) => agent.textStatus === "none" && agent.source !== "report",
  ).length;
  const truncated = details.agents.filter((agent) => agent.truncated).length;
  // Each run's status card raises its own attention; reading it still succeeded.
  const statusIssues = details.agents.flatMap((agent) => agent.issues ?? []);
  return settled(
    {
      subject: single ? displayName(only.name) : "",
      counters: single ? [stateLabel(only.state)] : [countLabel(details.agents.length, "agent")],
      metadata: [
        ...(empty > 0 ? [single ? "no message yet" : `${empty} without a message`] : []),
        ...(truncated > 0 ? [single ? "truncated" : `${truncated} truncated`] : []),
        ...(single && only.source === "report" ? ["report"] : []),
        ...(single && only.source === "error" ? ["error"] : []),
      ],
    },
    [...statusIssues, ...missingIssue(details.missingIds)],
  );
};

const summarizeDetails = (details: AgentToolDetails): CompactSummary =>
  details.action === AGENT_TOOL_NAME.list
    ? summarizeList(details)
    : details.action === AGENT_TOOL_NAME.send
      ? summarizeSend(details)
      : summarizeRead(details);

const failureSubject = (tool: AgentToolName, args: AgentCallEvidence): string => {
  if (tool === AGENT_TOOL_NAME.send) return isMain(args.to) ? "The main agent" : "The agent";
  const ids = requestedIds(args);
  if (ids.length === 1) return ids[0] === MAIN_AGENT_ID ? "The main agent" : "The agent";
  return "The agents";
};

const argumentLanes = (tool: AgentToolName, args: AgentCallEvidence): CompactSummary => {
  if (tool === AGENT_TOOL_NAME.send)
    return { subject: isMain(args.to) ? "main" : "", counters: [] };
  const ids = requestedIds(args);
  return {
    subject: ids.length === 1 && ids[0] === MAIN_AGENT_ID ? "main" : "",
    counters: ids.length > 1 ? [countLabel(ids.length, "agent")] : [],
  };
};

/** Compact headings for `agent_*`: what was listed, where a message went, whose message was read. */
export const createAgentCompactSummary =
  (tool: AgentToolName): CompactSummaryProvider =>
  ({ phase, args, result, context }) => {
    const input = decodeAgentCall(args);
    if (!input) return undefined;
    const lanes = argumentLanes(tool, input);
    if (!result) return context.isError || phase === "settled" ? undefined : lanes;
    if (context.isError)
      return phase === "settled"
        ? {
            ...lanes,
            outcome: "error",
            issues: agentFailureIssues(
              getTextContent(result.content),
              tool === AGENT_TOOL_NAME.send
                ? "send"
                : tool === AGENT_TOOL_NAME.read
                  ? "read"
                  : "list",
              failureSubject(tool, input),
            ),
          }
        : undefined;
    const details = decodeAgentToolDetails(result.details);
    if (details?.action !== tool) return undefined;
    return summarizeDetails(details);
  };
