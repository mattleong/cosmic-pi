import type { MessageRenderer, MessageRenderOptions, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { clipToWidth } from "pi-cosmic-ui/manager";
import {
  composeToolComponent,
  renderExpansionAffordance,
  renderToolHeader,
  toolExpandHint,
} from "pi-cosmic-ui/tool";
import type { ToolCallBackgroundMode, ToolCallCollapsedStyle } from "../config/schema";
import { sharedPresentation } from "../config/state";
import { escapeControlChars } from "../shared/terminal-text";
import { planCompactPresentation } from "../tools/compact-presentation";
import { compactStatus, type CompactSummary } from "../tools/compact-summary";
import { BorderedToolCall, statusBorderColor } from "./bordered-tool-call";
import { renderCompactIssues } from "./compact-issues";
import { compactSingleLine, renderCompactRow } from "./compact-row";
import { statusBackground } from "./self-background";

/** A custom message presented like a settled tool row: its heading, then what someone wrote. */
export interface CodePreviewMessage {
  /** The compact row's label, like a tool name. */
  readonly name: string;
  /** The preview heading's title; defaults to `name`. */
  readonly label?: string | undefined;
  /** The settled heading: action, subject, counters, metadata, outcome, and issues. */
  readonly summary: CompactSummary;
  /** The collapsed body, which the caller bounds. Omitted, a compact row stands alone. */
  readonly collapsed?: (() => Component | undefined) | undefined;
  /** The complete expanded body; defaults to the collapsed body. */
  readonly expanded?: (() => Component | undefined) | undefined;
  /** What expansion reveals; a collapsed frame then shows the configured expand hint. */
  readonly expandLabel?: string | undefined;
  /** Native components, such as images, drawn unchanged below the frame as Pi draws tool images. */
  readonly attachments?: ReadonlyArray<Component> | undefined;
}

export interface CodePreviewMessageOptions extends MessageRenderOptions {
  /** The owner's collapsed style, for bodies that differ between styles. */
  readonly collapsedStyle: ToolCallCollapsedStyle;
}

export type CodePreviewMessagePresenter<T = unknown> = (
  message: Parameters<MessageRenderer<T>>[0],
  options: CodePreviewMessageOptions,
  theme: Theme,
) => CodePreviewMessage;

/** A message renderer that always draws: a drawing failure falls back to the message's text. */
export type CodePreviewMessageRenderer<T = unknown> = (
  message: Parameters<MessageRenderer<T>>[0],
  options: MessageRenderOptions,
  theme: Theme,
) => Component;

interface MessagePolicy {
  readonly mode: ToolCallBackgroundMode;
  readonly style: ToolCallCollapsedStyle;
}

const decodeContent = Schema.decodeUnknownOption(
  Schema.Struct({ content: Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]) }),
  { onExcessProperty: "ignore" },
);
const isTextPart = Schema.is(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }));

/** The message's own text, which a drawing failure shows instead of its frame. */
const fallbackText = (message: unknown): string => {
  const content = Option.getOrUndefined(decodeContent(message))?.content;
  if (content === undefined) return "";
  const text = Predicate.isString(content)
    ? content
    : Arr.join(
        Arr.map(Arr.filter(content, isTextPart), (part) => part.text),
        "\n",
      );
  return escapeControlChars(Str.replaceAll("\r\n", "\n")(text));
};

const plainMessage = (text: string, outputPad: number): Component => new Text(text, outputPad, 0);

/**
 * Wraps a custom-message presenter so its message draws in the same frame as a settled tool row:
 * the background mode and collapsed style come from the process-wide appearance the latest settings
 * load published when Pi asks for the component, which tool registration also captured. Messages have no duration, so the frame
 * never shows timing. A presenter or body that throws falls back to the message's plain text.
 * Presentation only: it never executes anything or acquires resources.
 */
export function withCodePreviewMessageShell<T = unknown>(
  present: CodePreviewMessagePresenter<T>,
): CodePreviewMessageRenderer<T> {
  return (message, options, theme) => {
    const shared = sharedPresentation();
    const policy: MessagePolicy = {
      mode: shared.toolCallBackground,
      style: shared.toolCallCollapsedStyle,
    };
    const fallback = () => fallbackText(message);
    try {
      const presented = present(message, { ...options, collapsedStyle: policy.style }, theme);
      return new MessageShell(presented, policy, options, theme, fallback);
    } catch {
      return plainMessage(fallback(), options.outputPad);
    }
  };
}

class MessageShell implements Component {
  private drawn: Component | undefined;
  private cache: { readonly width: number; readonly rows: string[] } | undefined;
  private readonly message: CodePreviewMessage;
  private readonly policy: MessagePolicy;
  private readonly options: MessageRenderOptions;
  private readonly theme: Theme;
  private readonly fallback: () => string;

