import { absurd } from "effect/Function";
import { agentMessageDeliveryText } from "pi-cosmic-core";
import type {
  SupervisorAgentListResult,
  SupervisorAgentReadResult,
  SupervisorAgentSendResult,
} from "./protocol.ts";

const sendOutcome = (result: SupervisorAgentSendResult): string => {
  switch (result.disposition) {
    case "answered":
      return "answered its pending question";
    case "resumed":
      return "resumed the finished run with this message as its assignment";
    case "guided": {
      const guided = result.confirmed
        ? "delivered as guidance to its current turn"
        : "sent as guidance; delivery confirmation is still pending and it may already have arrived";
      return result.parked
        ? `${guided}; it is waiting on an answer to its own question, which only its ancestors can give, and sees the message once one of them answers`
        : guided;
    }
  }
  return absurd(result.disposition);
};

const missing = (ids: ReadonlyArray<string>): ReadonlyArray<string> =>
  ids.length === 0 ? [] : [`Not found: ${ids.join(", ")}.`];

/** One line per agent: ID, name, state, role, model, worktree, attention, and parent. */
export const agentListText = (result: SupervisorAgentListResult): string =>
  [
    `${result.agents.length} ${result.agents.length === 1 ? "agent" : "agents"}:`,
    ...result.agents.map((entry) => {
      const role = entry.kind === "main" ? "main agent" : (entry.agent ?? entry.profile);
      const details = [
        entry.state,
        ...(role === undefined ? [] : [role]),
        ...(entry.model !== undefined
          ? [entry.model]
          : entry.runtime === undefined
            ? []
            : [`runtime ${entry.runtime}`]),
        ...(entry.worktree === undefined ? [] : [entry.worktree]),
        ...(entry.attention === undefined ? [] : [entry.attention]),
        ...(entry.parentId === undefined ? [] : [`child of ${entry.parentId}`]),
        ...(entry.self ? ["you"] : []),
      ];
      return `- ${entry.id} ${JSON.stringify(entry.name)}: ${details.join("; ")}`;
    }),
    ...missing(result.missingIds),
  ].join("\n");

export const agentReadText = (result: SupervisorAgentReadResult): string =>
  [
    ...result.agents.map((entry) => {
      const notes = [
        entry.state,
        ...(entry.source === undefined || entry.source === "assistant"
          ? []
          : [`from its ${entry.source}`]),
        ...(entry.truncated ? ["truncated"] : []),
      ];
      return [
        `## ${entry.id} ${JSON.stringify(entry.name)} (${notes.join("; ")})`,
        ...(entry.card === undefined ? [] : [entry.card]),
        entry.text ?? "No message yet.",
      ].join("\n");
    }),
    ...missing(result.missingIds),
  ].join("\n\n");

export const agentSendText = (result: SupervisorAgentSendResult): string =>
  [
    `Message ${result.messageId} to ${result.to} ${JSON.stringify(result.name)}: ${result.disposition}${
      result.mainState === undefined
        ? `, ${sendOutcome(result)}.`
        : `. ${agentMessageDeliveryText(result.mainState, "The main agent")}`
    }`,
    "Do not resend it; any reply arrives as a new message.",
  ].join("\n");
