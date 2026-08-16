import * as Predicate from "effect/Predicate";
import { hasObjectRuntimeType } from "./runtime-values.ts";
import * as Schema from "effect/Schema";
const ANSI_ESCAPE_PATTERN = String.raw`\u001B\[[0-?]*[ -/]*[@-~]`;
const ANSI_ESCAPE_REGEXP = new RegExp(ANSI_ESCAPE_PATTERN, "g");
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

export interface DiagnosticSanitizerOptions {
  readonly maximumLength?: number;
  readonly extraPatterns?: readonly RegExp[];
}

const replaceControlCharacters = (value: string): string => value.replace(/\p{Cc}/gu, " ");

const replaceContentControlCharacters = (value: string): string =>
  value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/\p{Cc}/gu, (character) =>
      character === "\n" || character === "\t" ? character : " ",
    );

export const stripAnsi = (value: string): string => value.replace(ANSI_ESCAPE_REGEXP, "");

/** Remove terminal control strings while preserving Markdown-significant newlines and tabs. */
export function stripTerminalControls(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x9b) {
      index += 1;
      while (index < value.length) {
        const current = value.charCodeAt(index);
        if (current >= 0x40 && current <= 0x7e) break;
        index += 1;
      }
      continue;
    }
    if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) {
      index += 1;
      while (index < value.length) {
        const current = value.charCodeAt(index);
        if (current === 0x07 || current === 0x9c) break;
        if (current === 0x1b && value[index + 1] === "\\") {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (code === 0x1b) {
      const introducer = value[index + 1];
      if (introducer === "[") {
        index += 2;
        while (index < value.length) {
          const current = value.charCodeAt(index);
          if (current >= 0x40 && current <= 0x7e) break;
          index += 1;
        }
        continue;
      }
      if (["]", "P", "X", "^", "_"].includes(introducer ?? "")) {
        index += 2;
        while (index < value.length) {
          const current = value.charCodeAt(index);
          if (current === 0x07) break;
          if (current === 0x1b && value[index + 1] === "\\") {
            index += 1;
            break;
          }
          index += 1;
        }
        continue;
      }
      index += 1;
      continue;
    }
    const character = value[index] ?? "";
    if (
      character === "\n" ||
      character === "\t" ||
      (code >= 32 && code !== 127 && !(code >= 0x80 && code <= 0x9f))
    ) {
      result += character;
    }
  }
  return result;
}

/** Strip terminal controls and collapse whitespace into a single trimmed line. */
export const sanitizeTerminalLine = (text: string): string =>
  stripTerminalControls(text).replace(/\s+/g, " ").trim();

const redactSensitiveText = (message: string, extraPatterns: readonly RegExp[] = []): string => {
  let redacted = stripAnsi(message)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[REDACTED]")
    .replace(/\bacct_[A-Za-z0-9_-]{6,}\b/g, "acct_[REDACTED]")
    .replace(
      /(["']?(?:access|access[_-]?token|access[_-]?key|refresh|refresh[_-]?token|token|api[_-]?key|authorization|password|passwd|secret|private[_-]?key|credentials?|account[_-]?id|team[_-]?id)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^,\s}\]]+)/gi,
      "$1[REDACTED]",
    );
  for (const pattern of extraPatterns) redacted = redacted.replace(pattern, REDACTED);
  return redacted.replace(/\[REDACTED\](?:\])+/g, REDACTED);
};

export function decodeJwtPayloadText(token: string): string | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized + "=".repeat((4 - (normalized.length % 4)) % 4), "base64").toString(
    "utf8",
  );
}

export function maskIdentifier(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= 8 ? "found" : `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

export function sanitizeDiagnosticError(
  message: string,
  options: DiagnosticSanitizerOptions = {},
): string {
  const maximumLength = options.maximumLength ?? DIAGNOSTIC_MAX_LENGTH;
  let redacted = redactSensitiveText(message, options.extraPatterns ?? []);
  redacted = replaceControlCharacters(redacted).replace(/ +/g, " ").trim();
  const sanitized = redacted || "Unknown error.";
  if (sanitized.length <= maximumLength) return sanitized;
  return `${sanitized.slice(0, Math.max(0, maximumLength - 1)).trimEnd()}…`;
}

/** Redact secrets and terminal controls without collapsing Markdown-significant whitespace. */
export function sanitizeDiagnosticContent(
  content: string,
  options: DiagnosticSanitizerOptions = {},
): string {
  const maximumLength = options.maximumLength ?? DIAGNOSTIC_MAX_LENGTH;
  const sanitized = replaceContentControlCharacters(
    redactSensitiveText(content, options.extraPatterns ?? []),
  );
  if (sanitized.length <= maximumLength) return sanitized;
  return `${sanitized.slice(0, Math.max(0, maximumLength - 1)).trimEnd()}…`;
}

const isSensitiveKey = (key: string): boolean => {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalized === "access" ||
    normalized === "auth" ||
    normalized === "refresh" ||
    SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  );
};

export function redactDiagnosticValue<ValueInput>(
  value: ValueInput,
  options: DiagnosticSanitizerOptions = {},
): Schema.Json {
  const seen = new WeakSet<object>();
  const redact = <Current>(current: Current, depth: number): Schema.Json => {
    if (Predicate.isString(current)) return sanitizeDiagnosticError(current, options);
    if (current === null) return null;
    if (Predicate.isBoolean(current)) return current;
    if (Predicate.isNumber(current)) return Number.isFinite(current) ? current : null;
    if (!hasObjectRuntimeType(current)) return null;
    if (depth >= 16 || seen.has(current)) return "[TRUNCATED]";
    seen.add(current);
    if (Array.isArray(current)) return current.map((entry) => redact(entry, depth + 1));
    try {
      return Object.fromEntries(
        Object.entries(current).map(([key, entry]) => [
          key,
          isSensitiveKey(key) ? REDACTED : redact(entry, depth + 1),
        ]),
      );
    } catch {
      return "[UNREADABLE]";
    }
  };
  return Schema.decodeUnknownSync(Schema.Json)(redact(value, 0));
}
