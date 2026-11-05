import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import {
  escapeControlChars,
  expandedAuthoredText,
  expandedBody,
  expandedSection,
  expandedText,
  getTextContent,
} from "pi-code-previews";
import { decodeUnknownOrUndefined } from "pi-cosmic-core/schema/decode";
import {
  sanitizeTerminalLine,
  stripTerminalControls as sanitizeTerminalText,
} from "pi-cosmic-core/security";
import type { SubagentAwaitUntil } from "../run/service.ts";
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
import {
  decodeCompactToolDetails,
  decodeStartAwaitCardDetails,
  type decodeOutcomeDetails,
} from "./details-decode.ts";
import { rejectedFailureText } from "./failure-details.ts";
import { boundToolOutput } from "./format.ts";
import { renderCompactResultComponent, renderProfileRoutesComponent } from "./render-management.ts";
import { formatAwaitCounters, renderAwaitProgressComponent } from "./render-await.ts";
import { textResultBody } from "./render-preview.ts";
import { cardBlockLines, cardFactLines } from "./render-run-cards.ts";
import {
  expandedFactDetails,
  expandedRowsBody,
  factRowLines,
  indentedBody,
} from "../ui/agent-text.ts";
import { renderStartReceiptComponent } from "./render-start.ts";
import { isTextFragment } from "./text-fragments.ts";
import { homeDisplayPath } from "../ui/display-path.ts";

type ToolTextContent = ReadonlyArray<{ readonly type: string; readonly text?: string }>;

export const rawResultSection = (
  content: ToolTextContent,
  theme: Theme,
  label = "Raw result",
): Component | undefined => {
  const text = boundToolOutput(sanitizeTerminalText(getTextContent(content)));
  return text
    ? expandedSection(theme, label, new Text(theme.fg("toolOutput", text), 0, 0))
    : undefined;
};

export const renderSubagentCall = (name: string, target: string, theme: Theme): Component =>
  new Text(renderToolHeader({ title: name, subtitle: target }, theme), 0, 0);

const CallArgumentsSchema = Schema.Record(Schema.String, Schema.Json);

export const decodeCallArguments = decodeUnknownOrUndefined(CallArgumentsSchema);

/**
 * Every argument of a call the heading doesn't already show exactly, one per line, so expansion
 * shows what the heading can't. A string named in `shown` is the heading's subject.
 */
export const renderSubagentInputContent = (
  args: typeof CallArgumentsSchema.Type | undefined,
  theme: Theme,
  shown: ReadonlyArray<string> = [],
): Component => {
  if (!args) return new Text("", 0, 0);
  const lines = Arr.filterMap(Rec.toEntries(args), ([key, value]) =>
    Arr.contains(shown, key) && Predicate.isString(value) && sanitizeTerminalLine(value) === value
      ? Result.failVoid
      : Result.succeed(`${key}: ${Predicate.isString(value) ? value : JSON.stringify(value)}`),
  );
  return new Text(theme.fg("toolOutput", escapeControlChars(Arr.join(lines, "\n"))), 0, 0);
};

const WORKSPACE_ARGUMENT_LABELS = new Map([
  ["workspaceId", "worktree"],
  ["revisionId", "revision"],
  ["preparationId", "preparation"],
]);

/**
 * A worktree call expanded, at the heading's column: a revise's message to the writer as written,
 * then its other arguments on one dim line. The heading already names the action.
 */
export const renderWorkspaceCallArguments = (
  args: typeof CallArgumentsSchema.Type | undefined,
  theme: Theme,
): Component => {
  const message = args?.message;
  const rest = Arr.filter(
    Rec.toEntries(args ?? {}),
    ([key, value]) => key !== "action" && key !== "message" && value !== false,
  );
  const facts = Arr.map(rest, ([key, value]) =>
    value === true
      ? key
      : `${WORKSPACE_ARGUMENT_LABELS.get(key) ?? key} ${Predicate.isString(value) ? value : JSON.stringify(value)}`,
  );
  return expandedBody(
    expandedAuthoredText(theme, "Message", Predicate.isString(message) ? message : undefined),
    facts.length > 0
      ? indentedBody(
          theme,
          renderComponent((width) =>
            wrapTextWithAnsi(
              theme.fg("dim", sanitizeTerminalLine(`Requested ${Arr.join(facts, " · ")}`)),
              Math.max(1, width),
            ),
          ),
        )
      : undefined,
  );
};

