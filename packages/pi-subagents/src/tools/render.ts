import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { escapeControlChars, expandedSection, getTextContent } from "pi-code-previews";
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
  type CompactSubagentToolDetails,
  type SubagentAwaitDetails,
  type SubagentStartAwaitCardDetails,
  type WorkspaceToolDetails,
} from "./details-schema.ts";
import { decodeCompactToolDetails, decodeStartAwaitCardDetails } from "./details-decode.ts";
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
import { isTextFragment } from "./text-fragments.ts";

type ToolTextContent = ReadonlyArray<{ readonly type: string; readonly text?: string }>;

const rawResultSection = (content: ToolTextContent, theme: Theme, label = "Raw result") => {
  const text = boundToolOutput(sanitizeTerminalText(getTextContent(content)));
  return text
    ? expandedSection(theme, label, new Text(theme.fg("toolOutput", text), 0, 0))
    : undefined;
};

export const renderSubagentCall = (name: string, target: string, theme: Theme): Component =>
  new Text(renderToolHeader({ title: name, subtitle: target }, theme), 0, 0);

const CallArgumentsSchema = Schema.Record(Schema.String, Schema.Json);

export const decodeCallArguments = decodeUnknownOrUndefined(CallArgumentsSchema);

/** Every argument of a call, one per line, so expansion shows what the heading can't. */
export const renderSubagentInputContent = (
  args: typeof CallArgumentsSchema.Type | undefined,
  theme: Theme,
): Component => {
  if (!args) return new Text("", 0, 0);
  const lines = Arr.map(
    Rec.toEntries(args),
    ([key, value]) => `${key}: ${Predicate.isString(value) ? value : JSON.stringify(value)}`,
  );
  return new Text(theme.fg("toolOutput", escapeControlChars(Arr.join(lines, "\n"))), 0, 0);
};

const awaitScope = (details: SubagentAwaitDetails) => {
  const awaitedRunIds = new Set(details.awaitedRunIds ?? Arr.map(details.cards, (card) => card.id));
  return {
    hierarchy: { awaitedRunIds, contextOmitted: details.contextOmitted },
    targets: Arr.filter(details.cards, (card) => awaitedRunIds.has(card.id)),
  };
};

interface SubagentResultRenderOptions {
  readonly panelOwnsLiveHierarchy?: boolean | undefined;
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

const COLLAPSED_TEXT_LINES = 11;

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

const decodeWorkspaceDisplay = decodeUnknownOrUndefined(WorkspaceToolDetailsSchema, {
  onExcessProperty: "error",
});

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
  return Fn.pipe(
    [
      receipt.workspaceId,
      receipt.revisionId,
      receipt.preparationId,
      Fn.pipe(raw, Str.slice(span.offset, span.offset + span.length)),
    ],
    Arr.filter(isTextFragment),
    Arr.join("\n"),
  );
};

const renderWorkspaceContent = (
  result: { readonly content: ToolTextContent; readonly details?: unknown },
  theme: Theme,
): Component | undefined => {
  const receipt = decodeWorkspaceDisplay(result.details);
  if (!receipt) return undefined;
  const text = workspaceDisplayText(receipt, result.content);
  if (text !== undefined) return new Text(theme.fg("toolOutput", escapeControlChars(text)), 0, 0);
  return rawResultSection(result.content, theme) ?? renderComponent(() => []);
};

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

const renderExpandedRunCards = (
  projection: SubagentAwaitDetails | Exclude<CompactSubagentToolDetails, { action: "models" }>,
  theme: Theme,
): Component => {
  const scope = projection.action === "await" ? awaitScope(projection) : undefined;
  const sections = Arr.filter(
    expandedRunReportSections(scope?.targets ?? projection.cards),
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
  const compact = details ? undefined : decodeCompactToolDetails(result.details);
  if (compact?.action === "models") return renderProfileRoutesComponent(compact, true, theme, true);
  const projection = details ?? compact;
  if (!projection)
    return renderTextFallback(result.content, isPartial, true, theme, options.isError);
  if (projection.contentOmitted)
    return rawResultSection(result.content, theme) ?? renderComponent(() => []);
  return renderExpandedRunCards(projection, theme);
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
