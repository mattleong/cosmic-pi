import {
  expandedSection,
  getTextContent,
  type CodePreviewShellOptions,
  type CompactIssue,
} from "pi-code-previews";
import { Text } from "@earendil-works/pi-tui";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { CompactSummary, CompactSummaryProvider } from "pi-code-previews";
import { quoteText, sanitizeTerminalLine, stripTerminalControls } from "pi-cosmic-core";
import { safeTextPrefix } from "../run/state.ts";
import { MAX_PARENT_MESSAGE_CHARS, MAX_TOOL_OUTPUT_CHARS } from "../run/limits.ts";
import {
  SupervisorDeliveryIdSchema,
  SupervisorMessageSchema,
  SupervisorReportTextSchema,
} from "../supervisor/protocol.ts";
import { QUOTED_TEXT_LIMIT } from "./compact-run-issues.ts";
import { rejectedCallIssue } from "./compact-action-failures.ts";

const decodeMessage = Schema.decodeUnknownOption(
  Schema.Struct({ message: SupervisorMessageSchema }),
);
const decodeReport = Schema.decodeUnknownOption(
  Schema.Struct({ delivery_id: SupervisorDeliveryIdSchema, report: SupervisorReportTextSchema }),
);

const decodeContact = Schema.decodeUnknownOption(
  Schema.Struct({
    kind: Schema.Literals(["progress", "warning", "question"]),
    message: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(MAX_PARENT_MESSAGE_CHARS),
    ),
  }),
);
const decodeReceipt = Schema.decodeUnknownOption(
  Schema.Struct({
    content: Schema.Array(
      Schema.Struct({
        type: Schema.Literal("text"),
        text: Schema.String.check(Schema.isMaxLength(256)),
      }),
    ).check(Schema.isLengthBetween(1, 1)),
    details: Schema.Struct({}),
  }),
  { onExcessProperty: "error" },
);
const decodeReply = Schema.decodeUnknownOption(
  Schema.Struct({
    content: Schema.Array(
      Schema.Struct({
        type: Schema.Literal("text"),
        text: Schema.String.check(
          Schema.isMaxLength(MAX_TOOL_OUTPUT_CHARS),
          // Earlier local children said "Parent replied: ".
          Schema.isPattern(/^Parent repl(?:y|ied): /u),
        ),
      }),
    ).check(Schema.isLengthBetween(1, 1)),
    details: Schema.Struct({}),
  }),
  { onExcessProperty: "error" },
);

/** The parent's reply to a child's question, verbatim, when the result is exactly one. */
export const parentReplyText = <Result>(result: Result): string | undefined => {
  const decoded = decodeReply(result);
  return decoded._tag === "Some" ? decoded.value.content[0]!.text : undefined;
};

interface ParentRequest {
  readonly action: string;
  readonly message: string;
  readonly acknowledgement: string | RegExp | undefined;
}

/** The child's request, decoded from its arguments; undefined for anything else. */
export function parentRequest<Args>(toolName: string, args: Args): ParentRequest | undefined {
  if (toolName === "contact_parent") {
    const input = decodeContact(args);
    if (input._tag === "None" || !input.value.message.trim()) return undefined;
    const action = input.value.kind;
    return {
      action,
      message: input.value.message,
      acknowledgement: action === "question" ? undefined : `Parent received ${action}.`,
    };
  }
  if (toolName === "supervisor_submit_report") {
    const input = decodeReport(args);
    if (input._tag === "None") return undefined;
    return {
      action: "report",
      message: input.value.report,
      acknowledgement:
        /^(?:Final report(?: retry)? accepted; sequence [0-9]+\.|Supervisor report already accepted\.)$/,
    };
  }
  const input = decodeMessage(args);
  if (
    !["supervisor_progress", "supervisor_warning", "supervisor_question"].includes(toolName) ||
    input._tag === "None"
  )
    return undefined;
  const action = toolName.slice("supervisor_".length);
  return {
    action,
    message: input.value.message,
    acknowledgement:
      action === "question"
        ? undefined
        : action === "progress"
          ? "Progress delivered to the parent projection."
          : "Warning recorded in parent-visible run status.",
  };
}

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

const acknowledged = (request: ParentRequest, text: string): boolean =>
  request.acknowledgement === undefined
    ? false
    : Predicate.isString(request.acknowledgement)
      ? text === request.acknowledgement
      : request.acknowledgement.test(text);

/**
 * Owned acknowledgements, a parent's reply to a question, and rejected calls are classified;
 * any other result declines, so its text stays verbatim.
 */
export function createParentCompactSummary(
  toolName: string,
): CompactSummaryProvider<unknown, unknown, unknown> {
  return ({ args, result, phase, context }) => {
    const request = parentRequest(toolName, args);
    if (!request) return undefined;
    const warning = request.action === "warning";
    // A warning's text is its issue line, so the heading does not repeat it.
    const summary: CompactSummary = {
      subject: warning ? "" : safeTextPrefix(sanitizeTerminalLine(request.message), 120),
      ...(warning && { issues: [warningIssue(request.message)], outcome: "warning" as const }),
    };
    if (toolName === "contact_parent") summary.action = request.action;
    if (!result) return phase === "settled" || context.isError ? undefined : summary;
    if (context.isError)
      return phase === "settled"
        ? {
            ...summary,
            outcome: "error",
            issues: [
              rejectedCallIssue(request.action, getTextContent(result.content), "the parent"),
            ],
          }
        : undefined;
    if (request.action === "question")
      return parentReplyText(result) === undefined
        ? undefined
        : { ...summary, counters: ["answered"], outcome: "success" };
    const receipt = decodeReceipt(result);
    if (receipt._tag === "None" || !acknowledged(request, receipt.value.content[0]!.text))
      return undefined;
    return { ...summary, counters: ["acknowledged"], outcome: warning ? "warning" : "success" };
  };
}

/** Input evidence and replies only; the shared shell renders acknowledgement and warning issues. */
export function createParentExpandedContent(
  toolName: string,
): NonNullable<CodePreviewShellOptions["expandedContent"]> {
  const project = createParentCompactSummary(toolName);
  return {
    renderCall: (args, theme, context) => {
      if (!Predicate.isObject(args)) return new Text("", 0, 0);
      const warning =
        toolName === "supervisor_warning" || ("kind" in args && args.kind === "warning");
      const message = "report" in args ? args.report : "message" in args ? args.message : undefined;
      return new Text(
        (!warning || context.isError) && Predicate.isString(message)
          ? theme.fg("toolOutput", stripTerminalControls(message))
          : "",
        0,
        0,
      );
    },
    renderResult: (result, options, theme, context) => {
      const summary = project({
        phase: options.isPartial ? "running" : "settled",
        args: context?.args,
        result,
        context,
      });
      const text = stripTerminalControls(getTextContent(result.content));
      if (summary && context.isError)
        return expandedSection(theme, "Error", new Text(theme.fg("toolOutput", text), 0, 0));
      const shown = !summary || parentReplyText(result) !== undefined ? text : "";
      return new Text(theme.fg("toolOutput", shown), 0, 0);
    },
  };
}
