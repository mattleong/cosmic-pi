import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { expandedSection } from "pi-code-previews";
import { sanitizeTerminalLine } from "pi-cosmic-core";
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
import { renderExpandedRunsResult, runOverviewComponent } from "./render-run-overview.ts";

type ModelsToolDetails = Extract<CompactSubagentToolDetails, { readonly action: "models" }>;
type RunToolDetails = Exclude<CompactSubagentToolDetails, ModelsToolDetails>;

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
  const eligible = Arr.filter(
    profile.candidates,
    (candidate) => candidate.status === "eligible",
  ).length;
  const invalid = Fn.pipe(profile.source, Str.endsWith("-invalid"));
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
    ...Arr.flatMap(profile.candidates, (candidate, index) => [
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
    return Arr.flatMap(lines, (line) =>
      expanded ? wrapTextWithAnsi(line, safeWidth) : [clipToWidth(line, safeWidth)],
    );
  });

const failureCounts = (failures: ActionFailureCounts): ReadonlyArray<string> => [
  ...(failures.unconfirmed > 0 ? [`${failures.unconfirmed} unconfirmed`] : []),
  ...(failures.failed > 0 ? [`${failures.failed} failed`] : []),
];

const primaryCount = (details: RunToolDetails, count: number): string => {
  switch (details.action) {
    case "interrupt":
      return `${count} paused`;
    case "stop":
      return `${count} updated`;
  }
  return Fn.absurd(details.action);
};

const countersText = (details: RunToolDetails, count: number, failures: ActionFailureCounts) => {
  const exceptional = failureCounts(failures);
  return Arr.join(
    [
      ...(count > 0 || exceptional.length === 0 ? [primaryCount(details, count)] : []),
      ...exceptional,
    ],
    " · ",
  );
};

const failedTargetLines = (
  failures: ReadonlyArray<CompactToolActionFailure>,
  width: number,
  theme: Theme,
): string[] =>
  Arr.flatMap(failures, (failure) => {
    const code = failure.code ? ` [${sanitizeTerminalLine(failure.code)}]` : "";
    return [
      ...wrapTextWithAnsi(
        theme.fg(
          "toolOutput",
          `${sanitizeTerminalLine(failure.id)}${code} · ${sanitizeTerminalLine(failure.message)}`,
        ),
        width,
      ),
      ...wrapTextWithAnsi(
        theme.fg("dim", `  Next: ${failureRecovery(failure.code, failure.message)}`),
        width,
      ),
    ];
  });

const failureSections = (details: RunToolDetails, theme: Theme): ReadonlyArray<Component> =>
  Arr.flatMap(ACTION_FAILURE_SECTIONS, ([disposition, title]) => {
    const failures = Arr.filter(
      details.actionFailures ?? [],
      (failure) => actionFailureDisposition(failure) === disposition,
    );
    return failures.length === 0
      ? []
      : [
          expandedSection(
            theme,
            title,
            renderComponent((width) => failedTargetLines(failures, Math.max(1, width), theme)),
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
    countActionFailures(details.actionFailures),
  );
  const failures = expanded ? failureSections(details, theme) : [];
  return renderComponent((width) => {
    const safeWidth = Math.max(1, width);
    const runs = expanded
      ? renderExpandedRunsResult(details.cards, theme, counters)
      : runOverviewComponent(details.cards, theme, {
          expanded: false,
          reportSections: [],
          counters,
        });
    return Arr.flatMap([runs, ...failures], (component) => component.render(safeWidth));
  });
};
