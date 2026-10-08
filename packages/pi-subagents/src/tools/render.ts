/**
 * Preview-style call and result bodies for the root subagent tools. The shared shell draws the
 * issue lines from each tool's compact summary; these bodies show routine counts, rows, and
 * content, with agent-facing evidence only once expanded and under a label.
 */
import * as Schema from "effect/Schema";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { expandedSection, getTextContent } from "pi-code-previews";
import {
  decodeUnknownOrUndefined,
  stripTerminalControls as sanitizeTerminalText,
} from "pi-cosmic-core";
import {
  composeToolComponent as renderComponent,
  renderExpansionAffordance,
  renderToolHeader,
  toolRunningLine,
} from "pi-cosmic-ui/tool";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { workspaceReceiptLine } from "./compact-workspace-summary.ts";
import {
  WorkspaceToolDetailsSchema,
  decodeCompactToolDetails,
  decodeStartAwaitCardDetails,
  type CompactSubagentToolDetails,
  type SubagentAwaitDetails,
  type SubagentStartAwaitCardDetails,
  type WorkspaceToolDetails,
} from "./details-schema.ts";
import { boundToolOutput } from "./format.ts";
import { renderCompactResultComponent, renderProfileRoutesComponent } from "./render-management.ts";
import { formatAwaitCounters, renderAwaitProgressComponent } from "./render-await.ts";
import { textResultBody } from "./render-preview.ts";
import {
  appendReportSections,
  expandedRunReportSections,
  renderExpandedAwaitResult,
  runOverviewComponent,
} from "./render-run-overview.ts";
import { renderStartReceiptComponent } from "./render-start.ts";

type ToolTextContent = ReadonlyArray<{ readonly type: string; readonly text?: string }>;

/** The tool's own words for what it returned, under a label, for expanded views. */
const rawResultSection = (content: ToolTextContent, theme: Theme, label = "Raw result") => {
  const text = boundToolOutput(sanitizeTerminalText(getTextContent(content)));
  return text
    ? expandedSection(theme, label, new Text(theme.fg("toolOutput", text), 0, 0))
    : undefined;
};

export const renderSubagentCall = (name: string, target: string, theme: Theme): Component =>
  new Text(renderToolHeader({ title: name, subtitle: target }, theme), 0, 0);

const InputEvidenceSchema = Schema.Struct({
  message: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  paths: Schema.optionalKey(Schema.Array(Schema.String)),
});

/** Unique input evidence not carried by the semantic heading or result cards. */
export const renderSubagentInputContent = <ValueInput>(
  args: ValueInput,
  theme: Theme,
): Component => {
  const input = decodeUnknownOrUndefined(InputEvidenceSchema, args);
  if (!input) return new Text("", 0, 0);
  const lines = [input.message, input.name, ...(input.paths ?? [])].filter(Boolean);
  return new Text(theme.fg("toolOutput", sanitizeTerminalText(lines.join("\n"))), 0, 0);
};

/** An await's targets, and its hierarchy, which always names them. */
const awaitScope = (details: SubagentAwaitDetails) => {
  const awaitedRunIds = new Set(details.awaitedRunIds ?? details.cards.map((card) => card.id));
  return {
    hierarchy: { awaitedRunIds, contextOmitted: details.contextOmitted },
    targets: details.cards.filter((card) => awaitedRunIds.has(card.id)),
  };
};

interface SubagentResultRenderOptions {
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
    return renderStartReceiptComponent(details, expanded, theme, true);
  const { hierarchy } = awaitScope(details);
  return renderAwaitProgressComponent(details.cards, details.awaitUntil, theme, hierarchy);
};

