/**
 * Pure formatting for Code Mode execution results and bounded progress snapshots.
 */
import * as Predicate from "effect/Predicate";

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { ExecutionReceipts } from "./execution-receipts.ts";
import type { FailurePresentation } from "./failure-evidence.ts";
import type { CompactAttention, CompactReceipt } from "./compact-evidence.ts";
import type { McpEvidence } from "./mcp-evidence.ts";
import type { CodeModeFailure, CodeModeSuccess } from "../boundary/codemode-runtime.ts";

/** Schema and display bound (code points) for the human-readable `intent` parameter. */
export const MAX_INTENT_LENGTH = 160;

const FOREIGN_REJECTION_FALLBACK = "Unknown rejection";

/**
 * Total formatter for rejected foreign Promises. Ordinary Error and string messages retain
 * their text; hostile prototype, message, and string-coercion traps collapse to a fixed value.
 */
export const formatForeignRejection = <Rejection>(rejection: Rejection): string => {
  if (Predicate.isString(rejection)) return rejection;
  try {
    if (rejection instanceof Error) {
      const message = rejection.message;
      return Predicate.isString(message) ? message : FOREIGN_REJECTION_FALLBACK;
    }
  } catch {
    return FOREIGN_REJECTION_FALLBACK;
  }
  try {
    return String(rejection);
  } catch {
    return FOREIGN_REJECTION_FALLBACK;
  }
};

/** Code-point-safe truncation with a single-character ellipsis inside the budget. */
export const truncateDisplay = (text: string, maxCodePoints: number): string => {
  const points = [...text];
  if (points.length <= maxCodePoints) return text;
  return `${points.slice(0, Math.max(0, maxCodePoints - 1)).join("")}…`;
};

/** Tolerant schema decode of one unknown value; malformed input yields undefined, never a throw. */
export const decodeOption = <S extends Schema.ConstraintDecoder<unknown>, Value>(
  schema: S,
  value: Value,
): S["Type"] | undefined => {
  const decoded = Schema.decodeUnknownOption(schema)(value);
  return Option.isSome(decoded) ? decoded.value : undefined;
};

/** Identity-preserving validation; only the host's live registry grants timing authority. */
export const LiveChildTimingSchema = Schema.declare(
  Schema.is(Schema.Struct({ _tag: Schema.Literal("CodeModeLiveTiming") })),
);
export type LiveChildTiming = typeof LiveChildTimingSchema.Type;

/**
 * One bounded nested-call progress entry; never contains nested tool output.
 * New entries retain only the producer-derived, redacted subject.
 */
export interface CodeModeCallEntry {
  readonly compact?: CompactReceipt;
  readonly tool: string;
  readonly status: "queued" | "running" | "completed" | "error" | "cancelled";
  /** Historical activity only. New executions do not produce this field. */
  readonly activity?: string;
  /** Bounded, redacted argument-only target captured at decoded call start. */
  readonly subject?: string;
  /** Total wall-clock duration from queue admission through settlement. */
  readonly durationMs?: number;
  /** Opaque, process-local running clock. Never interpreted from serialized replay. */
  readonly liveTiming?: LiveChildTiming;
}

export interface CodeModeCallCounts {
  readonly total: number;
  readonly queued: number;
  readonly running: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: number;
}

/** Structured details persisted on the final `code_mode` tool result. */
export interface CodeModeToolDetails {
  readonly resultId?: string;
  readonly executionReceipts?: ExecutionReceipts;
  readonly failurePresentation?: FailurePresentation;
  readonly compactAttention?: CompactAttention;
  /** Historical MCP-specific ledger. New executions use compactAttention. */
  readonly mcpEvidence?: McpEvidence;
  readonly toolCalls: ReadonlyArray<CodeModeCallEntry>;
  /** Exact lifecycle counts, including calls hidden by bounded display selection. */
  readonly counts?: CodeModeCallCounts;
  /** Total retained for hidden-row display and legacy detail compatibility. */
  readonly totalToolCalls?: number;
  /** Extension-only presentation hint; model-visible content remains the authoritative result. */
  readonly outputKind?: "text" | "structured";
  readonly truncated?: boolean;
  readonly cancelled?: boolean;
}

/** Progress entries stay bounded no matter how many nested calls a program admits. */
export const MAX_PROGRESS_ENTRIES = 32;

export const countCallEntries = (calls: ReadonlyArray<CodeModeCallEntry>): CodeModeCallCounts => ({
  total: calls.length,
  queued: calls.filter((call) => call.status === "queued").length,
  running: calls.filter((call) => call.status === "running").length,
  succeeded: calls.filter((call) => call.status === "completed").length,
  failed: calls.filter((call) => call.status === "error").length,
  cancelled: calls.filter((call) => call.status === "cancelled").length,
});

