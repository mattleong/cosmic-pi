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

export const stripAnsi = (value: string): string => value.replace(ANSI_ESCAPE_REGEXP, "");

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
  let redacted = stripAnsi(message)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "sk-[REDACTED]")
    .replace(/\bacct_[A-Za-z0-9_-]{6,}\b/g, "acct_[REDACTED]")
    .replace(
      /(["']?(?:access|access_token|refresh|refresh_token|token|api[_-]?key|authorization|accountId|account_id|teamId|team_id)["']?\s*[:=]\s*["']?)([^"',\s}\]]+)/gi,
      "$1[REDACTED]",
    );
  for (const pattern of options.extraPatterns ?? []) redacted = redacted.replace(pattern, REDACTED);
  redacted = replaceControlCharacters(redacted)
    .replace(/\[REDACTED\](?:\])+/g, REDACTED)
    .replace(/ +/g, " ")
    .trim();
  const sanitized = redacted || "Unknown error.";
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

export function redactDiagnosticValue(
  value: unknown,
  options: DiagnosticSanitizerOptions = {},
): unknown {
  const seen = new WeakSet<object>();
  const redact = (current: unknown, depth: number): unknown => {
    if (typeof current === "string") return sanitizeDiagnosticError(current, options);
    if (typeof current !== "object" || current === null) return current;
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
  return redact(value, 0);
}
