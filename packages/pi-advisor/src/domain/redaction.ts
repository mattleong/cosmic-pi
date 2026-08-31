/**
 * Generic credential redaction shared by observations, reviews, logs, status, and checkpoints.
 *
 * This is domain policy, not observation-protocol structure: every value or message that can reach
 * a log, span, projection, or model prompt passes through here.
 */
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { isJsonObject } from "pi-cosmic-core";
import { snapshotData } from "./safe-data.ts";

const SENSITIVE_KEY_PATTERN =
  /(?:^|[_-])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|authorization|password|passwd|secret|token|client[_-]?secret|private[_-]?key)$/i;

const SENSITIVE_ASSIGNMENT_PATTERN =
  /(["']?)\b(?=[A-Za-z\d_-]*(?:api|key|access|refresh|auth|authorization|password|passwd|secret|token|client|private))([A-Za-z][A-Za-z\d_-]*)(["']?)(\s*[:=]\s*)((?:Bearer\s+)?)(?:(["'])([^"'\r\n]*)\6|[^\s,;}"'\]]+)/gi;

/** Snapshot unknown input, then apply the central recursive credential policy. */
export function redactObservationValue<ValueInput>(value: ValueInput): Schema.MutableJson {
  return redactObservationSnapshot(snapshotData(value));
}

/** Redact an owner-produced safe-data snapshot without walking the source value again. */
export function redactObservationSnapshot(
  value: Schema.MutableJson | undefined,
): Schema.MutableJson {
  return redactSnapshot(value, 0);
}

function redactSnapshot(value: Schema.MutableJson | undefined, depth: number): Schema.MutableJson {
  if (depth > 16) return "[nested value omitted]";
  if (Predicate.isString(value)) return redactSensitiveText(value);
  if (Array.isArray(value))
    return value.slice(0, 256).map((item) => redactSnapshot(item, depth + 1));
  if (!isJsonObject(value)) return value ?? null;
  // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
  const result: Schema.MutableJsonObject = Object.create(null);
  for (const [key, item] of Object.entries(value).slice(0, 256)) {
    result[key] = isSensitiveKey(key) ? "[REDACTED]" : redactSnapshot(item, depth + 1);
  }
  return result;
}

export function stringifyRedactedObservation<ValueInput>(value: ValueInput): string {
  try {
    return stringifyRedactedObservationSnapshot(snapshotData(value));
  } catch {
    return "[unserializable]";
  }
}

/** Serialize an owner-produced safe-data snapshot without snapshotting it again. */
export function stringifyRedactedObservationSnapshot(
  value: Schema.MutableJson | undefined,
): string {
  try {
    if (value === undefined) return "[unavailable]";
    return JSON.stringify(redactObservationSnapshot(value)) ?? "[unavailable]";
  } catch {
    return "[unserializable]";
  }
}

export function redactSensitiveText(value: string): string {
  const privateKeysRedacted = value.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[REDACTED PRIVATE KEY]",
  );
  const assignmentsRedacted =
    privateKeysRedacted.includes(":") || privateKeysRedacted.includes("=")
      ? redactSensitiveAssignments(privateKeysRedacted)
      : privateKeysRedacted;
  return assignmentsRedacted
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [REDACTED]")
    .replace(
      /\b(sk-[A-Za-z0-9_-]{12,}|gh[opusr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|npm_[A-Za-z0-9]{20,})\b/g,
      "[REDACTED CREDENTIAL]",
    )
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED TOKEN]");
}

function redactSensitiveAssignments(value: string): string {
  return value.replace(
    SENSITIVE_ASSIGNMENT_PATTERN,
    (
      match,
      openingKeyQuote: string,
      key: string,
      closingKeyQuote: string,
      delimiter: string,
      bearer: string,
      valueQuote: string | undefined,
    ) => {
      if (openingKeyQuote !== closingKeyQuote || !isSensitiveKey(key)) return match;
      const quote = valueQuote ?? "";
      return `${openingKeyQuote}${key}${closingKeyQuote}${delimiter}${bearer}${quote}[REDACTED]${quote}`;
    },
  );
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key.replace(/([a-z\d])([A-Z])/g, "$1_$2"));
}
