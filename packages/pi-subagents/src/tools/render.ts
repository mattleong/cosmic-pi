import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Markdown,
  Spacer,
  Text,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import {
  sanitizeTerminalLine,
  stripTerminalControls as sanitizeTerminalText,
} from "pi-cosmic-core";
import { MAX_TOOL_OUTPUT_CHARS } from "../run/limits.ts";
import { isAssignmentFinishedRunState } from "../run/model.ts";
import type { SubagentAwaitUntil } from "../run/service.ts";
import { clipWithMarker } from "../run/state.ts";
import { aggregateUsage } from "../ui/metrics.ts";
import {
  decodeCompactToolDetails,
  decodeStartAwaitCardDetails,
  type CompactSubagentToolDetails,
  type SubagentRunCard,
  type SubagentStartAwaitCardDetails,
} from "./details-schema.ts";
import { attentionRecoveryText, boundToolOutput, selectionSourceLabel } from "./format.ts";
import {
  composeToolComponent as renderComponent,
  renderExpansionAffordance,
  renderToolHeader,
} from "pi-cosmic-ui/tool";
import {
  renderCompactResultComponent,
  renderProfileRoutesComponent,
  type SemanticOutcomeBanner,
} from "./render-management.ts";
import { formatAwaitSummary, renderAwaitProgressComponent } from "./render-await.ts";
import { renderResponsiveRunRows } from "./render-run-rows.ts";
import { renderStartProgressComponent, renderStartReceiptComponent } from "./render-start.ts";

interface RunOverviewHierarchy {
  readonly awaitedRunIds?: ReadonlySet<string> | undefined;
  readonly contextOmitted?: boolean | undefined;
}

interface RunReportSection {
  readonly name: string;
  readonly kind: "report" | "failure";
  readonly text: string;
}

const joinTextContent = (
  content: ReadonlyArray<{ readonly type: string; readonly text?: string }>,
  separator = "\n",
): string =>
  content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join(separator);

const expandedRunReportSections = (
  runs: ReadonlyArray<SubagentRunCard>,
): ReadonlyArray<RunReportSection> => {
  const candidates = runs.flatMap((run): ReadonlyArray<RunReportSection> => {
    const name = sanitizeTerminalLine(run.name);
    const marker = "\n… [content truncated; use subagent_status for this run]";
    const sections: RunReportSection[] = [];
    if (run.finalText)
      sections.push({
        name,
        kind: "report",
        text: `${sanitizeTerminalText(run.finalText)}${run.finalTextTruncated ? marker : ""}`,
      });
    else if (run.finalTextTruncated)
      sections.push({
        name,
        kind: "report",
        text: "This saved card does not include the report content; use subagent_status for this run.",
      });
    if (run.error)
      sections.push({
        name,
        kind: "failure",
        text: `${sanitizeTerminalText(run.error)}${run.errorTruncated ? marker : ""}`,
      });
    else if (run.errorTruncated)
      sections.push({
        name,
        kind: "failure",
        text: "This saved card does not include the failure detail; use subagent_status for this run.",
      });
    return sections;
  });
  if (candidates.length === 0) return [];
  const headingBudget = candidates.reduce((total, section) => total + section.name.length + 24, 0);
  const perSection = Math.max(
    256,
    Math.floor((MAX_TOOL_OUTPUT_CHARS - headingBudget) / candidates.length),
  );
  return candidates.map((section) => {
    if (section.text.length <= perSection) return section;
    return { ...section, text: clipWithMarker(section.text, perSection, "\n… [report truncated]") };
  });
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
      ? `${reportCount} final report${reportCount === 1 ? "" : "s"}`
      : reportCount === 0
        ? `${failureCount} failure detail${failureCount === 1 ? "" : "s"}`
        : `${reportCount} report${reportCount === 1 ? "" : "s"} · ${failureCount} failure${failureCount === 1 ? "" : "s"}`;
  return renderExpansionAffordance(label, expanded, theme);
};

const runRetentionLabel = (run: SubagentRunCard): string =>
  run.closeOnReport === false
    ? `retain backend · assignment ${run.reportGeneration || 1}`
    : `close after report · assignment ${run.reportGeneration || 1}`;

const runSelectionSummary = (run: SubagentRunCard): string => {
  const profile = run.profile ? `${sanitizeTerminalLine(run.profile)} · ` : "";
  return sanitizeTerminalLine(`${profile}${selectionSourceLabel(run)} · ${run.selection.reason}`);
};

