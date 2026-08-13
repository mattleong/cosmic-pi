/**
 * Pure formatting for Code Mode execution results, bounded progress, and the bounded
 * nested-call activity labels persisted alongside them.
 */
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalLine } from "pi-cosmic-core";
import type { CodeMode } from "../boundary/codemode-runtime.ts";
import { utf8ByteLength } from "./limits.ts";

/** Schema and display bound (code points) for the human-readable `intent` parameter. */
export const MAX_INTENT_LENGTH = 160;

/** Display bound (code points) for one path/pattern/query inside an activity label. */
export const MAX_ACTIVITY_FIELD_LENGTH = 48;

/** Code-point-safe truncation with a single-character ellipsis inside the budget. */
export const truncateDisplay = (text: string, maxCodePoints: number): string => {
  const points = [...text];
  if (points.length <= maxCodePoints) return text;
  return `${points.slice(0, Math.max(0, maxCodePoints - 1)).join("")}…`;
};

/** One sanitized bounded field read from a decoded nested-call input, if present. */
const activityField = (input: unknown, key: string): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  if (typeof value !== "string") return undefined;
  const sanitized = sanitizeTerminalLine(value);
  return sanitized.length === 0 ? undefined : truncateDisplay(sanitized, MAX_ACTIVITY_FIELD_LENGTH);
};

/**
 * A bounded human-readable activity label for one nested call, derived only from the
 * runtime-decoded input at call start (never from nested output). Unknown names and
 * hostile inputs collapse to a safe bounded fallback; raw objects are never stringified.
 */
export const describeNestedActivity = (name: unknown, input: unknown): string => {
  const toolName = typeof name === "string" ? name : "";
  const at = (fallback: string) => activityField(input, "path") ?? fallback;
  switch (toolName) {
    case "pi.read":
      return `Read ${at("file")}`;
    case "pi.grep":
      return `Search ${activityField(input, "pattern") ?? "pattern"} in ${at("cwd")}`;
    case "pi.find":
      return `Find ${activityField(input, "pattern") ?? "pattern"} in ${at("cwd")}`;
    case "pi.ls":
      return `List ${at("cwd")}`;
    case "$codemode.search": {
      const query = activityField(input, "query");
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
  readonly status: "running" | "completed" | "error";
  readonly activity?: string;
}

/** Structured details persisted on the final `code_mode` tool result. */
export interface CodeModeToolDetails {
  readonly toolCalls: ReadonlyArray<CodeModeCallEntry>;
  /** Total admitted nested calls; present only when it exceeds the bounded entries. */
  readonly totalToolCalls?: number;
  readonly truncated?: boolean;
  readonly cancelled?: boolean;
}

/** Progress entries stay bounded no matter how many nested calls a program admits. */
export const MAX_PROGRESS_ENTRIES = 32;

/** Bounded, defensively copied entries: later host-side retention never observes mutation. */
export const boundedCallEntries = (
  calls: ReadonlyArray<CodeModeCallEntry>,
): ReadonlyArray<CodeModeCallEntry> =>
  calls.slice(0, MAX_PROGRESS_ENTRIES).map((call) => ({ ...call }));

/**
 * The bounded call-entry portion of the persisted details: defensively copied entries plus
 * the true total only when calls beyond the bound exist (so renderers can show `+N more`).
 */
export const callEntryDetails = (
  calls: ReadonlyArray<CodeModeCallEntry>,
): Pick<CodeModeToolDetails, "toolCalls" | "totalToolCalls"> => {
  const toolCalls = boundedCallEntries(calls);
  return {
    toolCalls,
    ...(calls.length > toolCalls.length ? { totalToolCalls: calls.length } : {}),
  };
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
): AgentToolResult<CodeModeToolDetails> => {
  const settled = calls.filter((call) => call.status !== "running").length;
  const shown = boundedCallEntries(calls);
  const names = shown
    .map(
      (call) =>
        `${call.tool}${call.status === "running" ? "…" : call.status === "error" ? " ✗" : " ✓"}`,
    )
    .join(", ");
  const suffix = calls.length > shown.length ? `, +${calls.length - shown.length} more` : "";
  return {
    content: [
      {
        type: "text",
        text: `code_mode: ${calls.length} nested tool call${calls.length === 1 ? "" : "s"} (${settled} settled)${
          names.length > 0 ? `: ${names}${suffix}` : ""
        }`,
      },
    ],
    details: callEntryDetails(calls),
  };
};

/**
 * Successful program output: the returned string or serialized JSON, with runtime logs
 * appended. The runtime's `maxOutputBytes` bound applies to the *compact* serialization, so
 * pretty-printing is used only while it still fits the same budget; otherwise the exact
 * compact form the runtime bounded is emitted, keeping the model-visible value inside
 * `maxOutputBytes`.
 */
export const formatCodeModeSuccess = (result: CodeMode.Success, maxOutputBytes: number): string => {
  // The runtime validates returned values as plain JSON data, so stringify cannot throw; it
  // yields undefined only for a program that returns undefined (serialized as null upstream).
  const output =
    typeof result.value === "string" ? result.value : renderJson(result.value, maxOutputBytes);
  return withLogs(output, result.logs);
};

const renderJson = (value: unknown, maxOutputBytes: number): string => {
  const pretty = JSON.stringify(value, null, 2) ?? String(value);
  if (utf8ByteLength(pretty) <= maxOutputBytes) return pretty;
  return JSON.stringify(value) ?? String(value);
};

/**
 * Normalized diagnostic rendering: stable kind, message, source location, and any
 * suggestions the runtime attached, with runtime logs preserved.
 */
export const formatCodeModeFailure = (result: CodeMode.Failure): string => {
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
