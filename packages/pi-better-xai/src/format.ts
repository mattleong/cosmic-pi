import {
  truncateToWidth as truncateTerminalText,
  visibleWidth as terminalVisibleWidth,
} from "@earendil-works/pi-tui";

const ANSI_ESCAPE_PATTERN = String.raw`\u001B\[[0-?]*[ -/]*[@-~]`;
const ANSI_ESCAPE_REGEXP = new RegExp(ANSI_ESCAPE_PATTERN, "g");
const DIAGNOSTIC_MAX_LENGTH = 500;
const REDACTED = "[REDACTED]";
const SENSITIVE_DIAGNOSTIC_KEY_SUFFIXES = [
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
] as const;

function replaceControlCharacters(value: string): string {
  let result = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    result += code <= 31 || (code >= 127 && code <= 159) ? " " : char;
  }
  return result;
}

export function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_REGEXP, "");
}

export function visibleWidth(value: string): number {
  return terminalVisibleWidth(value);
}

export function truncateToWidth(value: string, width: number, ellipsis = "..."): string {
  return truncateTerminalText(value, width, ellipsis);
}

export function maskIdentifier(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= 8) return "found";
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

export function sanitizeDiagnosticError(
  message: string,
  maxLength = DIAGNOSTIC_MAX_LENGTH,
): string {
  const redactedSecrets = stripAnsi(message)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(
      /(["']?(?:access|access_token|refresh|refresh_token|token|api[_-]?key|authorization)["']?\s*[:=]\s*["']?)([^"',\s}\]]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/\[REDACTED\](?:\])+/g, "[REDACTED]");
  const redacted = replaceControlCharacters(redactedSecrets).replace(/ +/g, " ").trim();
  const sanitized = redacted || "Unknown error.";
  if (sanitized.length <= maxLength) return sanitized;
  return `${sanitized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function isSensitiveDiagnosticKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    normalized === "access" ||
    normalized === "auth" ||
    normalized === "refresh" ||
    SENSITIVE_DIAGNOSTIC_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  );
}

export function redactDiagnosticValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeDiagnosticError(value);
  if (Array.isArray(value)) return value.map(redactDiagnosticValue);
  if (typeof value !== "object" || value === null) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      isSensitiveDiagnosticKey(key) ? REDACTED : redactDiagnosticValue(entry),
    ]),
  );
}