// Run names an await or lifecycle result resolved, by tool call. Only recent rows redraw their
// requested line, so the oldest entries go first once the bound is reached.
const MAX_REMEMBERED_ROWS = 256;
const runNamesByCall = new Map<string, ReadonlyMap<string, string>>();

/** Records the names a result resolved for its runs, for the requested line drawn beside it. */
export const rememberRunNames = (
  toolCallId: string,
  details: ReturnType<typeof decodeOutcomeDetails>,
): void => {
  if (details === undefined || !("cards" in details)) return;
  runNamesByCall.delete(toolCallId);
  runNamesByCall.set(
    toolCallId,
    new Map(Arr.map(details.cards, (card) => [card.id, sanitizeTerminalLine(card.name)] as const)),
  );
  for (const oldest of runNamesByCall.keys()) {
    if (runNamesByCall.size <= MAX_REMEMBERED_ROWS) break;
    runNamesByCall.delete(oldest);
  }
};

/**
 * The runs an await or lifecycle call names: by name once its result resolved them, by ID before
 * that or when a run is unknown. The result's Details keep every ID beside its name.
 */
export const renderRequestedRuns = (
  ids: ReadonlyArray<string>,
  wait: { readonly until: SubagentAwaitUntil; readonly timeoutSeconds?: number },
  tool: string,
  theme: Theme,
  toolCallId?: string,
): Component =>
  renderComponent((width) =>
    wrapTextWithAnsi(
      theme.fg(
        "dim",
        Arr.join(
          [
            `Requested ${Arr.join(
              Arr.map(
                ids,
                (id) =>
                  (toolCallId === undefined
                    ? undefined
                    : runNamesByCall.get(toolCallId)?.get(id)) ?? sanitizeTerminalLine(id),
              ),
              ", ",
            )}`,
            ...(tool === "agent_await" && wait.until === "any_finished"
              ? ["until the first finishes"]
              : []),
            ...(tool === "agent_await" && wait.timeoutSeconds !== undefined
              ? [`timeout ${wait.timeoutSeconds}s`]
              : []),
          ],
          " · ",
        ),
      ),
      Math.max(1, width),
    ),
  );

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
  /** The call's arguments, which a failure's body then needn't repeat. */
  readonly args?: unknown;
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
  const progress = renderAwaitProgressComponent(
    details.cards,
    details.awaitUntil,
    theme,
    hierarchy,
    expanded,
  );
  return expanded ? indentedBody(theme, progress) : progress;
};

/**
 * A settled wait: one muted totals line, then each awaited run's words: its report, failure, or
 * question. Expansion keeps them whole and adds every run's technical facts.
 */
const OMITTED_NOTE = "Some of this result was too long to keep for display";

const renderAwaitResult = (
  details: SubagentAwaitDetails,
  expanded: boolean,
  theme: Theme,
): Component => {
  const { hierarchy, targets } = awaitScope(details);
  const counters = formatAwaitCounters(details.cards, hierarchy, details.awaitUntil, true);
  const rows = (width: number): string[] => {
    const safeWidth = Math.max(1, width);
    return [
      ...factRowLines([[counters, "muted"]], safeWidth, theme, expanded, { wholeFacts: true }),
      ...cardBlockLines(targets, safeWidth, theme, expanded),
      // Details too large for their reports keep the rest; the agent still received every report.
      ...(details.contentOmitted ? [clipToWidth(theme.fg("dim", OMITTED_NOTE), safeWidth)] : []),
    ];
  };
  return expanded
    ? expandedRowsBody(theme, rows, Arr.flatMap(details.cards, cardFactLines))
    : renderComponent(rows);
};

