import * as Arr from "effect/Array";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Fn from "effect/Function";
import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { clipText } from "./display.ts";
import { decodeUnknownOrUndefined } from "./schema/decode.ts";
import { codeUnitAt } from "./text-scan.ts";

// Bound once because the terminal scans below call it per code unit.
const codeAt = codeUnitAt;
const TERMINAL_STRING_INTRODUCERS = new Set([0x90, 0x98, 0x9d, 0x9e, 0x9f]);
const ESCAPE_STRING_INTRODUCERS = new Set(["]", "P", "X", "^", "_"]);
const ANSI_ESCAPE_PATTERN = String.raw`\u001B\[[0-?]*[ -/]*[@-~]`;
const ANSI_ESCAPE_REGEXP = new RegExp(ANSI_ESCAPE_PATTERN, "g");
const CONTROL_CHARACTER_REGEXP = /\p{Cc}/u;
// Control characters other than newline and tab.
const CONTENT_CONTROL_CHARACTER_REGEXP = /[^\P{Cc}\n\t]/gu;
const DIAGNOSTIC_MAX_LENGTH = 500;
const REDACTED = "[REDACTED]";
const SENSITIVE_KEY_SUFFIXES = [
  "token",
  "apikey",
  "accesskey",
  "authorization",
  "password",
  "passwd",
  "secret",
  "privatekey",
  "credential",
  "credentials",
  "accountid",
  "teamid",
] as const;

interface DiagnosticSanitizerOptions {
  readonly maximumLength?: number;
}

export const hasControlCharacter = (value: string): boolean => CONTROL_CHARACTER_REGEXP.test(value);

const replaceContentControlCharacters = (value: string): string =>
  Fn.pipe(
    value,
    Str.replaceAll("\r\n", "\n"),
    Str.replaceAll("\r", "\n"),
    Str.replace(CONTENT_CONTROL_CHARACTER_REGEXP, " "),
  );

export const stripAnsi = (value: string): string =>
  Fn.pipe(value, Str.replace(ANSI_ESCAPE_REGEXP, ""));

const isPrintableCode = (code: number): boolean =>
  code >= 32 && code !== 127 && !(code >= 0x80 && code <= 0x9f);

const printableRunEnd = (value: string, start: number): number => {
  let end = start;
  while (end < value.length && isPrintableCode(codeAt(value, end))) end += 1;
  return end;
};

const skipControlSequence = (value: string, start: number): number => {
  for (let index = start; index < value.length; index += 1) {
    const current = codeAt(value, index);
    if (current >= 0x40 && current <= 0x7e) return index;
  }
  return value.length;
};

const skipTerminalString = (value: string, start: number, acceptC1Terminator: boolean): number => {
  for (let index = start; index < value.length; index += 1) {
    const current = codeAt(value, index);
    if (current === 0x07 || (acceptC1Terminator && current === 0x9c)) return index;
    if (current === 0x1b && value[index + 1] === "\\") return index + 1;
  }
  return value.length;
};

export function stripTerminalControls(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = codeAt(value, index);
    if (code === 0x9b) {
      index = skipControlSequence(value, index + 1);
      continue;
    }
    if (TERMINAL_STRING_INTRODUCERS.has(code)) {
      index = skipTerminalString(value, index + 1, true);
      continue;
    }
    if (code === 0x1b) {
      const introducer = value[index + 1];
      if (introducer === "[") index = skipControlSequence(value, index + 2);
      else if (ESCAPE_STRING_INTRODUCERS.has(introducer ?? ""))
        index = skipTerminalString(value, index + 2, false);
      else index += 1;
      continue;
    }
    // Printable runs, newlines, and tabs are kept unchanged; other controls are dropped.
    const end = code === 0x0a || code === 0x09 ? index + 1 : printableRunEnd(value, index);
    if (end > index) {
      result += Fn.pipe(value, Str.slice(index, end));
      index = end - 1;
    }
  }
  return result;
}

export const sanitizeTerminalLine = (text: string): string =>
  Str.trim(Fn.pipe(stripTerminalControls(text), Str.replace(/\s+/g, " ")));