const runWriterSummary = (run: SubagentRunCard): string | undefined => {
  if (run.writeIntent !== "writer") return undefined;
  if (!run.writeClaims) return "Writer · exclusive cwd";
  const claimCount = run.writeClaimCount ?? run.writeClaims.length;
  const omitted = Math.max(0, claimCount - run.writeClaims.length);
  return `Writer claims · ${run.writeClaims.join(", ")}${omitted > 0 ? ` · ${omitted} omitted` : ""}`;
};

const routineRunDiagnostics = (
  run: SubagentRunCard,
  width: number,
  theme: Theme,
  selection: string,
  retention: string,
): ReadonlyArray<string> => {
  const details = [
    run.context ? `context=${run.context}` : undefined,
    retention,
    run.capabilities ? `capabilities=${run.capabilities.join(", ") || "none"}` : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" · ");
  return [
    ...wrapTextWithAnsi(theme.fg("dim", `ID: ${sanitizeTerminalLine(run.id)}`), width),
    ...wrapTextWithAnsi(theme.fg("dim", selection), width),
    ...wrapTextWithAnsi(theme.fg("dim", details), width),
  ];
};

const exceptionalRunDiagnostics = (
  run: SubagentRunCard,
  width: number,
  theme: Theme,
  selection: string,
  retention: string,
): ReadonlyArray<string> => {
  const fallbackSelected =
    (run.selection.candidateIndex ?? 0) > 0 || run.selection.skippedCandidates.length > 0;
  const writer = runWriterSummary(run);
  return [
    ...(fallbackSelected ? wrapTextWithAnsi(theme.fg("dim", selection), width) : []),
    ...(run.closeOnReport === false ? wrapTextWithAnsi(theme.fg("dim", retention), width) : []),
    ...(writer ? wrapTextWithAnsi(theme.fg("warning", writer), width) : []),
    ...(run.writeAdmissionPaused
      ? wrapTextWithAnsi(theme.fg("warning", "Writer admission paused"), width)
      : []),
    ...(run.writeAudit?.violations ?? []).flatMap((violation) =>
      wrapTextWithAnsi(
        theme.fg(
          "error",
          sanitizeTerminalLine(`Write claim violation · ${violation.path} · ${violation.toolName}`),
        ),
        width,
      ),
    ),
  ];
};

const runActivityDiagnostics = (
  run: SubagentRunCard,
  width: number,
  theme: Theme,
): ReadonlyArray<string> => [
  ...(run.progress && !isAssignmentFinishedRunState(run.state)
    ? wrapTextWithAnsi(
        theme.fg("accent", `  Progress: ${sanitizeTerminalLine(run.progress)}`),
        width,
      )
    : []),
  ...(run.warning
    ? wrapTextWithAnsi(
        theme.fg("warning", `  Warning: ${sanitizeTerminalLine(run.warning)}`),
        width,
      )
    : []),
];

const runRouteDiagnostics = (
  run: SubagentRunCard,
  width: number,
  theme: Theme,
): ReadonlyArray<string> => [
  ...run.selection.skippedCandidates.flatMap((candidate) =>
    wrapTextWithAnsi(
      theme.fg(
        "dim",
        sanitizeTerminalLine(
          `  skipped ${candidate.candidate} [${candidate.code}] · ${candidate.reason}`,
        ),
      ),
      width,
    ),
  ),
  ...(run.selection.warning
    ? wrapTextWithAnsi(
        theme.fg("warning", sanitizeTerminalLine(`  ${run.selection.warning}`)),
        width,
      )
    : []),
];

const expandedRunDiagnostics = (
  run: SubagentRunCard,
  width: number,
  theme: Theme,
  includeRoutine: boolean,
): ReadonlyArray<string> => {
  const selection = runSelectionSummary(run);
  const retention = runRetentionLabel(run);
  return [
    ...(includeRoutine
      ? routineRunDiagnostics(run, width, theme, selection, retention)
      : exceptionalRunDiagnostics(run, width, theme, selection, retention)),
    ...runActivityDiagnostics(run, width, theme),
    ...runRouteDiagnostics(run, width, theme),
  ];
};

interface RunOverviewOptions {
  readonly expanded: boolean;
  readonly reportSections: ReadonlyArray<RunReportSection>;
  readonly banner?: SemanticOutcomeBanner | undefined;
  readonly showReportOutcomes?: boolean | undefined;
  readonly hierarchy?: RunOverviewHierarchy | undefined;
  readonly showRunRows?: boolean | undefined;
  readonly showOutcomeDetails?: boolean | undefined;
  readonly showReportAffordance?: boolean | undefined;
  readonly showContextOmission?: boolean | undefined;
}

