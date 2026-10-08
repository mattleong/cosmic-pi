import { asObject, stringField } from "./claims-observation.ts";
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

/** The argument that best identifies what a tool call works on. */
const toolTarget = <ArgsInput>(toolName: string, args: ArgsInput): string | undefined => {
  const input = asObject(args);
  const path =
    stringField(input, "path") ?? stringField(input, "file_path") ?? stringField(input, "cwd");
  switch (toolName.toLowerCase()) {
    case "bash":
      return stringField(input, "command");
    case "read":
    case "write":
    case "edit":
    case "ls":
      return path;
    case "grep": {
      const pattern = stringField(input, "pattern");
      return [pattern ? `/${pattern}/` : undefined, path].filter(Boolean).join(" · ");
    }
    case "find":
    case "glob":
      return [stringField(input, "pattern"), path].filter(Boolean).join(" · ");
    case "contact_parent":
      return [stringField(input, "kind"), stringField(input, "message")].filter(Boolean).join(": ");
    default:
      return (
        path ??
        stringField(input, "query") ??
        stringField(input, "id") ??
        stringField(input, "name") ??
        stringField(input, "message") ??
        stringField(input, "command")
      );
  }
};

function appendSessionEvent(
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
  const summary = toolTarget(input.toolName, input.args);
  const target = summary ? sanitizeDiagnosticText(summary, MAX_TOOL_TARGET_CHARS) : undefined;
  return appendSessionEvent(current, {
    type: "tool" as const,
    toolCallId: sanitizeDiagnosticText(input.toolCallId, MAX_PROTOCOL_ID_CHARS),
    toolName: sanitizeDiagnosticText(input.toolName, 200),
    ...(target && { target }),
    state: "running" as const,
    startedAt: input.startedAt,
  });
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
  const index = current.findLastIndex(
    (event) => event.type === "tool" && event.toolCallId === toolCallId,
  );
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
