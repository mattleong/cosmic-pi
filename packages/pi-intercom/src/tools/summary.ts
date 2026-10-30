import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
import type { CompactIssue, CompactSummary, CompactSummaryProvider } from "pi-code-previews";
import { clipText, countLabel } from "pi-cosmic-core/display";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import { MAX_MESSAGE_CHARS } from "../transport/protocol.ts";
import {
  decodeSessionToolDetails,
  SESSION_TOOL,
  type SessionRefusal,
  type SessionToolArgs,
  type SessionToolDetails,
  type SessionView,
  type ToolRefusalCode,
} from "./contract.ts";

const MAX_SUBJECT_CHARS = 60;

/** The short name a heading shows for a session: its name, else its id. */
export const sessionSubject = (session: Pick<SessionView, "sessionId" | "name">): string => {
  const name = sanitizeTerminalLine(session.name ?? "");
  return clipText(name === "" ? sanitizeTerminalLine(session.sessionId) : name, MAX_SUBJECT_CHARS);
};

const REFUSAL_MESSAGES: Record<ToolRefusalCode, string> = {
  session_not_found: "No live session has this id",
  session_ambiguous: "Several live sessions share this id",
  session_unreachable: "The session couldn't be reached",
  session_unresponsive: "The session didn't answer in time",
  session_unavailable: "The session is shutting down",
  session_receive_disabled: "The session has turned off incoming messages",
  session_message_too_long: "The message is too long",
};

/** What the user learns from expanding a refusal; the agent's procedure stays in the result. */
const REFUSAL_DETAILS: Record<ToolRefusalCode, (id: string) => string> = {
  session_not_found: (id) =>
    `No other live session has id ${JSON.stringify(id)}; it may have exited.`,
  session_ambiguous: (id) =>
    `More than one live session has id ${JSON.stringify(id)}, so neither can be addressed until one closes.`,
  session_unreachable: () => "Nothing answered at its socket; it may have exited.",
  session_unresponsive: () => "It may be busy or stuck.",
  session_unavailable: () => "It is shutting down or being replaced.",
  session_receive_disabled: () =>
    "Its user turned off messages from other sessions with /intercom receive off.",
  session_message_too_long: () =>
    `Messages are limited to ${MAX_MESSAGE_CHARS.toLocaleString("en-US")} characters.`,
};

const NOTHING_SENT: ReadonlySet<ToolRefusalCode> = new Set([
  "session_unreachable",
  "session_unresponsive",
  "session_unavailable",
  "session_receive_disabled",
  "session_message_too_long",
]);

/** The issue a refusal shows; its detail explains it to the user, without the agent's procedure. */
export const refusalIssue = (refusal: SessionRefusal): CompactIssue => {
  const nothingSent = refusal.tool === SESSION_TOOL.send && NOTHING_SENT.has(refusal.code);
  return {
    severity: "error",
    code: `${refusal.tool}:${refusal.code}`,
    message: REFUSAL_MESSAGES[refusal.code],
    detail: `${REFUSAL_DETAILS[refusal.code](sanitizeTerminalLine(refusal.to))}${nothingSent ? " Nothing was sent." : ""}`,
  };
};

const UNCERTAIN_DETAILS: Record<
  Extract<SessionToolDetails, { readonly outcome: "uncertain" }>["reason"],
  string
> = {
  timeout: "The session didn't answer in time",
  disconnected: "The connection ended before the session answered",
  protocol: "The session's answer couldn't be read",
};

export const uncertainIssue = (
  details: Extract<SessionToolDetails, { readonly outcome: "uncertain" }>,
): CompactIssue => ({
  severity: "warning",
  code: `${details.tool}:delivery_uncertain`,
  message: "The message may not have arrived",
  detail: `${UNCERTAIN_DETAILS[details.reason]}, so it may or may not have received the message.`,
});

