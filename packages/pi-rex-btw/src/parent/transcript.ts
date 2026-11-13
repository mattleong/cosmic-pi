import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { contentText } from "pi-cosmic-core/message-text";
import { decodeUnknownOrUndefined } from "pi-cosmic-core/schema/decode";
import { safeTextPrefix } from "pi-cosmic-core/text";

/** Messages a read returns when the agent doesn't say. */
export const DEFAULT_PARENT_MESSAGES = 15;
/** The most messages one read returns; larger requests read this many. */
export const MAX_PARENT_MESSAGES = 50;

// Bounds keep one read's result small enough for the child's context and the saved transcript.
const MAX_TEXT_CHARS = 4_000;
const MAX_TOOL_INPUT_CHARS = 200;
const MAX_TOOL_SUBJECT_CHARS = 120;
const MAX_TOOL_OUTPUT_CHARS = 300;
const MAX_RESULT_CHARS = 48_000;

/** Clamps a requested message count: absent, zero, or negative reads the default. */
export const parentMessageCount = (requested: number | undefined): number =>
  requested === undefined || !Number.isFinite(requested) || requested < 1
    ? DEFAULT_PARENT_MESSAGES
    : Math.min(MAX_PARENT_MESSAGES, Math.floor(requested));

const ToolUseSchema = Schema.Struct({
  name: Schema.String,
  /** The raw arguments as one clipped JSON line, for the agent. */
  input: Schema.String,
  /** The argument a person recognizes the call by, such as a command or path; may be empty. */
  subject: Schema.String,
  outcome: Schema.Literals(["done", "failed", "pending"]),
  output: Schema.String,
});
export type ToolUse = typeof ToolUseSchema.Type;

const ConversationItemSchema = Schema.Struct({
  role: Schema.Literals(["user", "assistant", "note", "shell", "summary"]),
  /** Where a note came from, such as another extension's message type. */
  source: Schema.optionalKey(Schema.String),
  at: Schema.optionalKey(Schema.String),
  text: Schema.String,
  tools: Schema.Array(ToolUseSchema),
});
export type ConversationItem = typeof ConversationItemSchema.Type;

/** What one read found: the latest messages, oldest first, and what came before them. */
export const ParentConversationSchema = Schema.Struct({
  parentId: Schema.String,
  requested: Schema.Int,
  items: Schema.Array(ConversationItemSchema),
  /** Earlier messages exist beyond this read. */
  earlier: Schema.Boolean,
  /** The parent compacted earlier messages into a summary, the first item. */
  compacted: Schema.Boolean,
});
export type ParentConversation = typeof ParentConversationSchema.Type;

// Pi's session entries, decoded only as far as a reader needs. Anything else is skipped.
const TextPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
const ToolCallPart = Schema.Struct({
  type: Schema.Literal("toolCall"),
  id: Schema.String,
  name: Schema.String,
  arguments: Schema.optionalKey(Schema.Json),
});
const OtherPart = Schema.Struct({ type: Schema.String });
const Part = Schema.Union([TextPart, ToolCallPart, OtherPart]);
const Content = Schema.Union([Schema.String, Schema.Array(Part)]);

const UserMessage = Schema.Struct({ role: Schema.Literal("user"), content: Content });
const AssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.Array(Part),
});
const ToolResultMessage = Schema.Struct({
  role: Schema.Literal("toolResult"),
  toolCallId: Schema.String,
  content: Content,
  isError: Schema.optionalKey(Schema.Boolean),
});
const ShellMessage = Schema.Struct({
  role: Schema.Literal("bashExecution"),
  command: Schema.String,
  output: Schema.String,
  exitCode: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
});
const CustomMessage = Schema.Struct({
  role: Schema.Literal("custom"),
  customType: Schema.String,
  content: Content,
  display: Schema.Boolean,
});
const Message = Schema.Union([
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  ShellMessage,
  CustomMessage,
]);

