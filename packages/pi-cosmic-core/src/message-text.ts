import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { clipText } from "./display.ts";
import { sanitizeTerminalLine } from "./security.ts";

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

export function firstLineMessage(
  text: string,
  fallback: string,
  limit = MESSAGE_TEXT_LIMIT,
): string {
  const line = Option.getOrUndefined(
    Arr.findFirst(Arr.map(Str.split(text, /\r?\n/u), sanitizeTerminalLine), Str.isNonEmpty),
  );
  const message = line === undefined || STRUCTURED.test(line) ? "" : tidy(line);
  return clipText(message || fallback, Math.min(limit, MESSAGE_TEXT_LIMIT));
}

export function restatesText(text: string, message: string): boolean {
  return (
    message !== "" &&
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
  const quote = options.failure ? failureMessage : firstLineMessage;
  const line = isAgentGuidance(text) ? "" : quote(text, "", options.limit);
  return {
    ...(line && { line }),
    ...(Str.trim(text) && !restatesText(text, line) && { detail: text }),
  };
}

export function isAgentGuidance(text: string): boolean {
  return ADVICE.test(firstLineMessage(text, ""));
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

export function failureMessage(text: string, fallback: string, limit = MESSAGE_TEXT_LIMIT): string {
  const line = firstLineMessage(text, "");
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
  if (phrase === undefined) return firstLineMessage(text, fallback, limit);
  const shownCode = code !== undefined && phrase !== "Too long for the model's context";
  return clipText(`${phrase}${shownCode ? ` (${code})` : ""}`, limit);
}

export function notificationText(message: string): string {
  if (/\n/u.test(Str.trim(message))) return message;
  return withoutFinalPeriod(sanitizeTerminalLine(message));
}