const runOverviewComponent = (
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
    const showReportOutcomes = options.showReportOutcomes !== false;
    const isAwaitHierarchy = hierarchy?.awaitedRunIds !== undefined;
    const outcomeRuns = hierarchy?.awaitedRunIds
      ? runs.filter((run) => hierarchy.awaitedRunIds?.has(run.id))
      : runs;
    return [
      ...(options.banner
        ? [truncateToWidth(theme.fg(options.banner.color, options.banner.text), safeWidth)]
        : []),
      ...(options.showContextOmission !== false && hierarchy?.contextOmitted
        ? [
            truncateToWidth(
              theme.fg("warning", "Some descendant context was omitted from this card."),
              safeWidth,
            ),
          ]
        : []),
      ...(!isAwaitHierarchy && usage
        ? [truncateToWidth(theme.fg("dim", `Total usage · ${usage}`), safeWidth)]
        : []),
      ...(showRunRows
        ? renderResponsiveRunRows(runs, safeWidth, theme, {
            fullId: options.expanded,
            hierarchy,
          })
        : []),
      ...(options.expanded && showRunRows
        ? runs.flatMap((run) => expandedRunDiagnostics(run, safeWidth, theme, !isAwaitHierarchy))
        : []),
      ...outcomeRuns
        .filter(
          (run) =>
            showOutcomeDetails &&
            showReportOutcomes &&
            run.state === "completed" &&
            !run.finalText &&
            !run.error,
        )
        .map((run) =>
          truncateToWidth(
            theme.fg("dim", `${sanitizeTerminalLine(run.name)} completed without a final report.`),
            safeWidth,
          ),
        ),
      ...(showOutcomeDetails
        ? runs
            .filter((run) => run.state === "reported" && run.closeOnReport === false)
            .map((run) =>
              truncateToWidth(
                theme.fg(
                  "dim",
                  `${sanitizeTerminalLine(run.name)} is ready for another assignment · use subagent_send.`,
                ),
                safeWidth,
              ),
            )
        : []),
      ...(showOutcomeDetails
        ? runs
            .filter((run) => run.state === "paused")
            .map((run) =>
              truncateToWidth(
                theme.fg(
                  "warning",
                  run.capabilities === undefined
                    ? `${sanitizeTerminalLine(run.name)} is paused · check resume support with subagent_status, or stop it with subagent_lifecycle.`
                    : run.capabilities.includes("resume")
                      ? `${sanitizeTerminalLine(run.name)} is paused · resume or stop it with subagent_lifecycle.`
                      : `${sanitizeTerminalLine(run.name)} cannot resume · stop it and start a replacement.`,
                ),
                safeWidth,
              ),
            )
        : []),
      ...(showOutcomeDetails
        ? attentionRecoveryText(runs)
            .split("\n")
            .filter(Boolean)
            .map((line) => truncateToWidth(theme.fg("warning", line), safeWidth))
        : []),
      ...(options.showReportAffordance !== false && options.reportSections.length > 0
        ? [
            truncateToWidth(
              reportAffordance(options.reportSections, options.expanded, theme),
              safeWidth,
            ),
          ]
        : []),
    ];
  });

const appendReportSections = (
  container: Container,
  sections: ReadonlyArray<RunReportSection>,
  theme: Theme,
): void => {
  for (const [index, section] of sections.entries()) {
    container.addChild(new Spacer(1));
    const heading =
      section.kind === "report"
        ? `${index + 1}/${sections.length} · ${section.name}`
        : `Failure ${index + 1}/${sections.length} · ${section.name}`;
    container.addChild(
      new Text(theme.fg(section.kind === "report" ? "accent" : "error", heading), 0, 0),
    );
    if (section.kind === "report")
      container.addChild(
        new Markdown(section.text, 2, 0, getMarkdownTheme(), {
          color: (text) => theme.fg("toolOutput", text),
        }),
      );
    else container.addChild(new Text(theme.fg("error", section.text), 2, 0));
  }
};

