import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  captureCodePreviewPresentationPolicy,
  renderCompactIssues,
  renderCompactRow,
  type CompactSummary,
} from "pi-code-previews";
import { stripTerminalControls } from "pi-cosmic-core/security";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { composeToolComponent, renderExpansionAffordance } from "pi-cosmic-ui/tool";
import { TaskNoticeDetailsSchema } from "../task/notice.ts";
import { taskNoticeSummary } from "./compact-summary.ts";

const Envelope = Schema.Struct({
  content: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.Unknown)])),
  details: Schema.optional(Schema.Unknown),
});
const TextPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });

const decodeEnvelope = Schema.decodeUnknownOption(Envelope, { onExcessProperty: "ignore" });
const decodeDetails = Schema.decodeUnknownOption(TaskNoticeDetailsSchema, {
  onExcessProperty: "ignore",
});
const isTextPart = Schema.is(TextPart);

const contentText = (content: string | ReadonlyArray<unknown> | undefined): string =>
  Predicate.isString(content)
    ? content
    : Arr.join(
        Arr.map(Arr.filter(content ?? [], isTextPart), (part) => part.text),
        "\n",
      );

const UNKNOWN_NOTICE: CompactSummary = { subject: "finished" };

/**
 * Shows a finished task's notice like a status row: the task, how it ended, and its issues
 * collapsed; the notice the agent read, with issue details, expanded. Undecodable details fall
 * back to a neutral row. Pi renders every frame, so rows are kept for the width they fit.
 */
export const renderTaskNotice: MessageRenderer = (message, options, theme) => {
  const envelope = Option.getOrUndefined(decodeEnvelope(message));
  const details = Option.getOrUndefined(decodeDetails(envelope?.details));
  const summary = details ? taskNoticeSummary(details.task) : UNKNOWN_NOTICE;
  const text = options.expanded ? stripTerminalControls(contentText(envelope?.content)) : "";
  const compact = captureCodePreviewPresentationPolicy().toolCallCollapsedStyle === "compact";
  const hint =
    options.expanded || compact ? undefined : renderExpansionAffordance("notice", false, theme);
  let rendered: { readonly width: number; readonly rows: string[] } | undefined;
  return composeToolComponent((width) => {
    if (rendered?.width === width) return rendered.rows;
    const inner = Math.max(1, width - options.outputPad * 2);
    const row = renderCompactRow(
      {
        name: "background task",
        phase: "settled",
        summary,
        ...(details === undefined && { status: "returned" as const }),
        expanded: options.expanded,
      },
      theme,
      inner,
    );
    const lines = [
      row,
      ...renderCompactIssues(summary.issues, theme, inner, options.expanded),
      ...(hint ? [clipToWidth(hint, inner)] : []),
      ...(text ? ["", text] : []),
    ];
    const rows = new Text(Arr.join(lines, "\n"), options.outputPad, 0).render(width);
    rendered = { width, rows };
    return rows;
  });
};
