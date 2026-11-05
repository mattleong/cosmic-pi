import type { AgentToolResult, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Container, Text, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
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
} from "pi-code-previews";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import { SUITE_STATUS_GLYPHS } from "pi-cosmic-ui/manager";
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
    detail:
      "Its session file was moved or deleted, so this side session can't see the parent. Run /btw in the parent session again to open one that can.",
  },
  unreadable: {
    severity: "error",
    code: "parent_conversation:unreadable",
    message: "Couldn't read the parent conversation",
    detail:
      "Its session file isn't a regular file this session can open. Run /btw in the parent session again to open one that can.",
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
    return {
      subject: requested,
      outcome: "error",
      issues: [failureIssue(details)],
      expandLabel: "details",
    };
  return {
    subject: readLabel(details),
    metadata: details.compacted ? ["after compaction"] : [],
    outcome: "success",
    // Collapsed rows show only the heading; expansion shows the whole read, or the parent's id.
    expandLabel: details.items.length > 0 ? "messages" : "details",
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

// A call's outcome as codemode's calls mark theirs. One still running when the parent's file was
// read is neutral, since a spinner would freeze.
const TOOL_STATUS = {
  done: { glyph: SUITE_STATUS_GLYPHS.succeeded, color: "success", text: "dim" },
  failed: { glyph: SUITE_STATUS_GLYPHS.failed, color: "error", text: "toolOutput" },
  pending: { glyph: SUITE_STATUS_GLYPHS.neutral, color: "accent", text: "muted" },
} as const satisfies Record<
  ToolUse["outcome"],
  {
    readonly glyph: string;
    readonly color: ThemeColor;
    readonly text: ThemeColor;
  }
>;

/** The calls a message made, one per row as `✗ bash pnpm test`, wrapping beneath the call. */
const toolRows = (tools: ReadonlyArray<ToolUse>, theme: Theme): Component => {
  let cached: { readonly width: number; readonly rows: string[] } | undefined;
  return {
    render(width) {
      if (!Number.isFinite(width) || width < 1) return [];
      if (cached?.width === width) return cached.rows;
      const rows = Arr.flatMap(tools, (tool) => {
        const status = TOOL_STATUS[tool.outcome];
        const call = sanitizeTerminalLine(
          Str.isEmpty(tool.subject) ? tool.name : `${tool.name} ${tool.subject}`,
        );
        return Arr.map(wrapTextWithAnsi(call, Math.max(1, width - 2)), (part, index) =>
          index === 0
            ? `${theme.fg(status.color, status.glyph)} ${theme.fg(status.text, part)}`
            : `  ${theme.fg(status.text, part)}`,
        );
      });
      cached = { width, rows };
      return rows;
    },
    invalidate() {
      cached = undefined;
    },
  };
};

const authored = (text: string, theme: Theme, verbatim: boolean): Component => ({
  render: (width) =>
    Number.isFinite(width) && width > 0
      ? authoredTextLines(text, width, theme, { expanded: true, indent: 0, verbatim })
      : [],
  invalidate() {},
});

/** One message: a muted label with its time, its words as markdown, then the tools it ran. */
const itemSection = (item: ConversationItem, theme: Theme, now: number): Component =>
  expandedSection(
    theme,
    itemLabel(item, now),
    ...(Str.isNonEmpty(item.text) ? [authored(item.text, theme, item.role === "shell")] : []),
    ...(item.tools.length > 0
      ? [expandedSection(theme, undefined, toolRows(item.tools, theme))]
      : []),
  );

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

/** What the call heading names once a result says it: the read, as the compact heading does. */
export interface ParentRenderState {
  read?: string | undefined;
}

/**
 * The body below the heading. Expanded, the whole read; collapsed, nothing more, since the heading
 * says how much it read.
 */
export const parentResultBody = (
  result: AgentToolResult<unknown>,
  theme: Theme,
  options: { readonly expanded: boolean; readonly compact: boolean },
): Component => {
  const details = decodeParentToolDetails(result);
  if (details === undefined)
    return options.expanded ? fallbackText(result, theme) : new Container();
  if (isReadFailure(details) || !options.expanded) return new Container();
  return conversationBody(
    details,
    theme,
    DateTime.toEpochMillis(DateTime.nowUnsafe()),
    options.compact,
  );
};

interface RenderContext {
  readonly expanded: boolean;
  readonly executionStarted: boolean;
  readonly isPartial: boolean;
}

/**
 * The preview heading: `Parent conversation last 15 messages` as requested, then what the read
 * found once settled, such as `all 4 messages`; its issues follow.
 */
export const renderParentCall = (
  args: ParentToolArgs,
  theme: Theme,
  context: RenderContext & { readonly state: ParentRenderState },
): Component => {
  const header = composeToolComponent((width) => {
    if (!Number.isFinite(width) || width < 1) return [];
    const subtitle = context.state.read ?? requestLabel(parentMessageCount(args.messages));
    return new Text(
      renderToolHeader({ title: "Parent conversation", subtitle }, theme),
      0,
      0,
    ).render(width);
  });
  const running = composeToolComponent((width) =>
    width >= 1 && context.executionStarted && context.isPartial ? [toolRunningLine(theme)] : [],
  );
  // Issues follow the heading, so an expanded preview row reuses only the heading above them.
  const body = new Container();
  body.addChild(header);
  body.addChild(previewIssuesSlot(context));
  body.addChild(running);
  return body;
};

export const renderParentResult = (
  result: AgentToolResult<unknown>,
  options: { readonly expanded: boolean; readonly isPartial: boolean },
  theme: Theme,
  context: { readonly state: ParentRenderState },
): Component => {
  if (options.isPartial) return new Container();
  const details = decodeParentToolDetails(result);
  context.state.read =
    details === undefined || isReadFailure(details) ? undefined : readSummary(details);
  return parentResultBody(result, theme, { expanded: options.expanded, compact: false });
};
