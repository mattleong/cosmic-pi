import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TUnknown } from "typebox";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import * as Fn from "effect/Function";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import {
  escapeControlChars,
  expandedAuthoredText,
  expandedSection,
  expandedText,
  getTextContent,
  previewIssuesSlot,
  type CodePreviewShellOptions,
  type CompactIssue,
  type CompactSummary,
  type CompactSummaryProvider,
} from "pi-code-previews";
import { decodeUnknownOrUndefined } from "pi-cosmic-core/schema/decode";
import { quoteText } from "pi-cosmic-core/message-text";
import { stripTerminalControls } from "pi-cosmic-core/security";
import { managerStateGlyph } from "pi-cosmic-ui/manager";
import { composeToolComponent, toolRunningLine, toolStatusLine } from "pi-cosmic-ui/tool";
import { MAX_PARENT_MESSAGE_CHARS, MAX_TOOL_OUTPUT_CHARS } from "../run/limits.ts";
import { rejectedCallIssue } from "./compact-action-failures.ts";
import { QUOTED_TEXT_LIMIT, questionQuote } from "./compact-run-issues.ts";
import {
  errorSection,
  previewHeading,
  rejectionAwareCall,
  textResultBody,
} from "./render-preview.ts";
import { agentTextLines } from "../ui/agent-text.ts";

/** A sent question's live status: it waits on the parent's reply. */
const waitingLine = (theme: Parameters<typeof toolRunningLine>[0]): string =>
  toolStatusLine(theme, "waiting", "Waiting for reply");

export const CONTACT_PARENT_LABEL = "Contact parent";

const ContactSchema = Schema.Struct({
  kind: Schema.Literals(["progress", "warning", "question"]),
  message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_PARENT_MESSAGE_CHARS)),
});

const singleTextResult = <TextSchema extends Schema.Top>(text: TextSchema) =>
  Schema.Struct({
    content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text })).check(
      Schema.isBetweenLength(1, 1),
    ),
    details: Schema.Struct({}),
  });

const ReceiptSchema = singleTextResult(Schema.String.check(Schema.isMaxLength(256)));
const ReplySchema = singleTextResult(
  Schema.String.check(
    Schema.isMaxLength(MAX_TOOL_OUTPUT_CHARS),
    Schema.isPattern(/^Parent repl(?:y|ied): /u),
  ),
);

const decodeReply = decodeUnknownOrUndefined(ReplySchema, { onExcessProperty: "error" });
const decodeReceipt = decodeUnknownOrUndefined(ReceiptSchema, { onExcessProperty: "error" });

const parentReplyText = Fn.flow(decodeReply, (reply) => reply?.content[0]?.text);

const contactRequest = Fn.flow(decodeUnknownOrUndefined(ContactSchema), (request) =>
  request !== undefined && Str.trim(request.message) ? request : undefined,
);

const warningIssue = (message: string): CompactIssue => {
  const { line } = quoteText(message, { limit: QUOTED_TEXT_LIMIT });
  return {
    severity: "warning",
    code: "parent-warning",
    message: line ?? "A warning was sent to the parent",
    detail: stripTerminalControls(message),
  };
};

/** The error a child's own cancelled question settles with; a routine stop, not a failure. */
const CANCELLED_QUESTION = "Parent question was cancelled.";

const isCancelledQuestion = (result: {
  readonly content: ReadonlyArray<{ readonly type: string }>;
}) => Str.trim(getTextContent(result.content)) === CANCELLED_QUESTION;

/**
 * Whether a warning's words fit its issue whole, so expanding it shows nothing more.
 */
const warningFitsIssue = (message: string): boolean => {
  const { line } = quoteText(message, { limit: QUOTED_TEXT_LIMIT });
  return line !== undefined && line === Str.trim(stripTerminalControls(message));
};

export const contactParentCompactSummary: CompactSummaryProvider = ({
  args,
  result,
  phase,
  context,
}) => {
  const request = contactRequest(args);
  if (!request) return undefined;
  const warning = request.kind === "warning";
  // A collapsed compact row hides the agent's words, so expansion offers them, then any reply.
  const summary: CompactSummary = {
    action: request.kind,
    subject: "",
    ...(warning
      ? {
          issues: [warningIssue(request.message)],
          outcome: "warning" as const,
          // A warning short enough for its issue has nothing more to show expanded.
          ...(warningFitsIssue(request.message) && { expandLabel: false as const }),
        }
      : { expandLabel: request.kind === "question" ? "question" : "message" }),
  };
  if (!result) {
    if (phase === "settled" || context.isError) return undefined;
    if (request.kind !== "question" || phase !== "running") return summary;
    // Once sent, an open question waits on the parent's reply, and is quoted as its problem line;
    // expansion adds the rest of one the quote cuts.
    const { quote, cut } = questionQuote(stripTerminalControls(request.message));
    return {
      ...summary,
      waiting: true,
      issues: [{ severity: "attention", code: "parent-question", message: quote }],
      expandLabel: cut ? "question" : false,
    };
  }
  if (context.isError) {
    if (phase !== "settled") return undefined;
    if (request.kind === "question" && isCancelledQuestion(result))
      return { ...summary, counters: ["cancelled"], outcome: "cancelled" };
    return {
      ...summary,
      outcome: "error",
      issues: [rejectedCallIssue(request.kind, getTextContent(result.content), "the parent")],
    };
  }
  if (request.kind === "question")
    return parentReplyText(result) === undefined
      ? undefined
      : { ...summary, counters: ["answered"], outcome: "success", expandLabel: "reply" };
  if (!isReceipt(request.kind, decodeReceipt(result))) return undefined;
  return { ...summary, counters: ["received"], outcome: warning ? "warning" : "success" };
};

