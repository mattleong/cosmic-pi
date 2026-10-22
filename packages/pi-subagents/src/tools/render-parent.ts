import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TUnknown } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import * as Predicate from "effect/Predicate";
import { flow } from "effect/Function";
import * as Schema from "effect/Schema";
import {
  escapeControlChars,
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
import { errorSection, previewCall, rejectionAwareCall, textResultBody } from "./render-preview.ts";

export const CONTACT_PARENT_LABEL = "Contact Parent";

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

const parentReplyText = flow(decodeReply, (reply) => reply?.content[0]?.text);

const contactRequest = flow(decodeUnknownOrUndefined(ContactSchema), (request) =>
  request?.message.trim() ? request : undefined,
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

export const contactParentCompactSummary: CompactSummaryProvider = ({
  args,
  result,
  phase,
  context,
}) => {
  const request = contactRequest(args);
  if (!request) return undefined;
  const warning = request.kind === "warning";
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
  const receipt = decodeReceipt(result);
  if (receipt?.content[0]?.text !== `Parent received ${request.kind}.`) return undefined;
  return { ...summary, counters: ["acknowledged"], outcome: warning ? "warning" : "success" };
};

export const contactParentExpandedContent: NonNullable<CodePreviewShellOptions["expandedContent"]> =
  {
    renderCall: (args, theme, context) => {
      if (!Predicate.isObject(args)) return new Text("", 0, 0);
      const warning = "kind" in args && args.kind === "warning";
      const message = "message" in args ? args.message : undefined;
      return new Text(
        (!warning || context.isError) && Predicate.isString(message)
          ? theme.fg("toolOutput", escapeControlChars(message))
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
      const text = escapeControlChars(getTextContent(result.content));
      if (summary && context.isError) return errorSection(theme, text);
      const shown = !summary || parentReplyText(result) !== undefined ? text : "";
      return new Text(theme.fg("toolOutput", shown), 0, 0);
    },
  };

const fitsHeading = (message: string): boolean =>
  message.length <= 120 && sanitizeTerminalLine(message) === message;

const COLLAPSED_REPLY_LINES = 4;

export const contactParentRenderers = {
  renderCall: rejectionAwareCall(CONTACT_PARENT_LABEL, (args, theme, context) => {
    const request = contactRequest(args);
    const message = request && request.kind !== "warning" ? request.message : undefined;
    const subject = [request?.kind, message].filter(Boolean).join(": ");
    const whole =
      context.expanded && message && !fitsHeading(message)
        ? new Text(theme.fg("toolOutput", escapeControlChars(message)), 0, 0)
        : undefined;
    return previewCall(theme, context, { title: CONTACT_PARENT_LABEL, subtitle: subject }, whole);
  }),
  renderResult(result, options, theme, context) {
    const text = stripTerminalControls(getTextContent(result.content));
    return textResultBody(
      theme,
      text,
      { expanded: options.expanded, isError: context.isError },
      COLLAPSED_REPLY_LINES,
    );
  },
} satisfies Required<Pick<ToolDefinition<TUnknown>, "renderCall" | "renderResult">>;
