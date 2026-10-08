/**
 * Run cards as preview bodies: routine counters, run rows, reports, and expanded diagnostics.
 * Attention and failures are the shell's issue lines; agent procedures appear only expanded,
 * under their own label.
 */
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Markdown,
  Spacer,
  Text,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import { expandedSection } from "pi-code-previews";
import {
  countLabel,
  sanitizeTerminalLine,
  stripTerminalControls as sanitizeTerminalText,
} from "pi-cosmic-core";
import { clipToWidth } from "pi-cosmic-ui/manager";
import {
  composeToolComponent as renderComponent,
  renderExpansionAffordance,
} from "pi-cosmic-ui/tool";
import { MAX_TOOL_OUTPUT_CHARS } from "../run/limits.ts";
import { isAssignmentFinishedRunState } from "../run/model.ts";
import { clipWithMarker } from "../run/state.ts";
import { aggregateUsage } from "../ui/metrics.ts";
import { profileOptionLabel } from "./compact-run-issues.ts";
import type { SubagentRunCard } from "./details-schema.ts";
import { attentionRecoveryText } from "./format.ts";
import { DESCENDANTS_OMITTED } from "./render-await.ts";
import { renderResponsiveRunRows, type RunHierarchy } from "./render-run-rows.ts";

interface RunReportSection {
  readonly name: string;
  readonly kind: "report" | "failure";
  readonly text: string;
}

const reportSection = (
  run: SubagentRunCard,
  kind: RunReportSection["kind"],
): RunReportSection | undefined => {
  const name = sanitizeTerminalLine(run.name);
  const marker = "\n… [content truncated; use subagent_status for this run]";
  const text = kind === "report" ? run.finalText : run.error;
  const truncated = kind === "report" ? run.finalTextTruncated : run.errorTruncated;
  if (text) return { name, kind, text: `${sanitizeTerminalText(text)}${truncated ? marker : ""}` };
  if (!truncated) return undefined;
  const missing = kind === "report" ? "report content" : "failure detail";
  return {
    name,
    kind,
    text: `This saved card does not include the ${missing}; use subagent_status for this run.`,
  };
};

export const expandedRunReportSections = (
  runs: ReadonlyArray<SubagentRunCard>,
): ReadonlyArray<RunReportSection> => {
  const candidates = runs.flatMap((run) =>
    [reportSection(run, "report"), reportSection(run, "failure")].filter(
      (section): section is RunReportSection => section !== undefined,
    ),
  );
  if (candidates.length === 0) return [];
  const headingBudget = candidates.reduce((total, section) => total + section.name.length + 24, 0);
  const perSection = Math.max(
    256,
    Math.floor((MAX_TOOL_OUTPUT_CHARS - headingBudget) / candidates.length),
  );
  return candidates.map((section) =>
    section.text.length <= perSection
      ? section
      : { ...section, text: clipWithMarker(section.text, perSection, "\n… [report truncated]") },
  );
};

const reportAffordance = (
  sections: ReadonlyArray<RunReportSection>,
  expanded: boolean,
  theme: Theme,
): string => {
  const reportCount = sections.filter((section) => section.kind === "report").length;
  const failureCount = sections.length - reportCount;
  const label =
    failureCount === 0
      ? countLabel(reportCount, "final report")
      : reportCount === 0
        ? countLabel(failureCount, "failure detail")
        : `${countLabel(reportCount, "report")} · ${countLabel(failureCount, "failure")}`;
  return renderExpansionAffordance(label, expanded, theme);
};

// Generic reasons restate the source; only a specific reason, such as a fallback, adds a fact.
const GENERIC_SELECTION_REASON = /^Profile (?:model|route) selection\.?$/u;

/** How the route was chosen; empty when it would only restate the default. */
const runSelectionSummary = (run: SubagentRunCard): string => {
  const { source, candidateIndex, reason } = run.selection;
  const parts = [
    run.profile ? `${run.profile} profile` : undefined,
    source === "profile-parent-candidate"
      ? "parent's model"
      : candidateIndex === undefined
        ? undefined
        : `option ${candidateIndex + 1}`,
    GENERIC_SELECTION_REASON.test(reason) ? undefined : reason,
  ].filter(Boolean);
  return sanitizeTerminalLine(parts.join(" · "));
};

const CAPABILITY_LABELS = new Map<string, string>([
  ["rename-display", "rename"],
  ["parent-contact", "ask the parent"],
  ["peer-notice", "notify peers"],
  ["native-fork", "fork"],
]);

/** The actions this subagent's backend supports, as a reader would name them. */
const runControls = (run: SubagentRunCard): string => {
  const labels = run.capabilities.map(
    (capability) => CAPABILITY_LABELS.get(capability) ?? capability,
  );
  const last = labels.pop();
  return last === undefined
    ? "no live controls"
    : `can ${labels.length ? `${labels.join(", ")} and ${last}` : last}`;
};

