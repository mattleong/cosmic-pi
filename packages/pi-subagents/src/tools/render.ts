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
import { MAX_TOOL_OUTPUT_CHARS } from "../run/limits.ts";
import { isAssignmentFinishedRunState } from "../run/model.ts";
import type { SubagentAwaitUntil } from "../run/service.ts";
import { safeTextPrefix } from "../run/state.ts";
import { runStateLabel } from "../ui/run-state.ts";
import { sanitizeTerminalLine, sanitizeTerminalText } from "../ui/sanitize.ts";
import { decodeCompactToolDetails, decodeStartAwaitCardDetails } from "./details-decode.ts";
import type { SubagentRunCard, SubagentStartEntry } from "./details.ts";
import { attentionRecoveryText, boundToolOutput, selectionSourceLabel } from "./format.ts";
import {
  renderCompactResultComponent,
  renderProfileRoutesComponent,
  type SemanticOutcomeBanner,
} from "./render-management.ts";
import { renderAwaitProgressComponent } from "./render-await.ts";
import { aggregateRunUsage, renderResponsiveRunRows } from "./render-run-rows.ts";
import { renderStartFailures, renderStartProgressComponent } from "./render-start.ts";
import type { SubagentStartFailure } from "./subagent.ts";

interface RunReportSection {
  readonly name: string;
  readonly kind: "report" | "failure";
  readonly text: string;
}

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
    const marker = "\n… [report truncated]";
    return {
      ...section,
      text: `${safeTextPrefix(section.text, perSection - marker.length)}${marker}`,
    };
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

  constructor(
    runs: ReadonlyArray<SubagentRunCard>,
    failures: ReadonlyArray<SubagentStartFailure>,
    expanded: boolean,
    theme: Theme,
    reportSections: ReadonlyArray<RunReportSection>,
    banner?: SemanticOutcomeBanner,
    showReportOutcomes = true,
  ) {
    this.runs = runs;
    this.failures = failures;
    this.expanded = expanded;
    this.theme = theme;
    this.reportSections = reportSections;
    this.banner = banner;
    this.showReportOutcomes = showReportOutcomes;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const usage = aggregateRunUsage(this.runs);
    return [
      ...(this.banner
        ? [truncateToWidth(this.theme.fg(this.banner.color, this.banner.text), safeWidth)]
        : []),
      ...(usage ? [this.theme.fg("dim", `Total usage · ${usage}`)] : []),
      ...renderResponsiveRunRows(this.runs, safeWidth, this.theme, {
        fullId: this.expanded,
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
      ...this.runs
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
        ? reportPreviews(this.runs, safeWidth, this.theme)
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
): Component =>
  new RunOverviewComponent(runs, failures, false, theme, expandedRunReportSections(runs), banner);

export const renderExpandedStartAwaitResult = (
  runs: ReadonlyArray<SubagentRunCard>,
  theme: Theme,
  failures: ReadonlyArray<SubagentStartFailure> = [],
  banner?: SemanticOutcomeBanner,
  showReportOutcomes = true,
): Component => {
  const container = new Container();
  const sections = showReportOutcomes ? expandedRunReportSections(runs) : [];
  container.addChild(
    new RunOverviewComponent(runs, failures, true, theme, sections, banner, showReportOutcomes),
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
}): SemanticOutcomeBanner | undefined => {
  const runs = details.runs ?? [];
  const unfinished = runs.filter((run) => !isAssignmentFinishedRunState(run.state));
  const waiting = runs.filter((run) => run.state === "waiting_for_parent").length;
  const attention = waiting > 0 ? ` · parent reply required for ${waiting}` : "";
  if (details.cancelled)
    return {
      color: "warning",
      text:
        runs.length === 0
          ? "Await canceled"
          : `Await canceled · ${unfinished.length} unfinished${attention}`,
    };
  if (details.timedOut)
    return {
      color: "warning",
      text: `Await timed out · ${unfinished.length} unfinished${attention}`,
    };
  if (details.attentionRequired)
    return {
      color: "warning",
      text: `Parent reply required for ${waiting} subagent${waiting === 1 ? "" : "s"}`,
    };
  if (details.awaitUntil !== "any_finished") {
    if (runs.length === 0 || unfinished.length > 0) return undefined;
    const failed = runs.filter((run) => run.state === "failed").length;
    return {
      color: failed > 0 ? "error" : "success",
      text: `${runs.length} subagent${runs.length === 1 ? "" : "s"} finished${failed > 0 ? ` · ${failed} failed` : ""}`,
    };
  }
  const first = runs
    .filter((run) => isAssignmentFinishedRunState(run.state))
    .sort((left, right) => (left.endedAt ?? Infinity) - (right.endedAt ?? Infinity))[0];
  if (!first) return undefined;
  const name = sanitizeTerminalLine(first.name);
  const outcome =
    first.state === "reported"
      ? "reported first · backend retained"
      : `${runStateLabel(first.state)} first`;
  return {
    color: first.state === "failed" ? "error" : "accent",
    text: `${name} ${outcome}${unfinished.length > 0 ? ` · ${unfinished.length} unfinished` : ""}${attention}`,
  };
};

const startResultBanner = (
  runs: ReadonlyArray<SubagentRunCard>,
  failures: ReadonlyArray<SubagentStartFailure>,
  entries: ReadonlyArray<SubagentStartEntry> | undefined,
): SemanticOutcomeBanner => {
  const requested = entries?.length ?? runs.length + failures.length;
  const text = `Started ${runs.length} of ${requested} subagent${requested === 1 ? "" : "s"}${failures.length > 0 ? ` · ${failures.length} failed` : ""}`;
  return {
    color: failures.length === 0 ? "success" : runs.length > 0 ? "warning" : "error",
    text,
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
    if (details.cancelled)
      return new RunOverviewComponent(
        details.cards,
        [],
        false,
        theme,
        [],
        awaitResultBanner({ ...details, runs: details.cards }),
      );
    return renderAwaitProgressComponent(details.cards, details.awaitUntil, theme);
  }
  if (isPartial && details?.action === "start") {
    const rawProgress = result.content
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join(" ");
    const progress = sanitizeTerminalLine(rawProgress || "Starting subagents…");
    return renderStartProgressComponent(
      progress,
      details.cards,
      details.startFailures ?? [],
      details.startEntries ?? [],
      theme,
    );
  }
  if (!isPartial && details) {
    const failures = details.startFailures ?? [];
    const banner = includeContentOmission(
      details.action === "await"
        ? awaitResultBanner({ ...details, runs: details.cards })
        : startResultBanner(details.cards, failures, details.startEntries),
      details.contentOmitted,
    );
    if (expanded) {
      const rendered = renderExpandedStartAwaitResult(details.cards, theme, failures, banner);
      if (!details.contentOmitted) return rendered;
      const fallback = boundToolOutput(
        sanitizeTerminalText(
          result.content
            .filter((part) => part.type === "text")
            .map((part) => part.text ?? "")
            .join("\n"),
        ),
      );
      if (!fallback) return rendered;
      const container = new Container();
      container.addChild(
        new Text(
          theme.fg(
            "warning",
            theme.bold("Recovered omitted output · bounded complete result follows"),
          ),
          0,
          0,
        ),
      );
      container.addChild(new Text(theme.fg("toolOutput", fallback), 2, 0));
      return container;
    }
    return renderStartAwaitOverviewComponent(details.cards, theme, failures, banner);
  }
  const compact = decodeCompactToolDetails(result.details);
  if (compact?.action === "models" && compact.profiles)
    return renderProfileRoutesComponent(compact, expanded, theme);
  if (compact && compact.action !== "models") {
    const rendered = renderCompactResultComponent(
      compact,
      expanded,
      theme,
      (cards, isExpanded, banner, showReports) =>
        isExpanded
          ? renderExpandedStartAwaitResult(cards, theme, [], banner, showReports)
          : new RunOverviewComponent(
              cards,
              [],
              false,
              theme,
              showReports ? expandedRunReportSections(cards) : [],
              banner,
              showReports,
            ),
    );
    if (!expanded || !compact.contentOmitted) return rendered;
    const fallback = boundToolOutput(
      sanitizeTerminalText(
        result.content
          .filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("\n"),
      ),
    );
    if (!fallback) return rendered;
    const container = new Container();
    container.addChild(
      new Text(
        theme.fg(
          "warning",
          theme.bold("Recovered omitted output · bounded complete result follows"),
        ),
        0,
        0,
      ),
    );
    container.addChild(new Text(theme.fg("toolOutput", fallback), 2, 0));
    return container;
  }
  let text = boundToolOutput(
    sanitizeTerminalText(
      result.content
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n"),
    ),
  );
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
