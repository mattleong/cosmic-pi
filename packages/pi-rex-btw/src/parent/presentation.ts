import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Str from "effect/String";
import {
  authoredTextLines,
  expandedBody,
  expandedDetails,
  expandedSection,
  expandedText,
  getTextContent,
  previewIssuesSlot,
  type CompactIssue,
  type CompactSummaryProvider,
  type ExpandedLine,
} from "pi-code-previews";
import { composeToolComponent, renderToolHeader, toolRunningLine } from "pi-cosmic-ui/tool";
import {
  decodeParentToolDetails,
  entryTime,
  isReadFailure,
  readLabel,
  requestLabel,
  trimmedLines,
  type ParentReadFailure,
} from "./contract.ts";
import {
  parentMessageCount,
  type ConversationItem,
  type ParentConversation,
  type ToolUse,
} from "./transcript.ts";

export interface ParentToolArgs {
  readonly messages?: number | undefined;
}

const ISSUES: Record<ParentReadFailure["failure"], CompactIssue> = {
  missing: {
    severity: "error",
    code: "parent_conversation:missing",
    message: "The parent conversation is no longer available",
    detail: "Its session file was moved or deleted, so this side session can't see the parent.",
  },
  unreadable: {
    severity: "error",
    code: "parent_conversation:unreadable",
    message: "Couldn't read the parent conversation",
    detail: "Its session file isn't a regular file this session can open.",
  },
};

export const failureIssue = (failure: ParentReadFailure): CompactIssue => ISSUES[failure.failure];

/** `parent_conversation last 15 messages`; a failed read keeps its request and says why. */
export const parentCompactSummary: CompactSummaryProvider<ParentToolArgs> = ({
  phase,
  args,
  result,
}) => {
  const requested = requestLabel(parentMessageCount(args.messages));
  if (phase !== "settled") return { subject: requested };
  const details = decodeParentToolDetails(result);
  if (details === undefined) return undefined;
  if (isReadFailure(details))
    return { subject: requested, outcome: "error", issues: [failureIssue(details)] };
  return {
    subject: readLabel(details),
    metadata: details.compacted ? ["after compaction"] : [],
    outcome: "success",
  };
};

const ROLE_LABELS: Record<ConversationItem["role"], string> = {
  user: "User",
  assistant: "Assistant",
  note: "Note",
  shell: "Shell command",
  summary: "Summary of earlier messages",
};

// What the suite's own message types are to a person; a note of any other type is an extension's.
const NOTE_LABELS: ReadonlyMap<string, string> = new Map([
  ["pi-intercom-message", "Message from another session"],
  ["pi-subagents-completed", "Agent report"],
  ["pi-subagents-question", "Agent question"],
  ["pi-subagents-agent-message", "Message from an agent"],
  ["pi-subagents-stopped", "Agents stopped"],
  ["pi-background-task-finished", "Background task finished"],
  ["pi-ask-user-async-answer", "Questionnaire answer"],
  ["openai-image", "Generated image"],
]);

const roleLabel = (item: ConversationItem): string =>
  item.role === "note" && item.source !== undefined
    ? (NOTE_LABELS.get(item.source) ?? "Extension message")
    : ROLE_LABELS[item.role];

const itemLabel = (item: ConversationItem, now: number): string =>
  Arr.join(Arr.filter([roleLabel(item), entryTime(item.at, now)], Str.isNonEmpty), " · ");

const TOOL_TONES = { done: "dim", failed: "error", pending: "muted" } as const;

const TOOL_STATES = { done: "finished", failed: "failed", pending: "running" } as const;

/** A call as the transcript names it: `bash pnpm test · failed`. */
const toolLine = (tool: ToolUse): ExpandedLine => ({
  text: Arr.join(
    [
      Str.isEmpty(tool.subject) ? tool.name : `${tool.name} ${tool.subject}`,
      TOOL_STATES[tool.outcome],
    ],
    " · ",
  ),
  tone: TOOL_TONES[tool.outcome],
});

const authored = (text: string, theme: Theme, verbatim: boolean): Component => ({
  render: (width) =>
    Number.isFinite(width) && width > 0
      ? authoredTextLines(text, width, theme, { expanded: true, indent: 0, verbatim })
      : [],
  invalidate() {},
});

/** One message: a muted label with its time, its words as markdown, then the tools it ran. */
const itemSection = (item: ConversationItem, theme: Theme, now: number): Component => {
  const tools = Arr.map(item.tools, toolLine);
  return expandedSection(
    theme,
    itemLabel(item, now),
    ...(Str.isNonEmpty(item.text) ? [authored(item.text, theme, item.role === "shell")] : []),
    ...(tools.length > 0 ? [expandedText(theme, undefined, tools)] : []),
  );
};

/**
 * Expanded, every message the read returned in order, then the parent session's id. A compact
 * heading already says when there are no messages yet.
 */
export const conversationBody = (
  conversation: ParentConversation,
  theme: Theme,
  now: number,
  compact: boolean,
): Component =>
  expandedBody(
    conversation.items.length === 0 && !compact
      ? expandedText(theme, undefined, [{ text: "No messages yet", tone: "muted" }])
      : undefined,
    ...Arr.map(conversation.items, (item) => itemSection(item, theme, now)),
    expandedDetails(theme, [`Parent session ${conversation.parentId}`]),
  );

const fallbackText = (result: AgentToolResult<unknown>, theme: Theme): Component =>
  expandedText(theme, undefined, trimmedLines(getTextContent(result.content)));

const readSummary = (conversation: ParentConversation): string =>
  Arr.join(
    [readLabel(conversation), ...(conversation.compacted ? ["after compaction"] : [])],
    " · ",
  );

/**
 * The body below the heading. Expanded, the whole read; collapsed, a preview heading adds how much
 * it read, which a compact heading already says.
 */
export const parentResultBody = (
  result: AgentToolResult<unknown>,
  theme: Theme,
  options: { readonly expanded: boolean; readonly compact: boolean },
): Component => {
  const details = decodeParentToolDetails(result);
  if (details === undefined)
    return options.expanded ? fallbackText(result, theme) : new Container();
  if (isReadFailure(details)) return new Container();
  if (options.expanded)
    return conversationBody(
      details,
      theme,
      DateTime.toEpochMillis(DateTime.nowUnsafe()),
      options.compact,
    );
  return options.compact
    ? new Container()
    : new Text(theme.fg("muted", readSummary(details)), 0, 0);
};

interface RenderContext {
  readonly expanded: boolean;
  readonly executionStarted: boolean;
  readonly isPartial: boolean;
}

/** The preview heading: `Parent conversation latest messages`, with its issues once settled. */
export const renderParentCall = (
  _args: ParentToolArgs,
  theme: Theme,
  context: RenderContext & { readonly state: object },
): Component => {
  const header = composeToolComponent((width) => {
    if (!Number.isFinite(width) || width < 1) return [];
    const lines = new Text(
      renderToolHeader({ title: "Parent conversation", subtitle: "latest messages" }, theme),
      0,
      0,
    ).render(width);
    return context.executionStarted && context.isPartial
      ? [...lines, toolRunningLine(theme)]
      : lines;
  });
  const issues = previewIssuesSlot(context);
  return composeToolComponent((width) => [...header.render(width), ...issues.render(width)]);
};

export const renderParentResult = (
  result: AgentToolResult<unknown>,
  options: { readonly expanded: boolean; readonly isPartial: boolean },
  theme: Theme,
): Component =>
  options.isPartial
    ? new Container()
    : parentResultBody(result, theme, { expanded: options.expanded, compact: false });
