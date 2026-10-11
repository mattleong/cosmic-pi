import * as Base64Url from "effect/encoding/Base64Url";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { clipText } from "./display.ts";
import { decodeUnknownOrUndefined } from "./schema/decode.ts";
import {
  ESCAPE_STRING_INTRODUCERS,
  isPrintableCode,
  TERMINAL_STRING_INTRODUCERS,
} from "./security/terminal-styled.ts";
const ANSI_ESCAPE_PATTERN = String.raw`\u001B\[[0-?]*[ -/]*[@-~]`;
const ANSI_ESCAPE_REGEXP = new RegExp(ANSI_ESCAPE_PATTERN, "g");
const CONTROL_CHARACTER_REGEXP = /\p{Cc}/u;
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
  value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/\p{Cc}/gu, (character) =>
      character === "\n" || character === "\t" ? character : " ",
    );

export const stripAnsi = (value: string): string => value.replace(ANSI_ESCAPE_REGEXP, "");

const skipControlSequence = (value: string, start: number): number => {
  for (let index = start; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0x40 && current <= 0x7e) return index;
  }
  return value.length;
};

const skipTerminalString = (value: string, start: number, acceptC1Terminator: boolean): number => {
  for (let index = start; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current === 0x07 || (acceptC1Terminator && current === 0x9c)) return index;
    if (current === 0x1b && value[index + 1] === "\\") return index + 1;
  }
  return value.length;
};

export function stripTerminalControls(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
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
    const character = value[index] ?? "";
    if (character === "\n" || character === "\t" || isPrintableCode(code)) result += character;
  }
  return result;
}

export const sanitizeTerminalLine = (text: string): string =>
  stripTerminalControls(text).replace(/\s+/g, " ").trim();

const redactSensitiveText = (message: string): string =>
  stripAnsi(message)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[REDACTED]")
    .replace(/\bacct_[A-Za-z0-9_-]{6,}\b/g, "acct_[REDACTED]")
    .replace(
      /(["']?(?:access|access[_-]?token|access[_-]?key|refresh|refresh[_-]?token|token|api[_-]?key|authorization|password|passwd|secret|private[_-]?key|credentials?|account[_-]?id|team[_-]?id)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^,\s}\]]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/\[REDACTED\](?:\])+/g, REDACTED);

const clipDiagnostic = (text: string, maximumLength = DIAGNOSTIC_MAX_LENGTH): string =>
  text.length <= maximumLength ? text : maximumLength > 1 ? clipText(text, maximumLength) : "…";

export function decodeJwtPayloadText(token: string): string | undefined {
  const payload = token.split(".")[1];
  return payload ? Result.getOrUndefined(Base64Url.decodeString(payload)) : undefined;
}

export const extractJwtClaim = <S extends Schema.ConstraintDecoder<unknown>>(
  token: string | undefined,
  payloadSchema: S,
): S["Type"] | undefined => {
  if (token === undefined) return undefined;
  const source = decodeJwtPayloadText(token);
  if (source === undefined) return undefined;
  return decodeUnknownOrUndefined(payloadSchema, source);
};

export const redactedTokenSchema = (label: string) =>
  Schema.RedactedFromValue(Schema.Trim.check(Schema.isMinLength(1)), { label });

export function maskIdentifier(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= 8 ? "found" : `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

export function sanitizeDiagnosticError(
  message: string,
  options: DiagnosticSanitizerOptions = {},
): string {
  const redacted = redactSensitiveText(message)
    .replace(/[\p{Cc} ]+/gu, " ")
    .trim();
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
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    ["access", "auth", "refresh"].includes(normalized) ||
    SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  );
};

export function redactDiagnosticValue<ValueInput>(value: ValueInput): Schema.Json {
  const seen = new WeakSet<object>();
  const redact = <Current>(current: Current, depth: number): Schema.Json => {
    if (Predicate.isString(current)) return sanitizeDiagnosticError(current);
    if (current === null) return null;
    if (Predicate.isBoolean(current)) return current;
    if (Predicate.isNumber(current)) return Number.isFinite(current) ? current : null;
    if (!Predicate.isObjectOrArray(current)) return null;
    if (depth >= 16 || seen.has(current)) return "[TRUNCATED]";
    seen.add(current);
    try {
      if (Array.isArray(current)) return Array.from(current, (entry) => redact(entry, depth + 1));
      return Object.fromEntries(
        Object.entries(current).map(([key, entry]) => [
          key,
          isSensitiveDiagnosticKey(key) ? REDACTED : redact(entry, depth + 1),
        ]),
      );
    } catch {
      return "[UNREADABLE]";
    }
  };
  return redact(value, 0);
}
