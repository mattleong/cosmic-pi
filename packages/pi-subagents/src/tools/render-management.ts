import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { expandedSection } from "pi-code-previews";
import { countLabel, sanitizeTerminalLine } from "pi-cosmic-core";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { formatRunRoute } from "../ui/run-presentation.ts";
import { composeToolComponent as renderComponent } from "pi-cosmic-ui/tool";
import { failureRecovery } from "./compact-action-failures.ts";
import type {
  CompactSubagentToolDetails,
  CompactToolActionFailure,
  SubagentProfileCandidateCard,
  SubagentProfileRouteCard,
} from "./details-schema.ts";
import { ACTION_FAILURE_SECTIONS } from "./format.ts";
import {
  actionFailureDisposition,
  countActionFailures,
  type ActionFailureCounts,
} from "./outcome.ts";
import {
  expandedRunReportSections,
  renderExpandedRunsResult,
  runOverviewComponent,
} from "./render-run-overview.ts";

type ModelsToolDetails = Extract<CompactSubagentToolDetails, { readonly action: "models" }>;
type RunToolDetails = Exclude<CompactSubagentToolDetails, ModelsToolDetails>;

const PENDING_DELIVERY_RECOVERY =
  "Delivery is still tracked; do not resend, retry, interrupt, or replace for this. Continue or await; stop remains available.";

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
          `• ${profile.id}${profile.isDefault ? " · fallback" : ""} · ${PROFILE_SOURCE_LABELS[profile.source]} · ${eligible}/${profile.candidates.length} eligible${first ? ` · ${first}` : " · disabled"}`,
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
    case "send":
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

/** Failed targets by ID, code, and recovery: agent evidence, so only once expanded. */
const failedTargetLines = (
  failures: ReadonlyArray<CompactToolActionFailure>,
  recovery: (failure: CompactToolActionFailure) => string,
  width: number,
  theme: Theme,
): string[] =>
  failures.flatMap((failure) => {
    const code = failure.code ? ` [${sanitizeTerminalLine(failure.code)}]` : "";
    return [
      ...wrapTextWithAnsi(
        theme.fg(
          "toolOutput",
          `${sanitizeTerminalLine(failure.id)}${code} · ${sanitizeTerminalLine(failure.message)}`,
        ),
        width,
      ),
      ...wrapTextWithAnsi(theme.fg("dim", `  Next: ${recovery(failure)}`), width),
    ];
  });

/** Pending delivery is neither delivered nor failed, so each disposition has its own section. */
const failureSections = (details: RunToolDetails, theme: Theme): ReadonlyArray<Component> =>
  ACTION_FAILURE_SECTIONS.flatMap(([disposition, title]) => {
    const failures = (details.actionFailures ?? []).filter(
      (failure) => actionFailureDisposition(details.action, failure) === disposition,
    );
    const recovery = (failure: CompactToolActionFailure) =>
      disposition === "pending"
        ? PENDING_DELIVERY_RECOVERY
        : failureRecovery(failure.code, failure.message);
    return failures.length === 0
      ? []
      : [
          expandedSection(
            theme,
            title,
            renderComponent((width) =>
              failedTargetLines(failures, recovery, Math.max(1, width), theme),
            ),
          ),
        ];
  });

export const renderCompactResultComponent = (
  details: RunToolDetails,
  expanded: boolean,
  theme: Theme,
): Component => {
  const counters = countersText(
    details,
    details.runCount,
    countActionFailures(details.action, details.actionFailures),
  );
  const failures = expanded ? failureSections(details, theme) : [];
  // A status says where each report went; a list draws its runs as a tree.
  const showReports = details.action === "status";
  const hierarchy = details.action === "list" ? {} : undefined;
  return renderComponent((width) => {
    const safeWidth = Math.max(1, width);
    const runs = expanded
      ? renderExpandedRunsResult(details.cards, theme, counters, showReports, hierarchy)
      : runOverviewComponent(details.cards, theme, {
          expanded: false,
          reportSections: showReports ? expandedRunReportSections(details.cards) : [],
          counters,
          showReportOutcomes: showReports,
          hierarchy,
        });
    return [runs, ...failures].flatMap((component) => component.render(safeWidth));
  });
};
