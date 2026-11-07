import type { MessageRenderer, MessageRenderOptions, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { composeToolComponent } from "pi-cosmic-ui/tool";
import type { ToolCallCollapsedStyle } from "../config/schema";
import { sharedPresentation, type SharedPresentation } from "../config/state";
import { escapeControlChars } from "../shared/terminal-text";
import { planCompactPresentation } from "../tools/compact-presentation";
import { compactStatus, type CompactSummary } from "../tools/compact-summary";
import { BorderedToolCall, statusBorderColor } from "./bordered-tool-call";
import { renderCompactIssues } from "./compact-issues";
import { layoutExpandedCompactHeading, layoutTaggedCompactRow } from "./compact-row";
import { showsAffordance } from "./expand-affordance";
import { drawWithBodyLabel } from "./expanded-section";
import { headingWrapped, recordHeadingSubject } from "./heading-coverage";
import { layoutTaggedHeading } from "./heading-tag";
import { layoutPreviewHeadingRow, wrappedPreviewHeading } from "./preview-heading";
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
  /**
   * The complete expanded body; defaults to the collapsed body. `headingState` is the key
   * `headingShowedSubject` reads, so the body can leave out a subject the heading showed whole.
   */
  readonly expanded?: ((headingState: WeakKey) => Component | undefined) | undefined;
  /**
   * What expansion reveals, such as `details` or `conversation`: in both styles the collapsed
   * message's heading then ends in its tag, `▸ label` or a bare `▸`, unless its body already ends in
   * an affordance.
   * Defaults to the summary's `expandLabel`.
   */
  readonly expandLabel?: string | undefined;
  /** Native components, such as images, drawn unchanged below the frame as Pi draws tool images. */
  readonly attachments?: ReadonlyArray<Component> | undefined;
  /**
   * The label, such as `Report`, of the expanded body's unlabeled section beneath a heading that
   * wraps, whose continuation rows would otherwise share the words' column. A delivered message
   * (`summary.messageIcon`) defaults to `Message`; other messages get one only when they set it.
   */
  readonly bodyLabel?: string | undefined;
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
    const policy = sharedPresentation();
    const fallback = () => fallbackText(message);
    try {
      const presented = present(
        message,
        { ...options, collapsedStyle: policy.toolCallCollapsedStyle },
        theme,
      );
      return new MessageShell(presented, policy, options, theme, fallback);
    } catch {
      return plainMessage(fallback(), options.outputPad);
    }
  };
}

class MessageShell implements Component {
  private drawn: Component | undefined;
  private cache: { readonly width: number; readonly rows: string[] } | undefined;
  // The width the collapsed row would get, which an expanded compact heading's counter follows.
  private renderWidth: number | undefined;
  private readonly message: CodePreviewMessage;
  private readonly policy: SharedPresentation;
  private readonly options: MessageRenderOptions;
  private readonly theme: Theme;
  private readonly fallback: () => string;
  // Whether the expanded heading showed the whole subject when it last drew, for the body.
  private readonly headingState = {};

