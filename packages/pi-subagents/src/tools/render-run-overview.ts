import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
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
import { countLabel } from "pi-cosmic-core/display";
import {
  sanitizeTerminalLine,
  stripTerminalControls as sanitizeTerminalText,
} from "pi-cosmic-core/security";
import { clipToWidth } from "pi-cosmic-ui/manager";
import {
  composeToolComponent as renderComponent,
  renderExpansionAffordance,
} from "pi-cosmic-ui/tool";
import { skippedCandidateLabel } from "../profiles/model.ts";
import { isTerminalRunState } from "../run/model.ts";
import { reportFileText, reportTruncationText } from "../run/state.ts";
import { aggregateUsage } from "../ui/metrics.ts";
import type { SubagentRunCard } from "./details-schema.ts";
import { attentionRecoveryText, cleanupEvidenceText } from "./format.ts";
import { DESCENDANTS_OMITTED } from "./render-await.ts";
import { renderResponsiveRunRows, type RunHierarchy } from "./render-run-rows.ts";
import { isTextFragment } from "./text-fragments.ts";

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
  // The parent reads a saved report from its file, so the reader sees which file that is.
  const archive = kind === "report" ? run.reportArchive : undefined;
  const saved = archive ? `\n[${reportFileText(archive)}]` : "";
  const marker = archive
    ? `\n… [${run.reportTruncation ? reportTruncationText(run.reportTruncation) : "content truncated"}]`
    : "\n… [content truncated; use agent_read for this run]";
  const text = kind === "report" ? run.finalText : run.error;
  const truncated = kind === "report" ? run.finalTextTruncated : run.errorTruncated;
  if (text)
    return {
      name,
      kind,
      text: `${sanitizeTerminalText(text)}${truncated ? marker : ""}${saved}`,
    };
  if (!truncated) return undefined;
  if (archive)
    return { name, kind, text: `This saved card does not include the report content.${saved}` };
  const missing = kind === "report" ? "report content" : "failure detail";
  return {
    name,
    kind,
    text: `This saved card does not include the ${missing}; use agent_read for this run.`,
  };
};

// Card projection owns retention; expansion preserves every retained report.
export const expandedRunReportSections = (
  runs: ReadonlyArray<SubagentRunCard>,
): ReadonlyArray<RunReportSection> =>
  Arr.flatMap(runs, (run) =>
    Arr.filter(
      [reportSection(run, "report"), reportSection(run, "failure")],
      Predicate.isNotUndefined,
    ),
  );

const reportAffordance = (
  sections: ReadonlyArray<RunReportSection>,
  expanded: boolean,
  theme: Theme,
): string => {
  const reportCount = Arr.filter(sections, (section) => section.kind === "report").length;
  const failureCount = sections.length - reportCount;
  const label =
    failureCount === 0
      ? countLabel(reportCount, "final report")
      : reportCount === 0
        ? countLabel(failureCount, "failure detail")
        : `${countLabel(reportCount, "report")} · ${countLabel(failureCount, "failure")}`;
  return renderExpansionAffordance(label, expanded, theme);
};

const GENERIC_SELECTION_REASON = /^Profile (?:model|route) selection\.?$/u;

const runSelectionSummary = (run: SubagentRunCard): string => {
  const { source, candidateIndex, reason } = run.selection;
  const parts = Arr.filter(
    [
      run.agent ? `${run.agent} agent` : undefined,
      run.profile ? `${run.profile} profile` : undefined,
      source === "profile-parent-candidate"
        ? "parent's model"
        : candidateIndex === undefined
          ? undefined
          : `option ${candidateIndex + 1}`,
      GENERIC_SELECTION_REASON.test(reason) ? undefined : reason,
    ],
    isTextFragment,
  );
  return sanitizeTerminalLine(Arr.join(parts, " · "));
};

const CAPABILITY_LABELS = new Map<string, string>([
  ["parent-contact", "ask the parent"],
  ["peer-notice", "notify peers"],
  ["native-fork", "fork"],
]);

const runControls = (run: SubagentRunCard): string => {
  const labels = Arr.map(
    run.capabilities,
    (capability) => CAPABILITY_LABELS.get(capability) ?? capability,
  );
  const last = labels.pop();
  return last === undefined
    ? "no live controls"
    : `can ${labels.length ? `${Arr.join(labels, ", ")} and ${last}` : last}`;
};

const runWriterSummary = (run: SubagentRunCard): string | undefined => {
  if (run.writeIntent !== "writer") return undefined;
  return run.workspaceId ? `Writer · worktree ${run.workspaceId}` : "Writer · shared cwd";
};

const dimLines = (text: string, width: number, theme: Theme): string[] =>
  wrapTextWithAnsi(theme.fg("dim", sanitizeTerminalLine(text)), width);

const routineRunDiagnostics = (run: SubagentRunCard, width: number, theme: Theme): string[] => {
  const selection = runSelectionSummary(run);
  const assignment = (run.reportGeneration || 1) > 1 ? ` · assignment ${run.reportGeneration}` : "";
  const details = `${run.context === "fork" ? "Forked context" : "Fresh context"}${assignment} · ${runControls(run)}`;
  return [
    ...dimLines(`ID: ${run.id}`, width, theme),
    ...(selection ? dimLines(selection, width, theme) : []),
    ...dimLines(details, width, theme),
  ];
};

