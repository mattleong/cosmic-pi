import { absurd } from "effect/Function";
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
  })} · ${candidate.context} · ${candidate.writeIntent}`;

const PROFILE_SOURCE_LABELS = {
  session: "session override",
  project: "project override",
  "project-invalid": "invalid project override",
  global: "global override",
  "global-invalid": "invalid global override",
  builtin: "built-in",
} as const satisfies Record<SubagentProfileRouteCard["source"], string>;

const profileRouteSummary = (profile: SubagentProfileRouteCard, theme: Theme): string => {
  const eligible = profile.candidates.filter((candidate) => candidate.status === "eligible").length;
  const invalid = profile.source.endsWith("-invalid");
  const color = invalid || eligible === 0 ? "warning" : "success";
  const firstCandidate = profile.candidates[0];
  const first = firstCandidate ? formattedCandidateRoute(firstCandidate) : undefined;
  return theme.fg(
    color,
    `• ${profile.id}${profile.isDefault ? " · fallback" : ""} · ${PROFILE_SOURCE_LABELS[profile.source]} · ${eligible}/${profile.candidates.length} eligible${first ? ` · ${first}` : " · disabled"}`,
  );
};

const profileRouteLines = (
  profile: SubagentProfileRouteCard,
  expanded: boolean,
  theme: Theme,
): string[] => {
  const summary = profileRouteSummary(profile, theme);
  if (!expanded) return [summary];
  return [
    summary,
    theme.fg("dim", `  ${profile.description}`),
    theme.fg(
      "dim",
      `  Defaults · ${profile.defaultContext} · ${profile.defaultWriteIntent} · ${profile.defaultEffort ?? "inherit effort"}`,
    ),
    ...profile.candidates.flatMap((candidate, index) => [
      theme.fg(
        candidate.status === "eligible" ? "success" : "warning",
        `  ${candidate.status === "eligible" ? "✓" : "–"} ${index + 1}. ${formattedCandidateRoute(candidate)}`,
      ),
      theme.fg("dim", `     ${candidate.reason}`),
    ]),
  ];
};

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
    for (const profile of profiles) lines.push(...profileRouteLines(profile, expanded, theme));
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

const failureCounts = (
  details: RunToolDetails,
  failures: ActionFailureCounts,
): ReadonlyArray<string> => [
  ...(failures.pending > 0 ? [`${failures.pending} awaiting confirmation`] : []),
  ...(failures.unconfirmed > 0 ? [`${failures.unconfirmed} unconfirmed`] : []),
  ...(failures.failed > 0
    ? [`${failures.failed} ${details.action === "status" ? "missing" : "failed"}`]
    : []),
];

const primaryCount = (details: RunToolDetails, count: number): string => {
  switch (details.action) {
    case "list":
      return count > 0 ? countLabel(count, "subagent") : "No subagents";
    case "status":
      return `${count} found`;
    case "send": {
      const answered = details.answeredRunIds?.length ?? 0;
      if (answered === 0) return `${count} delivered`;
      return count > answered
        ? `${answered} answered · ${count - answered} guided`
        : `${answered} answered`;
    }
    case "interrupt":
      return `${count} paused`;
    case "retry":
      return `${countLabel(count, "retry", "retries")} started`;
    case "resume":
    case "stop":
      return `${count} updated`;
  }
  return absurd(details.action);
};

const countersText = (details: RunToolDetails, count: number, failures: ActionFailureCounts) => {
  const exceptional = failureCounts(details, failures);
  return [
    ...(count > 0 || exceptional.length === 0 || details.action === "list"
      ? [primaryCount(details, count)]
      : []),
    ...exceptional,
  ].join(" · ");
};

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
