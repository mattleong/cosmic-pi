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
  hiddenPreviewExpandHintForShell,
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
  toolRunningLine,
} from "pi-cosmic-ui/tool";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { decodeWorkspaceToolDetails, workspaceReceiptLine } from "./compact-workspace-summary.ts";
import type {
  SubagentAwaitDetails,
  SubagentStartAwaitCardDetails,
  WorkspaceToolDetails,
} from "./details-schema.ts";
import { decodeOutcomeDetails } from "./details-decode.ts";
import { rejectedFailureText } from "./failure-details.ts";
import { boundToolOutput } from "./format.ts";
import { renderCompactResultComponent, renderProfileRoutesComponent } from "./render-management.ts";
import {
  formatAwaitCounters,
  renderAwaitProgressComponent,
  type AwaitHeading,
} from "./render-await.ts";
import { previewHeading, textResultBody } from "./render-preview.ts";
import { cardBlockLines, cardFactLines } from "./render-run-cards.ts";
import { expandedFactDetails, factRowLines, indentedBody } from "../ui/agent-text.ts";
import { aggregateUsage } from "../ui/metrics.ts";
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
  previewHeading({ title: name, subtitle: target }, theme);

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

/** Run names a result resolved, by ID, and whether its drawn body names every one of them. */
interface ResolvedRuns {
  readonly names: ReadonlyMap<string, string>;
  readonly shown: boolean;
}

/**
 * What a row's latest result leaves on the row's shared renderer state for the requested line drawn
 * beside it. Each result replaces it, so a failure or an undecodable result clears what an earlier
 * one named.
 */
export interface RequestedRowState {
  piSubagentsResolvedRuns?: ResolvedRuns | undefined;
  /** The worktree, revision, and preparation IDs, by argument, a shown receipt's Details name. */
  piSubagentsShownWorkspaceIds?: ReadonlyMap<string, string> | undefined;
}

/**
 * A worktree call expanded, at the heading's column: a revise's message to the writer as written,
 * then its other arguments on one dim line, less the IDs its result's Details already name. The
 * heading already names the action.
 */
export const renderWorkspaceCallArguments = (
  args: typeof CallArgumentsSchema.Type | undefined,
  theme: Theme,
  row?: RequestedRowState,
): Component => {
  const message = args?.message;
  const rest = Arr.filter(
    Rec.toEntries(args ?? {}),
    ([key, value]) => key !== "action" && key !== "message" && value !== false,
  );
  const requested = (): string[] => {
    const shown = row?.piSubagentsShownWorkspaceIds;
    return Arr.filterMap(rest, ([key, value]) =>
      Predicate.isString(value) && shown?.get(key) === value
        ? Result.failVoid
        : Result.succeed(
            value === true
              ? key
              : `${WORKSPACE_ARGUMENT_LABELS.get(key) ?? key} ${Predicate.isString(value) ? value : JSON.stringify(value)}`,
          ),
    );
  };
  return expandedBody(
    expandedAuthoredText(theme, "Message", Predicate.isString(message) ? message : undefined),
    rest.length > 0
      ? indentedBody(
          theme,
          renderComponent((width) => {
            const facts = requested();
            return facts.length === 0
              ? []
              : wrapTextWithAnsi(
                  theme.fg("dim", sanitizeTerminalLine(`Requested ${Arr.join(facts, " · ")}`)),
                  Math.max(1, width),
                );
          }),
        )
      : undefined,
  );
};

/**
 * Records on the row the names its result resolved for its runs, for the requested line drawn
 * beside it. `shown` says the result's body draws every one of them, a settled body with their
 * rows and Details or a running wait's progress tree, so the requested line needn't name them again.
 * A stop or interrupt's Details also name, by ID, each target it couldn't act on.
 */
export const rememberRunNames = (
  row: RequestedRowState,
  details: ReturnType<typeof decodeOutcomeDetails>,
  shown = false,
): void => {
  row.piSubagentsResolvedRuns =
    details === undefined || !("cards" in details)
      ? undefined
      : {
          names: new Map([
            ...Arr.map(
              "actionFailures" in details ? (details.actionFailures ?? []) : [],
              (failure) => [failure.id, sanitizeTerminalLine(failure.id)] as const,
            ),
            ...Arr.map(
              details.cards,
              (card) => [card.id, sanitizeTerminalLine(card.name)] as const,
            ),
          ]),
          shown,
        };
};