const runWriterSummary = (run: SubagentRunCard): string | undefined => {
  if (run.writeIntent !== "writer") return undefined;
  if (!run.writeClaims) return "Writer · exclusive cwd";
  const claimCount = run.writeClaimCount ?? run.writeClaims.length;
  const omitted = Math.max(0, claimCount - run.writeClaims.length);
  return `Writer claims · ${run.writeClaims.join(", ")}${omitted > 0 ? ` · ${omitted} omitted` : ""}`;
};

const dimLines = (text: string, width: number, theme: Theme): string[] =>
  wrapTextWithAnsi(theme.fg("dim", sanitizeTerminalLine(text)), width);

/** Identity, route choice, and controls: routine facts every expanded row states. */
const routineRunDiagnostics = (run: SubagentRunCard, width: number, theme: Theme): string[] => {
  const selection = runSelectionSummary(run);
  const assignment = (run.reportGeneration || 1) > 1 ? ` · assignment ${run.reportGeneration}` : "";
  const details = `${run.context === "fork" ? "Forked context" : "Fresh context"} · closes after its report${assignment} · ${runControls(run)}`;
  return [
    ...dimLines(`ID: ${run.id}`, width, theme),
    ...(selection ? dimLines(selection, width, theme) : []),
    ...dimLines(details, width, theme),
  ];
};

/** Only what differs from the default: an await's rows already carry the route. */
const exceptionalRunDiagnostics = (run: SubagentRunCard, width: number, theme: Theme): string[] => {
  const fallbackSelected =
    (run.selection.candidateIndex ?? 0) > 0 || run.selection.skippedCandidates.length > 0;
  const selection = runSelectionSummary(run);
  return fallbackSelected && selection ? dimLines(selection, width, theme) : [];
};

/** Work state as labelled facts; the shell's issue lines say what needs attention. */
const runStateDiagnostics = (run: SubagentRunCard, width: number, theme: Theme): string[] => {
  const writer = runWriterSummary(run);
  return [
    ...(run.progress && !isAssignmentFinishedRunState(run.state)
      ? wrapTextWithAnsi(theme.fg("accent", sanitizeTerminalLine(run.progress)), width)
      : []),
    ...(writer ? dimLines(writer, width, theme) : []),
    ...(run.writeAdmissionPaused ? dimLines("Writer admission paused", width, theme) : []),
    ...(run.writeAudit?.violations ?? []).flatMap((violation) =>
      dimLines(`Outside claims · ${violation.path} · ${violation.toolName}`, width, theme),
    ),
    ...(run.warning ? dimLines(`Warning: ${run.warning}`, width, theme) : []),
  ];
};

/** Every skipped option with its full reason, and the launch's own option warning. */
const runRouteDiagnostics = (run: SubagentRunCard, width: number, theme: Theme): string[] => [
  ...run.selection.skippedCandidates.flatMap((candidate) =>
    dimLines(
      `Skipped ${profileOptionLabel(candidate.candidate)} [${candidate.code}] · ${candidate.reason}`,
      width,
      theme,
    ),
  ),
  ...(run.selection.warning ? dimLines(`Launch note: ${run.selection.warning}`, width, theme) : []),
];

const REPORT_STATUS_TEXT = {
  missing: "no accepted final report",
  claimed: "final report claimed by another operation",
  delivered: "final report already delivered",
  available: "final report omitted from this card",
} as const;

/** Completed runs without report text say where the report went. */
const reportStatusLines = (
  runs: ReadonlyArray<SubagentRunCard>,
  width: number,
  theme: Theme,
): string[] =>
  runs
    .filter((run) => run.state === "completed" && !run.finalText && !run.error)
    .map((run) =>
      clipToWidth(
        theme.fg(
          "dim",
          `${sanitizeTerminalLine(run.name)}: ${
            run.reportStatus === undefined
              ? "final report availability unknown in this observation"
              : REPORT_STATUS_TEXT[run.reportStatus]
          }`,
        ),
        width,
      ),
    );

interface RunOverviewOptions {
  readonly expanded: boolean;
  readonly reportSections: ReadonlyArray<RunReportSection>;
  /** Routine counts, shown first as muted text. */
  readonly counters?: string | undefined;
  readonly showReportOutcomes?: boolean | undefined;
  readonly hierarchy?: RunHierarchy | undefined;
  readonly showRunRows?: boolean | undefined;
  readonly showOutcomeDetails?: boolean | undefined;
  readonly showContextOmission?: boolean | undefined;
  readonly contentOnly?: boolean | undefined;
}

/** Once expanded, the agent's own recovery steps. */
const nextStepLines = (
  runs: ReadonlyArray<SubagentRunCard>,
  theme: Theme,
  width: number,
  options: RunOverviewOptions,
): string[] => {
  const notes = options.expanded && !options.contentOnly ? attentionRecoveryText(runs) : "";
  return notes
    ? expandedSection(theme, "Agent notes", new Text(theme.fg("dim", notes), 0, 0)).render(width)
    : [];
};

