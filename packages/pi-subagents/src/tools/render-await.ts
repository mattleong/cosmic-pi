import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { sanitizeTerminalLine, synchronousNow } from "pi-cosmic-core";
import { managerStateGlyph } from "pi-cosmic-ui/manager";
import { isAssignmentFinishedRunState } from "../run/model.ts";
import type { SubagentAwaitUntil } from "../run/service.ts";
import { runStateGlyph, runStateLabel } from "../ui/run-state.ts";
import type { SubagentRunCard, SubagentStartAwaitCardDetails } from "./details.ts";
import { aggregateRunUsage, renderResponsiveRunRows, runTiming } from "./render-run-rows.ts";
import { projectRunCardTree, runCardTreeBranch } from "./run-card-tree.ts";

interface AwaitProgressRun {
  readonly id: string;
  readonly name: string;
  readonly state: SubagentRunCard["state"];
  readonly parentRunId?: string | undefined;
  readonly currentTool?: string | undefined;
  readonly startedAt?: number | undefined;
  readonly lastActivityAt?: number | undefined;
  readonly endedAt?: number | undefined;
  readonly usage?: { readonly totalTokens: number; readonly cost?: number | undefined } | undefined;
}

export interface AwaitSummaryOutcome {
  readonly timedOut?: boolean | undefined;
  readonly attentionRequired?: boolean | undefined;
  readonly cancelled?: boolean | undefined;
  readonly settled?: boolean | undefined;
  readonly targetCount?: number | undefined;
  readonly descendantCount?: number | undefined;
}

export const formatAwaitSummary = (
  runs: ReadonlyArray<AwaitProgressRun>,
  until: SubagentAwaitUntil,
  usage = "",
  outcome: AwaitSummaryOutcome = {},
): string => {
  const finished = runs.filter((run) => isAssignmentFinishedRunState(run.state)).length;
  const failed = runs.filter((run) => run.state === "failed").length;
  const targetCount = outcome.targetCount ?? runs.length;
  const descendantCount = outcome.descendantCount ?? 0;
  const mode = until === "all_finished" ? "Waiting for subagents" : "Waiting for first subagent";
  const unfinishedStates = [
    "starting",
    "running",
    "waiting_for_parent",
    "paused",
    "stopping",
  ] as const;
  const activeSummary = unfinishedStates.flatMap((state) => {
    const count = runs.filter((run) => run.state === state).length;
    return count > 0 ? [`${count} ${runStateLabel(state)}`] : [];
  });
  const firstFinished =
    until === "any_finished"
      ? runs
          .filter((run) => isAssignmentFinishedRunState(run.state))
          .sort((left, right) => (left.endedAt ?? Infinity) - (right.endedAt ?? Infinity))[0]
      : undefined;
  const firstSummary = firstFinished
    ? `${sanitizeTerminalLine(firstFinished.name)} ${
        firstFinished.state === "reported"
          ? "reported first · retained"
          : `${runStateLabel(firstFinished.state)} first`
      }`
    : undefined;
  const interrupted = outcome.cancelled || outcome.timedOut || outcome.attentionRequired;
  const settledNormally = outcome.settled === true && !interrupted;
  const completionFailed =
    until === "any_finished" ? firstFinished?.state === "failed" : failed > 0;
  const completionGlyph = managerStateGlyph(completionFailed ? "failed" : "done");
  const heading = outcome.cancelled
    ? "Await canceled"
    : outcome.timedOut
      ? "Await timed out"
      : outcome.attentionRequired
        ? "Parent action required"
        : settledNormally
          ? until === "any_finished" && firstSummary
            ? `${completionGlyph} ${firstSummary}`
            : `${completionGlyph} ${finished}/${targetCount} finished`
          : mode;
  const progressInHeading = settledNormally && until === "all_finished";
  const firstInHeading = settledNormally && until === "any_finished" && firstSummary !== undefined;
  return [
    heading,
    ...(targetCount > 0 && !progressInHeading ? [`${finished}/${targetCount}`] : []),
    ...(firstSummary && !firstInHeading ? [firstSummary] : []),
    ...activeSummary,
    ...(failed > 0 ? [`${failed} failed`] : []),
    ...(usage ? [usage] : []),
    ...(outcome.settled ? [] : [`◎${targetCount} target${targetCount === 1 ? "" : "s"}`]),
    ...(descendantCount > 0
      ? [`${descendantCount} descendant${descendantCount === 1 ? "" : "s"}`]
      : []),
  ].join(" · ");
};

const awaitRunStatus = (run: AwaitProgressRun): string =>
  sanitizeTerminalLine([run.currentTool, runTiming(run)].filter(Boolean).join(" · "));

export const formatAwaitProgress = (
  runs: ReadonlyArray<AwaitProgressRun>,
  until: SubagentAwaitUntil,
  contextRuns: ReadonlyArray<AwaitProgressRun> = [],
): string => {
  const awaitedIds = new Set(runs.map((run) => run.id));
  const allRuns = [...runs, ...contextRuns.filter((run) => !awaitedIds.has(run.id))];
  const usage = aggregateRunUsage(allRuns, "compact");
  return [
    formatAwaitSummary(runs, until, usage, {
      targetCount: awaitedIds.size,
      descendantCount: allRuns.length - runs.length,
    }),
    ...projectRunCardTree(allRuns).map((row) => {
      const status = awaitRunStatus(row.run);
      return `${runCardTreeBranch(row)}${awaitedIds.has(row.run.id) ? "◎ " : ""}${runStateGlyph(row.run.state)} ${sanitizeTerminalLine(row.run.name)} (${sanitizeTerminalLine(row.run.id)})${status ? ` · ${status}` : ""}`;
    }),
  ].join("\n");
};