const renderSettledStartAwait = (
  content: ToolTextContent,
  details: SubagentStartAwaitCardDetails,
  expanded: boolean,
  theme: Theme,
): Component => {
  if (details.action === "start") return renderStartReceiptComponent(details, expanded, theme);
  const { hierarchy, targets } = awaitScope(details);
  const counters = formatAwaitCounters(details.cards, hierarchy, details.awaitUntil, true);
  if (!expanded)
    return runOverviewComponent(details.cards, theme, {
      expanded: false,
      reportSections: expandedRunReportSections(targets),
      counters,
      hierarchy,
      showRunRows: false,
    });
  const rendered = renderExpandedAwaitResult(details.cards, targets, theme, counters, hierarchy);
  return details.contentOmitted ? (rawResultSection(content, theme) ?? rendered) : rendered;
};

const renderCompactDetails = (
  content: ToolTextContent,
  compact: CompactSubagentToolDetails,
  expanded: boolean,
  theme: Theme,
): Component => {
  if (compact.action === "models") return renderProfileRoutesComponent(compact, expanded, theme);
  const rendered = renderCompactResultComponent(compact, expanded, theme);
  if (!expanded || !compact.contentOmitted) return rendered;
  return rawResultSection(content, theme) ?? rendered;
};

/** Lines a collapsed text result shows before its expansion affordance. */
const COLLAPSED_TEXT_LINES = 11;

/** Results without typed details: a running line until text arrives, then the text's body. */
const renderTextFallback = (
  content: ToolTextContent,
  isPartial: boolean,
  expanded: boolean,
  theme: Theme,
  isError = false,
): Component => {
  const text = boundToolOutput(sanitizeTerminalText(getTextContent(content)));
  if (!text && isPartial) return new Text(toolRunningLine(theme), 0, 0);
  return textResultBody(theme, text, { expanded, isError }, COLLAPSED_TEXT_LINES);
};

/** A strict receipt: its display span is trusted only when nothing unknown rides along. */
const decodeWorkspaceDisplay = <Details>(details: Details) =>
  decodeUnknownOrUndefined(WorkspaceToolDetailsSchema, details, { onExcessProperty: "error" });

/** The workspace's own display span (list records or the diff page), when it is intact. */
const workspaceDisplayText = (
  receipt: WorkspaceToolDetails,
  content: ToolTextContent,
): string | undefined => {
  const span = receipt.displayContent;
  const raw = getTextContent(content);
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
  const receipt = decodeWorkspaceDisplay(result.details);
  if (!receipt) return undefined;
  const text = workspaceDisplayText(receipt, result.content);
  if (text !== undefined) return new Text(theme.fg("toolOutput", sanitizeTerminalText(text)), 0, 0);
  return rawResultSection(result.content, theme) ?? renderComponent(() => []);
};

/** Preview style: one short line collapsed; the tool's full text only once expanded. */
const renderWorkspacePreview = (
  result: { readonly content: ToolTextContent; readonly details?: unknown },
  expanded: boolean,
  theme: Theme,
): Component | undefined => {
  const receipt = decodeWorkspaceDisplay(result.details);
  if (!receipt) return undefined;
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
  if (details && isPartial && options.panelOwnsLiveHierarchy) return renderComponent(() => []);
  if (details?.action === "start")
    return renderStartReceiptComponent(details, true, theme, isPartial, true);
  // Start/await receipts never share an action with the others, so one of them decodes at most.
  const compact = details ? undefined : decodeCompactToolDetails(result.details);
  if (compact?.action === "models") return renderProfileRoutesComponent(compact, true, theme, true);
  const projection = details ?? compact;
  if (!projection)
    return renderTextFallback(result.content, isPartial, true, theme, options.isError);
  if (projection.contentOmitted)
    return rawResultSection(result.content, theme) ?? renderComponent(() => []);
  const scope = details && awaitScope(details);
  const sections = expandedRunReportSections(scope?.targets ?? projection.cards).filter(
    (section) => section.kind === "report",
  );
  const container = new Container();
  appendReportSections(container, sections, theme);
  container.addChild(
    runOverviewComponent(projection.cards, theme, {
      expanded: true,
      reportSections: [],
      showContextOmission: false,
      contentOnly: true,
      hierarchy: scope?.hierarchy,
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
