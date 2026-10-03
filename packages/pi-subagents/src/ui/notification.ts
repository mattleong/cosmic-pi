import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { countLabel, formatDuration, formatTokens, stripTerminalControls } from "pi-cosmic-core";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { renderExpansionAffordance } from "pi-cosmic-ui/tool";
import { renderCompactRow, type CompactStatus, type CompactSummary } from "pi-code-previews";

const Count = Schema.Natural.check(Schema.isLessThanOrEqualTo(100_000));
const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120));
const WorkflowDetails = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("workflow"),
  name: Name,
  outcome: Schema.Literals(["completed", "failed", "stopped", "interrupted"]),
  durationMs: Schema.Natural,
  outputTokens: Schema.optional(Schema.Natural),
  agents: Count,
  failed: Count,
  skipped: Count,
  reused: Count,
});
const Details = Schema.Union([
  WorkflowDetails,
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
]);
type NotificationDetails = typeof Details.Type;
const Envelope = Schema.Struct({
  customType: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.Unknown)])),
  details: Schema.optional(Schema.Unknown),
});

const TextPart = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });

interface NotificationRow {
  readonly summary: CompactSummary;
  /** Only for messages whose outcome is not recorded: a neutral mark, never a guess. */
  readonly status?: CompactStatus;
}

/** Notices forwarded into a nested session carry no typed outcome, so they stay neutral. */
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
    : [
        finished ? `${finished} finished` : "",
        details.failed ? `${details.failed} failed` : "",
        details.warnings ? `${details.warnings} with warnings` : "",
      ]
        .filter(Boolean)
        .join(", ");
  return { summary: { subject, outcome } };
};

const WORKFLOW_OUTCOMES = {
  completed: { verb: "completed in", outcome: "success" },
  failed: { verb: "failed after", outcome: "error" },
  stopped: { verb: "stopped after", outcome: "cancelled" },
  interrupted: { verb: "interrupted", outcome: "cancelled" },
} as const;

const workflowRow = (details: typeof WorkflowDetails.Type): NotificationRow => {
  const { verb, outcome } = WORKFLOW_OUTCOMES[details.outcome];
  const problems = [
    details.failed ? `${details.failed} failed` : "",
    details.skipped ? `${details.skipped} skipped` : "",
  ].filter(Boolean);
  // A torn-down run's duration isn't known, only that it was cut short.
  const ended =
    details.outcome === "interrupted" ? verb : `${verb} ${formatDuration(details.durationMs)}`;
  const agents =
    details.outcome === "interrupted"
      ? `${countLabel(details.agents, "agent")} finished`
      : countLabel(details.agents, "agent");
  const tokens = details.outputTokens ? [`${formatTokens(details.outputTokens)} tokens`] : [];
  return {
    summary: {
      subject: details.name,
      counters: [
        [ended, agents, ...problems, ...tokens].join(" · "),
        [ended, agents, ...problems].join(" · "),
        `${ended} · ${agents}`,
        ended,
      ],
      // Failed agents don't fail the workflow; the script decides what null results mean.
      outcome: outcome === "success" && details.failed > 0 ? "warning" : outcome,
    },
  };
};

/** Typed counts and names when the notifier recorded them; a neutral row otherwise. */
const notificationRow = (
  customType: string | undefined,
  details: NotificationDetails | undefined,
): NotificationRow => {
  if (details?.kind === "workflow") return workflowRow(details);
  if (details?.kind === "question")
    return {
      summary: { subject: `${details.name ?? "A subagent"} needs a reply`, outcome: "warning" },
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

/** What expanding a notification reveals, in the words of its kind. */
const WORKFLOW_EXPANSION = {
  completed: "result",
  failed: "error",
  stopped: "details",
  interrupted: "details",
} as const;

const expansionLabel = (details: NotificationDetails | undefined): string =>
  details?.kind === "workflow"
    ? WORKFLOW_EXPANSION[details.outcome]
    : details?.kind === "question"
      ? "question"
      : details?.kind === "completed"
        ? details.failed === details.total
          ? countLabel(details.total, "failure detail")
          : countLabel(details.total, "report")
        : "message";

/**
 * The message content remains the agent's record; collapsed, it is one human row in either
 * style, so run IDs and agent procedures appear only once expanded. Preview style adds the
 * expansion hint its tool rows use.
 */
export function renderSubagentNotification<Input>(
  input: Input,
  options: { expanded: boolean; outputPad: number },
  compact: boolean,
  theme: Theme,
): Component {
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
  const { summary, status } = notificationRow(envelope?.customType, details);
  const hint = compact
    ? undefined
    : renderExpansionAffordance(expansionLabel(details), false, theme);
  return {
    render: (width) => {
      const inner = Math.max(1, width - options.outputPad * 2);
      const row = renderCompactRow(
        {
          name: details?.kind === "workflow" ? "workflow" : "subagents",
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
    },
    invalidate() {},
  };
}
