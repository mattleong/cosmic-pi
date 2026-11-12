import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Str from "effect/String";
import type { CompactIssue, CompactSummary, CompactSummaryProvider } from "pi-code-previews";
import { countLabel, formatCount } from "pi-cosmic-core/display";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import { MAX_MESSAGE_CHARS } from "../transport/protocol.ts";
import {
  decodeSessionToolDetails,
  SESSION_TOOL,
  type SessionRefusal,
  type SessionToolArgs,
  type SessionToolDetails,
  type ToolRefusalCode,
} from "./contract.ts";
import {
  addresseeSubject,
  knownAddresseeSubject,
  SESSION_STATE_LABELS,
  sessionSubject,
  type SessionNames,
} from "../identity.ts";
import { joinInline } from "pi-cosmic-ui/manager";
import { UNCERTAIN_TEXT } from "./text.ts";

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
    `Messages are limited to ${formatCount(MAX_MESSAGE_CHARS)} characters.`,
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

export const uncertainIssue = (
  details: Extract<SessionToolDetails, { readonly outcome: "uncertain" }>,
): CompactIssue => ({
  severity: "warning",
  code: `${details.tool}:delivery_uncertain`,
  message: "The message may not have arrived",
  detail: `${Str.capitalize(UNCERTAIN_TEXT[details.reason])}, so it may or may not have received the message. Look for it in that session before sending it again.`,
});

/** Delivery worth a word: a woken session reading the message at once is the plain case. */
export const DISPOSITION_WORDS = { woken: "", queued: "queued", held: "held" } as const;

const pending = (
  tool: string,
  to: string | undefined,
  names: SessionNames | undefined,
  sending: boolean,
): CompactSummary => {
  // Until it settles, expansion shows only a send's message.
  if (tool === SESSION_TOOL.list) return { subject: "sessions", expandLabel: false };
  return { subject: knownAddresseeSubject(to, names), expandLabel: sending ? "message" : false };
};

/** What an empty listing says, in a compact heading and a preview body alike. */
export const NO_OTHER_SESSIONS = "no other live sessions";

type ListDetails = Extract<SessionToolDetails, { readonly tool: "session_list" }>;

const UNUSABLE_STATES = ["unavailable", "unresponsive", "unreachable"] as const;
const LISTED_STATES = ["idle", "busy", ...UNUSABLE_STATES] as const;

/**
 * One combined counter, widest first: each state's count where the sessions' states differ
 * (`1 idle · 2 busy`), else the total, or the shared state where no session in it can take a
 * message (`2 unreachable`); then the total with how many can't be messaged, then the total.
 */
const listCounters = (details: ListDetails, total: number): string[] => {
  const counts = Arr.filterMap(LISTED_STATES, (state) => {
    const count = Arr.filter(details.sessions, (session) => session.state === state).length;
    return count > 0
      ? Result.succeed({ state, text: `${count} ${SESSION_STATE_LABELS[state]}` })
      : Result.failVoid;
  });
  const sessions = countLabel(total, "session");
  const [only, ...others] = counts;
  const more = details.omitted > 0 ? [`${details.omitted} more`] : [];
  const widest =
    only !== undefined && (others.length > 0 || Arr.contains(UNUSABLE_STATES, only.state))
      ? joinInline([...Arr.map(counts, (count) => count.text), ...more])
      : sessions;
  const unusable = Arr.filter(details.sessions, (session) =>
    Arr.contains(UNUSABLE_STATES, session.state),
  ).length;
  return [
    ...new Set([
      widest,
      ...(unusable > 0 ? [joinInline([sessions, `${unusable} can't be messaged`])] : []),
      sessions,
    ]),
  ];
};

/** A listing only looks, so it is neutral: `• session_list · 2 sessions`. */
const listSummary = (details: ListDetails): CompactSummary => {
  const total = details.sessions.length + details.omitted;
  const duplicates = Arr.filter(details.sessions, ({ duplicate }) => duplicate).length;
  // An empty listing's counter says so, where a preview's status line can show it too.
  if (total === 0) return { subject: "", counters: [NO_OTHER_SESSIONS], outcome: "returned" };
  return {
    subject: "",
    counters: listCounters(details, total),
    metadata: duplicates > 0 ? [countLabel(duplicates, "duplicate id")] : [],
    outcome: "returned",
  };
};

const refusedSummary = (details: SessionRefusal): CompactSummary => {
  const subject = details.session ? sessionSubject(details.session) : addresseeSubject(details.to);
  const issues = [refusalIssue(details)];
  return { subject, outcome: "error", issues };
};

const settled = (details: SessionToolDetails): CompactSummary => {
  if (details.tool === SESSION_TOOL.list) return listSummary(details);
  if ("outcome" in details && details.outcome === "refused") return refusedSummary(details);
  if (details.tool === SESSION_TOOL.read)
    // A read only looks, so it is neutral, with the session's state as its first fact and, without
    // a reply, that there is none yet.
    return {
      subject: sessionSubject(details.session),
      metadata: [
        SESSION_STATE_LABELS[details.state],
        ...(hasReply(details) ? [] : ["no reply yet"]),
      ],
      subjectState: true,
      outcome: "returned",
    };
  if (details.outcome === "uncertain")
    return {
      subject: sessionSubject(details.session),
      outcome: "uncertain",
      messageIcon: "sent",
      issues: [uncertainIssue(details)],
    };
  return {
    subject: sessionSubject(details.session),
    metadata: Arr.filter([DISPOSITION_WORDS[details.disposition]], Str.isNonEmpty),
    outcome: "success",
    messageIcon: "sent",
  };
};

/** Whether a read found words to show. */
const hasReply = (details: { readonly text?: string | undefined }): boolean =>
  details.text !== undefined && Str.isNonEmpty(Str.trim(details.text));

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

/**
 * What expanding a settled row reveals where a compact row hides it: every session, a send's
 * message, or a read's reply. A preview row shows those collapsed, so its expansion adds the
 * sessions' ids and directories, and a clipped body names its own hidden lines. An empty list has
 * nothing more to show.
 */
const settledExpandLabel = (details: SessionToolDetails, style: CollapsedStyle): string | false => {
  if (details.tool === SESSION_TOOL.list && details.sessions.length === 0) return false;
  if (style === "preview") return "details";
  if (details.tool === SESSION_TOOL.list) return "sessions";
  if (details.tool === SESSION_TOOL.send) return "message";
  return "outcome" in details || !hasReply(details) ? "details" : "reply";
};

type CollapsedStyle = "compact" | "preview";

export const sessionToolCompactSummary =
  (
    tool: string,
    names?: SessionNames,
    style: CollapsedStyle = "compact",
  ): CompactSummaryProvider<SessionToolArgs> =>
  ({ phase, args, result }) => {
    // The words a send carries, which its expansion shows.
    const sending =
      tool === SESSION_TOOL.send &&
      Predicate.isString(args.message) &&
      Str.isNonEmpty(Str.trim(args.message));
    if (phase !== "settled") return pending(tool, args.to, names, sending);
    const details = sessionToolDetails(tool, result);
    return details
      ? { expandLabel: settledExpandLabel(details, style), ...settled(details) }
      : undefined;
  };
