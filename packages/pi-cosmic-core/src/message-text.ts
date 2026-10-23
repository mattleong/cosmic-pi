import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { clipText } from "./display.ts";
import { sanitizeTerminalLine } from "./security.ts";
import { codeUnitAt, indexOfFrom } from "./text-scan.ts";

export const MESSAGE_TEXT_LIMIT = 240;

const ERROR_PREFIX =
  /^(?:Uncaught(?: exception)?(?::?\s+|:$)|(?:[A-Z][A-Za-z]*)?Error(?: \[[A-Z0-9_]+\])?:(?:\s+|$)|\[[A-Z][a-z]+(?:[A-Z][a-z]+)+\]\s+)/u;
const ERROR_WRAPPER = /^[A-Z][A-Za-z]*Error\((.*?)\)?$/u;
const SENTENCE_BREAK = /(?<=[.!?])\s+(?=[A-Z])/u;
const ADVICE =
  /^(?:Do|Don't|Please|Inspect|Use|Retry|Try|Call|Run|Check|Await|Reply|Wait|Consider|See|Read|Review|Confirm|Continue|Resume|Stop|Provide|Make|Ensure|Omit|Merge|Add|Match|Launch|Grant|Pass|Set|Serialize|Convert|Encode|Return|Avoid|Split|Remove|Replace|Start|Restart|Reload|Open|Switch)\b/u;

const STRUCTURED = /^[[{]\s*(?:"|\{|\[|$)/u;

const withoutFinalPeriod = (text: string): string => Fn.pipe(text, Str.replace(/(?<!\.)\.$/u, ""));

function tidy(line: string): string {
  let text = line;
  for (let pass = 0; pass < 3; pass++) {
    const next = Fn.pipe(text, Str.replace(ERROR_PREFIX, ""));
    if (next === text) break;
    text = next;
  }
  text = ERROR_WRAPPER.exec(text)?.[1] ?? text;
  const [first, ...rest] = Str.split(text, SENTENCE_BREAK);
  const advice = Arr.findFirstIndex(rest, (sentence) => ADVICE.test(sentence));
  text = Arr.join([first, ...(Option.isNone(advice) ? rest : rest.slice(0, advice.value))], " ");
  return Str.trim(withoutFinalPeriod(text));
}

/** The first `\r?\n`-separated line that sanitizes to non-empty text, reading no further. */
const firstSanitizedLine = (text: string): string | undefined => {
  let start = 0;
  for (;;) {
    const newline = indexOfFrom(text, "\n", start);
    const end =
      newline === -1
        ? text.length
        : newline > start && codeUnitAt(text, newline - 1) === 0x0d
          ? newline - 1
          : newline;
    const line = sanitizeTerminalLine(Fn.pipe(text, Str.slice(start, end)));
    if (line !== "") return line;
    if (newline === -1) return undefined;
    start = newline + 1;
  }
};

/** The tidied first line, or empty when there is none or it starts structured data. */
const firstLineText = (text: string): string => {
  const line = firstSanitizedLine(text);
  return line === undefined || STRUCTURED.test(line) ? "" : tidy(line);
};

const clippedMessage = (message: string, fallback: string, limit = MESSAGE_TEXT_LIMIT): string =>
  clipText(message || fallback, Math.min(limit, MESSAGE_TEXT_LIMIT));

export function firstLineMessage(
  text: string,
  fallback: string,
  limit = MESSAGE_TEXT_LIMIT,
): string {
  return clippedMessage(firstLineText(text), fallback, limit);
}

const NON_WHITESPACE_RUN = /\S+/gu;

/** Whether `text` has more than `limit` non-whitespace code units, counting only that far. */
const visibleLengthExceeds = (text: string, limit: number): boolean => {
  let visible = 0;
  for (const [run] of Fn.pipe(text, Str.matchAll(NON_WHITESPACE_RUN))) {
    visible += run.length;
    if (visible > limit) return true;
  }
  return false;
};

export function restatesText(text: string, message: string): boolean {
  // Collapsing whitespace keeps every other character and dropping a final period removes one,
  // so text with more non-whitespace than that can't restate the message.
  return (
    message !== "" &&
    !visibleLengthExceeds(text, message.length + 1) &&
    withoutFinalPeriod(Fn.pipe(text, Str.trim, Str.replace(/\s+/gu, " "))) === message
  );
}

interface QuotedText {
  readonly line?: string;
  readonly detail?: string;
}

export function quoteText(
  text: string,
  options: { readonly limit?: number; readonly failure?: boolean } = {},
): QuotedText {
  const message = firstLineText(text);
  const quote = options.failure ? failureFromFirstLine : clippedMessage;
  const line = isAdvice(message) ? "" : quote(message, "", options.limit);
  return {
    ...(line && { line }),
    ...(Str.trim(text) && !restatesText(text, line) && { detail: text }),
  };
}

const isAdvice = (message: string): boolean => ADVICE.test(clippedMessage(message, ""));

export function isAgentGuidance(text: string): boolean {
  return isAdvice(firstLineText(text));
}

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

function failureFromFirstLine(
  message: string,
  fallback: string,
  limit = MESSAGE_TEXT_LIMIT,
): string {
  const line = clippedMessage(message, "");
  const status = STATUS.exec(line)?.[1];
  const code = status === undefined ? undefined : Number(status);
  const phrase = Fn.pipe(
    Arr.findFirst(PHRASE_FAILURES, ([pattern]) => pattern.test(line)),
    Option.orElse(() =>
      code === undefined
        ? Option.none()
        : Arr.findFirst(STATUS_FAILURES, ([matches]) => matches(code)),
    ),
    Option.map(([, label]) => label),
    Option.getOrUndefined,
  );
  if (phrase === undefined) return clippedMessage(message, fallback, limit);
  const shownCode = code !== undefined && phrase !== "Too long for the model's context";
  return clipText(`${phrase}${shownCode ? ` (${code})` : ""}`, limit);
}

export function failureMessage(text: string, fallback: string, limit = MESSAGE_TEXT_LIMIT): string {
  return failureFromFirstLine(firstLineText(text), fallback, limit);
}

export function notificationText(message: string): string {
  if (/\n/u.test(Str.trim(message))) return message;
  return withoutFinalPeriod(sanitizeTerminalLine(message));
}
