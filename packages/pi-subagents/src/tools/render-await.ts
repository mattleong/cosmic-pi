import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { sanitizeTerminalLine, synchronousNow } from "pi-cosmic-core";
import { managerStateGlyph } from "pi-cosmic-ui/manager";
import { isAssignmentFinishedRunState } from "../run/model.ts";
import type { SubagentAwaitUntil } from "../run/service.ts";
import { aggregateUsage } from "../ui/metrics.ts";
import { runStateGlyph, runStateLabel } from "../ui/run-state.ts";
import { projectRunCardTree, runTreeBranch } from "../ui/run-tree-rows.ts";
import type { SubagentRunCard, SubagentStartAwaitCardDetails } from "./details-schema.ts";
import { renderComponent } from "./render-primitives.ts";
import { renderResponsiveRunRows, runTiming } from "./render-run-rows.ts";

export interface AwaitProgressRun {
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

const firstFinishedSummary = (run: AwaitProgressRun): string =>
  `${sanitizeTerminalLine(run.name)} ${
    run.state === "reported" ? "reported first · retained" : `${runStateLabel(run.state)} first`
  }`;

const interruptedOutcome = (outcome: AwaitSummaryOutcome): boolean =>
  outcome.cancelled === true || outcome.timedOut === true || outcome.attentionRequired === true;

/** First finished run by earliest end time; relevant only for any_finished waits. */
const firstFinishedRun = (
  runs: ReadonlyArray<AwaitProgressRun>,
  until: SubagentAwaitUntil,
): AwaitProgressRun | undefined =>
  until === "any_finished"
    ? runs
        .filter((run) => isAssignmentFinishedRunState(run.state))
        .sort((left, right) => (left.endedAt ?? Infinity) - (right.endedAt ?? Infinity))[0]
    : undefined;

const awaitHeading = (
  until: SubagentAwaitUntil,
  outcome: AwaitSummaryOutcome,
  finished: number,
  failed: number,
  targetCount: number,
  firstRun: AwaitProgressRun | undefined,
): string => {
  if (outcome.cancelled) return "Await canceled";
  if (outcome.timedOut) return "Await timed out";
  if (outcome.attentionRequired) return "Parent action required";
  if (outcome.settled !== true)
    return until === "all_finished" ? "Waiting for subagents" : "Waiting for first subagent";
  const completionFailed = until === "any_finished" ? firstRun?.state === "failed" : failed > 0;
  const glyph = managerStateGlyph(completionFailed ? "failed" : "done");
  if (until === "any_finished" && firstRun !== undefined)
    return `${glyph} ${firstFinishedSummary(firstRun)}`;
  return `${glyph} ${finished}/${targetCount} finished`;
};

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
  const firstRun = firstFinishedRun(runs, until);
  const firstSummary = firstRun === undefined ? undefined : firstFinishedSummary(firstRun);
  // Interrupted-settled waits (cancelled, timed out, or needing parent action) still carry the
  // standalone count and first-finished lines; only normal settlement folds them into the heading.
  const settledNormally = outcome.settled === true && !interruptedOutcome(outcome);
  const progressInHeading = settledNormally && until === "all_finished";
  const firstInHeading = settledNormally && until === "any_finished" && firstSummary !== undefined;
  const heading = awaitHeading(until, outcome, finished, failed, targetCount, firstRun);
  const activeSummary = (
    ["starting", "running", "waiting_for_parent", "paused", "stopping"] as const
  ).flatMap((state) => {
    const count = runs.filter((run) => run.state === state).length;
    return count > 0 ? [`${count} ${runStateLabel(state)}`] : [];
  });
  return [
    heading,
    ...(targetCount > 0 && !progressInHeading ? [`${finished}/${targetCount}`] : []),
    ...(firstSummary !== undefined && !firstInHeading ? [firstSummary] : []),
    ...activeSummary,
    ...(failed > 0 ? [`${failed} failed`] : []),
    ...(usage ? [usage] : []),
    ...(outcome.settled ? [] : [`◎${targetCount} target${targetCount === 1 ? "" : "s"}`]),
    ...(descendantCount > 0
      ? [`${descendantCount} descendant${descendantCount === 1 ? "" : "s"}`]
      : []),
  ].join(" · ");
};

export const formatAwaitProgress = (
  runs: ReadonlyArray<AwaitProgressRun>,
  until: SubagentAwaitUntil,
  contextRuns: ReadonlyArray<AwaitProgressRun> = [],
): string => {
  const awaitedIds = new Set(runs.map((run) => run.id));
  const allRuns = [...runs, ...contextRuns.filter((run) => !awaitedIds.has(run.id))];
  const usage = aggregateUsage(allRuns, "compact");
  return [
    formatAwaitSummary(runs, until, usage, {
      targetCount: awaitedIds.size,
      descendantCount: allRuns.length - runs.length,
    }),
    ...projectRunCardTree(allRuns).map((row) => {
      const status = sanitizeTerminalLine(
        [row.run.currentTool, runTiming(row.run)].filter(Boolean).join(" · "),
      );
      return `${runTreeBranch(row)}${awaitedIds.has(row.run.id) ? "◎ " : ""}${runStateGlyph(row.run.state)} ${sanitizeTerminalLine(row.run.name)} (${sanitizeTerminalLine(row.run.id)})${status ? ` · ${status}` : ""}`;
    }),
  ].join("\n");
};

interface AwaitProgressHierarchy {
  readonly awaitedRunIds?: ReadonlySet<string> | undefined;
  readonly contextOmitted?: boolean | undefined;
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
): Component =>
  renderComponent((width) => {
    const safeWidth = Math.max(1, width);
    const frame = Math.floor(synchronousNow() / 160);
    const usage = aggregateUsage(runs, "compact");
    const targetIds = hierarchy.awaitedRunIds ?? new Set(targets.map((run) => run.id));
    const summary = {
      ...outcome,
      targetCount: targetIds.size,
      descendantCount: runs.filter((run) => !targetIds.has(run.id)).length,
    };
    return [
      truncateToWidth(
        theme.fg(
          interruptedOutcome(outcome)
            ? "warning"
            : targets.some((run) => run.state === "failed")
              ? "error"
              : targets.length > 0 &&
                  targets.every((run) => isAssignmentFinishedRunState(run.state))
                ? "success"
                : "warning",
          formatAwaitSummary(targets, until, usage, summary),
        ),
        safeWidth,
      ),
      ...(hierarchy.contextOmitted
        ? [
            truncateToWidth(
              theme.fg("warning", "Some descendant context was omitted from this card."),
              safeWidth,
            ),
          ]
        : []),
      ...renderResponsiveRunRows(runs, safeWidth, theme, { frame, hierarchy }),
    ];
  });
