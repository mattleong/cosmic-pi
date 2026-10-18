import type {
  SupervisorAgentListResult,
  SupervisorAgentReadResult,
  SupervisorAgentSendResult,
} from "./protocol.ts";

const DISPOSITIONS: Record<SupervisorAgentSendResult["disposition"], string> = {
  answered: "answered its pending question",
  guided: "delivered as guidance to its current turn",
  resumed: "resumed the finished run with this message as its assignment",
  woken: "started a new turn for the idle main agent",
  queued: "appended for the busy main agent to read before its turn ends",
  held: "held for the main agent until its user's next prompt",
};

const missing = (ids: ReadonlyArray<string>): ReadonlyArray<string> =>
  ids.length === 0 ? [] : [`Not found: ${ids.join(", ")}.`];

/** One line per agent: ID, name, state, role, runtime, and parent. */
export const agentListText = (result: SupervisorAgentListResult): string =>
  [
    `${result.agents.length} ${result.agents.length === 1 ? "agent" : "agents"}:`,
    ...result.agents.map((entry) => {
      const role = entry.kind === "main" ? "main agent" : (entry.agent ?? entry.profile);
      const details = [
        entry.state,
        ...(role === undefined ? [] : [role]),
        ...(entry.runtime === undefined ? [] : [`runtime ${entry.runtime}`]),
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
        entry.text ?? "No message yet.",
      ].join("\n");
    }),
    ...missing(result.missingIds),
  ].join("\n\n");

export const agentSendText = (result: SupervisorAgentSendResult): string =>
  [
    `Message ${result.messageId} to ${result.to} ${JSON.stringify(result.name)}: ${result.disposition}, ${DISPOSITIONS[result.disposition]}.`,
    ...(result.wakeBudgetExhausted
      ? ["The main agent's wake budget is spent until the user's next prompt."]
      : []),
    "Do not resend it; any reply arrives as a new message.",
  ].join("\n");
