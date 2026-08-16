/**
 * Generic credential redaction shared by observations, reviews, logs, status, and checkpoints.
 *
 * This is domain policy, not observation-protocol structure: every value or message that can reach
 * a log, span, projection, or model prompt passes through here.
 */
import { isStringValue } from "pi-cosmic-core";
import { stringifyJson } from "../boundary/json.ts";
import * as Schema from "effect/Schema";
import { snapshotData } from "./safe-data.ts";
import { isRecord } from "../shared/utils.ts";

/** Central recursive credential redaction used by every observation/delta path. */
export function redactObservationValue<ValueInput>(value: ValueInput) {
  return redactSnapshot(snapshotData(value), 0);
}

function redactSnapshot(value: Schema.MutableJson | undefined, depth: number): Schema.MutableJson {
  if (depth > 16) return "[nested value omitted]";
  if (isStringValue(value)) return redactSensitiveText(value);
  if (Array.isArray(value))
    return value.slice(0, 256).map((item) => redactSnapshot(item, depth + 1));
  if (!isRecord(value)) return value ?? null;
  // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
  const result: Schema.MutableJsonObject = Object.create(null);
  for (const [key, item] of Object.entries(value).slice(0, 256)) {
    result[key] = isSensitiveKey(key) ? "[REDACTED]" : redactSnapshot(item, depth + 1);
  }
  return result;
}

export function stringifyRedactedObservation<ValueInput>(value: ValueInput): string {
  try {
    const snapshot = snapshotData(value);
    if (snapshot === undefined) return "[unavailable]";
    return stringifyJson(redactSnapshot(snapshot, 0)) ?? "[unavailable]";
  } catch {
    return "[unserializable]";
  }
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [REDACTED]")
    .replace(
      /["']?\b((?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|passwd|secret|token|client[_-]?secret|private[_-]?key)(?:[_-][A-Za-z0-9]+)*)\b["']?\s*[:=]\s*(?:Bearer\s+)?["']?[^\s,;"'}]+["']?/gi,
      "$1=[REDACTED]",
    )
    .replace(
      /\b(sk-[A-Za-z0-9_-]{12,}|gh[opusr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|npm_[A-Za-z0-9]{20,})\b/g,
      "[REDACTED CREDENTIAL]",
    )
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED TOKEN]");
}

function isSensitiveKey(key: string): boolean {
  return /(?:^|[_-])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|passwd|secret|token|client[_-]?secret|private[_-]?key)(?:$|[_-])/i.test(
    key,
  );
}