  constructor(
    message: CodePreviewMessage,
    policy: SharedPresentation,
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
    this.renderWidth = width;
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
    const compact = policy.toolCallCollapsedStyle === "compact";
    // A collapsed heading is one row, laid out beside the tag `tag` names.
    const headingRows = (width: number, tag: string | undefined): string[] => {
      const title = message.label ?? message.name;
      if (!compact && !expanded)
        return [
          layoutTaggedHeading(tag, theme, width, (room, subjectMinimum) =>
            layoutPreviewHeadingRow(title, summary, false, theme, room, subjectMinimum),
          ).row,
        ];
      // An expanded preview heading wraps rather than clips, so the body may leave out its subject.
      if (!compact) {
        const { rows, subjectComplete } = wrappedPreviewHeading(title, summary, theme, width);
        recordHeadingSubject(this.headingState, subjectComplete, rows);
        return rows;
      }
      if (!expanded)
        return [
          layoutTaggedCompactRow(
            { name: message.name, phase: "settled", summary },
            theme,
            width,
            tag,
          ).row,
        ];
      const { rows, subjectComplete } = layoutExpandedCompactHeading(
        {
          name: message.name,
          phase: "settled",
          summary,
          expanded,
          collapsedWidth: this.renderWidth,
          collapsedExpandLabel: this.expandLabel(),
        },
        theme,
        width,
      );
      recordHeadingSubject(this.headingState, subjectComplete, rows);
      return rows;
    };
    const heading = (tag: string | undefined) =>
      composeToolComponent((width) => [
        ...headingRows(width, tag),
        ...renderCompactIssues(
          summary.issues,
          theme,
          width,
          expanded,
          compact || expanded ? ROW_INDENT : "",
        ),
      ]);
    const content = expanded
      ? message.expanded
        ? message.expanded(this.headingState)
        : message.collapsed?.()
      : message.collapsed?.();
    // Unlabeled words would share the column of a wrapped heading's rows.
    const bodyLabel = Str.isNonEmpty(Str.trim(message.bodyLabel ?? ""))
      ? message.bodyLabel
      : message.summary.messageIcon !== undefined
        ? "Message"
        : undefined;
    const body =
      expanded && content && bodyLabel !== undefined
        ? labeledBeneathWrappedHeading(content, bodyLabel, this.headingState)
        : content;
    const shown = new Container();
    // A collapsed compact message is a bare compact row, as a collapsed compact tool row is.
    if (compact && !expanded) shown.addChild(this.tagged(heading, body && beneathRow(body)));
    else shown.addChild(this.frame(heading, body, status));
    for (const attachment of message.attachments ?? []) {
      shown.addChild(new Spacer(1));
      shown.addChild(attachment);
    }
    return shown;
  }

  private frame(
    heading: (tag: string | undefined) => Component,
    body: Component | undefined,
    status: ReturnType<typeof compactStatus>,
  ): Component {
    const { theme, policy } = this;
    if (policy.toolCallBackground === "border") {
      const hint = this.options.expanded ? undefined : this.expandLabel();
      const rest = new Container();
      if (body) rest.addChild(body);
      const shell = new BorderedToolCall(theme);
      shell.setContent(heading(undefined), rest, {}, statusBorderColor(status, false), undefined);
      shell.setExpandFallback((_, rows) => (showsAffordance(rows) ? undefined : hint));
      return shell;
    }
    const shell =
      policy.toolCallBackground === "on"
        ? new Box(this.options.outputPad, 1, (text) =>
            theme.bg(statusBackground(status, false), text),
          )
        : new Container();
    shell.addChild(this.tagged(heading, body));
    return shell;
  }

  /**
   * The heading, its tag naming what expansion reveals unless the row is expanded or its body
   * already ends in its own affordance, then the body.
   */
  private tagged(
    heading: (tag: string | undefined) => Component,
    body: Component | undefined,
  ): Component {
    const hint = this.options.expanded ? undefined : this.expandLabel();
    const untagged = heading(undefined);
    if (hint === undefined)
      // The heading draws first: an expanded body reads whether it showed the subject whole.
      return composeToolComponent((width) => [
        ...untagged.render(width),
        ...(body?.render(width) ?? []),
      ]);
    const tagged = heading(hint);
    return composeToolComponent((width) => {
      const rows = body?.render(width) ?? [];
      return [...(showsAffordance(rows) ? untagged : tagged).render(width), ...rows];
    });
  }

  /**
   * What expansion reveals: the presenter's `expandLabel`, else its summary's. A collapsed body that
   * already ends in its own affordance, such as clipped authored text, doesn't get a second one.
   */
  private expandLabel(): string | undefined {
    const { expandLabel, summary } = this.message;
    if (expandLabel !== undefined)
      return Str.isNonEmpty(Str.trim(expandLabel)) ? expandLabel : undefined;
    const declared = summary.expandLabel;
    return declared === false || declared === undefined || !Str.isNonEmpty(Str.trim(declared))
      ? undefined
      : declared;
  }
}

/**
 * A message body whose unlabeled section is labeled beneath a heading that wrapped, as a `bash`
 * result is labeled `Output`: the heading's continuation rows hang at the body's column.
 */
function labeledBeneathWrappedHeading(
  body: Component,
  label: string,
  headingState: WeakKey,
): Component {
  return {
    render: (width) =>
      drawWithBodyLabel(headingWrapped(headingState) ? label : undefined, () => body.render(width)),
    invalidate: () => body.invalidate(),
  };
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
