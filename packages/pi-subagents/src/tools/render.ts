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
import {
  decodeCompactToolDetails,
  decodeStartAwaitCardDetails,
  type SubagentRunCard,
} from "./details.ts";
import { attentionRecoveryText, boundToolOutput, selectionSourceLabel } from "./format.ts";
import {
  renderCompactResultComponent,
  renderProfileRoutesComponent,
  type SemanticOutcomeBanner,
} from "./render-management.ts";
import { formatAwaitSummary, renderAwaitProgressComponent } from "./render-await.ts";
import { aggregateRunUsage, renderResponsiveRunRows } from "./render-run-rows.ts";
import {
  renderStartFailures,
  renderStartProgressComponent,
  renderStartReceiptComponent,
} from "./render-start.ts";
import type { SubagentStartFailure } from "./subagent.ts";

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
      ? `final report${reportCount === 1 ? "" : "s"}`
      : reportCount === 0
        ? `failure detail${failureCount === 1 ? "" : "s"}`
        : "reports and failures";
  return theme.fg("dim", `${expanded ? "▾" : "▸"} ${label}${expanded ? "" : " · expand to view"}`);
};

const reportPreviews = (
  runs: ReadonlyArray<SubagentRunCard>,
  width: number,
  theme: Theme,
): ReadonlyArray<string> => {
  const previews = runs.flatMap((run) => {
    const firstLine = run.finalText
      ?.split("\n")
      .map((line) => line.trim())
      .find(Boolean)
      ?.replace(/^#{1,6}\s+/, "");
    if (!firstLine) return [];
    return [
      truncateToWidth(
        theme.fg("dim", `↳ ${sanitizeTerminalLine(run.name)}: ${sanitizeTerminalLine(firstLine)}`),
        width,
      ),
    ];
  });
  if (previews.length <= 3) return previews;
  return [
    ...previews.slice(0, 3),
    theme.fg("dim", `… ${previews.length - 3} more report previews · expand to view`),
  ];
};

class RunOverviewComponent implements Component {
  private readonly runs: ReadonlyArray<SubagentRunCard>;
  private readonly failures: ReadonlyArray<SubagentStartFailure>;
  private readonly expanded: boolean;
  private readonly theme: Theme;
  private readonly reportSections: ReadonlyArray<RunReportSection>;
  private readonly banner: SemanticOutcomeBanner | undefined;
  private readonly showReportOutcomes: boolean;
  private readonly hierarchy: RunOverviewHierarchy | undefined;

  constructor(
    runs: ReadonlyArray<SubagentRunCard>,
    failures: ReadonlyArray<SubagentStartFailure>,
    expanded: boolean,
    theme: Theme,
    reportSections: ReadonlyArray<RunReportSection>,
    banner?: SemanticOutcomeBanner,
    showReportOutcomes = true,
    hierarchy?: RunOverviewHierarchy,
  ) {
    this.runs = runs;
    this.failures = failures;
    this.expanded = expanded;
    this.theme = theme;
    this.reportSections = reportSections;
    this.banner = banner;
    this.showReportOutcomes = showReportOutcomes;
    this.hierarchy = hierarchy;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const usage = aggregateRunUsage(this.runs);
    const isAwaitHierarchy = this.hierarchy?.awaitedRunIds !== undefined;
    const outcomeRuns = this.hierarchy?.awaitedRunIds
      ? this.runs.filter((run) => this.hierarchy?.awaitedRunIds?.has(run.id))
      : this.runs;
    return [
      ...(this.banner
        ? [truncateToWidth(this.theme.fg(this.banner.color, this.banner.text), safeWidth)]
        : []),
      ...(this.hierarchy?.contextOmitted
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
      ...renderResponsiveRunRows(this.runs, safeWidth, this.theme, {
        fullId: this.expanded,
        hierarchy: this.hierarchy,
      }),
      ...(this.expanded
        ? this.runs.flatMap((run) => {
            const profile = run.profile ? `${sanitizeTerminalLine(run.profile)} · ` : "";
            const summary = sanitizeTerminalLine(
              `${profile}${selectionSourceLabel(run)} · ${run.selection.reason}`,
            );
            const retention =
              run.closeOnReport === false
                ? `retain backend · assignment ${run.reportGeneration || 1}`
                : `close after report · assignment ${run.reportGeneration || 1}`;
            const details = [
              run.context ? `context=${run.context}` : undefined,
              retention,
              run.capabilities
                ? `capabilities=${run.capabilities.join(", ") || "none"}`
                : undefined,
            ]
              .filter((value): value is string => value !== undefined)
              .join(" · ");
            return [
              ...wrapTextWithAnsi(
                this.theme.fg("dim", `ID: ${sanitizeTerminalLine(run.id)}`),
                safeWidth,
              ),
              ...wrapTextWithAnsi(this.theme.fg("dim", summary), safeWidth),
              ...wrapTextWithAnsi(this.theme.fg("dim", details), safeWidth),
              ...(run.progress
                ? wrapTextWithAnsi(
                    this.theme.fg("accent", `  Progress: ${sanitizeTerminalLine(run.progress)}`),
                    safeWidth,
                  )
                : []),
              ...(run.warning
                ? wrapTextWithAnsi(
                    this.theme.fg("warning", `  Warning: ${sanitizeTerminalLine(run.warning)}`),
                    safeWidth,
                  )
                : []),
              ...run.selection.skippedCandidates.flatMap((candidate) =>
                wrapTextWithAnsi(
                  this.theme.fg(
                    "dim",
                    sanitizeTerminalLine(
                      `  skipped ${candidate.candidate} [${candidate.code}] · ${candidate.reason}`,
                    ),
                  ),
                  safeWidth,
                ),
              ),
              ...(run.selection.warning
                ? wrapTextWithAnsi(
                    this.theme.fg("warning", sanitizeTerminalLine(`  ${run.selection.warning}`)),
                    safeWidth,
                  )
                : []),
            ];
          })
        : []),
      ...renderStartFailures(this.failures, this.expanded, this.theme)
        .split("\n")
        .filter(Boolean)
        .map((line) => truncateToWidth(line, safeWidth)),
      ...outcomeRuns
        .filter(
          (run) =>
            this.showReportOutcomes && run.state === "completed" && !run.finalText && !run.error,
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
      ...this.runs
        .filter((run) => run.state === "reported" && run.closeOnReport === false)
        .map((run) =>
          truncateToWidth(
            this.theme.fg(
              "dim",
              `${sanitizeTerminalLine(run.name)} is retained · use subagent_send for its next assignment.`,
            ),
            safeWidth,
          ),
        ),
      ...this.runs
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
        ),
      ...(!this.expanded && this.showReportOutcomes
        ? reportPreviews(outcomeRuns, safeWidth, this.theme)
        : []),
      ...attentionRecoveryText(this.runs)
        .split("\n")
        .filter(Boolean)
        .map((line) => truncateToWidth(this.theme.fg("warning", line), safeWidth)),
      ...(this.reportSections.length > 0
        ? [
            truncateToWidth(
              reportAffordance(this.reportSections, this.expanded, this.theme),
              safeWidth,
            ),
          ]
        : this.failures.length > 0 && !this.expanded
          ? [this.theme.fg("dim", "▸ failure details · expand to view")]
          : []),
    ];
  }

  invalidate(): void {
    // Rendering is a pure projection of immutable result details.
  }
}

/** Collapsed start/await rendering: run summaries, launch failures, and the report affordance. */
export const renderStartAwaitOverviewComponent = (
  runs: ReadonlyArray<SubagentRunCard>,
  theme: Theme,
  failures: ReadonlyArray<SubagentStartFailure> = [],
  banner?: SemanticOutcomeBanner,
  hierarchy?: RunOverviewHierarchy,
  reportRuns: ReadonlyArray<SubagentRunCard> = runs,
): Component =>
  new RunOverviewComponent(
    runs,
    failures,
    false,
    theme,
    expandedRunReportSections(reportRuns),
    banner,
    true,
    hierarchy,
  );

export const renderExpandedStartAwaitResult = (
  runs: ReadonlyArray<SubagentRunCard>,
  theme: Theme,
  failures: ReadonlyArray<SubagentStartFailure> = [],
  banner?: SemanticOutcomeBanner,
  showReportOutcomes = true,
  hierarchy?: RunOverviewHierarchy,
  reportRuns: ReadonlyArray<SubagentRunCard> = runs,
): Component => {
  const container = new Container();
  const sections = showReportOutcomes ? expandedRunReportSections(reportRuns) : [];
  container.addChild(
    new RunOverviewComponent(
      runs,
      failures,
      true,
      theme,
      sections,
      banner,
      showReportOutcomes,
      hierarchy,
    ),
  );
  if (sections.length === 0) return container;
  for (const [index, section] of sections.entries()) {
    container.addChild(new Spacer(1));
    const heading = section.kind === "report" ? "Report" : "Failure";
    container.addChild(
      new Text(
        theme.fg(
          section.kind === "report" ? "accent" : "error",
          `${heading} ${index + 1} of ${sections.length} — ${section.name}`,
        ),
        0,
        0,
      ),
    );
    if (section.kind === "report")
      container.addChild(
        new Markdown(section.text, 2, 0, getMarkdownTheme(), {
          color: (text) => theme.fg("toolOutput", text),
        }),
      );
    else container.addChild(new Text(theme.fg("error", section.text), 2, 0));
  }
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
    text: formatAwaitSummary(runs, details.awaitUntil ?? "all_finished", details.usage, details),
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

export const renderSubagentResult = (
  result: {
    readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
    readonly details?: unknown;
  },
  isPartial: boolean,
  expanded: boolean,
  theme: Theme,
): Component => {
  const details = decodeStartAwaitCardDetails(result.details);
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
    const banner = includeContentOmission(
      awaitResultBanner({
        ...details,
        runs: targets,
        usage: aggregateRunUsage(details.cards),
      }),
      details.contentOmitted,
    );
    if (expanded) {
      const rendered = renderExpandedStartAwaitResult(
        details.cards,
        theme,
        [],
        banner,
        true,
        hierarchy,
        targets,
      );
      if (!details.contentOmitted) return rendered;
      return recoveredOmittedFallback(result.content, theme) ?? rendered;
    }
    return renderStartAwaitOverviewComponent(details.cards, theme, [], banner, hierarchy, targets);
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
          ? renderExpandedStartAwaitResult(cards, theme, [], banner, showReports, hierarchy)
          : new RunOverviewComponent(
              cards,
              [],
              false,
              theme,
              showReports ? expandedRunReportSections(cards) : [],
              banner,
              showReports,
              hierarchy,
            ),
    );
    if (!expanded || !compact.contentOmitted) return rendered;
    return recoveredOmittedFallback(result.content, theme) ?? rendered;
  }
  let text = boundToolOutput(sanitizeTerminalText(joinTextContent(result.content)));
  if (!expanded) {
    const lines = text.split("\n");
    if (lines.length > 12)
      text = `${lines.slice(0, 11).join("\n")}\n… [${lines.length - 11} more lines · expand to view]`;
  }
  return new Text(
    theme.fg(isPartial ? "warning" : "toolOutput", text || (isPartial ? "Working…" : "Done")),
    0,
    0,
  );
};