const renderSettledStartAwait = (
  details: SubagentStartAwaitCardDetails,
  expanded: boolean,
  theme: Theme,
): Component =>
  details.action === "start"
    ? renderStartReceiptComponent(details, expanded, theme)
    : renderAwaitResult(details, expanded, theme);

const renderCompactDetails = (
  compact: CompactSubagentToolDetails,
  expanded: boolean,
  theme: Theme,
): Component =>
  compact.action === "models"
    ? renderProfileRoutesComponent(compact, expanded, theme)
    : renderCompactResultComponent(
        compact,
        expanded,
        theme,
        compact.contentOmitted && OMITTED_NOTE,
      );

const COLLAPSED_TEXT_LINES = 11;

/** A result's text; a failure shows its recorded user copy, or the text of one saved without it. */
const renderTextFallback = (
  result: { readonly content: ToolTextContent; readonly details?: unknown },
  isPartial: boolean,
  expanded: boolean,
  theme: Theme,
  { isError = false, args }: SubagentResultRenderOptions = {},
): Component => {
  const text = boundToolOutput(
    sanitizeTerminalText(isError ? rejectedFailureText(result) : getTextContent(result.content)),
  );
  if (!text && isPartial) return new Text(toolRunningLine(theme), 0, 0);
  return textResultBody(theme, text, { expanded, isError, args }, COLLAPSED_TEXT_LINES);
};

const decodeWorkspaceDisplay = decodeUnknownOrUndefined(WorkspaceToolDetailsSchema, {
  onExcessProperty: "error",
});

/** The text a receipt's producer marked for display, or undefined when its span doesn't fit. */
const workspaceSpanText = (
  receipt: WorkspaceToolDetails,
  content: ToolTextContent,
): string | undefined => {
  const span = receipt.displayContent;
  const raw = getTextContent(content);
  if (!span || span.offset > raw.length || span.length > raw.length - span.offset) return undefined;
  return Fn.pipe(raw, Str.slice(span.offset, span.offset + span.length));
};

interface WorkspaceView {
  /** A review's diff page or an apply's changed files: what the user reads. */
  readonly body?: string | undefined;
  /** IDs, paths, and listed worktrees for the expanded details. */
  readonly facts: ReadonlyArray<string>;
}

const ORPHAN_LABELS = { adoptable: "adoptable", "discard-only": "discard only" } as const;

const listEntryFact = (entry: NonNullable<WorkspaceToolDetails["entries"]>[number]): string =>
  Arr.join(
    Arr.filter(
      [
        `${entry.workspaceId}: ${entry.status}`,
        entry.orphan && ORPHAN_LABELS[entry.orphan],
        entry.revisionId && `revision ${entry.revisionId}`,
        entry.sourceCwd && homeDisplayPath(entry.sourceCwd),
      ],
      isTextFragment,
    ),
    " · ",
  );

/**
 * A worktree receipt as the user reads it. Undefined when the receipt can't be shown that way: a
 * span outside its text, or a preparation with no recorded test cwd.
 */
const workspaceView = (
  receipt: WorkspaceToolDetails,
  content: ToolTextContent,
): WorkspaceView | undefined => {
  const span = workspaceSpanText(receipt, content);
  if (span === undefined) return undefined;
  const marked = Str.trim(span) ? span : undefined;
  if (receipt.operation === "prepare" && !receipt.preparedCwd && !marked) return undefined;
  const shownBody = receipt.operation === "review" || receipt.operation === "apply";
  return {
    ...(shownBody && marked && { body: marked }),
    facts: Arr.filter(
      [
        receipt.workspaceId && `Worktree ${receipt.workspaceId}`,
        receipt.revisionId && `Revision ${receipt.revisionId}`,
        receipt.preparationId && `Preparation ${receipt.preparationId}`,
        receipt.preparedCwd
          ? `Test cwd: ${homeDisplayPath(receipt.preparedCwd)}`
          : receipt.operation === "prepare"
            ? marked
            : undefined,
        receipt.successorRunId && `Revised by run ${receipt.successorRunId}`,
        ...Arr.map(receipt.entries ?? [], listEntryFact),
        // A list saved before its entries were recorded marked its raw lines instead.
        ...(receipt.operation === "list" && !receipt.entries && marked
          ? Str.split(marked, "\n")
          : []),
      ],
      isTextFragment,
    ),
  };
};

