/**
 * Preview-style call and result bodies for the root subagent tools. The shared shell draws the
 * issue lines from each tool's compact summary; these bodies show routine counts, rows, and
 * content, with agent-facing evidence only once expanded and under a label.
 */
import * as Schema from "effect/Schema";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { expandedSection } from "pi-code-previews";
import { stripTerminalControls as sanitizeTerminalText } from "pi-cosmic-core";
import {
  composeToolComponent as renderComponent,
  renderExpansionAffordance,
  renderToolHeader,
  toolRunningLine,
} from "pi-cosmic-ui/tool";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { aggregateUsage } from "../ui/metrics.ts";
import { workspaceReceiptLine } from "./compact-workspace-summary.ts";
import {
  WorkspaceToolDetailsSchema,
  decodeCompactToolDetails,
  decodeStartAwaitCardDetails,
  type CompactSubagentToolDetails,
  type SubagentRunCard,
  type SubagentStartAwaitCardDetails,
  type WorkspaceToolDetails,
} from "./details-schema.ts";
import { boundToolOutput } from "./format.ts";
import { renderCompactResultComponent, renderProfileRoutesComponent } from "./render-management.ts";
import { formatAwaitCounters, renderAwaitProgressComponent } from "./render-await.ts";
import {
  appendReportSections,
  expandedRunReportSections,
  renderExpandedStartAwaitResult,
  runOverviewComponent,
} from "./render-run-overview.ts";
import { renderStartReceiptComponent } from "./render-start.ts";

type ToolTextContent = ReadonlyArray<{ readonly type: string; readonly text?: string }>;

const joinTextContent = (content: ToolTextContent): string =>
  content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");

/** The tool's own words for what it returned, under a label, for expanded views. */
const rawResultSection = (content: ToolTextContent, theme: Theme, label = "Raw result") => {
  const text = boundToolOutput(sanitizeTerminalText(joinTextContent(content)));
  return text
    ? expandedSection(theme, label, new Text(theme.fg("toolOutput", text), 0, 0))
    : undefined;
};

export const renderSubagentCall = (name: string, target: string, theme: Theme): Component =>
  new Text(renderToolHeader({ title: name, subtitle: target }, theme), 0, 0);

