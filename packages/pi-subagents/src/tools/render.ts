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
import { clipWithMarker, safeTextPrefix } from "../run/state.ts";
import { aggregateUsage } from "../ui/metrics.ts";
import {
  decodeCompactToolDetails,
  decodeStartAwaitCardDetails,
  type SubagentRunCard,
} from "./details-schema.ts";
import { attentionRecoveryText, boundToolOutput, selectionSourceLabel } from "./format.ts";
import { renderExpansionAffordance } from "./render-affordance.ts";
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
        text: "Report content was omitted from this persisted card; use subagent_status for this run.",
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
        text: "Failure detail was omitted from this persisted card; use subagent_status for this run.",
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

const expandedRunDiagnostics = (
  run: SubagentRunCard,
  width: number,
  theme: Theme,
  includeRoutine: boolean,
): ReadonlyArray<string> => {
  const profile = run.profile ? `${sanitizeTerminalLine(run.profile)} · ` : "";
  const selectionSummary = sanitizeTerminalLine(
    `${profile}${selectionSourceLabel(run)} · ${run.selection.reason}`,
  );
  const retention =
    run.closeOnReport === false
      ? `retain backend · assignment ${run.reportGeneration || 1}`
      : `close after report · assignment ${run.reportGeneration || 1}`;
  const routineDetails = [
    run.context ? `context=${run.context}` : undefined,
    retention,
    run.capabilities ? `capabilities=${run.capabilities.join(", ") || "none"}` : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" · ");
  const fallbackSelected =
    (run.selection.candidateIndex ?? 0) > 0 || run.selection.skippedCandidates.length > 0;
  const claimCount = run.writeClaimCount ?? run.writeClaims?.length ?? 0;
  const omittedClaimCount = Math.max(0, claimCount - (run.writeClaims?.length ?? 0));
  const writerSummary =
    run.writeIntent !== "writer"
      ? undefined
      : run.writeClaims
        ? `Writer claims · ${run.writeClaims.join(", ")}${omittedClaimCount > 0 ? ` · ${omittedClaimCount} omitted` : ""}`
        : "Writer · exclusive cwd";
  return [
    ...(includeRoutine
      ? [
          ...wrapTextWithAnsi(theme.fg("dim", `ID: ${sanitizeTerminalLine(run.id)}`), width),
          ...wrapTextWithAnsi(theme.fg("dim", selectionSummary), width),
          ...wrapTextWithAnsi(theme.fg("dim", routineDetails), width),
        ]
      : [
          ...(fallbackSelected ? wrapTextWithAnsi(theme.fg("dim", selectionSummary), width) : []),
          ...(run.closeOnReport === false
            ? wrapTextWithAnsi(theme.fg("dim", retention), width)
            : []),
          ...(writerSummary ? wrapTextWithAnsi(theme.fg("warning", writerSummary), width) : []),
          ...(run.writeAdmissionPaused
            ? wrapTextWithAnsi(theme.fg("warning", "Writer admission paused"), width)
            : []),
          ...(run.writeAudit?.violations ?? []).flatMap((violation) =>
            wrapTextWithAnsi(
              theme.fg(
                "error",
                sanitizeTerminalLine(
                  `Write claim violation · ${violation.path} · ${violation.toolName}`,
                ),
              ),
              width,
            ),
          ),
        ]),
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

class RunOverviewComponent implements Component {
  private readonly runs: ReadonlyArray<SubagentRunCard>;
  private readonly theme: Theme;
  private readonly options: RunOverviewOptions;

  constructor(runs: ReadonlyArray<SubagentRunCard>, theme: Theme, options: RunOverviewOptions) {
    this.runs = runs;
    this.theme = theme;
    this.options = options;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const usage = aggregateUsage(this.runs);
    const hierarchy = this.options.hierarchy;
    const showRunRows = this.options.showRunRows !== false;
    const showOutcomeDetails = this.options.showOutcomeDetails !== false;
    const showReportOutcomes = this.options.showReportOutcomes !== false;
    const isAwaitHierarchy = hierarchy?.awaitedRunIds !== undefined;
    const outcomeRuns = hierarchy?.awaitedRunIds
      ? this.runs.filter((run) => hierarchy.awaitedRunIds?.has(run.id))
      : this.runs;
    return [
      ...(this.options.banner
        ? [
            truncateToWidth(
              this.theme.fg(this.options.banner.color, this.options.banner.text),
              safeWidth,
            ),
          ]
        : []),
      ...(this.options.showContextOmission !== false && hierarchy?.contextOmitted
        ? [
            truncateToWidth(
              this.theme.fg("warning", "Some descendant context was omitted from this card."),
              safeWidth,
            ),
          ]
        : []),
      ...(!isAwaitHierarchy && usage
        ? [truncateToWidth(this.theme.fg("dim", `Total usage · ${usage}`), safeWidth)]
        : []),
      ...(showRunRows
        ? renderResponsiveRunRows(this.runs, safeWidth, this.theme, {
            fullId: this.options.expanded,
            hierarchy,
          })
        : []),
      ...(this.options.expanded && showRunRows
        ? this.runs.flatMap((run) =>
            expandedRunDiagnostics(run, safeWidth, this.theme, !isAwaitHierarchy),
          )
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
            this.theme.fg(
              "dim",
              `${sanitizeTerminalLine(run.name)} completed without a final report.`,
            ),
            safeWidth,
          ),
        ),
      ...(showOutcomeDetails
        ? this.runs
            .filter((run) => run.state === "reported" && run.closeOnReport === false)
            .map((run) =>
              truncateToWidth(
                this.theme.fg(
                  "dim",
                  `${sanitizeTerminalLine(run.name)} is retained · use subagent_send for its next assignment.`,
                ),
                safeWidth,
              ),
            )
        : []),
      ...(showOutcomeDetails
        ? this.runs
            .filter((run) => run.state === "paused")
            .map((run) =>
              truncateToWidth(
                this.theme.fg(
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
        ? attentionRecoveryText(this.runs)
            .split("\n")
            .filter(Boolean)
            .map((line) => truncateToWidth(this.theme.fg("warning", line), safeWidth))
        : []),
      ...(this.options.showReportAffordance !== false && this.options.reportSections.length > 0
        ? [
            truncateToWidth(
              reportAffordance(this.options.reportSections, this.options.expanded, this.theme),
              safeWidth,
            ),
          ]
        : []),
    ];
  }

  invalidate(): void {
    // Rendering is a pure projection of immutable result details.
  }
}

/** Collapsed start/await rendering: outcome, recovery, and report disclosure. */
export const renderStartAwaitOverviewComponent = (
  runs: ReadonlyArray<SubagentRunCard>,
  theme: Theme,
  banner?: SemanticOutcomeBanner,
  hierarchy?: RunOverviewHierarchy,
  reportRuns: ReadonlyArray<SubagentRunCard> = runs,
  showRunRows = true,
): Component =>
  new RunOverviewComponent(runs, theme, {
    expanded: false,
    reportSections: expandedRunReportSections(reportRuns),
    banner,
    showReportOutcomes: true,
    hierarchy,
    showRunRows,
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
      new RunOverviewComponent(runs, theme, {
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
    new RunOverviewComponent(runs, theme, {
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
    new RunOverviewComponent(runs, theme, {
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
    "Some report content was omitted from the persisted card; use subagent_status for individual runs";
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
    new Text(
      theme.fg("warning", theme.bold("Recovered omitted output · bounded complete result follows")),
      0,
      0,
    ),
  );
  container.addChild(new Text(theme.fg("toolOutput", fallback), 2, 0));
  return container;
};

export const renderSubagentCall = (name: string, target: string, theme: Theme): Component => {
  const safeTarget = sanitizeTerminalLine(target);
  const clippedTarget =
    safeTarget.length <= 160 ? safeTarget : `${safeTextPrefix(safeTarget, 146)}… [truncated]`;
  return new Text(
    `${theme.fg("toolTitle", theme.bold(name))}${clippedTarget ? ` ${theme.fg("dim", clippedTarget)}` : ""}`,
    0,
    0,
  );
};

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

class EmptyLiveHierarchyComponent implements Component {
  render(): string[] {
    return [];
  }

  invalidate(): void {}
}

export const renderSubagentResult = (
  result: {
    readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
    readonly details?: unknown;
  },
  isPartial: boolean,
  expanded: boolean,
  theme: Theme,
  options: SubagentResultRenderOptions = {},
): Component => {
  const details = decodeStartAwaitCardDetails(result.details);
  if (
    isPartial &&
    options.panelOwnsLiveHierarchy &&
    (details?.action === "start" || details?.action === "await")
  )
    return new EmptyLiveHierarchyComponent();
  if (isPartial && details?.action === "await" && details.awaitUntil) {
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
  }
  if (isPartial && details?.action === "start")
    return renderStartProgressComponent(
      details.startFailures ?? [],
      details.startEntries,
      expanded,
      theme,
    );
  if (!isPartial && details) {
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
    if (expanded) {
      const rendered = renderExpandedStartAwaitResult(
        details.cards,
        theme,
        banner,
        true,
        hierarchy,
        targets,
        true,
      );
      if (!details.contentOmitted) return rendered;
      return recoveredOmittedFallback(result.content, theme) ?? rendered;
    }
    return renderStartAwaitOverviewComponent(
      details.cards,
      theme,
      banner,
      hierarchy,
      targets,
      false,
    );
  }
  const compact = decodeCompactToolDetails(result.details);
  if (compact?.action === "models" && compact.profiles)
    return renderProfileRoutesComponent(compact, expanded, theme);
  if (compact && compact.action !== "models") {
    const hierarchy = compact.action === "list" ? {} : undefined;
    const rendered = renderCompactResultComponent(
      compact,
      expanded,
      theme,
      (cards, isExpanded, banner, showReports) =>
        isExpanded
          ? renderExpandedStartAwaitResult(cards, theme, banner, showReports, hierarchy)
          : new RunOverviewComponent(cards, theme, {
              expanded: false,
              reportSections: showReports ? expandedRunReportSections(cards) : [],
              banner,
              showReportOutcomes: showReports,
              hierarchy,
            }),
    );
    if (!expanded || !compact.contentOmitted) return rendered;
    return recoveredOmittedFallback(result.content, theme) ?? rendered;
  }
  let text = boundToolOutput(sanitizeTerminalText(joinTextContent(result.content)));
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
