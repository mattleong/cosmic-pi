import { freezeSnapshot, sanitizeDiagnosticError, stripTerminalControls } from "pi-cosmic-core";
import type { SubagentRunView, SubagentUsage } from "./model.ts";

export const MAX_NAME_CHARS = 80;
export const MAX_TASK_CHARS = 128 * 1024;
export const MAX_FINAL_TEXT_CHARS = 32 * 1024;
export const MAX_ERROR_CHARS = 8 * 1024;

export const safeTextPrefix = (value: string, maximumCodeUnits: number): string => {
  let end = Math.max(0, Math.min(value.length, Math.floor(maximumCodeUnits)));
  if (
    end > 0 &&
    end < value.length &&
    value.charCodeAt(end - 1) >= 0xd800 &&
    value.charCodeAt(end - 1) <= 0xdbff &&
    value.charCodeAt(end) >= 0xdc00 &&
    value.charCodeAt(end) <= 0xdfff
  )
    end -= 1;
  return value.slice(0, end);
};

export const clipWithMarker = (value: string, maximum: number, marker: string): string =>
  value.length <= maximum
    ? value
    : `${safeTextPrefix(value, Math.max(0, maximum - marker.length))}${marker}`;

export const clipUtf8Text = (value: string, maximumBytes: number): string => {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  const marker = "…";
  const contentBudget = Math.max(0, maximumBytes - Buffer.byteLength(marker, "utf8"));
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const prefix = safeTextPrefix(value, middle);
    if (Buffer.byteLength(prefix, "utf8") <= contentBudget) low = middle;
    else high = middle - 1;
  }
  return `${safeTextPrefix(value, low)}${marker}`;
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
  const snapshot = freezeSnapshot({
    ...view,
    capabilities: [...view.capabilities],
    selection: {
      ...view.selection,
      skippedCandidates: view.selection.skippedCandidates.map((candidate) => ({ ...candidate })),
    },
    sessionEvents: view.sessionEvents.map((event) => ({ ...event })),
    usage: { ...view.usage },
  });
  frozenViewSnapshots.set(view, snapshot);
  return snapshot;
};

export const clipText = (value: string, limit: number): string =>
  value.length <= limit ? value : `${safeTextPrefix(value, limit)}…`;

export const sanitizeDiagnosticText = (value: string, limit: number): string => {
  const sanitized = sanitizeDiagnosticError(value, { maximumLength: limit + 2 });
  if (sanitized.length <= limit) return sanitized;
  return `${safeTextPrefix(sanitized, Math.max(0, limit - 1)).trimEnd()}…`;
};

export const sanitizeOutputText = (value: string, limit: number): string =>
  clipText(stripTerminalControls(value), limit);

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
    ...(cost === undefined ? {} : { cost }),
  };
  return isValidUsage(combined) ? combined : left;
};