const Entry = Schema.Struct({
  type: Schema.String,
  id: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  timestamp: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.Unknown),
  summary: Schema.optionalKey(Schema.String),
  customType: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Content),
  display: Schema.optionalKey(Schema.Boolean),
});
type Entry = typeof Entry.Type;

const decodeOptions = { onExcessProperty: "ignore" } as const;
const decodeEntryLine = decodeUnknownOrUndefined(Schema.fromJsonString(Entry), decodeOptions);
const decodeMessage = decodeUnknownOrUndefined(Message, decodeOptions);
const isToolCallPart = Schema.is(ToolCallPart);

const clip = (text: string, limit: number): string =>
  text.length <= limit
    ? text
    : `${safeTextPrefix(text, limit)}… (${text.length - limit} more characters)`;

const oneLine = (text: string, limit: number): string => {
  const flat = Fn.pipe(text, Str.replace(/\s+/gu, " "), Str.trim);
  return flat.length <= limit ? flat : `${safeTextPrefix(flat, limit)}…`;
};

const toolInput = (input: Schema.Json | undefined): string => {
  const encoded: string | undefined = Predicate.isString(input) ? input : JSON.stringify(input);
  return oneLine(encoded ?? "", MAX_TOOL_INPUT_CHARS);
};

// Arguments that name what a call acts on, in the order a person would look for them.
const SUBJECT_ARGUMENTS = [
  "command",
  "path",
  "file_path",
  "pattern",
  "query",
  "url",
  "name",
  "prompt",
  "message",
  "task",
] as const;

/** The call's subject: its first well-known string argument, else its first string argument. */
const toolSubject = (input: Schema.Json | undefined): string => {
  if (Predicate.isString(input)) return oneLine(input, MAX_TOOL_SUBJECT_CHARS);
  if (!Predicate.isObject(input)) return "";
  const subject = Arr.findFirst([...SUBJECT_ARGUMENTS, ...Rec.keys(input)], (key) => {
    const value = input[key];
    return Predicate.isString(value) && Str.isNonEmpty(Str.trim(value))
      ? Option.some(value)
      : Option.none();
  });
  return Option.match(subject, {
    onNone: () => "",
    onSome: (value) => oneLine(value, MAX_TOOL_SUBJECT_CHARS),
  });
};

interface ToolResult {
  readonly failed: boolean;
  readonly output: string;
}

const item = (
  role: ConversationItem["role"],
  entry: Entry,
  text: string,
  tools: ReadonlyArray<ToolUse> = [],
  source?: string,
): ConversationItem => ({
  role,
  ...(source !== undefined && { source }),
  ...(entry.timestamp !== undefined && { at: entry.timestamp }),
  text: clip(Str.trim(text), MAX_TEXT_CHARS),
  tools,
});

/** One entry as a conversation item, or undefined when it isn't one a reader follows. */
const entryItem = (
  entry: Entry,
  results: ReadonlyMap<string, ToolResult>,
): ConversationItem | undefined => {
  if (entry.type === "custom_message")
    return entry.display === true && entry.content !== undefined
      ? item("note", entry, contentText(entry.content), [], entry.customType)
      : undefined;
  if (
    (entry.type === "branch_summary" || entry.type === "compaction") &&
    entry.summary !== undefined
  )
    return item("summary", entry, entry.summary);
  if (entry.type !== "message") return undefined;
  const message = decodeMessage(entry.message);
  if (message === undefined) return undefined;
  switch (message.role) {
    case "user":
      return item("user", entry, contentText(message.content));
    case "assistant": {
      const tools = Arr.map(Arr.filter(message.content, isToolCallPart), (call): ToolUse => {
        const result = results.get(call.id);
        return {
          name: oneLine(call.name, MAX_TOOL_INPUT_CHARS),
          input: toolInput(call.arguments),
          subject: toolSubject(call.arguments),
          outcome: result === undefined ? "pending" : result.failed ? "failed" : "done",
          output: result?.output ?? "",
        };
      });
      const text = contentText(message.content);
      return Str.isNonEmpty(Str.trim(text)) || tools.length > 0
        ? item("assistant", entry, text, tools)
        : undefined;
    }
    case "bashExecution":
      return item(
        "shell",
        entry,
        `$ ${message.command}\n${clip(message.output, MAX_TOOL_OUTPUT_CHARS)}`,
      );
    case "custom":
      return message.display
        ? item("note", entry, contentText(message.content), [], message.customType)
        : undefined;
    // A tool's result belongs to the call that asked for it.
    case "toolResult":
    default:
      return undefined;
  }
};

