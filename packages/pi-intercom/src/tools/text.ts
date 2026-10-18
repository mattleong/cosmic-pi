import { countLabel, formatBytes, sanitizeTerminalLine } from "pi-cosmic-core";
import { MAX_MESSAGE_CHARS, MAX_READ_BYTES } from "../transport/protocol.ts";
import type {
  ListedSession,
  SessionListContract,
  SessionReadContract,
  SessionRefusal,
  SessionSendDetails,
  SessionView,
  ToolRefusalCode,
} from "./contract.ts";

/** How the model and the user name a session: its name and id, or just its id. */
export const sessionLabel = (session: SessionView): string => {
  const id = sanitizeTerminalLine(session.sessionId);
  const name = session.name === undefined ? "" : sanitizeTerminalLine(session.name);
  return name ? `session ${JSON.stringify(name)} (${id})` : `session ${id}`;
};

const sentence = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

const listedLine = (session: ListedSession): string => {
  const name = session.name === undefined ? "" : sanitizeTerminalLine(session.name);
  return [
    `- ${sanitizeTerminalLine(session.sessionId)}`,
    name && ` ${JSON.stringify(name)}`,
    ` in ${sanitizeTerminalLine(session.cwd)}: ${session.state}`,
    session.duplicate ? " (duplicate id; can't be addressed)" : "",
  ].join("");
};

export const listText = (result: SessionListContract): string => {
  if (result.sessions.length === 0)
    return "No other live Pi sessions of this user are registered on this machine.";
  const total = result.sessions.length + result.omitted;
  return [
    `${countLabel(total, "other live session")}:`,
    ...result.sessions.map(listedLine),
    ...(result.omitted > 0 ? [`- and ${result.omitted} more`] : []),
    "Message one with session_send using its sessionId. An unresponsive session didn't answer in time and may be exiting.",
  ].join("\n");
};

const DISPOSITION_TEXT: Record<
  Extract<SessionSendDetails, { readonly outcome: "delivered" }>["disposition"],
  string
> = {
  woken: "It was idle and started a turn to read it.",
  queued: "It's busy and will read it when its current turn ends.",
  held: "It's holding messages after an interrupt, during a dialog, or after several messages, so it reads it once its user next prompts it or the dialog closes.",
};

const UNCERTAIN_TEXT: Record<
  Extract<SessionSendDetails, { readonly outcome: "uncertain" }>["reason"],
  string
> = {
  timeout: "the session didn't answer in time",
  disconnected: "the connection ended before the session answered",
  protocol: "the session's answer couldn't be read",
};

export const sendText = (result: SessionSendDetails): string =>
  result.outcome === "delivered"
    ? `Delivered to ${sessionLabel(result.session)}. ${DISPOSITION_TEXT[result.disposition]} A reply, if any, arrives as a message from that session; don't wait for it in a loop.`
    : `The message to ${sessionLabel(result.session)} may or may not have been delivered: ${UNCERTAIN_TEXT[result.reason]}. Don't resend it. Use session_read later to see whether the session responded.`;

export const readText = (result: SessionReadContract): string => {
  const label = sentence(sessionLabel(result.session));
  if (result.text === undefined) return `${label} is ${result.state} and has no reply yet.`;
  const cut = result.truncated ? ` (cut to the first ${formatBytes(MAX_READ_BYTES)})` : "";
  return `${label} is ${result.state}. Its latest assistant message${cut}:\n\n${result.text}`;
};

const REFUSAL_TEXT: Record<ToolRefusalCode, (to: string, id: string) => string> = {
  session_not_found: (_to, id) =>
    `No other live session has id ${JSON.stringify(id)}. Use session_list to see the sessions you can reach.`,
  session_ambiguous: (_to, id) =>
    `More than one live session has id ${JSON.stringify(id)}, so it can't be addressed. Ask the user to close the duplicate.`,
  session_unreachable: (to) => `Couldn't reach ${to}; it may have exited. Nothing was delivered.`,
  session_unavailable: (to) => `${to} is shutting down or being replaced. Nothing was delivered.`,
  session_receive_disabled: (to) =>
    `${to} has turned off messages from other sessions. Nothing was delivered.`,
  session_message_too_long: () =>
    `The message is longer than ${MAX_MESSAGE_CHARS} characters. Shorten it and send again.`,
};

export const refusalText = (refusal: SessionRefusal): string => {
  const id = sanitizeTerminalLine(refusal.to);
  const label = refusal.session ? sessionLabel(refusal.session) : `session ${id}`;
  return sentence(REFUSAL_TEXT[refusal.code](label, id));
};
