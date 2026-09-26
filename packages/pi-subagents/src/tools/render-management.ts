import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import { sanitizeTerminalLine } from "pi-cosmic-core";
import { managerStateGlyph } from "pi-cosmic-ui/manager";
import { formatRunRoute } from "../ui/run-presentation.ts";
import {
  composeToolComponent as renderComponent,
  renderExpansionAffordance,
} from "pi-cosmic-ui/tool";
import type {
  CompactSubagentToolDetails,
  SubagentProfileCandidateCard,
  SubagentProfileRouteCard,
  SubagentRunCard,
} from "./details-schema.ts";

type ModelsToolDetails = Extract<CompactSubagentToolDetails, { readonly action: "models" }>;
type RunToolDetails = Exclude<CompactSubagentToolDetails, ModelsToolDetails>;

export interface SemanticOutcomeBanner {
  readonly color: "warning" | "success" | "error" | "accent";
  readonly text: string;
}

/** [lower-cased code substrings, recovery text, optional message-only substrings]. */
type FailureRecoveryRule = readonly [
  codes: ReadonlyArray<string>,
  recovery: string,
  messages?: ReadonlyArray<string>,
];

const START_FAILURE_RECOVERY_RULES: ReadonlyArray<FailureRecoveryRule> = [
  [
    ["profile", "candidate", "auth", "harness", "model", "unsupported", "confinement", "readiness"],
    "Inspect the effective route with subagent_models or choose a compatible route in /subagents profiles.",
  ],
  [
    ["capacity", "writer"],
    "Resolve the reported capacity or writer-ownership constraint, then retry the launch.",
  ],
];
const ACTION_FAILURE_RECOVERY_RULES: ReadonlyArray<FailureRecoveryRule> = [
  [["notfound", "not_found"], "Refresh run IDs with subagent_list.", ["not found"]],
  [
    ["completion_claim_conflict"],
    "Wait for or cancel the operation that already owns this completion, then retry.",
  ],
  [
    ["retry_route_exhausted"],
    "The original profile route is exhausted; only now consider a generalist replacement.",
  ],
  [
    ["retry_cleanup_unconfirmed", "retry_outcome_uncertain"],
    "Do not retry automatically; inspect the failed run and resolve the reported ownership uncertainty.",
  ],
  [
    ["retry_claim", "retry_already"],
    "Inspect the predecessor and its linked successor with subagent_status.",
  ],
  [
    ["report_delivery_backlog"],
    "Wait for automatic outcome delivery or claim the current outcome with subagent_await, then retry.",
  ],
  [
    ["reply_outcome_uncertain"],
    "Do not resend the reply automatically; inspect subagent_status and wait for the run's next event.",
  ],
  [
    ["reply_send_failed"],
    "The reply was never delivered and the question is still pending; resend it with subagent_reply.",
  ],
  [["reply_too_large"], "The question is still pending; send a shorter reply with subagent_reply."],
  [
    ["question_transport_closed"],
    "The helper connection closed and the question was cancelled; inspect subagent_status before taking another action.",
  ],
  [
    ["question_ownership_mismatch"],
    "The question is no longer pending; refresh the run with subagent_status before taking another action.",
  ],
  [
    ["waiting_for_parent", "parent_question"],
    "Reply with subagent_reply, then await the run again.",
    ["waiting for a parent reply"],
  ],
  [["capability", "unsupported"], "Inspect the run's capabilities with subagent_status."],
  [
    ["profile", "candidate", "auth", "harness", "model"],
    "Inspect the effective route with subagent_models or edit it with /subagents profiles.",
  ],
];
export const failureRecovery = (
  code: string | undefined,
  message: string,
  context: "start" | "action" = "action",
): string => {
  const normalizedCode = code?.toLowerCase() ?? "";
  const normalizedMessage = message.toLowerCase();
  const [rules, fallback] =
    context === "start"
      ? [
          START_FAILURE_RECOVERY_RULES,
          "Review the launch failure and profile route before retrying.",
        ]
      : [
          ACTION_FAILURE_RECOVERY_RULES,
          "Review the failure detail and current subagent_status before retrying.",
        ];
  const matched = rules.find(
    ([codes, , messages]) =>
      codes.some((needle) => normalizedCode.includes(needle)) ||
      messages?.some((needle) => normalizedMessage.includes(needle)),
  );
  return matched?.[1] ?? fallback;
};