/**
 * The runs an await or lifecycle call names that nothing else on its row names yet: by name once
 * its result resolved them, by ID before that or when a run is unknown. A settled result's rows
 * and Details, or a running wait's progress tree, name each run it found, and a stop or interrupt's
 * Details each target it couldn't act on, so only the other unknown IDs and the wait's terms remain. Read at draw time, after the row's result recorded what it names.
 */
export const renderRequestedRuns = (
  ids: ReadonlyArray<string>,
  wait: { readonly until: SubagentAwaitUntil; readonly timeoutSeconds?: number },
  tool: string,
  theme: Theme,
  row?: RequestedRowState,
): Component =>
  renderComponent((width) => {
    const resolved = row?.piSubagentsResolvedRuns;
    const unnamed = Arr.filter(ids, (id) => !(resolved?.shown && resolved.names.has(id)));
    const facts = [
      ...(unnamed.length > 0
        ? [
            `Requested ${Arr.join(
              Arr.map(unnamed, (id) => resolved?.names.get(id) ?? sanitizeTerminalLine(id)),
              ", ",
            )}`,
          ]
        : []),
      ...(tool === "agent_await" && wait.until === "any_finished"
        ? ["until the first finishes"]
        : []),
      ...(tool === "agent_await" && wait.timeoutSeconds !== undefined
        ? [`timeout ${wait.timeoutSeconds}s`]
        : []),
    ];
    return facts.length === 0
      ? []
      : wrapTextWithAnsi(
          theme.fg("dim", Str.capitalize(Arr.join(facts, " · "))),
          Math.max(1, width),
        );
  });

const awaitScope = (details: SubagentAwaitDetails) => {
  const awaitedRunIds = new Set(details.awaitedRunIds);
  return {
    hierarchy: { awaitedRunIds, contextOmitted: details.contextOmitted },
    targets: Arr.filter(details.cards, (card) => awaitedRunIds.has(card.id)),
  };
};

interface SubagentResultRenderOptions {
  readonly panelOwnsLiveHierarchy?: boolean | undefined;
  /**
   * What the row's heading drew, so the body needn't count the awaited runs it counts. Asked at
   * draw time: the heading draws first and leaves out a counter its width can't fit.
   */
  readonly awaitHeading?: (() => AwaitHeading) | undefined;
  readonly isError?: boolean | undefined;
  /** The call's arguments, which a failure's body then needn't repeat. */
  readonly args?: unknown;
  /** The row's render context, through which a hidden receipt body names the row's tag. */
  readonly row?: { readonly state: unknown } | undefined;
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
    options.awaitHeading,
  );
  return expanded ? indentedBody(theme, progress) : progress;
};

/**
 * A settled wait: one muted totals line when it has any, then each awaited run's words: its report,
 * failure, or question. Expansion keeps them whole and adds every run's technical facts.
 */
const OMITTED_NOTE = "Some of this result was too long to keep for display";

