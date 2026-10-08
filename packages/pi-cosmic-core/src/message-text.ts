/**
 * Human one-line messages from producer text that has no domain classification, shared by tool
 * issues and user notifications.
 */
import { clipText } from "./display.ts";
import { sanitizeTerminalLine } from "./security.ts";

/** Longest message one of these helpers returns by default. */
export const MESSAGE_TEXT_LIMIT = 240;

// Error-class wrappers add nothing beside an error glyph: `Error: `, `Uncaught TypeError: `,
// `[ToolFailure] `. One-hump brackets such as `[REDACTED]` are content and stay.
const ERROR_PREFIX =
  /^(?:Uncaught(?: exception)?(?::?\s+|:$)|(?:[A-Z][A-Za-z]*)?Error(?: \[[A-Z0-9_]+\])?:(?:\s+|$)|\[[A-Z][a-z]+(?:[A-Z][a-z]+)+\]\s+)/u;
const ERROR_WRAPPER = /^[A-Z][A-Za-z]*Error\((.*?)\)?$/u;
const SENTENCE_BREAK = /(?<=[.!?])\s+(?=[A-Z])/u;
// A later sentence that tells the reader what to do is agent guidance, not the failure.
const ADVICE =
  /^(?:Do|Don't|Please|Inspect|Use|Retry|Try|Call|Run|Check|Await|Reply|Wait|Consider|See|Read|Review|Confirm|Continue|Resume|Stop|Provide|Make|Ensure|Omit|Merge|Add|Match|Launch|Grant|Pass|Set|Serialize|Convert|Encode|Return|Avoid|Split|Remove|Replace|Start|Restart|Reload|Open|Switch)\b/u;

const STRUCTURED = /^[[{]\s*(?:"|\{|\[|$)/u;

const withoutFinalPeriod = (text: string): string => text.replace(/(?<!\.)\.$/u, "");

function tidy(line: string): string {
  let text = line;
  for (let pass = 0; pass < 3; pass++) {
    const next = text.replace(ERROR_PREFIX, "");
    if (next === text) break;
    text = next;
  }
  text = ERROR_WRAPPER.exec(text)?.[1] ?? text;
  const [first = "", ...rest] = text.split(SENTENCE_BREAK);
  const advice = rest.findIndex((sentence) => ADVICE.test(sentence));
  text = [first, ...(advice === -1 ? rest : rest.slice(0, advice))].join(" ");
  return withoutFinalPeriod(text).trim();
}

/**
 * The first nonblank line of unrecognised text, bounded for one row. Error-class prefixes,
 * trailing advice sentences and a final period are dropped; the raw text stays with the caller.
 */
export function firstLineMessage(
  text: string,
  fallback: string,
  limit = MESSAGE_TEXT_LIMIT,
): string {
  const line = text.split(/\r?\n/u).map(sanitizeTerminalLine).find(Boolean);
  // Structured data, such as a JSON reply, is not a message; the raw text stays with the caller.
  const message = line === undefined || STRUCTURED.test(line) ? "" : tidy(line);
  return clipText(message || fallback, Math.min(limit, MESSAGE_TEXT_LIMIT));
}

/** Whether `message` already says all of `text`: one line, bar spacing and its final period. */
export function restatesText(text: string, message: string): boolean {
  return message !== "" && withoutFinalPeriod(text.trim().replace(/\s+/gu, " ")) === message;
}

/** A quoted line in people's terms, and the full text when the line does not say all of it. */
interface QuotedText {
  /** Absent when the text opens with agent guidance or has nothing to quote. */
  readonly line?: string;
  readonly detail?: string;
}

/**
 * Quote producer, worker, or server text: its first line, unless the text opens with agent
 * guidance, and the full text as detail unless that line already says all of it. `failure`
 * names common service failures rather than quoting them.
 */
export function quoteText(
  text: string,
  options: { readonly limit?: number; readonly failure?: boolean } = {},
): QuotedText {
  const quote = options.failure ? failureMessage : firstLineMessage;
  const line = isAgentGuidance(text) ? "" : quote(text, "", options.limit);
  return {
    ...(line && { line }),
    ...(text.trim() && !restatesText(text, line) && { detail: text }),
  };
}

/** Text that opens by telling its reader what to do is agent guidance, not a fact to quote. */
export function isAgentGuidance(text: string): boolean {
  return ADVICE.test(firstLineMessage(text, ""));
}

// Status codes only count where they read as a status, never as an arbitrary number.
const STATUS =
  /(?:^|\bstatus(?:[ _]code)?\W{0,3}|\bHTTP(?:\/[\d.]+)?\s+|\bcode\W{0,3})([45]\d\d)\b/iu;
const STATUS_FAILURES: ReadonlyArray<readonly [(code: number) => boolean, string]> = [
  [(code) => code === 429, "Rate limited"],
  [(code) => code === 529, "Service overloaded"],
  [(code) => code === 401, "Authentication failed"],
  [(code) => code === 403, "Access denied"],
  [(code) => code >= 500, "Server error"],
];
const PHRASE_FAILURES: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /context[_ ]length[_ ]exceeded|maximum context length|prompt is too long|exceeds? (?:the )?(?:model'?s? )?context (?:window|length|limit)/iu,
    "Too long for the model's context",
  ],
  [/too many requests|rate[ _-]?limit(?:ed|s)?\b/iu, "Rate limited"],
  [/\boverloaded/iu, "Service overloaded"],
  [
    /\bunauthori[sz]ed\b|invalid (?:api[ _-]?key|token)|incorrect api key|authentication (?:failed|error)/iu,
    "Authentication failed",
  ],
  [/\bforbidden\b/iu, "Access denied"],
  [/internal server error|bad gateway|service unavailable|gateway time-?out/iu, "Server error"],
  [/\bE(?:TIMEDOUT|SOCKETTIMEDOUT)\b/u, "Connection timed out"],
  [/\bECONNRESET\b|\bEPIPE\b|socket hang up/iu, "Connection lost"],
  [/\bECONNREFUSED\b/u, "Connection refused"],
  [/\bENOTFOUND\b|\bEAI_AGAIN\b/u, "Host not found"],
  [/\bfetch failed\b|\bnetwork error\b/iu, "Network request failed"],
];

/**
 * A failure's human message: a short phrase for common service and network failures (rate
 * limits, authentication, server errors, connection loss, context overflow), otherwise its
 * first line. Classification reads only the first line, so bodies and stacks cannot match.
 */
export function failureMessage(text: string, fallback: string, limit = MESSAGE_TEXT_LIMIT): string {
  const line = firstLineMessage(text, "");
  const status = STATUS.exec(line)?.[1];
  const code = status === undefined ? undefined : Number(status);
  const phrase =
    PHRASE_FAILURES.find(([pattern]) => pattern.test(line))?.[1] ??
    (code === undefined ? undefined : STATUS_FAILURES.find(([matches]) => matches(code))?.[1]);
  if (phrase === undefined) return firstLineMessage(text, fallback, limit);
  const shownCode = code !== undefined && phrase !== "Too long for the model's context";
  return clipText(`${phrase}${shownCode ? ` (${code})` : ""}`, limit);
}

/**
 * A notification as people read it: one tidy line without a final period. Multi-line text is a
 * requested report, such as help or status, and keeps its layout. Nothing is cut: a reply that
 * carries data, such as JSON for a non-interactive client, must arrive whole.
 */
export function notificationText(message: string): string {
  if (/\n/u.test(message.trim())) return message;
  return withoutFinalPeriod(sanitizeTerminalLine(message));
}
