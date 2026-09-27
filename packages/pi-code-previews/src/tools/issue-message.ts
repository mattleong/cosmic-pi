/** Human one-line messages from producer text that has no domain classification. */
import { escapeControlChars } from "../shared/terminal-text";
import { COMPACT_ISSUE_MESSAGE_LIMIT } from "./compact-issues";

// Error-class wrappers add nothing beside an error glyph: `Error: `, `Uncaught TypeError: `,
// `[ToolFailure] `. One-hump brackets such as `[REDACTED]` are content and stay.
const ERROR_PREFIX =
  /^(?:Uncaught(?: exception)?(?::?\s+|:$)|(?:[A-Z][A-Za-z]*)?Error(?: \[[A-Z0-9_]+\])?:(?:\s+|$)|\[[A-Z][a-z]+(?:[A-Z][a-z]+)+\]\s+)/u;
const ERROR_WRAPPER = /^[A-Z][A-Za-z]*Error\((.*?)\)?$/u;
const SENTENCE_BREAK = /(?<=[.!?])\s+(?=[A-Z])/u;
// A later sentence that tells the reader what to do is agent guidance, not the failure.
const ADVICE =
  /^(?:Do|Don't|Please|Inspect|Use|Retry|Try|Call|Run|Check|Await|Reply|Wait|Consider|See|Read|Review|Confirm|Continue|Resume|Stop|Provide|Make|Ensure|Omit|Merge|Add|Match|Launch|Grant|Pass|Set|Serialize|Convert|Encode|Return|Avoid|Split|Remove|Replace)\b/u;

const clip = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;

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
  return text.replace(/(?<!\.)\.$/u, "").trim();
}

/**
 * The first nonblank line of unrecognised text, bounded for one row. Error-class prefixes,
 * trailing advice sentences and a final period are dropped; the raw text stays with the caller.
 */
export function firstLineMessage(
  text: string,
  fallback: string,
  limit = COMPACT_ISSUE_MESSAGE_LIMIT,
): string {
  const line = text
    .split(/\r?\n/u)
    .map((value) => escapeControlChars(value).replace(/\s+/gu, " ").trim())
    .find(Boolean);
  const message = line === undefined ? "" : tidy(line);
  return clip(message || fallback, Math.min(limit, COMPACT_ISSUE_MESSAGE_LIMIT));
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
export function failureMessage(
  text: string,
  fallback: string,
  limit = COMPACT_ISSUE_MESSAGE_LIMIT,
): string {
  const line = firstLineMessage(text, "", Number.MAX_SAFE_INTEGER);
  const status = STATUS.exec(line)?.[1];
  const code = status === undefined ? undefined : Number(status);
  const phrase =
    PHRASE_FAILURES.find(([pattern]) => pattern.test(line))?.[1] ??
    (code === undefined ? undefined : STATUS_FAILURES.find(([matches]) => matches(code))?.[1]);
  if (phrase === undefined) return firstLineMessage(text, fallback, limit);
  const shownCode = code !== undefined && phrase !== "Too long for the model's context";
  return clip(`${phrase}${shownCode ? ` (${code})` : ""}`, limit);
}
