import {
  AssistantMessageComponent,
  BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent,
  CustomMessageComponent,
  getMarkdownTheme,
  ToolExecutionComponent,
  UserMessageComponent,
  type MessageRenderer,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, type TUI } from "@earendil-works/pi-tui";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { invokeHostCallback } from "pi-cosmic-core/host-session";
import { contentText } from "pi-cosmic-core/message-text";
import { decodeUnknownOrUndefined } from "pi-cosmic-core/schema/decode";
import { transcriptMessage, type TranscriptMessage } from "../boundary/session-transcript.ts";

type AssistantMessage = Extract<TranscriptMessage, { readonly role: "assistant" }>;

const ToolResultSchema = Schema.Struct({
  content: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      text: Schema.optionalKey(Schema.String),
      data: Schema.optionalKey(Schema.String),
      mimeType: Schema.optionalKey(Schema.String),
    }),
  ),
  details: Schema.optional(Schema.Json),
});
const ToolCallId = Schema.String.check(Schema.isMinLength(1));

/** The child events the transcript draws, as Pi's interactive mode reads them from its own run. */
const TranscriptEventSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["message_start", "message_update", "message_end"]),
    message: Schema.Json,
  }),
  Schema.Struct({
    type: Schema.Literal("tool_execution_start"),
    toolCallId: ToolCallId,
    toolName: Schema.String,
    args: Schema.optional(Schema.Json),
    /** Set on a call a codemode script made, which its parent's row shows. */
    parentToolCallId: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("tool_execution_update"),
    toolCallId: ToolCallId,
    partialResult: ToolResultSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("tool_execution_end"),
    toolCallId: ToolCallId,
    result: ToolResultSchema,
    isError: Schema.Boolean,
    durationMs: Schema.optional(Schema.Finite),
  }),
  Schema.Struct({ type: Schema.Literals(["agent_start", "agent_end", "compaction_end"]) }),
]);
const decodeTranscriptEvent = decodeUnknownOrUndefined(TranscriptEventSchema);

type ToolResult = typeof ToolResultSchema.Type;
const rowResult = (result: ToolResult, isError: boolean, durationMs?: number) => ({
  content: [...result.content],
  details: result.details,
  isError,
  ...(durationMs !== undefined && { durationMs }),
});

export interface SessionTranscriptOptions {
  readonly tui: TUI;
  /** The run's working directory, which tool rows shorten paths against. */
  readonly cwd: string;
  /** How this session draws a tool; a tool without renderers gets Pi's plain row. */
  readonly toolRenderers: (name: string) => ToolRenderers | undefined;
  readonly messageRenderer: (customType: string) => MessageRenderer | undefined;
}

interface Expandable {
  setExpanded(expanded: boolean): void;
}

/**
 * A run's conversation as rows, built from Pi's own message and tool components the way its
 * interactive mode builds its transcript, so a subagent's session reads like a session opened
 * natively. It holds presentation state only: the snapshot and events come from the run's owner.
 */
export class SessionTranscript {
  private readonly rows = new Container();
  private readonly pendingTools = new Map<string, ToolExecutionComponent>();
  private readonly expandable = new Set<Expandable>();
  private readonly assistants = new Set<AssistantMessageComponent>();
  private readonly options: SessionTranscriptOptions;
  private streaming: AssistantMessageComponent | undefined;
  private expanded = false;
  private thinkingHidden = false;
  private turnActive = false;
  private userMessages = 0;

  constructor(options: SessionTranscriptOptions) {
    this.options = options;
  }

  /** Whether the child said its turn is running; a snapshot alone can't tell. */
  get working(): boolean {
    return this.turnActive;
  }

  /** The user messages drawn since the last snapshot, so a view can tell a sent one arrived. */
  get userMessageCount(): number {
    return this.userMessages;
  }

  get toolsExpanded(): boolean {
    return this.expanded;
  }

  render(width: number): string[] {
    return this.rows.render(width);
  }

  invalidate(): void {
    this.rows.invalidate();
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    for (const row of this.expandable) row.setExpanded(expanded);
  }

  toggleThinking(): void {
    this.thinkingHidden = !this.thinkingHidden;
    for (const row of this.assistants) row.setHideThinkingBlock(this.thinkingHidden);
  }

  /**
   * Replaces every row with the conversation so far. In a `live` conversation, a call without a
   * result is running: its start came before the snapshot, so no event will say so.
   */
  reset(messages: ReadonlyArray<TranscriptMessage>, live: boolean): void {
    this.rows.clear();
    this.pendingTools.clear();
    this.expandable.clear();
    this.assistants.clear();
    this.streaming = undefined;
    this.turnActive = false;
    this.userMessages = 0;
    for (const message of messages) this.guarded(() => this.addSaved(message));
    if (!live) return;
    for (const tool of this.pendingTools.values())
      this.guarded(() => {
        tool.setArgsComplete();
        tool.markExecutionStarted();
      });
    this.turnActive = this.pendingTools.size > 0;
  }