/** Delivery worth a word: a woken session reading the message at once is the plain case. */
export const DISPOSITION_WORDS = { woken: "", queued: "queued", held: "holding" } as const;

const targetSubject = (to: string | undefined): string =>
  clipText(sanitizeTerminalLine(to ?? ""), MAX_SUBJECT_CHARS);

const pending = (tool: string, to: string | undefined): CompactSummary => {
  if (tool === SESSION_TOOL.list) return { action: "Listing", subject: "sessions" };
  if (tool === SESSION_TOOL.send)
    return { action: "Sending message to", subject: targetSubject(to) };
  return { action: "Reading", subject: `${targetSubject(to)}'s last message` };
};

const listSummary = (
  details: Extract<SessionToolDetails, { readonly tool: "session_list" }>,
): CompactSummary => {
  const total = details.sessions.length + details.omitted;
  const counted = (state: "unavailable" | "unresponsive" | "unreachable") => {
    const count = Arr.filter(details.sessions, (session) => session.state === state).length;
    return count > 0 ? [`${count} ${state}`] : [];
  };
  const duplicates = Arr.filter(details.sessions, ({ duplicate }) => duplicate).length;
  return {
    action: "Listed",
    subject: countLabel(total, "session"),
    counters: [...counted("unavailable"), ...counted("unresponsive"), ...counted("unreachable")],
    metadata: duplicates > 0 ? [countLabel(duplicates, "duplicate id")] : [],
    outcome: "success",
  };
};

const refusedSummary = (details: SessionRefusal): CompactSummary => {
  const subject = details.session ? sessionSubject(details.session) : targetSubject(details.to);
  const issues = [refusalIssue(details)];
  return details.tool === SESSION_TOOL.send
    ? { action: "Couldn't send message to", subject, outcome: "error", issues }
    : { action: "Couldn't read", subject: `${subject}'s last message`, outcome: "error", issues };
};

const settled = (details: SessionToolDetails): CompactSummary => {
  if (details.tool === SESSION_TOOL.list) return listSummary(details);
  if ("outcome" in details && details.outcome === "refused") return refusedSummary(details);
  if (details.tool === SESSION_TOOL.read)
    return {
      action: "Read",
      subject: `${sessionSubject(details.session)}'s last message`,
      metadata: [
        ...(details.state === "busy" ? ["busy"] : []),
        ...(details.text === undefined ? ["no reply yet"] : []),
        ...(details.truncated ? ["truncated"] : []),
      ],
      outcome: "success",
    };
  if (details.outcome === "uncertain")
    return {
      action: "Sent message to",
      subject: sessionSubject(details.session),
      outcome: "uncertain",
      messageIcon: "sent",
      issues: [uncertainIssue(details)],
    };
  return {
    action: "Sent message to",
    subject: sessionSubject(details.session),
    metadata: Arr.filter([DISPOSITION_WORDS[details.disposition]], Str.isNonEmpty),
    outcome: "success",
    messageIcon: "sent",
  };
};

/** Decodes a result's details when they belong to `tool`. */
export const sessionToolDetails = (
  tool: string,
  result: AgentToolResult<unknown> | undefined,
): SessionToolDetails | undefined =>
  Option.getOrUndefined(
    decodeSessionToolDetails(result?.details).pipe(
      Option.filter((details) => details.tool === tool),
    ),
  );

export const sessionToolCompactSummary =
  (tool: string): CompactSummaryProvider<SessionToolArgs> =>
  ({ phase, args, result }) => {
    // The words a send carries, shown beneath its collapsed compact row.
    const words =
      tool === SESSION_TOOL.send &&
      Predicate.isString(args.message) &&
      Str.isNonEmpty(Str.trim(args.message))
        ? { quote: args.message }
        : {};
    if (phase !== "settled") return { ...pending(tool, args.to), ...words };
    const details = sessionToolDetails(tool, result);
    return details ? { ...settled(details), ...words } : undefined;
  };
