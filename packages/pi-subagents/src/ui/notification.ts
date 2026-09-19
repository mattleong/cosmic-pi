import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { stripTerminalControls } from "pi-cosmic-core";
import { renderCompactRow, type CompactSummary } from "pi-code-previews";

const Count = Schema.Natural.check(Schema.isLessThanOrEqualTo(100_000));
const Details = Schema.Union([
  Schema.Struct({ version: Schema.Literal(1), kind: Schema.Literal("question") }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("completed"),
    total: Count,
    failed: Count,
    warnings: Count,
  }),
]);
const Envelope = Schema.Struct({
  content: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.Unknown)])),
  details: Schema.optional(Schema.Unknown),
});

const TextPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });

/** The message content remains the agent's record. Only its compact human view changes. */
export function renderSubagentNotification<Input>(
  input: Input,
  options: { expanded: boolean; outputPad: number },
  compact: boolean,
  theme: Theme,
): Component | undefined {
  if (!compact) return undefined;
  const envelope = Option.getOrUndefined(Schema.decodeUnknownOption(Envelope)(input));
  if (options.expanded) {
    const content = envelope?.content;
    const text = Predicate.isString(content)
      ? content
      : (content ?? [])
          .flatMap((part) => {
            const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(TextPart)(part));
            return decoded ? [decoded.text] : [];
          })
          .join("\n");
    return new Text(stripTerminalControls(text), options.outputPad, 0);
  }
  const details = Option.getOrUndefined(Schema.decodeUnknownOption(Details)(envelope?.details));
  let summary: CompactSummary = { subject: "Worker update", outcome: "uncertain" };
  if (details?.kind === "question")
    summary = { subject: "A worker needs a reply.", outcome: "warning" };
  else if (
    details?.kind === "completed" &&
    details.total > 0 &&
    details.failed <= details.total &&
    details.warnings <= details.total
  ) {
    const parts = [
      details.failed
        ? `${details.failed} worker${details.failed === 1 ? "" : "s"} reported errors`
        : "",
      details.total > details.failed
        ? `${details.total - details.failed} worker reports received`
        : "",
      details.warnings ? `${details.warnings} with warnings` : "",
    ].filter(Boolean);
    summary = {
      subject: parts.join("; "),
      outcome: details.failed ? "error" : details.warnings ? "warning" : "success",
    };
  }
  return {
    render: (width) =>
      new Text(
        renderCompactRow(
          { name: "subagents", phase: "settled", summary },
          theme,
          Math.max(1, width - options.outputPad * 2),
        ),
        options.outputPad,
        0,
      ).render(width),
    invalidate() {},
  };
}