/** A receipt's body and technical facts at the heading's column; a review labels its diff. */
const workspaceExpandedBody = (
  receipt: WorkspaceToolDetails,
  view: WorkspaceView,
  theme: Theme,
): Component =>
  expandedBody(
    view.body === undefined
      ? undefined
      : expandedText(
          theme,
          receipt.operation === "review" ? "Diff" : undefined,
          Str.split(view.body, "\n"),
        ),
    expandedFactDetails(theme, view.facts),
  );

const renderWorkspaceContent = (
  result: { readonly content: ToolTextContent; readonly details?: unknown },
  theme: Theme,
): Component | undefined => {
  const receipt = decodeWorkspaceDisplay(result.details);
  if (!receipt) return undefined;
  const view = workspaceView(receipt, result.content);
  if (!view) return rawResultSection(result.content, theme) ?? renderComponent(() => []);
  return workspaceExpandedBody(receipt, view, theme);
};

const renderWorkspacePreview = (
  result: { readonly content: ToolTextContent; readonly details?: unknown },
  expanded: boolean,
  theme: Theme,
): Component | undefined => {
  const receipt = decodeWorkspaceDisplay(result.details);
  if (!receipt) return undefined;
  const line = workspaceReceiptLine(receipt);
  // The producer's display span; only a receipt without one falls back to the agent's text.
  const view = workspaceView(receipt, result.content);
  const raw = view ? undefined : rawResultSection(result.content, theme);
  const expandable = view ? view.body !== undefined || view.facts.length > 0 : raw !== undefined;
  const lineRows = (width: number) =>
    line ? factRowLines([[line, "muted"]], Math.max(1, width), theme, expanded) : [];
  if (expanded && expandable)
    return expandedBody(
      indentedBody(theme, renderComponent(lineRows)),
      view ? workspaceExpandedBody(receipt, view, theme) : raw,
    );
  return renderComponent((width) => {
    const label = receipt.operation === "review" && view?.body ? "diff page" : "details";
    return [
      ...lineRows(width),
      ...(expandable && !expanded
        ? [clipToWidth(renderExpansionAffordance(label, false, theme), Math.max(1, width))]
        : []),
    ];
  });
};

/**
 * A compact row's expanded result at the heading's column. Labeled sections such as a failure's
 * Error or a raw result indent themselves.
 */
export const renderSubagentExpandedContent = (
  result: { readonly content: ToolTextContent; readonly details?: unknown },
  isPartial: boolean,
  theme: Theme,
  options: SubagentResultRenderOptions = {},
): Component =>
  renderWorkspaceContent(result, theme) ??
  renderSubagentResult(result, isPartial, true, theme, { ...options, workspace: false });

/** A result collapsed, or expanded at the heading's column as every workspace tool's body is. */
export const renderSubagentResult = (
  result: { readonly content: ToolTextContent; readonly details?: unknown },
  isPartial: boolean,
  expanded: boolean,
  theme: Theme,
  options: SubagentResultRenderOptions & { readonly workspace?: false } = {},
): Component => {
  const details = decodeStartAwaitCardDetails(result.details);
  if (details)
    return isPartial
      ? renderPartialStartAwait(details, expanded, theme, options)
      : renderSettledStartAwait(details, expanded, theme);
  const compact = decodeCompactToolDetails(result.details);
  if (compact) return renderCompactDetails(compact, expanded, theme);
  const workspace =
    options.isError || options.workspace === false
      ? undefined
      : renderWorkspacePreview(result, expanded, theme);
  if (workspace) return workspace;
  return renderTextFallback(result, isPartial, expanded, theme, options);
};