export const renderExpandedStartAwaitResult = (
  runs: ReadonlyArray<SubagentRunCard>,
  theme: Theme,
  banner?: SemanticOutcomeBanner,
  showReportOutcomes = true,
  hierarchy?: RunOverviewHierarchy,
  reportRuns: ReadonlyArray<SubagentRunCard> = runs,
  reportsFirst = false,
): Component => {
  const container = new Container();
  const sections = showReportOutcomes ? expandedRunReportSections(reportRuns) : [];
  if (!reportsFirst) {
    container.addChild(
      runOverviewComponent(runs, theme, {
        expanded: true,
        reportSections: sections,
        banner,
        showReportOutcomes,
        hierarchy,
      }),
    );
    appendReportSections(container, sections, theme);
    return container;
  }

  container.addChild(
    runOverviewComponent(runs, theme, {
      expanded: false,
      reportSections: [],
      banner,
      showReportOutcomes: false,
      hierarchy,
      showRunRows: false,
      showOutcomeDetails: false,
      showReportAffordance: false,
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
      showReportOutcomes,
      hierarchy,
      showReportAffordance: false,
      showContextOmission: false,
    }),
  );
  return container;
};

export const awaitResultBanner = (details: {
  readonly action?: "start" | "await" | undefined;
  readonly runs?: ReadonlyArray<SubagentRunCard> | undefined;
  readonly awaitUntil?: SubagentAwaitUntil | undefined;
  readonly timedOut?: boolean | undefined;
  readonly attentionRequired?: boolean | undefined;
  readonly cancelled?: boolean | undefined;
  readonly usage?: string | undefined;
  readonly targetCount?: number | undefined;
  readonly descendantCount?: number | undefined;
}): SemanticOutcomeBanner => {
  const runs = details.runs ?? [];
  const finishedRuns = runs
    .filter((run) => isAssignmentFinishedRunState(run.state))
    .sort((left, right) => (left.endedAt ?? Infinity) - (right.endedAt ?? Infinity));
  const failed = runs.filter((run) => run.state === "failed").length;
  const interrupted = details.cancelled || details.timedOut || details.attentionRequired;
  const firstFinished = finishedRuns[0];
  const color: SemanticOutcomeBanner["color"] = interrupted
    ? "warning"
    : details.awaitUntil === "any_finished" && firstFinished
      ? firstFinished.state === "failed"
        ? "error"
        : "accent"
      : failed > 0
        ? "error"
        : runs.length > 0 && finishedRuns.length === runs.length
          ? "success"
          : "warning";
  return {
    color,
    text: formatAwaitSummary(runs, details.awaitUntil ?? "all_finished", details.usage, {
      ...details,
      settled: true,
    }),
  };
};

const includeContentOmission = (
  banner: SemanticOutcomeBanner | undefined,
  omitted: boolean | undefined,
): SemanticOutcomeBanner | undefined => {
  if (!omitted) return banner;
  const warning =
    "This saved card does not include some report content; use subagent_status for individual runs";
  return banner
    ? { color: "warning", text: `${banner.text} · ${warning}` }
    : { color: "warning", text: warning };
};

const recoveredOmittedFallback = (
  content: ReadonlyArray<{ readonly type: string; readonly text?: string }>,
  theme: Theme,
): Component | undefined => {
  const fallback = boundToolOutput(sanitizeTerminalText(joinTextContent(content)));
  if (!fallback) return undefined;
  const container = new Container();
  container.addChild(
    new Text(theme.fg("warning", theme.bold("Recovered output shown below")), 0, 0),
  );
  container.addChild(new Text(theme.fg("toolOutput", fallback), 2, 0));
  return container;
};

export const renderSubagentCall = (name: string, target: string, theme: Theme): Component =>
  new Text(renderToolHeader({ title: name, subtitle: target }, theme), 0, 0);

const awaitTargets = (details: {
  readonly cards: ReadonlyArray<SubagentRunCard>;
  readonly awaitedRunIds?: ReadonlyArray<string> | undefined;
}): ReadonlyArray<SubagentRunCard> => {
  if (!details.awaitedRunIds) return details.cards;
  const ids = new Set(details.awaitedRunIds);
  return details.cards.filter((card) => ids.has(card.id));
};

const awaitHierarchy = (details: {
  readonly cards: ReadonlyArray<SubagentRunCard>;
  readonly awaitedRunIds?: ReadonlyArray<string> | undefined;
  readonly contextOmitted?: true | undefined;
}): RunOverviewHierarchy => ({
  awaitedRunIds: new Set(details.awaitedRunIds ?? details.cards.map((card) => card.id)),
  contextOmitted: details.contextOmitted,
});

export interface SubagentResultRenderOptions {
  readonly panelOwnsLiveHierarchy?: boolean | undefined;
}

type ToolTextContent = ReadonlyArray<{ readonly type: string; readonly text?: string }>;