const exceptionalRunDiagnostics = (run: SubagentRunCard, width: number, theme: Theme): string[] => {
  const fallbackSelected =
    (run.selection.candidateIndex ?? 0) > 0 || run.selection.skippedCandidates.length > 0;
  const selection = runSelectionSummary(run);
  return fallbackSelected && selection ? dimLines(selection, width, theme) : [];
};

const runStateDiagnostics = (run: SubagentRunCard, width: number, theme: Theme): string[] => {
  const writer = runWriterSummary(run);
  return [
    ...(run.progress && !isTerminalRunState(run.state)
      ? wrapTextWithAnsi(theme.fg("accent", sanitizeTerminalLine(run.progress)), width)
      : []),
    ...(writer ? dimLines(writer, width, theme) : []),
    ...Fn.pipe(
      cleanupEvidenceText(run),
      Str.split("\n"),
      Arr.filter(Boolean),
      Arr.flatMap((line) => dimLines(line, width, theme)),
    ),
    ...(run.warning ? dimLines(`Warning: ${run.warning}`, width, theme) : []),
  ];
};

const runRouteDiagnostics = (run: SubagentRunCard, width: number, theme: Theme): string[] => [
  ...Arr.flatMap(run.selection.skippedCandidates, (candidate) =>
    dimLines(
      `Skipped ${skippedCandidateLabel(candidate.candidate)} [${candidate.code}] · ${candidate.reason}`,
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

const reportStatusLines = (
  runs: ReadonlyArray<SubagentRunCard>,
  width: number,
  theme: Theme,
): string[] =>
  Arr.flatMap(runs, (run) =>
    run.state !== "completed" || run.finalText || run.error
      ? []
      : [
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
        ],
  );

interface RunOverviewOptions {
  readonly expanded: boolean;
  readonly reportSections: ReadonlyArray<RunReportSection>;
  readonly counters?: string | undefined;
  readonly showReportOutcomes?: boolean | undefined;
  readonly hierarchy?: RunHierarchy | undefined;
  readonly showRunRows?: boolean | undefined;
  readonly showOutcomeDetails?: boolean | undefined;
  readonly showContextOmission?: boolean | undefined;
  readonly contentOnly?: boolean | undefined;
}

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
  const routine = options.contentOnly === true || options.hierarchy?.awaitedRunIds === undefined;
  return Arr.flatMap(runs, (run) => [
    ...(routine
      ? routineRunDiagnostics(run, width, theme)
      : exceptionalRunDiagnostics(run, width, theme)),
    ...runStateDiagnostics(run, width, theme),
    ...runRouteDiagnostics(run, width, theme),
  ]);
};

const overviewHeaderLines = (
  runs: ReadonlyArray<SubagentRunCard>,
  theme: Theme,
  options: RunOverviewOptions,
  width: number,
): string[] => {
  const usage = aggregateUsage(runs);
  const hierarchy = options.hierarchy;
  const isAwaitHierarchy = hierarchy?.awaitedRunIds !== undefined;
  return [
    ...(options.counters ? [clipToWidth(theme.fg("muted", options.counters), width)] : []),
    ...(options.showContextOmission !== false && hierarchy?.contextOmitted
      ? [clipToWidth(theme.fg("dim", DESCENDANTS_OMITTED), width)]
      : []),
    ...((!isAwaitHierarchy || options.contentOnly) && usage
      ? [clipToWidth(theme.fg("muted", `Total usage · ${usage}`), width)]
      : []),
  ];
};

const overviewOutcomeLines = (
  runs: ReadonlyArray<SubagentRunCard>,
  theme: Theme,
  options: RunOverviewOptions,
  width: number,
): string[] => {
  const hierarchy = options.hierarchy;
  const showOutcomeDetails = options.showOutcomeDetails !== false;
  const outcomeRuns = hierarchy?.awaitedRunIds
    ? Arr.filter(runs, (run) => hierarchy.awaitedRunIds?.has(run.id) === true)
    : runs;
  return [
    ...(showOutcomeDetails && options.showReportOutcomes !== false
      ? reportStatusLines(outcomeRuns, width, theme)
      : []),
    ...(showOutcomeDetails ? nextStepLines(runs, theme, width, options) : []),
    ...(options.reportSections.length > 0
      ? [clipToWidth(reportAffordance(options.reportSections, options.expanded, theme), width)]
      : []),
  ];
};

export const runOverviewComponent = (
  runs: ReadonlyArray<SubagentRunCard>,
  theme: Theme,
  options: RunOverviewOptions,
): Component =>
  renderComponent((width) => {
    const safeWidth = Math.max(1, width);
    const showRunRows = options.showRunRows !== false;
    return [
      ...overviewHeaderLines(runs, theme, options, safeWidth),
      ...(showRunRows
        ? renderResponsiveRunRows(runs, safeWidth, theme, {
            fullId: options.expanded,
            hierarchy: options.hierarchy,
          })
        : []),
      ...(options.expanded && showRunRows
        ? expandedRowDiagnostics(runs, safeWidth, theme, options)
        : []),
      ...overviewOutcomeLines(runs, theme, options, safeWidth),
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

export const renderExpandedRunsResult = (
  runs: ReadonlyArray<SubagentRunCard>,
  theme: Theme,
  counters: string,
): Component => runOverviewComponent(runs, theme, { expanded: true, reportSections: [], counters });

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