const redactSensitiveText = (message: string): string =>
  Fn.pipe(
    stripAnsi(message),
    Str.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]"),
    Str.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[REDACTED]"),
    Str.replace(/\bacct_[A-Za-z0-9_-]{6,}\b/g, "acct_[REDACTED]"),
    Str.replace(
      /(["']?(?:access|access[_-]?token|access[_-]?key|refresh|refresh[_-]?token|token|api[_-]?key|authorization|password|passwd|secret|private[_-]?key|credentials?|account[_-]?id|team[_-]?id)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^,\s}\]]+)/gi,
      "$1[REDACTED]",
    ),
    Str.replace(/\[REDACTED\](?:\])+/g, REDACTED),
  );

const clipDiagnostic = (text: string, maximumLength = DIAGNOSTIC_MAX_LENGTH): string =>
  text.length <= maximumLength ? text : maximumLength > 1 ? clipText(text, maximumLength) : "…";

export function decodeJwtPayloadText(token: string): string | undefined {
  const payload = Str.split(token, ".")[1];
  return payload ? Result.getOrUndefined(Base64Url.decodeString(payload)) : undefined;
}

export const extractJwtClaim = <S extends Schema.ConstraintDecoder<unknown>>(
  token: string | undefined,
  payloadSchema: S,
): S["Type"] | undefined => {
  if (token === undefined) return undefined;
  const source = decodeJwtPayloadText(token);
  if (source === undefined) return undefined;
  return decodeUnknownOrUndefined(payloadSchema)(source);
};

export const redactedTokenSchema = (label: string) =>
  Schema.RedactedFromValue(Schema.Trim.check(Schema.isMinLength(1)), { label });

export function maskIdentifier(value: string | undefined): string | undefined {
  const trimmed = value === undefined ? undefined : Str.trim(value);
  if (!trimmed) return undefined;
  return trimmed.length <= 8
    ? "found"
    : `${Fn.pipe(trimmed, Str.slice(0, 4))}...${Fn.pipe(trimmed, Str.slice(-4))}`;
}

export function sanitizeDiagnosticError(
  message: string,
  options: DiagnosticSanitizerOptions = {},
): string {
  const redacted = Str.trim(
    Fn.pipe(redactSensitiveText(message), Str.replace(/[\p{Cc} ]+/gu, " ")),
  );
  return clipDiagnostic(redacted || "Unknown error.", options.maximumLength);
}

export function sanitizeDiagnosticContent(
  content: string,
  options: DiagnosticSanitizerOptions = {},
): string {
  return clipDiagnostic(
    replaceContentControlCharacters(redactSensitiveText(content)),
    options.maximumLength,
  );
}

export const isSensitiveDiagnosticKey = (key: string): boolean => {
  const normalized = Fn.pipe(key, Str.toLowerCase, Str.replace(/[^a-z0-9]/g, ""));
  return (
    ["access", "auth", "refresh"].includes(normalized) ||
    Arr.some(SENSITIVE_KEY_SUFFIXES, (suffix) => Fn.pipe(normalized, Str.endsWith(suffix)))
  );
};

const redactNode = (seen: WeakSet<object>, depth: number) =>
  Match.type<unknown>().pipe(
    Match.when(Predicate.isString, (text): Schema.Json => sanitizeDiagnosticError(text)),
    Match.when(Predicate.isNull, (): Schema.Json => null),
    Match.when(Predicate.isBoolean, (flag): Schema.Json => flag),
    Match.when(Predicate.isNumber, (count): Schema.Json => (Number.isFinite(count) ? count : null)),
    Match.when(Predicate.isObjectOrArray, (container): Schema.Json => {
      if (depth >= 16 || seen.has(container)) return "[TRUNCATED]";
      seen.add(container);
      const child = redactNode(seen, depth + 1);
      try {
        if (Arr.isArray(container)) return Array.from(container, (entry) => child(entry));
        return Rec.fromEntries(
          Arr.map(Rec.toEntries(container), ([key, entry]) => [
            key,
            isSensitiveDiagnosticKey(key) ? REDACTED : child(entry),
          ]),
        );
      } catch {
        return "[UNREADABLE]";
      }
    }),
    Match.orElse((): Schema.Json => null),
  );

export const redactDiagnosticValue: ReturnType<typeof redactNode> = (value) =>
  redactNode(new WeakSet(), 0)(value);