const formattedCandidateRoute = (candidate: SubagentProfileCandidateCard): string =>
  `${formatRunRoute({
    ...candidate,
    openaiFastMode: candidate.openaiFastMode && candidate.status === "eligible",
  })} · ${candidate.context} · ${candidate.writeIntent} · ${candidate.closeOnReport ? "close after report" : "retain after report"}`;

const PROFILE_SOURCE_LABELS = {
  session: "session override",
  project: "project override",
  "project-invalid": "invalid project override",
  global: "global override",
  "global-invalid": "invalid global override",
  builtin: "built-in",
} as const satisfies Record<SubagentProfileRouteCard["source"], string>;

export const renderProfileRoutesComponent = (
  details: ModelsToolDetails,
  expanded: boolean,
  theme: Theme,
  contentOnly = false,
): Component =>
  renderComponent((width) => {
    const safeWidth = Math.max(1, width);
    const profiles = details.profiles;
    const lines: string[] = contentOnly
      ? []
      : [
          theme.fg(
            "accent",
            `Profile routes · static eligibility only${details.fallbackProfile ? ` · fallback ${details.fallbackProfile}` : ""}`,
          ),
        ];
    if (contentOnly && details.fallbackProfile)
      lines.push(theme.fg("dim", `Fallback profile: ${details.fallbackProfile}`));
    for (const profile of profiles) {
      const eligible = profile.candidates.filter(
        (candidate) => candidate.status === "eligible",
      ).length;
      const invalid = profile.source.endsWith("-invalid");
      const color = invalid || eligible === 0 ? "warning" : "success";
      const firstCandidate = profile.candidates[0];
      const first = firstCandidate ? formattedCandidateRoute(firstCandidate) : undefined;
      lines.push(
        theme.fg(
          color,
          `• ${profile.id}${profile.isDefault ? " · when omitted" : ""} · ${PROFILE_SOURCE_LABELS[profile.source]} · ${eligible}/${profile.candidates.length} eligible${first ? ` · ${first}` : " · disabled"}`,
        ),
      );
      if (!expanded) continue;
      lines.push(theme.fg("dim", `  ${profile.description}`));
      lines.push(
        theme.fg(
          "dim",
          `  Defaults · ${profile.defaultContext} · ${profile.defaultWriteIntent} · ${profile.defaultEffort ?? "inherit effort"}`,
        ),
      );
      for (const [index, candidate] of profile.candidates.entries()) {
        lines.push(
          theme.fg(
            candidate.status === "eligible" ? "success" : "warning",
            `  ${candidate.status === "eligible" ? "✓" : "–"} ${index + 1}. ${formattedCandidateRoute(candidate)}`,
          ),
        );
        lines.push(theme.fg("dim", `     ${candidate.reason}`));
      }
    }
    if (profiles.length === 0)
      lines.push(theme.fg("muted", "No profile route details were persisted."));
    if (details.contentOmitted && !contentOnly)
      lines.push(theme.fg("warning", "Long model or route-detail text was omitted."));
    lines.push(
      theme.fg(
        "dim",
        "Launch checks pending · executable, authentication, native integration, and private harness are checked at launch.",
      ),
    );
    return lines.flatMap((line) =>
      expanded ? wrapTextWithAnsi(line, safeWidth) : [truncateToWidth(line, safeWidth)],
    );
  });

