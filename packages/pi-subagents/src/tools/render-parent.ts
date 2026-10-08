/**
 * Presentation of a local Pi child's `contact_parent` tool: its compact summary, content-only
 * expansion, and preview-style bodies. The shared shell draws warning and failure issues; these
 * bodies show the request, the parent's reply, and acknowledgements.
 */
import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  getTextContent,
  type CodePreviewShellOptions,
  type CompactIssue,
  type CompactSummary,
  type CompactSummaryProvider,
} from "pi-code-previews";
import {
  decodeUnknownOrUndefined,
  quoteText,
  safeTextPrefix,
  sanitizeTerminalLine,
  stripTerminalControls,
} from "pi-cosmic-core";
import { MAX_PARENT_MESSAGE_CHARS, MAX_TOOL_OUTPUT_CHARS } from "../run/limits.ts";
import { rejectedCallIssue } from "./compact-action-failures.ts";
import { QUOTED_TEXT_LIMIT } from "./compact-run-issues.ts";
import {
  errorSection,
  previewCall,
  textResultBody,
  type PreviewRenderContext,
} from "./render-preview.ts";

export const CONTACT_PARENT_LABEL = "Contact Parent";

const ContactSchema = Schema.Struct({
  kind: Schema.Literals(["progress", "warning", "question"]),
  message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_PARENT_MESSAGE_CHARS)),
});

/** A result of exactly one text part, whose text `text` decodes, and no details. */
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
    // Earlier local children said "Parent replied: ".
    Schema.isPattern(/^Parent repl(?:y|ied): /u),
  ),
);

/** The parent's reply to a child's question, verbatim, when the result is exactly one. */
const parentReplyText = <Result>(result: Result): string | undefined =>
  decodeUnknownOrUndefined(ReplySchema, result, { onExcessProperty: "error" })?.content[0]?.text;

/** The child's request, decoded from its arguments; undefined for anything else. */
const contactRequest = <Args>(args: Args) => {
  const request = decodeUnknownOrUndefined(ContactSchema, args);
  return request?.message.trim() ? request : undefined;
};

/** The warning's own first line, unless it opens with agent guidance; full text on expansion. */
const warningIssue = (message: string): CompactIssue => {
  const { line } = quoteText(message, { limit: QUOTED_TEXT_LIMIT });
  return {
    severity: "warning",
    code: "parent-warning",
    message: line ?? "A warning was sent to the parent",
    detail: stripTerminalControls(message),
  };
};

/**
 * Owned acknowledgements, a parent's reply to a question, and rejected calls are classified;
 * any other result declines, so its text stays verbatim.
 */
export const contactParentCompactSummary: CompactSummaryProvider<unknown, unknown, unknown> = ({
  args,
  result,
  phase,
  context,
}) => {
  const request = contactRequest(args);
  if (!request) return undefined;
  const warning = request.kind === "warning";
  // A warning's text is its issue line, so the heading does not repeat it.
  const summary: CompactSummary = {
    action: request.kind,
    subject: warning ? "" : safeTextPrefix(sanitizeTerminalLine(request.message), 120),
    ...(warning && { issues: [warningIssue(request.message)], outcome: "warning" as const }),
  };
  if (!result) return phase === "settled" || context.isError ? undefined : summary;
  if (context.isError)
    return phase === "settled"
      ? {
          ...summary,
          outcome: "error",
          issues: [rejectedCallIssue(request.kind, getTextContent(result.content), "the parent")],
        }
      : undefined;
  if (request.kind === "question")
    return parentReplyText(result) === undefined
      ? undefined
      : { ...summary, counters: ["answered"], outcome: "success" };
  const receipt = decodeUnknownOrUndefined(ReceiptSchema, result, { onExcessProperty: "error" });
  if (receipt?.content[0]?.text !== `Parent received ${request.kind}.`) return undefined;
  return { ...summary, counters: ["acknowledged"], outcome: warning ? "warning" : "success" };
};

/** Input evidence and replies only; the shared shell renders acknowledgement and warning issues. */
export const contactParentExpandedContent: NonNullable<CodePreviewShellOptions["expandedContent"]> =
  {
    renderCall: (args, theme, context) => {
      if (!Predicate.isObject(args)) return new Text("", 0, 0);
      const warning = "kind" in args && args.kind === "warning";
      const message = "message" in args ? args.message : undefined;
      return new Text(
        (!warning || context.isError) && Predicate.isString(message)
          ? theme.fg("toolOutput", stripTerminalControls(message))
          : "",
        0,
        0,
      );
    },
    renderResult: (result, options, theme, context) => {
      const summary = contactParentCompactSummary({
        phase: options.isPartial ? "running" : "settled",
        args: context?.args,
        result,
        context,
      });
      const text = stripTerminalControls(getTextContent(result.content));
      if (summary && context.isError) return errorSection(theme, text);
      const shown = !summary || parentReplyText(result) !== undefined ? text : "";
      return new Text(theme.fg("toolOutput", shown), 0, 0);
    },
  };

/** Input the heading's bounded subtitle shows exactly. */
const fitsHeading = (message: string): boolean =>
  message.length <= 120 && sanitizeTerminalLine(message) === message;

/** Lines of a reply or receipt a collapsed row shows before its expansion affordance. */
const COLLAPSED_REPLY_LINES = 4;

/** Preview-style call and result bodies. */
export const contactParentRenderers = {
  renderCall<Args>(args: Args, theme: Theme, context: PreviewRenderContext): Component {
    const request = contactRequest(args);
    // A warning's text is the shell's issue line, so the heading names only the kind.
    const message = request && request.kind !== "warning" ? request.message : undefined;
    const subject = [request?.kind, message].filter(Boolean).join(": ");
    // The heading shows one bounded line; longer or multi-line input appears whole.
    const whole =
      context.expanded && message && !fitsHeading(message)
        ? new Text(theme.fg("toolOutput", stripTerminalControls(message)), 0, 0)
        : undefined;
    return previewCall(theme, context, { title: CONTACT_PARENT_LABEL, subtitle: subject }, whole);
  },
  renderResult<Details>(
    result: AgentToolResult<Details>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: PreviewRenderContext,
  ): Component {
    const text = stripTerminalControls(getTextContent(result.content));
    return textResultBody(
      theme,
      text,
      { expanded: options.expanded, isError: context.isError },
      COLLAPSED_REPLY_LINES,
    );
  },
};
