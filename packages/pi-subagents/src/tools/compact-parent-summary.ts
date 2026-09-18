import { withCompactIssues } from "pi-code-previews";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { CompactSummary, CompactSummaryProvider } from "pi-code-previews";
import { sanitizeTerminalLine, stripTerminalControls } from "pi-cosmic-core";
import { safeTextPrefix } from "../run/state.ts";
import { MAX_PARENT_MESSAGE_CHARS } from "../run/limits.ts";
import {
  SupervisorDeliveryIdSchema,
  SupervisorMessageSchema,
  SupervisorReportTextSchema,
} from "../supervisor/protocol.ts";

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

/** Only owned acknowledgements may replace a settled child result. Replies stay verbatim. */
export function createParentCompactSummary(
  toolName: string,
): CompactSummaryProvider<unknown, unknown, unknown> {
  return ({ args, result, phase, context }) => {
    if (context.isError) return undefined;
    let action: string;
    let message: string;
    let acknowledgement: string | RegExp;
    if (toolName === "contact_parent") {
      const input = decodeContact(args);
      if (input._tag === "None" || !input.value.message.trim()) return undefined;
      action = input.value.kind;
      message = input.value.message;
      acknowledgement = `Parent received ${action}.`;
    } else if (toolName === "supervisor_submit_report") {
      const input = decodeReport(args);
      if (input._tag === "None") return undefined;
      action = "report";
      message = input.value.report;
      acknowledgement =
        /^(?:Final report(?: retry)? accepted; sequence [0-9]+\.|Supervisor report already accepted\.)$/;
    } else {
      const input = decodeMessage(args);
      if (
        !["supervisor_progress", "supervisor_warning", "supervisor_question"].includes(toolName) ||
        input._tag === "None"
      )
        return undefined;
      action = toolName.slice("supervisor_".length);
      message = input.value.message;
      acknowledgement =
        action === "progress"
          ? "Progress delivered to the parent projection."
          : "Warning recorded in parent-visible run status.";
    }
    const summary: CompactSummary = {
      subject: safeTextPrefix(sanitizeTerminalLine(message), 120),
    };
    if (toolName === "contact_parent") summary.action = action;
    if (action === "warning") {
      summary.outcome = "warning";
      summary.notices = [
        { code: "parent-warning", kind: "warning", text: stripTerminalControls(message) },
      ];
    }
    if (!result) return phase === "settled" ? undefined : withCompactIssues(summary, toolName);
    if (action === "question") return undefined;
    const receipt = decodeReceipt(result);
    if (receipt._tag === "None") return undefined;
    const text = receipt.value.content[0]!.text;
    if (
      Predicate.isString(acknowledgement) ? text !== acknowledgement : !acknowledgement.test(text)
    )
      return undefined;
    return withCompactIssues(
      {
        ...summary,
        counters: ["acknowledged"],
        outcome: action === "warning" ? "warning" : "success",
        detailsOnExpand: true,
      },
      toolName,
    );
  };
}
