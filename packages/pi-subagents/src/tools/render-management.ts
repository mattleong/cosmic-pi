import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { expandedSection } from "pi-code-previews";
import { countLabel, sanitizeTerminalLine } from "pi-cosmic-core";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { formatRunRoute } from "../ui/run-presentation.ts";
import { composeToolComponent as renderComponent } from "pi-cosmic-ui/tool";
import type {
  CompactSubagentToolDetails,
  SubagentProfileCandidateCard,
  SubagentProfileRouteCard,
  SubagentRunCard,
} from "./details-schema.ts";
import {
  actionFailureDisposition,
  countActionFailures,
  isUncertainToolFailure,
  unconfirmedActionRecovery,
  type ActionFailureCounts,
} from "./outcome.ts";

type ModelsToolDetails = Extract<CompactSubagentToolDetails, { readonly action: "models" }>;
type RunToolDetails = Exclude<CompactSubagentToolDetails, ModelsToolDetails>;

/** [lower-cased code substrings, recovery text, optional message-only substrings]. */
type FailureRecoveryRule = readonly [
  codes: ReadonlyArray<string>,
  recovery: string,
  messages?: ReadonlyArray<string>,
];

const SCRIPTED_WRITER_RECOVERY: FailureRecoveryRule = [
  ["scripted_subtree_writer_not_supported", "scripted_writer_not_supported"],
  "Hand writer work back to the root main agent for authorization and a separate launch outside the script-origin tree.",
];
const START_FAILURE_RECOVERY_RULES: ReadonlyArray<FailureRecoveryRule> = [
  SCRIPTED_WRITER_RECOVERY,
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
  SCRIPTED_WRITER_RECOVERY,
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
    ["retry_claim", "retry_already"],
    "Inspect the predecessor and its linked successor with subagent_status.",
  ],
  [
    ["report_delivery_backlog"],
    "Wait for automatic outcome delivery or claim the current outcome with subagent_await, then retry.",
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
/** Uncertain outcomes never reach retry-shaped rules; these keep their specific no-resend hints. */
const UNCERTAIN_FAILURE_RECOVERY_RULES: ReadonlyArray<FailureRecoveryRule> = [
  [
    ["retry_cleanup_unconfirmed", "retry_outcome_uncertain"],
    "Do not retry automatically; inspect the failed run and resolve the reported ownership uncertainty.",
  ],
  [
    ["reply_outcome_uncertain"],
    "Do not resend the reply automatically; inspect subagent_status and wait for the run's next event.",
  ],
];
const PENDING_DELIVERY_RECOVERY =
  "Delivery is still tracked; do not resend, retry, interrupt, or replace for this. Continue or await; stop remains available.";

export const failureRecovery = (
  code: string | undefined,
  message: string,
  context: "start" | "action" = "action",
): string => {
  const normalizedCode = code?.toLowerCase() ?? "";
  const normalizedMessage = message.toLowerCase();
  const [rules, fallback] = isUncertainToolFailure({ code: normalizedCode })
    ? [
        UNCERTAIN_FAILURE_RECOVERY_RULES,
        context === "start"
          ? "Do not retry the launch automatically; it may already have taken effect. Inspect subagent_list and subagent_status before recovery."
          : unconfirmedActionRecovery,
      ]
    : context === "start"
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
      lines.push(theme.fg("dim", "Long model or route-detail text was omitted."));
    lines.push(
      theme.fg(
        "dim",
        "Launch checks pending · executable, authentication, native integration, and private harness are checked at launch.",
      ),
    );
    return lines.flatMap((line) =>
      expanded ? wrapTextWithAnsi(line, safeWidth) : [clipToWidth(line, safeWidth)],
    );
  });

/** Nonzero exceptional counts, each in its own words: "1 awaiting confirmation · 1 failed". */
const failureCounts = (
  details: RunToolDetails,
  failures: ActionFailureCounts,
): ReadonlyArray<string> => [
  ...(failures.pending > 0 ? [`${failures.pending} awaiting confirmation`] : []),
  ...(failures.unconfirmed > 0 ? [`${failures.unconfirmed} unconfirmed`] : []),
  // Status only reads, so a target it could not read is missing, not failed.
  ...(failures.failed > 0
    ? [`${failures.failed} ${details.action === "status" ? "missing" : "failed"}`]
    : []),
];

/** What each action did to the targets it reached, as a count. */
const primaryCount = (details: RunToolDetails, count: number): string => {
  switch (details.action) {
    case "list":
      return count > 0 ? countLabel(count, "subagent") : "No subagents";
    case "status":
      return `${count} found`;
    case "send": {
      // closeOnReport=false targets started their next assignment; others got guidance.
      const retained = details.cards.filter((card) => card.closeOnReport === false).length;
      return retained > 0 && retained === details.cards.length
        ? `${countLabel(count, "next assignment")} started`
        : `${count} delivered`;
    }
    case "reply":
      return `${count} delivered`;
    case "rename":
      return `${count} renamed`;
    case "interrupt":
      return `${count} paused`;
    case "retry":
      return `${countLabel(count, "retry", "retries")} started`;
    case "claims":
      return countLabel(count, "subagent");
    default:
      return `${count} updated`;
  }
};

/**
 * Routine counters as muted body text. A count of zero beside failures says nothing the
 * failure count does not; the shell's issue lines explain the failures themselves.
 */
const countersText = (details: RunToolDetails, count: number, failures: ActionFailureCounts) => {
  const exceptional = failureCounts(details, failures);
  return [
    ...(count > 0 || exceptional.length === 0 || details.action === "list"
      ? [primaryCount(details, count)]
      : []),
    ...exceptional,
  ].join(" · ");
};

export type RunCardRenderer = (
  cards: ReadonlyArray<SubagentRunCard>,
  expanded: boolean,
  counters: string,
  showReports: boolean,
) => Component;

/** Failed targets by ID, code, and recovery: agent evidence, so only once expanded. */
const failedTargetLines = (details: RunToolDetails, width: number, theme: Theme): string[] =>
  (details.actionFailures ?? []).flatMap((failure) => {
    const code = failure.code ? ` [${sanitizeTerminalLine(failure.code)}]` : "";
    const recovery =
      actionFailureDisposition(details.action, failure) === "pending"
        ? PENDING_DELIVERY_RECOVERY
        : failureRecovery(failure.code, failure.message);
    return [
      ...wrapTextWithAnsi(
        theme.fg(
          "toolOutput",
          `${sanitizeTerminalLine(failure.id)}${code} · ${sanitizeTerminalLine(failure.message)}`,
        ),
        width,
      ),
      ...wrapTextWithAnsi(theme.fg("dim", `  Next: ${recovery}`), width),
    ];
  });

export const renderCompactResultComponent = (
  details: RunToolDetails,
  expanded: boolean,
  theme: Theme,
  renderRuns: RunCardRenderer,
): Component => {
  const failures = countActionFailures(details.action, details.actionFailures);
  const failed = expandedSection(
    theme,
    failures.failed > 0 ? "Failed targets" : "Unconfirmed targets",
    renderComponent((width) => failedTargetLines(details, Math.max(1, width), theme)),
  );
  return renderComponent((width) => {
    const safeWidth = Math.max(1, width);
    const counters = countersText(details, details.runCount, failures);
    return [
      ...renderRuns(details.cards, expanded, counters, details.action === "status").render(
        safeWidth,
      ),
      ...(expanded && (details.actionFailures?.length ?? 0) > 0 ? failed.render(safeWidth) : []),
    ];
  });
};
