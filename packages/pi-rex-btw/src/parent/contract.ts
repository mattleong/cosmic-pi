import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { countLabel, formatClockTime } from "pi-cosmic-core/display";
import {
  MAX_PARENT_MESSAGES,
  ParentConversationSchema,
  type ConversationItem,
  type ParentConversation,
} from "./transcript.ts";

export const PARENT_TOOL = "parent_conversation";

/** A read that failed: the parent's file is gone, or it couldn't be read safely. */
const ParentReadFailureSchema = Schema.Struct({
  failure: Schema.Literals(["missing", "unreadable"]),
  requested: Schema.Int,
});
export type ParentReadFailure = typeof ParentReadFailureSchema.Type;

const ParentToolDetailsSchema = Schema.Union([ParentConversationSchema, ParentReadFailureSchema]);
export type ParentToolDetails = typeof ParentToolDetailsSchema.Type;

export const decodeParentToolDetails = (
  result: AgentToolResult<unknown> | undefined,
): ParentToolDetails | undefined =>
  Option.getOrUndefined(
    Schema.decodeUnknownOption(ParentToolDetailsSchema, { onExcessProperty: "ignore" })(
      result?.details,
    ),
  );

export const isReadFailure = Schema.is(ParentReadFailureSchema);

/** Items that count as messages; a summary of earlier messages stands in for many. */
export const countedMessages = (conversation: ParentConversation): number =>
  Arr.filter(conversation.items, (item) => item.role !== "summary").length;

/** How a heading names a read: `last 15 messages`, or `all 6 messages` from the start. */
export const readLabel = (conversation: ParentConversation): string => {
  const count = countedMessages(conversation);
  if (count === 0) return "no messages yet";
  return `${conversation.earlier ? "last" : "all"} ${countLabel(count, "message")}`;
};

export const requestLabel = (requested: number): string =>
  `last ${countLabel(requested, "message")}`;

const ROLE_NAMES: Record<ConversationItem["role"], string> = {
  user: "user",
  assistant: "assistant",
  note: "note",
  shell: "user shell command",
  summary: "summary of earlier messages",
};

const modelItem = (item: ConversationItem): string => {
  const heading = Arr.join(
    Arr.filter(
      [
        ROLE_NAMES[item.role],
        item.source === undefined ? "" : `from ${item.source}`,
        item.at ?? "",
      ],
      Str.isNonEmpty,
    ),
    " · ",
  );
  const tools = Arr.map(
    item.tools,
    (tool) =>
      `- called ${tool.name} ${tool.input} → ${tool.outcome}${tool.output === "" ? "" : `: ${tool.output}`}`,
  );
  return Arr.join(Arr.filter([`[${heading}]`, item.text, ...tools], Str.isNonEmpty), "\n");
};

/** What the child's agent reads: the messages, oldest first, and how to see more. */
export const conversationText = (conversation: ParentConversation): string => {
  const count = countedMessages(conversation);
  if (conversation.items.length === 0)
    return "The parent session has no messages yet. Read it again once its user has sent one.";
  const more = conversation.earlier
    ? conversation.compacted
      ? " The parent compacted its earlier messages; the summary comes first."
      : count < MAX_PARENT_MESSAGES && conversation.requested < MAX_PARENT_MESSAGES
        ? ` Earlier messages exist; read again with a larger messages count, at most ${MAX_PARENT_MESSAGES}, to see more.`
        : " Earlier messages exist."
    : "";
  return Arr.join(
    [
      `The parent session's ${conversation.earlier ? "latest" : "only"} ${countLabel(count, "message")}, oldest first.${more} Read again whenever a question depends on what the parent is doing now.`,
      ...Arr.map(conversation.items, modelItem),
    ],
    "\n\n",
  );
};

const FAILURE_TEXT: Record<ParentReadFailure["failure"], string> = {
  missing:
    "The parent conversation is no longer available: its session file was moved or deleted. Tell the user this side session can't see the parent anymore.",
  unreadable:
    "The parent conversation couldn't be read: its session file isn't a regular file this session can open. Tell the user.",
};

export const failureText = (failure: ParentReadFailure): string => FAILURE_TEXT[failure.failure];

/** A short display form of an entry's time: `10:59 PM` today, otherwise `Nov 3, 10:59 PM`. */
export const entryTime = (at: string | undefined, now: number): string =>
  Option.match(at === undefined ? Option.none() : DateTime.make(at), {
    onNone: () => "",
    onSome: (moment) => formatClockTime(moment, now),
  });

export const trimmedLines = (text: string): ReadonlyArray<string> =>
  Fn.pipe(text, Str.trimEnd, Str.split("\n"));