/**
 * Keep active/problem rows plus the most recent successes, then restore chronological order.
 * Every returned row is an owned shallow copy, including on the unbounded fast path.
 */
const boundedCallEntries = (
  calls: ReadonlyArray<CodeModeCallEntry>,
): ReadonlyArray<CodeModeCallEntry> => {
  if (calls.length <= MAX_PROGRESS_ENTRIES) return calls.map((call) => ({ ...call }));
  const selected = new Set(
    calls
      .flatMap((call, index) => (call.status === "completed" ? [] : [index]))
      .slice(-MAX_PROGRESS_ENTRIES),
  );
  for (let index = calls.length - 1; selected.size < MAX_PROGRESS_ENTRIES; index -= 1) {
    selected.add(index);
  }
  return calls.filter((_, index) => selected.has(index)).map((call) => ({ ...call }));
};

/** Bounded display rows plus exact counts for accurate hidden-row projection. */
export const callEntryDetails = (
  calls: ReadonlyArray<CodeModeCallEntry>,
  exactCounts: CodeModeCallCounts = countCallEntries(calls),
): Pick<CodeModeToolDetails, "toolCalls" | "totalToolCalls" | "counts"> => {
  const toolCalls = Object.freeze(boundedCallEntries(calls).map((call) => Object.freeze(call)));
  const base = { toolCalls, counts: Object.freeze({ ...exactCounts }) };
  return Object.freeze(
    exactCounts.total > toolCalls.length ? { ...base, totalToolCalls: exactCounts.total } : base,
  );
};

const withLogs = (text: string, logs: ReadonlyArray<string> | undefined): string => {
  if (logs === undefined || logs.length === 0) return text;
  const rendered = `Logs:\n${logs.join("\n")}`;
  return text.length > 0 ? `${text}\n\n${rendered}` : rendered;
};

/**
 * Deterministic, bounded partial result for `onUpdate`: nested call names and statuses only,
 * never nested output.
 */
export const progressResult = (
  calls: ReadonlyArray<CodeModeCallEntry>,
  exactCounts: CodeModeCallCounts = countCallEntries(calls),
): AgentToolResult<CodeModeToolDetails> => {
  const counts = { ...exactCounts };
  const settled = counts.succeeded + counts.failed + counts.cancelled;
  const details = callEntryDetails(calls, counts);
  const names = details.toolCalls
    .map((call) => {
      const symbol =
        call.status === "queued"
          ? " ◌"
          : call.status === "running"
            ? " ⠋"
            : call.status === "error"
              ? " ✗"
              : call.status === "cancelled"
                ? " ⊘"
                : " ✓";
      return `${call.tool}${symbol}`;
    })
    .join(", ");
  const hidden = Math.max(0, counts.total - details.toolCalls.length);
  const suffix = hidden > 0 ? `, +${hidden} earlier` : "";
  return {
    content: [
      {
        type: "text",
        text:
          counts.total === 0
            ? "code_mode: starting"
            : `code_mode: ${counts.total} nested tool call${counts.total === 1 ? "" : "s"} (${settled} settled, ${counts.running} running, ${counts.queued} queued)${
                names.length > 0 ? `: ${names}${suffix}` : ""
              }`,
      },
    ],
    details,
  };
};

/**
 * Return strings verbatim and serialize structured values without indentation. This preserves
 * every JSON value without expanding the compact representation already bounded by the runtime.
 * Execution applies the final UTF-8 byte clamp after logs are appended.
 */
export const formatCodeModeSuccess = (result: CodeModeSuccess): string => {
  // The runtime validates returned values as plain JSON data. Never parse or reformat strings,
  // even when they contain JSON, source code, or whitespace-sensitive document contents.
  const output = Predicate.isString(result.value)
    ? result.value
    : (JSON.stringify(result.value) ?? String(result.value));
  return withLogs(output, result.logs);
};

/**
 * Normalized diagnostic rendering: stable kind, message, source location, and any
 * suggestions the runtime attached, with runtime logs preserved.
 */
export const formatCodeModeFailure = (result: CodeModeFailure): string => {
  const { error } = result;
  const location =
    error.location === undefined
      ? ""
      : ` (line ${error.location.line}, column ${error.location.column})`;
  const hints = (error.suggestions ?? []).filter((hint) => !error.message.includes(hint));
  return withLogs(
    [`[${error.kind}]${location} ${error.message}`, ...hints].join("\n"),
    result.logs,
  );
};