const summaryText = (
  details: RunToolDetails,
  count: number,
  failed: number,
  failedSuffix: string,
): string => {
  const plural = count === 1 ? "" : "s";
  const missing = failed > 0 ? ` · ${failed} missing` : "";
  switch (details.action) {
    case "list":
      return count > 0 ? `${count} session subagent${plural}` : "No session subagents";
    case "status":
      return `Status · ${count} found${missing}`;
    case "send": {
      // closeOnReport=false targets started their next assignment; others got guidance.
      const cards = details.cards;
      const retained = cards.filter((card) => card.closeOnReport === false).length;
      const label =
        cards.length > 0 && retained === cards.length
          ? "Next assignments"
          : retained > 0
            ? "Guidance/next assignments"
            : "Guidance";
      return `${label} · ${count} delivered${failedSuffix}`;
    }
    case "reply":
      return failed > 0 ? "Reply failed" : `Reply delivered to ${count} subagent${plural}`;
    case "rename":
      return failed > 0 ? "Rename failed" : "Subagent renamed";
    case "interrupt":
      return `Interrupt · ${count} paused${failedSuffix}`;
    case "resume":
      return `Resume · ${count} updated${failedSuffix}`;
    case "stop":
      return `Stop · ${count} updated${failedSuffix}`;
    default:
      return `${details.action} · ${count} result${plural}${failedSuffix}`;
  }
};

export type SemanticRunRenderer = (
  cards: ReadonlyArray<SubagentRunCard>,
  expanded: boolean,
  banner: SemanticOutcomeBanner,
  showReports: boolean,
) => Component;

export const renderCompactResultComponent = (
  details: RunToolDetails,
  expanded: boolean,
  theme: Theme,
  renderRuns: SemanticRunRenderer,
): Component => {
  const renderActionFailures = (width: number): ReadonlyArray<string> =>
    (details.actionFailures ?? []).flatMap((failure) => {
      const code = failure.code ? ` [${sanitizeTerminalLine(failure.code)}]` : "";
      const recovery = failureRecovery(failure.code, failure.message);
      const summary = theme.fg(
        "error",
        `${managerStateGlyph("failed")} ${sanitizeTerminalLine(failure.id)}${code} · ${sanitizeTerminalLine(failure.message)}`,
      );
      const summaryLines = expanded
        ? wrapTextWithAnsi(summary, width)
        : [truncateToWidth(summary, width)];
      const hidden = !expanded && visibleWidth(summary) > width;
      return [
        ...summaryLines,
        truncateToWidth(theme.fg("accent", `  Next: ${recovery}`), width),
        ...(hidden
          ? [truncateToWidth(renderExpansionAffordance("failure text", false, theme), width)]
          : []),
      ];
    });

  return renderComponent((width) => {
    const safeWidth = Math.max(1, width);
    const cards = details.cards;
    const count = details.runCount;
    const failed = details.actionFailures?.length ?? 0;
    const neutral =
      details.action === "list" ||
      details.action === "status" ||
      details.action === "retry" ||
      details.action === "claims";
    const strict = details.action === "reply" || details.action === "rename";
    const color: SemanticOutcomeBanner["color"] =
      failed === 0
        ? neutral
          ? "accent"
          : "success"
        : details.action === "send"
          ? count > 0
            ? "warning"
            : "error"
          : strict
            ? "error"
            : "warning";
    const summary: SemanticOutcomeBanner = {
      color,
      text: summaryText(details, count, failed, failed > 0 ? ` · ${failed} failed` : ""),
    };
    const omittedRuns = Math.max(0, count - cards.length);
    const omissionCues = [
      ...(omittedRuns > 0
        ? [
            `${cards.length} of ${count} shown · ${omittedRuns} omitted · use subagent_status for specific run IDs`,
          ]
        : []),
      ...(details.contentOmitted
        ? ["Report content omitted · use subagent_status for individual run IDs"]
        : []),
    ];
    const omissionLines = omissionCues.flatMap((cue) =>
      wrapTextWithAnsi(theme.fg("warning", cue), safeWidth),
    );
    return [
      ...renderRuns(cards, expanded, summary, details.action === "status").render(safeWidth),
      ...omissionLines,
      ...renderActionFailures(safeWidth),
    ];
  });
};