const toolResultOf = (entry: Entry): readonly [string, ToolResult] | undefined => {
  if (entry.type !== "message") return undefined;
  const message = decodeMessage(entry.message);
  return message?.role === "toolResult"
    ? [
        message.toolCallId,
        {
          failed: message.isError === true,
          output: oneLine(contentText(message.content), MAX_TOOL_OUTPUT_CHARS),
        },
      ]
    : undefined;
};

const itemChars = (entry: ConversationItem): number =>
  entry.text.length +
  Arr.reduce(
    entry.tools,
    0,
    (total, tool) => total + tool.input.length + tool.subject.length + tool.output.length,
  );

const NO_RESULTS: ReadonlyMap<string, ToolResult> = new Map();

/**
 * Whether an entry is a message a read counts, as opposed to state, a tool's result, or a summary,
 * which stands in for many messages and comes along uncounted.
 */
const isCounted = (entry: Entry): boolean => {
  const counted = entryItem(entry, NO_RESULTS);
  return counted !== undefined && counted.role !== "summary";
};

/** The newest items whose text fits one result; at least the newest one is kept. */
const fitting = (items: ReadonlyArray<ConversationItem>): ReadonlyArray<ConversationItem> => {
  let total = 0;
  let kept = 0;
  for (const entry of Arr.reverse(items)) {
    total += itemChars(entry);
    if (kept > 0 && total > MAX_RESULT_CHARS) break;
    kept++;
  }
  return Arr.takeRight(items, kept);
};

/**
 * The latest `requested` messages on the parent's current branch, from the end of its session file.
 * `text` holds whole JSONL lines unless `truncated`, when its first line may be cut and is skipped.
 * The branch is followed back from the newest entry through each entry's parent; it ends at the
 * session's start, at a compaction (whose summary becomes the first item), or where the read
 * window ends.
 */
export const parentConversation = (
  parentId: string,
  text: string,
  truncated: boolean,
  requested: number,
): ParentConversation => {
  const lines = Str.split(text, "\n");
  const entries = Arr.flatMap(truncated ? Arr.drop(lines, 1) : lines, (line) =>
    Arr.fromNullishOr(decodeEntryLine(line)),
  );
  const byId = new Map(Arr.map(entries, (entry) => [entry.id, entry] as const));
  const branch: Entry[] = [];
  let compacted = false;
  let earlier = false;
  let counted = 0;
  let next = Option.getOrUndefined(Arr.last(entries));
  while (next !== undefined) {
    if (next.type === "compaction") {
      compacted = true;
      earlier = true;
      branch.push(next);
      break;
    }
    if (isCounted(next)) {
      if (counted >= requested) {
        earlier = true;
        break;
      }
      counted++;
    }
    branch.push(next);
    if (next.parentId === null) break;
    next = byId.get(next.parentId);
    // The branch continues before the read window.
    if (next === undefined) earlier = true;
  }
  const chronological = Arr.reverse(branch);
  const results = new Map(
    Arr.flatMap(chronological, (entry) => Arr.fromNullishOr(toolResultOf(entry))),
  );
  const items = Arr.flatMap(chronological, (entry) => Arr.fromNullishOr(entryItem(entry, results)));
  const kept = fitting(items);
  return {
    parentId,
    requested,
    items: kept,
    earlier: earlier || kept.length < items.length,
    compacted: compacted && kept.length === items.length,
  };
};