const decodeInputEvidence = Schema.decodeUnknownOption(
  Schema.Struct({
    message: Schema.optionalKey(Schema.String),
    name: Schema.optionalKey(Schema.String),
    paths: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
);

/** Unique input evidence not carried by the semantic heading or result cards. */
export const renderSubagentInputContent = <ValueInput>(
  args: ValueInput,
  theme: Theme,
): Component => {
  const decoded = decodeInputEvidence(args);
  if (decoded._tag === "None") return new Text("", 0, 0);
  const input = decoded.value;
  const lines = [input.message, input.name, ...(input.paths ?? [])].filter(Boolean);
  return new Text(theme.fg("toolOutput", sanitizeTerminalText(lines.join("\n"))), 0, 0);
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
}) => ({
  awaitedRunIds: new Set(details.awaitedRunIds ?? details.cards.map((card) => card.id)),
  contextOmitted: details.contextOmitted,
});

export interface SubagentResultRenderOptions {
  readonly panelOwnsLiveHierarchy?: boolean | undefined;
  /** Pi flagged the result as an error; its text is then the shell's issue line. */
  readonly isError?: boolean | undefined;
}

const renderPartialStartAwait = (
  details: SubagentStartAwaitCardDetails,
  expanded: boolean,
  theme: Theme,
  options: SubagentResultRenderOptions,
): Component => {
  if (options.panelOwnsLiveHierarchy) return renderComponent(() => []);
  if (details.action === "start")
    return renderStartReceiptComponent(
      details.startFailures ?? [],
      details.startEntries,
      expanded,
      theme,
      true,
    );
  return renderAwaitProgressComponent(
    details.cards,
    awaitTargets(details),
    details.awaitUntil,
    theme,
    awaitHierarchy(details),
    details,
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
  const targetIds = hierarchy.awaitedRunIds;
  const counters = formatAwaitCounters(
    targets,
    details.awaitUntil,
    aggregateUsage(details.cards, "compact"),
    {
      ...details,
      settled: true,
      targetCount: targetIds.size,
      descendantCount: details.cards.filter((run) => !targetIds.has(run.id)).length,
    },
  );
  if (!expanded)
    return runOverviewComponent(details.cards, theme, {
      expanded: false,
      reportSections: expandedRunReportSections(targets),
      counters,
      hierarchy,
      showRunRows: false,
    });
  const rendered = renderExpandedStartAwaitResult(
    details.cards,
    theme,
    counters,
    true,
    hierarchy,
    targets,
    true,
  );
  return details.contentOmitted ? (rawResultSection(content, theme) ?? rendered) : rendered;
};

const renderCompactDetails = (
  content: ToolTextContent,
  compact: CompactSubagentToolDetails,
  expanded: boolean,
  theme: Theme,
): Component => {
  if (compact.action === "models") return renderProfileRoutesComponent(compact, expanded, theme);
  const hierarchy = compact.action === "list" ? {} : undefined;
  const rendered = renderCompactResultComponent(
    compact,
    expanded,
    theme,
    (cards, isExpanded, counters, showReports) =>
      isExpanded
        ? renderExpandedStartAwaitResult(cards, theme, counters, showReports, hierarchy)
        : runOverviewComponent(cards, theme, {
            expanded: false,
            reportSections: showReports ? expandedRunReportSections(cards) : [],
            counters,
            showReportOutcomes: showReports,
            hierarchy,
          }),
  );
  if (!expanded || !compact.contentOmitted) return rendered;
  return rawResultSection(content, theme) ?? rendered;
};

/** Lines a collapsed text result shows before its expansion affordance. */
const COLLAPSED_TEXT_LINES = 11;

/**
 * Results without typed details. A rejected call's text is already the shell's issue line, so
 * it appears only expanded, labelled; other text is a bounded preview.
 */
const renderTextFallback = (
  content: ToolTextContent,
  isPartial: boolean,
  expanded: boolean,
  theme: Theme,
  isError = false,
): Component => {
  const text = boundToolOutput(sanitizeTerminalText(joinTextContent(content)));
  if (!text) return isPartial ? new Text(toolRunningLine(theme), 0, 0) : new Container();
  if (isError)
    return expanded
      ? expandedSection(theme, "Error", new Text(theme.fg("toolOutput", text), 0, 0))
      : new Container();
  const lines = text.split("\n");
  if (expanded || lines.length <= COLLAPSED_TEXT_LINES + 1)
    return new Text(theme.fg("toolOutput", text), 0, 0);
  return new Text(
    [
      theme.fg("toolOutput", lines.slice(0, COLLAPSED_TEXT_LINES).join("\n")),
      renderExpansionAffordance(`${lines.length - COLLAPSED_TEXT_LINES} more lines`, false, theme),
    ].join("\n"),
    0,
    0,
  );
};

const decodeWorkspaceDisplay = Schema.decodeUnknownOption(WorkspaceToolDetailsSchema, {
  onExcessProperty: "error",
});

/** The workspace's own display span (list records or the diff page), when it is intact. */
const workspaceDisplayText = (
  receipt: WorkspaceToolDetails,
  content: ToolTextContent,
): string | undefined => {
  const span = receipt.displayContent;
  const raw = joinTextContent(content);
  const missingPreparationPath =
    receipt.operation === "prepare" && !receipt.preparedCwd && !span?.length;
  if (
    missingPreparationPath ||
    !span ||
    span.offset > raw.length ||
    span.length > raw.length - span.offset
  )
    return undefined;
  return [
    receipt.workspaceId,
    receipt.revisionId,
    receipt.preparationId,
    raw.slice(span.offset, span.offset + span.length),
  ]
    .filter(Boolean)
    .join("\n");
};

/** Compact expansion: the receipt's display span, or the labelled raw result. */
const renderWorkspaceContent = (
  result: { readonly content: ToolTextContent; readonly details?: unknown },
  theme: Theme,
): Component | undefined => {
  const workspace = decodeWorkspaceDisplay(result.details);
  if (workspace._tag === "None") return undefined;
  const text = workspaceDisplayText(workspace.value, result.content);
  if (text !== undefined) return new Text(theme.fg("toolOutput", sanitizeTerminalText(text)), 0, 0);
  return rawResultSection(result.content, theme) ?? renderComponent(() => []);
};

/** Preview style: one short line collapsed; the tool's full text only once expanded. */
const renderWorkspacePreview = (
  result: { readonly content: ToolTextContent; readonly details?: unknown },
  expanded: boolean,
  theme: Theme,
): Component | undefined => {
  const workspace = decodeWorkspaceDisplay(result.details);
  if (workspace._tag === "None") return undefined;
  const receipt = workspace.value;
  const line = workspaceReceiptLine(receipt);
  const raw = rawResultSection(
    result.content,
    theme,
    receipt.operation === "review" ? "Diff" : "Raw result",
  );
  return renderComponent((width) => {
    const safeWidth = Math.max(1, width);
    return [
      ...(line ? [clipToWidth(theme.fg("muted", line), safeWidth)] : []),
      ...(!raw
        ? []
        : expanded
          ? raw.render(safeWidth)
          : [
              clipToWidth(
                renderExpansionAffordance(
                  receipt.operation === "review" ? "diff page" : "details",
                  false,
                  theme,
                ),
                safeWidth,
              ),
            ]),
    ];
  });
};

/** Compact expansion supplies evidence only. The shell owns headings and attention. */
export const renderSubagentExpandedContent = (
  result: { readonly content: ToolTextContent; readonly details?: unknown },
  isPartial: boolean,
  theme: Theme,
  options: SubagentResultRenderOptions = {},
): Component => {
  const workspace = renderWorkspaceContent(result, theme);
  if (workspace) return workspace;
  const details = decodeStartAwaitCardDetails(result.details);
  const compact = decodeCompactToolDetails(result.details);
  if (details && isPartial && options.panelOwnsLiveHierarchy) return renderComponent(() => []);
  if (details?.action === "start")
    return renderStartReceiptComponent(
      details.startFailures ?? [],
      details.startEntries,
      true,
      theme,
      isPartial,
      true,
    );
  if (compact?.action === "models") return renderProfileRoutesComponent(compact, true, theme, true);
  const projection = details ?? compact;
  if (!projection)
    return renderTextFallback(result.content, isPartial, true, theme, options.isError);
  if (projection.contentOmitted)
    return rawResultSection(result.content, theme) ?? renderComponent(() => []);
  const runs = projection.cards;
  const targets = details?.action === "await" ? awaitTargets(details) : runs;
  const sections = expandedRunReportSections(targets).filter(
    (section) => section.kind === "report",
  );
  const container = new Container();
  appendReportSections(container, sections, theme);
  container.addChild(
    runOverviewComponent(runs, theme, {
      expanded: true,
      reportSections: [],
      showContextOmission: false,
      contentOnly: true,
      hierarchy: details?.action === "await" ? awaitHierarchy(details) : undefined,
    }),
  );
  return container;
};

export const renderSubagentResult = (
  result: { readonly content: ToolTextContent; readonly details?: unknown },
  isPartial: boolean,
  expanded: boolean,
  theme: Theme,
  options: SubagentResultRenderOptions = {},
): Component => {
  const details = decodeStartAwaitCardDetails(result.details);
  if (details)
    return isPartial
      ? renderPartialStartAwait(details, expanded, theme, options)
      : renderSettledStartAwait(result.content, details, expanded, theme);
  const compact = decodeCompactToolDetails(result.details);
  if (compact) return renderCompactDetails(result.content, compact, expanded, theme);
  const workspace = options.isError ? undefined : renderWorkspacePreview(result, expanded, theme);
  if (workspace) return workspace;
  return renderTextFallback(result.content, isPartial, expanded, theme, options.isError);
};