const renderAwaitResult = (
  details: SubagentAwaitDetails,
  expanded: boolean,
  theme: Theme,
  heading?: () => AwaitHeading,
): Component => {
  const { hierarchy, targets } = awaitScope(details);
  const counterRows = (width: number): string[] => {
    // Expanded, usage is a technical fact, so it moves to `Details`.
    const counters = formatAwaitCounters(details.cards, hierarchy, details.awaitUntil, {
      settled: true,
      heading: heading?.(),
      usage: !expanded,
    });
    return counters
      ? factRowLines([[counters, "muted"]], width, theme, expanded, { wholeFacts: true })
      : [];
  };
  const blockRows = (width: number): string[] => [
    ...cardBlockLines(targets, width, theme, expanded),
    // Details too large for their reports keep the rest; the agent still received every report.
    ...(details.contentOmitted ? [clipToWidth(theme.fg("dim", OMITTED_NOTE), width)] : []),
  ];
  if (!expanded)
    return renderComponent((width) => {
      const safeWidth = Math.max(1, width);
      return [...counterRows(safeWidth), ...blockRows(safeWidth)];
    });
  const total = details.cards.length > 1 ? aggregateUsage(details.cards) : undefined;
  // The wait's totals, then its runs as one labelled list, then each run's technical facts.
  return expandedBody(
    indentedBody(
      theme,
      renderComponent((width) => counterRows(Math.max(1, width))),
    ),
    expandedSection(
      theme,
      Arr.every(targets, (card) => card.state === "completed")
        ? targets.length === 1
          ? "Report"
          : "Reports"
        : "Subagents",
      renderComponent((width) => blockRows(Math.max(1, width))),
    ),
    expandedFactDetails(theme, [
      ...(total ? [`Total: ${total}`] : []),
      ...Arr.flatMap(details.cards, cardFactLines),
    ]),
  );
};

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
      ],
      isTextFragment,
    ),
  };
};

/**
 * Records on the row the worktree, revision, and preparation IDs a shown receipt's Details name, so
 * the requested line beside it leaves them out. A result that isn't shown, such as a failure, names
 * none.
 */
export const rememberWorkspaceIds = (
  row: RequestedRowState,
  result: { readonly content: ToolTextContent; readonly details?: unknown },
  shown: boolean,
): void => {
  const receipt = shown ? decodeWorkspaceToolDetails(result.details) : undefined;
  row.piSubagentsShownWorkspaceIds =
    receipt && workspaceView(receipt, result.content)
      ? new Map(
          Arr.filterMap(
            [
              ["workspaceId", receipt.workspaceId],
              ["revisionId", receipt.revisionId],
              ["preparationId", receipt.preparationId],
            ] as const,
            ([key, id]) =>
              id === undefined ? Result.failVoid : Result.succeed([key, id] as const),
          ),
        )
      : undefined;
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
  const receipt = decodeWorkspaceToolDetails(result.details);
  if (!receipt) return undefined;
  const view = workspaceView(receipt, result.content);
  if (!view) return rawResultSection(result.content, theme) ?? renderComponent(() => []);
  return workspaceExpandedBody(receipt, view, theme);
};

const renderWorkspacePreview = (
  result: { readonly content: ToolTextContent; readonly details?: unknown },
  expanded: boolean,
  theme: Theme,
  row: { readonly state: unknown } | undefined,
): Component | undefined => {
  const receipt = decodeWorkspaceToolDetails(result.details);
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
  const label = receipt.operation === "review" && view?.body ? "diff page" : "details";
  // Inside the row's shell the hidden body names the heading's tag rather than drawing a row.
  const hint =
    !expandable || expanded
      ? ""
      : row
        ? hiddenPreviewExpandHintForShell(row, theme, label)
        : renderExpansionAffordance(label, false, theme);
  return renderComponent((width) => [
    ...lineRows(width),
    ...(hint ? [clipToWidth(hint, Math.max(1, width))] : []),
  ]);
};

/**
 * A row's expanded result at the heading's column. Labeled sections such as a failure's Error or a
 * raw result indent themselves.
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
  const details = decodeOutcomeDetails(result.details);
  if (details?.action === "start" || details?.action === "await") {
    if (isPartial) return renderPartialStartAwait(details, expanded, theme, options);
    return details.action === "start"
      ? renderStartReceiptComponent(details, expanded, theme)
      : renderAwaitResult(details, expanded, theme, options.awaitHeading);
  }
  if (details)
    return details.action === "models"
      ? renderProfileRoutesComponent(details, expanded, theme)
      : renderCompactResultComponent(
          details,
          expanded,
          theme,
          details.contentOmitted && OMITTED_NOTE,
        );
  const workspace =
    options.isError || options.workspace === false
      ? undefined
      : renderWorkspacePreview(result, expanded, theme, options.row);
  if (workspace) return workspace;
  return renderTextFallback(result, isPartial, expanded, theme, options);
};