const renderPartialStartAwait = (
  details: SubagentStartAwaitCardDetails,
  expanded: boolean,
  theme: Theme,
  options: SubagentResultRenderOptions,
): Component | undefined => {
  if (options.panelOwnsLiveHierarchy) return renderComponent(() => []);
  if (details.action === "start")
    return renderStartProgressComponent(
      details.startFailures ?? [],
      details.startEntries,
      expanded,
      theme,
    );
  if (!details.awaitUntil) return undefined;
  const targets = awaitTargets(details);
  const hierarchy = awaitHierarchy(details);
  return renderAwaitProgressComponent(
    details.cards,
    targets,
    details.awaitUntil,
    theme,
    hierarchy,
    {
      cancelled: details.cancelled,
      timedOut: details.timedOut,
      attentionRequired: details.attentionRequired,
    },
  );
};

const renderSettledStartAwait = (
  content: ToolTextContent,
  details: SubagentStartAwaitCardDetails,
  expanded: boolean,
  theme: Theme,
): Component => {
  if (details.action === "start")
    return renderStartReceiptComponent(
      details.startFailures ?? [],
      details.startEntries,
      expanded,
      theme,
    );
  const targets = awaitTargets(details);
  const hierarchy = awaitHierarchy(details);
  const targetIds = hierarchy.awaitedRunIds ?? new Set(targets.map((run) => run.id));
  const banner = includeContentOmission(
    awaitResultBanner({
      ...details,
      runs: targets,
      usage: aggregateUsage(details.cards, "compact"),
      targetCount: targetIds.size,
      descendantCount: details.cards.filter((run) => !targetIds.has(run.id)).length,
    }),
    details.contentOmitted,
  );
  if (!expanded)
    return runOverviewComponent(details.cards, theme, {
      expanded: false,
      reportSections: expandedRunReportSections(targets),
      banner,
      showReportOutcomes: true,
      hierarchy,
      showRunRows: false,
    });
  const rendered = renderExpandedStartAwaitResult(
    details.cards,
    theme,
    banner,
    true,
    hierarchy,
    targets,
    true,
  );
  return details.contentOmitted ? (recoveredOmittedFallback(content, theme) ?? rendered) : rendered;
};

const renderCompactDetails = (
  content: ToolTextContent,
  compact: CompactSubagentToolDetails,
  expanded: boolean,
  theme: Theme,
): Component | undefined => {
  if (compact.action === "models")
    return compact.profiles ? renderProfileRoutesComponent(compact, expanded, theme) : undefined;
  const hierarchy = compact.action === "list" ? {} : undefined;
  const rendered = renderCompactResultComponent(
    compact,
    expanded,
    theme,
    (cards, isExpanded, banner, showReports) =>
      isExpanded
        ? renderExpandedStartAwaitResult(cards, theme, banner, showReports, hierarchy)
        : runOverviewComponent(cards, theme, {
            expanded: false,
            reportSections: showReports ? expandedRunReportSections(cards) : [],
            banner,
            showReportOutcomes: showReports,
            hierarchy,
          }),
  );
  if (!expanded || !compact.contentOmitted) return rendered;
  return recoveredOmittedFallback(content, theme) ?? rendered;
};

const renderTextFallback = (
  content: ToolTextContent,
  isPartial: boolean,
  expanded: boolean,
  theme: Theme,
): Component => {
  let text = boundToolOutput(sanitizeTerminalText(joinTextContent(content)));
  if (!expanded) {
    const lines = text.split("\n");
    if (lines.length > 12)
      text = `${lines.slice(0, 11).join("\n")}\n… [${lines.length - 11} more lines · ctrl+o to expand]`;
  }
  return new Text(
    theme.fg(isPartial ? "warning" : "toolOutput", text || (isPartial ? "Working…" : "Done")),
    0,
    0,
  );
};

export const renderSubagentResult = (
  result: { readonly content: ToolTextContent; readonly details?: unknown },
  isPartial: boolean,
  expanded: boolean,
  theme: Theme,
  options: SubagentResultRenderOptions = {},
): Component => {
  const details = decodeStartAwaitCardDetails(result.details);
  if (details) {
    if (!isPartial) return renderSettledStartAwait(result.content, details, expanded, theme);
    const rendered = renderPartialStartAwait(details, expanded, theme, options);
    if (rendered) return rendered;
  }
  const compact = decodeCompactToolDetails(result.details);
  if (compact) {
    const rendered = renderCompactDetails(result.content, compact, expanded, theme);
    if (rendered) return rendered;
  }
  return renderTextFallback(result.content, isPartial, expanded, theme);
};
