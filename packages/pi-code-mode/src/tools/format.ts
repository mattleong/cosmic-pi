/**
 * Pure formatting for Code Mode execution results, bounded progress, and the bounded
 * nested-call activity labels persisted alongside them.
 */
import * as Predicate from "effect/Predicate";

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalLine } from "pi-cosmic-core";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { CodeModeFailure, CodeModeSuccess } from "../boundary/codemode-runtime.ts";
import { utf8ByteLength } from "./limits.ts";

/** Schema and display bound (code points) for the human-readable `intent` parameter. */
export const MAX_INTENT_LENGTH = 160;

/** Display bound (code points) for one path/pattern/query inside an activity label. */
export const MAX_ACTIVITY_FIELD_LENGTH = 48;

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

const ActivityInputSchema = Schema.Struct({
  path: Schema.optional(Schema.Unknown),
  command: Schema.optional(Schema.Unknown),
  pattern: Schema.optional(Schema.Unknown),
  query: Schema.optional(Schema.Unknown),
  action: Schema.optional(Schema.Unknown),
  id: Schema.optional(Schema.Unknown),
  name: Schema.optional(Schema.Unknown),
});
type ActivityInput = typeof ActivityInputSchema.Type;
type ActivityField = keyof ActivityInput;

/** Tolerant schema decode of one unknown value; malformed input yields undefined, never a throw. */
export const decodeOption = <S extends Schema.ConstraintDecoder<unknown>, Value>(
  schema: S,
  value: Value,
): S["Type"] | undefined => {
  const decoded = Schema.decodeUnknownOption(schema)(value);
  return Option.isSome(decoded) ? decoded.value : undefined;
};

/** One sanitized bounded field read from a schema-decoded nested-call input, if present. */
const activityField = (input: ActivityInput, key: ActivityField): string | undefined => {
  const value = input[key];
  if (!Predicate.isString(value)) return undefined;
  const sanitized = sanitizeTerminalLine(value);
  return sanitized.length === 0 ? undefined : truncateDisplay(sanitized, MAX_ACTIVITY_FIELD_LENGTH);
};

/**
 * A bounded human-readable activity label for one nested call, derived only from the
 * runtime-decoded input at call start (never from nested output). Unknown names and
 * hostile inputs collapse to a safe bounded fallback; raw objects are never stringified.
 */
export const describeNestedActivity = <Name, Input>(name: Name, input: Input): string => {
  const toolName = Predicate.isString(name) ? name : "";
  const activityInput = decodeOption(ActivityInputSchema, input) ?? {};
  const at = (fallback: string) => activityField(activityInput, "path") ?? fallback;
  switch (toolName) {
    case "pi.read":
      return `Read ${at("file")}`;
    case "pi.bash":
    case "pi.powershell":
      return `Run ${activityField(activityInput, "command") ?? "command"}`;
    case "pi.edit":
      return `Edit ${at("file")}`;
    case "pi.write":
      return `Write ${at("file")}`;
    case "pi.grep":
      return `Search ${activityField(activityInput, "pattern") ?? "pattern"} in ${at("cwd")}`;
    case "pi.find":
      return `Find ${activityField(activityInput, "pattern") ?? "pattern"} in ${at("cwd")}`;
    case "pi.ls":
      return `List ${at("cwd")}`;
    case "session.backgroundTask": {
      const action = activityField(activityInput, "action") ?? "manage";
      const target =
        activityField(activityInput, "id") ??
        activityField(activityInput, "name") ??
        activityField(activityInput, "command");
      return `Background ${action}${target === undefined ? "" : ` ${target}`}`;
    }
    case "$codemode.search": {
      const query = activityField(activityInput, "query");
      return query === undefined ? "Discover tools" : `Discover tools for ${query}`;
    }
    default: {
      const sanitized = sanitizeTerminalLine(toolName);
      return sanitized.length === 0
        ? "Call tool"
        : `Call ${truncateDisplay(sanitized, MAX_ACTIVITY_FIELD_LENGTH)}`;
    }
  }
};

/**
 * One bounded nested-call progress entry; never contains nested tool output. `activity` is
 * a bounded, sanitized human-readable label derived from the decoded input at call start.
 */
export interface CodeModeCallEntry {
  readonly tool: string;
  readonly status: "queued" | "running" | "completed" | "error" | "cancelled";
  readonly activity?: string;
  /** Total wall-clock duration from queue admission through settlement. */
  readonly durationMs?: number;
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
  const toolCalls = boundedCallEntries(calls);
  const base = { toolCalls, counts: { ...exactCounts } };
  return exactCounts.total > toolCalls.length
    ? { ...base, totalToolCalls: exactCounts.total }
    : base;
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
 * Successful program output: the returned string or serialized JSON, with runtime logs
 * appended. The runtime's `maxOutputBytes` bound applies to the *compact* serialization, so
 * pretty-printing is used only while it still fits the same budget; otherwise the exact
 * compact form the runtime bounded is emitted, keeping the model-visible value inside
 * `maxOutputBytes`.
 */
export const formatCodeModeSuccess = (result: CodeModeSuccess, maxOutputBytes: number): string => {
  // The runtime validates returned values as plain JSON data, so stringify cannot throw; it
  // yields undefined only for a program that returns undefined (serialized as null upstream).
  const output = Predicate.isString(result.value)
    ? result.value
    : renderJson(result.value, maxOutputBytes);
  return withLogs(output, result.logs);
};

const renderJson = (value: Schema.Json, maxOutputBytes: number): string => {
  const pretty = JSON.stringify(value, null, 2) ?? String(value);
  if (utf8ByteLength(pretty) <= maxOutputBytes) return pretty;
  return JSON.stringify(value) ?? String(value);
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