const awaitHeaderColor = (
  runs: ReadonlyArray<SubagentRunCard>,
  outcome: AwaitSummaryOutcome,
): "warning" | "success" | "error" => {
  if (outcome.cancelled || outcome.timedOut || outcome.attentionRequired) return "warning";
  if (runs.some((run) => run.state === "failed")) return "error";
  return runs.length > 0 && runs.every((run) => isAssignmentFinishedRunState(run.state))
    ? "success"
    : "warning";
};

interface AwaitProgressHierarchy {
  readonly awaitedRunIds?: ReadonlySet<string> | undefined;
  readonly contextOmitted?: boolean | undefined;
}

class AwaitProgressComponent implements Component {
  private readonly runs: ReadonlyArray<SubagentRunCard>;
  private readonly targets: ReadonlyArray<SubagentRunCard>;
  private readonly until: SubagentAwaitUntil;
  private readonly theme: Theme;
  private readonly hierarchy: AwaitProgressHierarchy;
  private readonly outcome: AwaitSummaryOutcome;

  constructor(
    runs: ReadonlyArray<SubagentRunCard>,
    targets: ReadonlyArray<SubagentRunCard>,
    until: SubagentAwaitUntil,
    theme: Theme,
    hierarchy: AwaitProgressHierarchy,
    outcome: AwaitSummaryOutcome,
  ) {
    this.runs = runs;
    this.targets = targets;
    this.until = until;
    this.theme = theme;
    this.hierarchy = hierarchy;
    this.outcome = outcome;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const frame = Math.floor(synchronousNow() / 160);
    const usage = aggregateRunUsage(this.runs, "compact");
    const targetIds = this.hierarchy.awaitedRunIds ?? new Set(this.targets.map((run) => run.id));
    const summary = {
      ...this.outcome,
      targetCount: targetIds.size,
      descendantCount: this.runs.filter((run) => !targetIds.has(run.id)).length,
    };
    return [
      truncateToWidth(
        this.theme.fg(
          awaitHeaderColor(this.targets, this.outcome),
          formatAwaitSummary(this.targets, this.until, usage, summary),
        ),
        safeWidth,
      ),
      ...(this.hierarchy.contextOmitted
        ? [
            truncateToWidth(
              this.theme.fg("warning", "Some descendant context was omitted from this card."),
              safeWidth,
            ),
          ]
        : []),
      ...renderResponsiveRunRows(this.runs, safeWidth, this.theme, {
        frame,
        hierarchy: this.hierarchy,
      }),
    ];
  }

  invalidate(): void {
    // Rendering is derived from the current clock frame.
  }
}

interface SubagentToolRendererState extends Record<string, unknown> {
  piSubagentsAwaitTicker?: (() => void) | undefined;
  piSubagentsAwaitInvalidate?: (() => void) | undefined;
}

export interface SubagentToolRenderContext {
  readonly state: SubagentToolRendererState;
  readonly invalidate: () => void;
}

export const syncAwaitProgressTicker = (
  details: SubagentStartAwaitCardDetails | undefined,
  isPartial: boolean,
  context: SubagentToolRenderContext | undefined,
  startTicker: (intervalMs: number, tick: () => void) => () => void,
): void => {
  if (!context?.state) return;
  const shouldAnimate =
    isPartial &&
    (details?.action === "start" ||
      (details?.action === "await" &&
        details.cancelled !== true &&
        details.cards.some((run) => run.state === "starting" || run.state === "running")));
  if (shouldAnimate) {
    context.state.piSubagentsAwaitInvalidate = context.invalidate;
    if (!context.state.piSubagentsAwaitTicker) {
      const weakState = new WeakRef(context.state);
      let stopTimer = () => {};
      const cleanup = () => {
        try {
          stopTimer();
        } catch {
          // Renderer teardown is best effort while the host tool row is settling.
        }
      };
      stopTimer = startTicker(160, () => {
        const active = weakState.deref();
        if (active) active.piSubagentsAwaitInvalidate?.();
        else cleanup();
      });
      context.state.piSubagentsAwaitTicker = cleanup;
    }
    return;
  }
  const stop = context.state.piSubagentsAwaitTicker;
  if (!stop) return;
  context.state.piSubagentsAwaitTicker = undefined;
  context.state.piSubagentsAwaitInvalidate = undefined;
  try {
    stop();
  } catch {
    // Renderer teardown is best effort while the host tool row is settling.
  }
};

export const renderAwaitProgressComponent = (
  runs: ReadonlyArray<SubagentRunCard>,
  targets: ReadonlyArray<SubagentRunCard>,
  until: SubagentAwaitUntil,
  theme: Theme,
  hierarchy: AwaitProgressHierarchy,
  outcome: AwaitSummaryOutcome = {},
): Component => new AwaitProgressComponent(runs, targets, until, theme, hierarchy, outcome);