/** Whether a decoded result is the parent's receipt for progress or a warning. */
const isReceipt = (kind: string, receipt: typeof ReceiptSchema.Type | undefined): boolean =>
  receipt?.content[0]?.text === `Parent received ${kind}.`;

/**
 * Delivered progress reads `✓ Received`, as the shell's expanded status line states it. A warning's
 * issue carries its state, so its receipt shows no line collapsed or expanded.
 */
const receivedLine = (theme: Theme): Component =>
  new Text(
    `${theme.fg("success", managerStateGlyph("done"))} ${theme.fg("muted", "Received")}`,
    0,
    0,
  );

const MESSAGE_LABELS = { progress: "Progress", warning: "Warning", question: "Question" } as const;

/** The parent's reply without the prefix the child reads, or undefined for another result. */
const replyWords = Fn.flow(parentReplyText, (text) =>
  text === undefined ? undefined : Str.replace(/^Parent repl(?:y|ied): /u, "")(text),
);

export const contactParentExpandedContent: NonNullable<CodePreviewShellOptions["expandedContent"]> =
  {
    renderCall: (args, theme, context) => {
      const request = contactRequest(args);
      // A warning's words are its issue, unless the call failed before the warning was sent, and so
      // are an open question's while its quote holds all of it.
      if (!request || (request.kind === "warning" && !context.isError)) return new Container();
      if (
        request.kind === "question" &&
        context.executionStarted &&
        context.isPartial &&
        !questionQuote(stripTerminalControls(request.message)).cut
      )
        return new Container();
      return expandedAuthoredText(theme, MESSAGE_LABELS[request.kind], request.message);
    },
    renderResult: (result, options, theme, context) => {
      const summary = contactParentCompactSummary({
        phase: options.isPartial ? "running" : "settled",
        args: context?.args,
        result,
        context,
      });
      const text = escapeControlChars(getTextContent(result.content));
      if (summary?.outcome === "cancelled") return new Container();
      if (summary && context.isError) return errorSection(theme, text, context?.args);
      const reply = replyWords(result);
      if (reply !== undefined) return expandedAuthoredText(theme, "Reply", reply);
      return summary ? new Container() : expandedText(theme, undefined, Str.split(text, "\n"));
    },
  };

const COLLAPSED_REPLY_LINES = 4;

export const contactParentRenderers = {
  renderCall: rejectionAwareCall(CONTACT_PARENT_LABEL, (args, theme, context) => {
    const request = contactRequest(args);
    // An open question its issue quotes whole shows only there.
    const quotedWhole =
      request?.kind === "question" &&
      context.executionStarted &&
      context.isPartial &&
      !questionQuote(stripTerminalControls(request.message)).cut;
    const message =
      request && request.kind !== "warning" && !quotedWhole ? request.message : undefined;
    const container = new Container();
    container.addChild(
      previewHeading({ title: CONTACT_PARENT_LABEL, subtitle: request?.kind }, theme),
    );
    // Issues follow the heading, so the shell knows where the heading ends and the body begins.
    container.addChild(previewIssuesSlot(context));
    if (request && message !== undefined)
      container.addChild(
        context.expanded
          ? expandedAuthoredText(theme, MESSAGE_LABELS[request.kind], message)
          : composeToolComponent((width) =>
              agentTextLines(message, width, theme, { expanded: false }),
            ),
      );
    if (context.executionStarted && context.isPartial)
      container.addChild(
        new Text(request?.kind === "question" ? waitingLine(theme) : toolRunningLine(theme), 0, 0),
      );
    return container;
  }),
  renderResult(result, options, theme, context) {
    // A cancelled question's status line already says so.
    if (context.isError && isCancelledQuestion(result)) return new Container();
    const reply = context.isError ? undefined : replyWords(result);
    if (reply !== undefined)
      return options.expanded
        ? expandedAuthoredText(theme, "Reply", reply)
        : composeToolComponent((width) =>
            agentTextLines(`Parent replied: ${reply}`, width, theme, {
              expanded: false,
              indent: 0,
              rows: COLLAPSED_REPLY_LINES,
            }),
          );
    const kind = contactRequest(context.args)?.kind;
    if (!context.isError && kind !== undefined && isReceipt(kind, decodeReceipt(result)))
      return kind === "warning"
        ? new Container()
        : options.expanded
          ? expandedSection(theme, undefined, receivedLine(theme))
          : receivedLine(theme);
    const text = stripTerminalControls(getTextContent(result.content));
    return textResultBody(
      theme,
      text,
      { expanded: options.expanded, isError: context.isError, args: context.args },
      COLLAPSED_REPLY_LINES,
    );
  },
} satisfies Required<Pick<ToolDefinition<TUnknown>, "renderCall" | "renderResult">>;
