import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { SubagentSessionEvent } from "./model.ts";
import { MAX_PROTOCOL_ID_CHARS } from "./limits.ts";
import { sanitizeDiagnosticText, sanitizeOutputText } from "./state.ts";

const MAX_SESSION_EVENTS = 120;
const MAX_SESSION_BYTES = 192 * 1024;
const MAX_TOOL_TARGET_CHARS = 500;
const MAX_ASSISTANT_TEXT_CHARS = 16 * 1024;
const MAX_NOTICE_CHARS = 4 * 1024;
const MAX_TOOL_PREVIEW_CHARS = 1_200;

const ToolArgumentsSchema = Schema.Record(Schema.String, Schema.Unknown);
type ToolArguments = typeof ToolArgumentsSchema.Type;
const decodeToolArguments = Fn.flow(
  Schema.decodeUnknownOption(ToolArgumentsSchema),
  Option.getOrUndefined,
);

const stringField = (value: ToolArguments | undefined, key: string): string | undefined => {
  const field = value?.[key];
  return Predicate.isString(field) && field.trim() ? field.trim() : undefined;
};

const eventBytes = new WeakMap<SubagentSessionEvent, number>();

const bytes = (event: SubagentSessionEvent): number => {
  const cached = eventBytes.get(event);
  if (cached !== undefined) return cached;
  const size = Buffer.byteLength(JSON.stringify(event), "utf8");
  eventBytes.set(event, size);
  return size;
};

const toolTarget = (toolName: string, input: ToolArguments | undefined): string | undefined => {
  const path =
    stringField(input, "path") ?? stringField(input, "file_path") ?? stringField(input, "cwd");
  const fallbackTarget = () =>
    path ??
    stringField(input, "query") ??
    stringField(input, "id") ??
    stringField(input, "name") ??
    stringField(input, "message") ??
    stringField(input, "command");
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
    case "agent_contact_parent":
      return [stringField(input, "kind"), stringField(input, "message")].filter(Boolean).join(": ");
    default:
      return fallbackTarget();
  }
};

function appendSessionEvent(
  current: ReadonlyArray<SubagentSessionEvent>,
  event: SubagentSessionEvent,
): ReadonlyArray<SubagentSessionEvent> {
  if (bytes(event) > MAX_SESSION_BYTES) return current;
  return fitSessionEvents([...current, event].slice(-MAX_SESSION_EVENTS));
}

// Keeps the newest events that fit the byte budget.
function fitSessionEvents(
  next: ReadonlyArray<SubagentSessionEvent>,
): ReadonlyArray<SubagentSessionEvent> {
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

/** Records an agent message this run received (`in`) or sent (`out`). */
export function appendMessageSessionEvent(
  current: ReadonlyArray<SubagentSessionEvent>,
  direction: "in" | "out",
  peer: string,
  text: string,
  createdAt: number,
): ReadonlyArray<SubagentSessionEvent> {
  return appendSessionEvent(current, {
    type: "notice",
    kind: "message",
    direction,
    peer: sanitizeDiagnosticText(peer, MAX_PROTOCOL_ID_CHARS),
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
  const summary = toolTarget(input.toolName, decodeToolArguments(input.args));
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
    readonly outputPreview?: string | undefined;
  },
): ReadonlyArray<SubagentSessionEvent> {
  const toolCallId = sanitizeDiagnosticText(input.toolCallId, MAX_PROTOCOL_ID_CHARS);
  const outputPreview =
    input.outputPreview && sanitizeOutputText(input.outputPreview, MAX_TOOL_PREVIEW_CHARS).trim();
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
      ...(outputPreview && { outputPreview }),
    });
  return fitSessionEvents(
    current.map((event, eventIndex) =>
      eventIndex === index && event.type === "tool"
        ? {
            ...event,
            state: input.isError ? "failed" : "completed",
            endedAt: input.endedAt,
            ...(outputPreview && { outputPreview }),
          }
        : event,
    ),
  );
}

// Tool calls still open when an assignment stops never finish; closing them keeps an interrupted
// call from looking like a live one after the run resumes.
export const closeOpenToolSessionEvents = (
  current: ReadonlyArray<SubagentSessionEvent>,
): ReadonlyArray<SubagentSessionEvent> =>
  current.some((event) => event.type === "tool" && event.state === "running")
    ? current.map((event) =>
        event.type === "tool" && event.state === "running"
          ? { ...event, state: "failed" as const, endedAt: event.startedAt }
          : event,
      )
    : current;
