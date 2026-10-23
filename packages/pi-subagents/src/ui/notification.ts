import type { MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Match from "effect/Match";
import { countLabel, stripTerminalControls } from "pi-cosmic-core";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { composeToolComponent, renderExpansionAffordance } from "pi-cosmic-ui/tool";
import { renderCompactRow, type CompactStatus, type CompactSummary } from "pi-code-previews";
import { decodeMessageEnvelope, messageContentText } from "./message-envelope.ts";

const Count = Schema.Natural.check(Schema.isLessThanOrEqualTo(100_000));
const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120));
const Details = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("question"),
    name: Schema.optional(Name),
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("completed"),
    total: Count,
    failed: Count,
    warnings: Count,
    name: Schema.optional(Name),
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("stopped"),
    total: Count,
    name: Schema.optional(Name),
  }),
]);
type NotificationDetails = typeof Details.Type;
const decodeDetails = Schema.decodeUnknownOption(Details, { onExcessProperty: "ignore" });

interface NotificationRow {
  readonly summary: CompactSummary;
  readonly status?: CompactStatus;
}

const UNTYPED_SUBJECTS = new Map([
  ["pi-subagents-proxy-notification", "Update about a nested subagent"],
  ["pi-subagents-peer-notice", "Working directory shared with other subagents"],
]);

const completedRow = (
  details: Extract<NotificationDetails, { readonly kind: "completed" }>,
): NotificationRow => {
  const finished = details.total - details.failed;
  const outcome = details.failed ? "error" : details.warnings ? "warning" : "success";
  const single = details.total === 1 && details.name;
  const subject = single
    ? `${details.name} ${details.failed ? "failed" : details.warnings ? "finished with a warning" : "finished"}`
    : Fn.pipe(
        [
          finished ? `${finished} finished` : "",
          details.failed ? `${details.failed} failed` : "",
          details.warnings ? `${details.warnings} with warnings` : "",
        ],
        Arr.filter(Boolean),
        Arr.join(", "),
      );
  return { summary: { subject, outcome } };
};

const notificationRow = (
  customType: string | undefined,
  details: NotificationDetails | undefined,
): NotificationRow => {
  if (details?.kind === "question")
    return {
      summary: { subject: `${details.name ?? "A subagent"} needs a reply`, outcome: "warning" },
    };
  if (details?.kind === "stopped" && details.total > 0)
    return {
      summary: {
        subject:
          details.total === 1 && details.name
            ? `${details.name} stopped`
            : `${countLabel(details.total, "subagent")} stopped`,
        outcome: "warning",
      },
    };
  if (
    details?.kind === "completed" &&
    details.total > 0 &&
    details.failed <= details.total &&
    details.warnings <= details.total
  )
    return completedRow(details);
  return {
    summary: { subject: UNTYPED_SUBJECTS.get(customType ?? "") ?? "Subagent update" },
    status: "returned",
  };
};

const expansionLabel = (details: NotificationDetails | undefined): string => {
  if (details === undefined) return "message";
  return Match.value(details).pipe(
    Match.when({ kind: "question" }, () => "question"),
    Match.when({ kind: "stopped" }, () => "list"),
    Match.when({ kind: "completed" }, (completed) =>
      completed.failed === completed.total
        ? countLabel(completed.total, "failure detail")
        : countLabel(completed.total, "report"),
    ),
    Match.orElse(() => "message"),
  );
};

export function renderSubagentNotification(
  input: Parameters<MessageRenderer>[0],
  options: { expanded: boolean; outputPad: number },
  compact: boolean,
  theme: Theme,
): Component {
  const envelope = Option.getOrUndefined(decodeMessageEnvelope(input));
  if (options.expanded)
    return new Text(
      stripTerminalControls(messageContentText(envelope?.content)),
      options.outputPad,
      0,
    );
  const details = Option.getOrUndefined(decodeDetails(envelope?.details));
  const { summary, status } = notificationRow(envelope?.customType, details);
  const hint = compact
    ? undefined
    : renderExpansionAffordance(expansionLabel(details), false, theme);
  return composeToolComponent((width) => {
    const inner = Math.max(1, width - options.outputPad * 2);
    const row = renderCompactRow(
      {
        name: "subagents",
        phase: "settled",
        summary,
        ...(status && { status }),
      },
      theme,
      inner,
    );
    return new Text(
      hint ? `${row}\n${clipToWidth(hint, inner)}` : row,
      options.outputPad,
      0,
    ).render(width);
  });
}
