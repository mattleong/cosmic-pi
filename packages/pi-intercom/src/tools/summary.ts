import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import * as Option from "effect/Option";
import type { CompactIssue, CompactSummary, CompactSummaryProvider } from "pi-code-previews";
import { clipText, countLabel, sanitizeTerminalLine, stripTerminalControls } from "pi-cosmic-core";
import {
  decodeSessionToolDetails,
  SESSION_TOOL,
  type SessionRefusal,
  type SessionToolArgs,
  type SessionToolDetails,
  type SessionView,
  type ToolRefusalCode,
} from "./contract.ts";
import { refusalText, sendText } from "./text.ts";

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

/** The issue a refusal shows; the agent's procedure stays in the expanded detail. */
export const refusalIssue = (refusal: SessionRefusal): CompactIssue => ({
  severity: "error",
  code: `${refusal.tool}:${refusal.code}`,
  message: REFUSAL_MESSAGES[refusal.code],
  detail: refusalText(refusal),
});

export const uncertainIssue = (
  details: Extract<SessionToolDetails, { readonly outcome: "uncertain" }>,
): CompactIssue => ({
  severity: "warning",
  code: `${details.tool}:delivery_uncertain`,
  message: "The message may not have arrived",
  detail: sendText(details),
});

const DISPOSITION_LABELS = { woken: "woke it", queued: "queued", held: "held" } as const;

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
    const count = details.sessions.filter((session) => session.state === state).length;
    return count > 0 ? [`${count} ${state}`] : [];
  };
  const duplicates = details.sessions.filter(({ duplicate }) => duplicate).length;
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
        details.state,
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
      issues: [uncertainIssue(details)],
    };
  return {
    action: "Sent message to",
    subject: sessionSubject(details.session),
    metadata: [DISPOSITION_LABELS[details.disposition]],
    outcome: "success",
  };
};

const DISPOSITION_SENTENCES = {
  woken: "it started a turn to read it",
  queued: "it reads it when its current turn ends",
  held: "it's holding messages until its user's next prompt",
} as const;

const MAX_COLLAPSED_LINES = 6;

/** The user-facing body of a collapsed preview row; empty when the issues say it all. */
export const collapsedResultText = (details: SessionToolDetails): string => {
  if (details.tool === SESSION_TOOL.list)
    return details.sessions
      .slice(0, MAX_COLLAPSED_LINES)
      .map(
        (session) =>
          `${sessionSubject(session)} · ${sanitizeTerminalLine(session.cwd)} · ${session.state}`,
      )
      .join("\n");
  if ("outcome" in details && details.outcome !== "delivered") return "";
  if (details.tool === SESSION_TOOL.read)
    return details.text === undefined
      ? "No reply yet"
      : stripTerminalControls(details.text).split("\n").slice(0, MAX_COLLAPSED_LINES).join("\n");
  return `Delivered to ${sessionSubject(details.session)}; ${DISPOSITION_SENTENCES[details.disposition]}`;
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
    if (phase !== "settled") return pending(tool, args.to);
    const details = sessionToolDetails(tool, result);
    return details ? settled(details) : undefined;
  };