const expandedRowDiagnostics = (
  runs: ReadonlyArray<SubagentRunCard>,
  width: number,
  theme: Theme,
  options: RunOverviewOptions,
): string[] => {
  const routine = options.contentOnly || options.hierarchy?.awaitedRunIds === undefined;
  return runs.flatMap((run) => [
    ...(routine
      ? routineRunDiagnostics(run, width, theme)
      : exceptionalRunDiagnostics(run, width, theme)),
    ...runStateDiagnostics(run, width, theme),
    ...runRouteDiagnostics(run, width, theme),
  ]);
};

export const runOverviewComponent = (
  runs: ReadonlyArray<SubagentRunCard>,
  theme: Theme,
  options: RunOverviewOptions,
): Component =>
  renderComponent((width) => {
    const safeWidth = Math.max(1, width);
    const usage = aggregateUsage(runs);
    const hierarchy = options.hierarchy;
    const showRunRows = options.showRunRows !== false;
    const showOutcomeDetails = options.showOutcomeDetails !== false;
    const isAwaitHierarchy = hierarchy?.awaitedRunIds !== undefined;
    const outcomeRuns = hierarchy?.awaitedRunIds
      ? runs.filter((run) => hierarchy.awaitedRunIds?.has(run.id))
      : runs;
    return [
      ...(options.counters ? [clipToWidth(theme.fg("muted", options.counters), safeWidth)] : []),
      ...(options.showContextOmission !== false && hierarchy?.contextOmitted
        ? [clipToWidth(theme.fg("dim", DESCENDANTS_OMITTED), safeWidth)]
        : []),
      ...((!isAwaitHierarchy || options.contentOnly) && usage
        ? [clipToWidth(theme.fg("muted", `Total usage · ${usage}`), safeWidth)]
        : []),
      ...(showRunRows
        ? renderResponsiveRunRows(runs, safeWidth, theme, { fullId: options.expanded, hierarchy })
        : []),
      ...(options.expanded && showRunRows
        ? expandedRowDiagnostics(runs, safeWidth, theme, options)
        : []),
      ...(showOutcomeDetails && options.showReportOutcomes !== false
        ? reportStatusLines(outcomeRuns, safeWidth, theme)
        : []),
      ...(showOutcomeDetails ? nextStepLines(runs, theme, safeWidth, options) : []),
      ...(options.reportSections.length > 0
        ? [
            clipToWidth(
              reportAffordance(options.reportSections, options.expanded, theme),
              safeWidth,
            ),
          ]
        : []),
    ];
  });

export const appendReportSections = (
  container: Container,
  sections: ReadonlyArray<RunReportSection>,
  theme: Theme,
): void => {
  for (const [index, section] of sections.entries()) {
    const report = section.kind === "report";
    const heading = `${report ? "" : "Failure "}${index + 1}/${sections.length} · ${section.name}`;
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("accent", heading), 0, 0));
    container.addChild(
      report
        ? new Markdown(section.text, 2, 0, getMarkdownTheme(), {
            color: (text) => theme.fg("toolOutput", text),
          })
        : new Text(theme.fg("toolOutput", section.text), 2, 0),
    );
  }
};

/** Expanded run rows with their diagnostics, then each run's report or failure. */
export const renderExpandedRunsResult = (
  runs: ReadonlyArray<SubagentRunCard>,
  theme: Theme,
  counters: string,
  showReportOutcomes: boolean,
  hierarchy: RunHierarchy | undefined,
): Component => {
  const container = new Container();
  const sections = showReportOutcomes ? expandedRunReportSections(runs) : [];
  container.addChild(
    runOverviewComponent(runs, theme, {
      expanded: true,
      reportSections: sections,
      counters,
      showReportOutcomes,
      hierarchy,
    }),
  );
  appendReportSections(container, sections, theme);
  return container;
};

/** A settled await leads with its targets' reports, then every run's outcome. */
export const renderExpandedAwaitResult = (
  runs: ReadonlyArray<SubagentRunCard>,
  targets: ReadonlyArray<SubagentRunCard>,
  theme: Theme,
  counters: string,
  hierarchy: RunHierarchy,
): Component => {
  const container = new Container();
  const sections = expandedRunReportSections(targets);
  container.addChild(
    runOverviewComponent(runs, theme, {
      expanded: false,
      reportSections: [],
      counters,
      hierarchy,
      showRunRows: false,
      showOutcomeDetails: false,
    }),
  );
  appendReportSections(container, sections, theme);
  if (sections.length > 0) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "Run outcomes"), 0, 0));
  }
  container.addChild(
    runOverviewComponent(runs, theme, {
      expanded: true,
      reportSections: [],
      hierarchy,
      showContextOmission: false,
    }),
  );
  return container;
};