  /**
   * Applies one child event. Returns `stale` when the conversation changed in a way the events
   * don't carry, such as a compaction, so the owner should take a new snapshot.
   */
  apply(value: Schema.Json): "applied" | "stale" {
    const event = decodeTranscriptEvent(value);
    if (!event) return "applied";
    if (event.type === "compaction_end") return "stale";
    this.guarded(() => {
      switch (event.type) {
        case "agent_start":
          this.turnActive = true;
          break;
        case "compaction_end":
          break;
        case "agent_end":
          this.turnActive = false;
          if (this.streaming) this.rows.removeChild(this.streaming);
          this.streaming = undefined;
          this.pendingTools.clear();
          break;
        case "message_start":
        case "message_update":
        case "message_end": {
          const message = transcriptMessage(event.message);
          if (message) this.applyMessage(event.type, message);
          break;
        }
        case "tool_execution_start": {
          if (event.parentToolCallId !== undefined) break;
          const row =
            this.pendingTools.get(event.toolCallId) ??
            this.addTool(event.toolCallId, event.toolName, event.args);
          row.markExecutionStarted();
          break;
        }
        case "tool_execution_update":
          this.pendingTools
            .get(event.toolCallId)
            ?.updateResult(rowResult(event.partialResult, false), true);
          break;
        case "tool_execution_end":
          this.pendingTools
            .get(event.toolCallId)
            ?.updateResult(rowResult(event.result, event.isError, event.durationMs));
          this.pendingTools.delete(event.toolCallId);
      }
    });
    return "applied";
  }

  // Pi's components read messages Pi's session reader typed without checking; a malformed one must
  // cost its own row, never the view.
  private guarded(draw: () => void): void {
    invokeHostCallback(draw, undefined);
  }

  private applyMessage(
    phase: "message_start" | "message_update" | "message_end",
    message: TranscriptMessage,
  ): void {
    if (message.role !== "assistant") {
      // A tool result arrives with its tool's end, and a saved message was drawn when it started.
      if (phase === "message_start" && message.role !== "toolResult") this.addSaved(message);
      return;
    }
    this.turnActive = true;
    const row = (this.streaming ??= this.addAssistant(undefined));
    row.updateContent(message, phase !== "message_end");
    if (phase !== "message_end") {
      for (const part of message.content) {
        if (part.type !== "toolCall") continue;
        const tool = this.pendingTools.get(part.id);
        if (tool) tool.updateArgs(part.arguments);
        else this.addTool(part.id, part.name, part.arguments);
      }
      return;
    }
    this.streaming = undefined;
    const failure = assistantFailure(message);
    if (failure === undefined) {
      for (const tool of this.pendingTools.values()) tool.setArgsComplete();
      return;
    }
    for (const tool of this.pendingTools.values())
      tool.updateResult({ content: [{ type: "text", text: failure }], isError: true });
    this.pendingTools.clear();
  }

  private addSaved(message: TranscriptMessage): void {
    switch (message.role) {
      case "user": {
        const text = contentText(message.content);
        if (!text) break;
        this.userMessages++;
        if (this.rows.children.length > 0) this.rows.addChild(new Spacer(1));
        this.rows.addChild(new UserMessageComponent(text, getMarkdownTheme()));
        break;
      }
      case "assistant": {
        this.addAssistant(message);
        const failure = assistantFailure(message);
        for (const part of message.content) {
          if (part.type !== "toolCall") continue;
          const tool = this.addTool(part.id, part.name, part.arguments);
          if (failure === undefined) continue;
          tool.updateResult({ content: [{ type: "text", text: failure }], isError: true });
          this.pendingTools.delete(part.id);
        }
        break;
      }
      case "toolResult":
        this.pendingTools.get(message.toolCallId)?.updateResult(message);
        this.pendingTools.delete(message.toolCallId);
        break;
      case "custom": {
        if (!message.display) break;
        const row = new CustomMessageComponent(
          message,
          this.options.messageRenderer(message.customType),
          getMarkdownTheme(),
        );
        this.track(row);
        this.rows.addChild(row);
        break;
      }
      case "compactionSummary":
      case "branchSummary": {
        const row =
          message.role === "compactionSummary"
            ? new CompactionSummaryMessageComponent(message, getMarkdownTheme())
            : new BranchSummaryMessageComponent(message, getMarkdownTheme());
        this.track(row);
        this.rows.addChild(new Spacer(1));
        this.rows.addChild(row);
        break;
      }
      // A subagent's session has no shell commands the user ran, and system messages aren't drawn.
      case "bashExecution":
      case "system":
    }
  }

  private addAssistant(message: AssistantMessage | undefined): AssistantMessageComponent {
    const row = new AssistantMessageComponent(message, this.thinkingHidden, getMarkdownTheme());
    this.assistants.add(row);
    this.rows.addChild(row);
    return row;
  }

  private addTool(id: string, name: string, args: Schema.Json | undefined): ToolExecutionComponent {
    const row = new ToolExecutionComponent(
      name,
      id,
      args,
      undefined,
      invokeHostCallback(() => this.options.toolRenderers(name), undefined),
      this.options.tui,
      this.options.cwd,
    );
    this.track(row);
    this.rows.addChild(row);
    this.pendingTools.set(id, row);
    return row;
  }

  private track(row: Expandable): void {
    row.setExpanded(this.expanded);
    this.expandable.add(row);
  }
}

/** What an assistant message that didn't finish says on its pending tool rows, as Pi words it. */
const assistantFailure = (message: AssistantMessage): string | undefined => {
  if (message.stopReason === "aborted") return "Operation aborted";
  if (message.stopReason === "error")
    return Str.isNonEmpty(message.errorMessage ?? "") ? message.errorMessage : "Error";
  return undefined;
};
