import {
  freezeSnapshot,
  safeTextPrefix,
  safeTextSuffix,
  sanitizeDiagnosticError,
  stripTerminalControls,
  utf8Prefix,
  clipText,
} from "pi-cosmic-core";
import type { SubagentRunView, SubagentUsage } from "./model.ts";

export const MAX_NAME_CHARS = 80;
export const MAX_TASK_CHARS = 128 * 1024;
export const MAX_FINAL_TEXT_CHARS = 32 * 1024;
export const MAX_ERROR_CHARS = 8 * 1024;

export { safeTextPrefix };

export const clipWithMarker = (value: string, maximum: number, marker: string): string =>
  value.length <= maximum
    ? value
    : `${safeTextPrefix(value, Math.max(0, maximum - marker.length))}${marker}`;

export const clipUtf8Text = (value: string, maximumBytes: number): string => {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  const marker = "…";
  const prefix = utf8Prefix(value, Math.max(0, maximumBytes - Buffer.byteLength(marker, "utf8")));
  return `${prefix}${marker}`;
};

export const sanitizeName = (value: string): string => {
  let sanitized = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    sanitized += code < 32 || (code >= 127 && code <= 159) ? " " : character;
  }
  return safeTextPrefix(sanitized.replace(/\s+/g, " ").trim(), MAX_NAME_CHARS);
};

const frozenViewSnapshots = new WeakMap<SubagentRunView, SubagentRunView>();

/**
 * Deep-clones and deep-freezes a view for publication. Run views are only ever
 * replaced immutably (never mutated in place), so the frozen snapshot is
 * memoized per view object and shared across projections and returned views.
 */
export const snapshotView = (view: SubagentRunView): SubagentRunView => {
  const cached = frozenViewSnapshots.get(view);
  if (cached) return cached;
  const snapshot = freezeSnapshot(view);
  frozenViewSnapshots.set(view, snapshot);
  return snapshot;
};

export const sanitizeDiagnosticText = (value: string, limit: number): string => {
  const sanitized = sanitizeDiagnosticError(value, { maximumLength: limit + 2 });
  return clipText(sanitized, limit);
};

/**
 * A stream such as stderr can lead with its fatal error or end with it after warnings, so long
 * text keeps both ends.
 */
export const sanitizeStreamDiagnostic = (value: string, limit: number): string => {
  const sanitized = sanitizeDiagnosticError(value, { maximumLength: Number.MAX_SAFE_INTEGER });
  if (sanitized.length <= limit) return sanitized;
  const marker = " … ";
  const budget = Math.max(0, limit - marker.length);
  const head = Math.ceil(budget / 2);
  return `${safeTextPrefix(sanitized, head).trimEnd()}${marker}${safeTextSuffix(sanitized, budget - head).trimStart()}`;
};

export const sanitizeOutputText = (value: string, limit: number): string =>
  clipText(stripTerminalControls(value), limit);

export const boundedAsciiOr = (value: string, maximum: number, fallback: string): string => {
  const cleaned = stripTerminalControls(value).trim();
  return cleaned.length > 0 && cleaned.length <= maximum && /^[\x20-\x7e]+$/.test(cleaned)
    ? cleaned
    : fallback;
};

const isValidUsage = (usage: SubagentUsage): boolean =>
  [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens].every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  ) &&
  (usage.cost === undefined || (Number.isFinite(usage.cost) && usage.cost >= 0));

/**
 * Sums token counts and known costs. Cost stays unknown (absent) only while no
 * event has ever reported a known cost; a known cost never regresses to unknown.
 */
export const addUsage = (left: SubagentUsage, right: SubagentUsage): SubagentUsage => {
  if (!isValidUsage(right)) return left;
  const cost =
    left.cost === undefined && right.cost === undefined
      ? undefined
      : (left.cost ?? 0) + (right.cost ?? 0);
  const combined: SubagentUsage = {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    totalTokens: left.totalTokens + right.totalTokens,
    ...(cost !== undefined && { cost }),
  };
  return isValidUsage(combined) ? combined : left;
};