  constructor(
    message: CodePreviewMessage,
    policy: MessagePolicy,
    options: MessageRenderOptions,
    theme: Theme,
    fallback: () => string,
  ) {
    this.message = message;
    this.policy = policy;
    this.options = options;
    this.theme = theme;
    this.fallback = fallback;
  }

  render(width: number): string[] {
    if (this.cache?.width === width) return this.cache.rows;
    let rows: string[];
    try {
      this.drawn ??= this.compose();
      rows = this.drawn.render(width);
    } catch {
      this.drawn = undefined;
      rows = plainMessage(this.fallback(), this.options.outputPad).render(width);
    }
    this.cache = { width, rows };
    return rows;
  }

  invalidate(): void {
    this.cache = undefined;
    this.drawn?.invalidate();
  }

  private compose(): Component {
    const { message, theme, policy } = this;
    const { expanded } = this.options;
    const { collapsedSummary: summary } = planCompactPresentation({
      summary: message.summary,
      phase: "settled",
      isError: false,
      expanded,
    });
    const status = compactStatus("settled", summary);
    const compact = policy.style === "compact";
    const heading = composeToolComponent((width) => [
      ...(compact
        ? [
            renderCompactRow(
              { name: message.name, phase: "settled", summary, expanded },
              theme,
              width,
            ),
          ]
        : new Text(previewHeading(message, summary, expanded, theme), 0, 0).render(width)),
      ...renderCompactIssues(summary.issues, theme, width, expanded, compact ? ROW_INDENT : ""),
    ]);
    const body = (expanded ? (message.expanded ?? message.collapsed) : message.collapsed)?.();
    const shown = new Container();
    // A collapsed compact message is a bare compact row, as a collapsed compact tool row is.
    if (compact && !expanded) {
      shown.addChild(heading);
      if (body) shown.addChild(beneathRow(body));
    } else shown.addChild(this.frame(heading, body, status));
    for (const attachment of message.attachments ?? []) {
      shown.addChild(new Spacer(1));
      shown.addChild(attachment);
    }
    return shown;
  }

  private frame(
    heading: Component,
    body: Component | undefined,
    status: ReturnType<typeof compactStatus>,
  ): Component {
    const { message, theme, policy } = this;
    const hint = this.options.expanded ? undefined : message.expandLabel;
    if (policy.mode === "border") {
      const rest = new Container();
      if (body) rest.addChild(body);
      const shell = new BorderedToolCall(theme);
      shell.setContent(
        heading,
        rest,
        { codePreviewBorderResultExpandLabel: hint && theme.fg("muted", toolExpandHint()) },
        statusBorderColor(status, false),
        undefined,
      );
      return shell;
    }
    const shell =
      policy.mode === "on"
        ? new Box(this.options.outputPad, 1, (text) =>
            theme.bg(statusBackground(status, false), text),
          )
        : new Container();
    shell.addChild(heading);
    if (body) shell.addChild(body);
    if (hint !== undefined)
      shell.addChild(
        composeToolComponent((width) => [
          clipToWidth(renderExpansionAffordance(hint, false, theme), width),
        ]),
      );
    return shell;
  }
}

/** A body beneath a compact row, indented as the row's issues are. */
function beneathRow(body: Component): Component {
  return {
    render: (width) => {
      const indent = width > ROW_INDENT.length * 2 ? ROW_INDENT : "";
      return Arr.map(body.render(Math.max(1, width - indent.length)), (line) =>
        line === "" ? line : `${indent}${line}`,
      );
    },
    invalidate: () => body.invalidate(),
  };
}

const ROW_INDENT = "  ";

/** A preview heading as tool rows have it: the title, then its action and subject dimmed. */
function previewHeading(
  message: CodePreviewMessage,
  summary: CompactSummary,
  expanded: boolean,
  theme: Theme,
): string {
  const subject = expanded ? summary.subject : (summary.compactSubject ?? summary.subject);
  const facts = Arr.filter(
    Arr.map([...(summary.counters ?? []), ...(summary.metadata ?? [])], compactSingleLine),
    Str.isNonEmpty,
  );
  const lead = Arr.join(
    Arr.filter(
      [compactSingleLine(summary.action ?? ""), compactSingleLine(subject)],
      Str.isNonEmpty,
    ),
    " ",
  );
  const subtitle = Arr.join(Arr.filter([lead, ...facts], Str.isNonEmpty), " · ");
  return renderToolHeader({ title: message.label ?? message.name, subtitle }, theme);
}
