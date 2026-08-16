import * as Predicate from "effect/Predicate";
import type { JsonObject } from "pi-cosmic-core";
import { hasObjectRuntimeType } from "pi-cosmic-core";
import type { SubagentSessionEvent } from "./model.ts";
import { MAX_PROTOCOL_ID_CHARS } from "./limits.ts";
import { sanitizeDiagnosticText, sanitizeOutputText } from "./state.ts";

const MAX_SESSION_EVENTS = 120;
const MAX_SESSION_BYTES = 192 * 1024;
const MAX_TOOL_TARGET_CHARS = 500;
const MAX_ASSISTANT_TEXT_CHARS = 16 * 1024;
const MAX_NOTICE_CHARS = 4 * 1024;

// Session events are immutable once created, so each event's serialized size
// is computed once and reused across every retention pass.
const eventBytes = new WeakMap<SubagentSessionEvent, number>();

const bytes = (event: SubagentSessionEvent): number => {
  const cached = eventBytes.get(event);
  if (cached !== undefined) return cached;
  const size = Buffer.byteLength(JSON.stringify(event), "utf8");
  eventBytes.set(event, size);
  return size;
};

// SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
const asRecord = <ValueInput>(value: ValueInput): Readonly<JsonObject> | undefined =>
  value !== null && hasObjectRuntimeType(value) && !Array.isArray(value)
    ? (value as Readonly<JsonObject>)
    : undefined;

const stringField = (record: Readonly<JsonObject> | undefined, key: string): string | undefined => {
  const value = record?.[key];
  return Predicate.isString(value) && value.trim() ? value.trim() : undefined;
};

export function summarizeToolArguments<ArgsInput>(
  toolName: string,
  args: ArgsInput,
): string | undefined {
  const input = asRecord(args);
  const path =
    stringField(input, "path") ?? stringField(input, "file_path") ?? stringField(input, "cwd");
  let summary: string | undefined;
  switch (toolName.toLowerCase()) {
    case "bash":
      summary = stringField(input, "command");
      break;
    case "read":
    case "write":
    case "edit":
    case "ls":
      summary = path;
      break;
    case "grep": {
      const pattern = stringField(input, "pattern");
      summary = [pattern ? `/${pattern}/` : undefined, path].filter(Boolean).join(" · ");
      break;
    }
    case "find":
    case "glob":
      summary = [stringField(input, "pattern"), path].filter(Boolean).join(" · ");
      break;
    case "contact_parent":
      summary = [stringField(input, "kind"), stringField(input, "message")]
        .filter(Boolean)
        .join(": ");
      break;
    default:
      summary =
        path ??
        stringField(input, "query") ??
        stringField(input, "id") ??
        stringField(input, "name") ??
        stringField(input, "message") ??
        stringField(input, "command");
  }
  return summary ? sanitizeDiagnosticText(summary, MAX_TOOL_TARGET_CHARS) : undefined;
}

export function appendSessionEvent(
  current: ReadonlyArray<SubagentSessionEvent>,
  event: SubagentSessionEvent,
): ReadonlyArray<SubagentSessionEvent> {
  if (bytes(event) > MAX_SESSION_BYTES) return current;
  const next = [...current, event].slice(-MAX_SESSION_EVENTS);
  let retainedBytes = 0;
  let start = next.length;
  while (start > 0) {
    const retained = next[start - 1];
    if (!retained) break;
    const size = bytes(retained);
    if (retainedBytes + size > MAX_SESSION_BYTES) break;
    retainedBytes += size;
    start -= 1;
  }
  return next.slice(start);
}

export function appendAssistantSessionEvent(
  current: ReadonlyArray<SubagentSessionEvent>,
  text: string,
  createdAt: number,
): ReadonlyArray<SubagentSessionEvent> {
  const sanitized = sanitizeOutputText(text, MAX_ASSISTANT_TEXT_CHARS).trim();
  return sanitized
    ? appendSessionEvent(current, { type: "assistant", text: sanitized, createdAt })
    : current;
}

export function appendNoticeSessionEvent(
  current: ReadonlyArray<SubagentSessionEvent>,
  kind: "parent" | "progress" | "warning" | "question",
  text: string,
  createdAt: number,
): ReadonlyArray<SubagentSessionEvent> {
  return appendSessionEvent(current, {
    type: "notice",
    kind,
    text: sanitizeDiagnosticText(text, MAX_NOTICE_CHARS),
    createdAt,
  });
}

export function startToolSessionEvent(
  current: ReadonlyArray<SubagentSessionEvent>,
  input: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly args: unknown;
    readonly startedAt: number;
  },
): ReadonlyArray<SubagentSessionEvent> {
  const target = summarizeToolArguments(input.toolName, input.args);
  return appendSessionEvent(
    current,
    (() => {
      const objectPart4450_0 = {
        type: "tool" as const,
        toolCallId: sanitizeDiagnosticText(input.toolCallId, MAX_PROTOCOL_ID_CHARS),
        toolName: sanitizeDiagnosticText(input.toolName, 200),
      };
      const objectPart4450_1 = target ? { ...objectPart4450_0, target } : objectPart4450_0;
      const objectPart4450_2 = {
        ...objectPart4450_1,
        state: "running" as const,
        startedAt: input.startedAt,
      };
      return objectPart4450_2;
    })(),
  );
}

export function finishToolSessionEvent(
  current: ReadonlyArray<SubagentSessionEvent>,
  input: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly isError: boolean;
    readonly endedAt: number;
  },
): ReadonlyArray<SubagentSessionEvent> {
  const toolCallId = sanitizeDiagnosticText(input.toolCallId, MAX_PROTOCOL_ID_CHARS);
  let index = -1;
  for (let candidate = current.length - 1; candidate >= 0; candidate -= 1) {
    const event = current[candidate];
    if (event?.type === "tool" && event.toolCallId === toolCallId) {
      index = candidate;
      break;
    }
  }
  if (index < 0)
    return appendSessionEvent(current, {
      type: "tool",
      toolCallId,
      toolName: sanitizeDiagnosticText(input.toolName, 200),
      state: input.isError ? "failed" : "completed",
      startedAt: input.endedAt,
      endedAt: input.endedAt,
    });
  return current.map((event, eventIndex) =>
    eventIndex === index && event.type === "tool"
      ? {
          ...event,
          state: input.isError ? "failed" : "completed",
          endedAt: input.endedAt,
        }
      : event,
  );
}
